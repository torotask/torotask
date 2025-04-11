import { Queue, Worker, Job, JobsOptions, WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { EventDispatcher } from './event-dispatcher.js';
import type { EventSubscriptionInfo } from './types.js';
import { BaseQueue } from './base-queue.js';

const SYNC_QUEUE_NAME = 'events.sync';

// Define Redis key prefixes
const EVENT_BY_EVENT_PREFIX = 'events:by-event:';
const EVENT_BY_TASK_PREFIX = 'events:by-task:';

interface SyncJobPayload {
  taskGroup: string;
  taskName: string;
  // The complete list of event subscriptions this task *should* have
  desiredSubscriptions: EventSubscriptionInfo[];
}

interface SyncJobReturn {
  registered: number;
  unregistered: number;
  errors: number;
}

/**
 * Manages the synchronization of event trigger registrations using a dedicated queue
 * processed by a single worker. Ensures atomic updates across multiple Task instances.
 */
export class EventManager extends BaseQueue {
  // Store reference to dispatcher for performing registrations
  private readonly eventDispatcher: EventDispatcher;

  constructor(dispatcher: EventDispatcher, parentLogger: Logger, queueName: string = SYNC_QUEUE_NAME) {
    if (!dispatcher) {
      throw new Error('EventDispatcher instance is required for EventManager.');
    }
    const managerLogger = parentLogger.child({ service: 'EventManager', queue: queueName });
    super(dispatcher.client, queueName, managerLogger);

    // EventManager needs access to the dispatcher to modify registrations
    this.eventDispatcher = dispatcher;
  }

  /**
   * Overrides BaseQueue's startWorker with concurrency option
   */
  getDefaultOptions(): Partial<WorkerOptions> {
    return {
      concurrency: 1, // Ensure only one sync job runs at a time globally
    };
  }

  getEventKey(eventName: string): string {
    return `${EVENT_BY_EVENT_PREFIX}${eventName}`;
  }

  getTaskKey(info: EventSubscriptionInfo): string {
    const { taskGroup, taskName, triggerId, eventId } = info;
    let suffix = '';
    if (triggerId) {
      suffix = `:trigger:${triggerId}`;
    } else if (eventId) {
      suffix = `:event:${eventId}`;
    }
    return `${EVENT_BY_TASK_PREFIX}${taskGroup}:${taskName}${suffix}`;
  }

  /**
   * Adds a job to the synchronization queue to update event registrations for a specific task.
   * Uses a job ID based on the task to prevent duplicate concurrent syncs.
   *
   * @param taskGroup The group name of the task.
   * @param taskName The name of the task.
   * @param desiredSubscriptions The complete list of event subscriptions the task should have.
   * @param options Optional BullMQ job options.
   */
  async requestSync(
    taskGroup: string,
    taskName: string,
    desiredSubscriptions: EventSubscriptionInfo[],
    options?: JobsOptions
  ): Promise<Job<SyncJobPayload, SyncJobReturn | undefined> | undefined> {
    const payload: SyncJobPayload = {
      taskGroup,
      taskName,
      desiredSubscriptions,
    };
    this.logger.info(
      { taskGroup, taskName, desiredCount: desiredSubscriptions.length },
      `Requesting event trigger sync job.`
    );

    // Add job, preventing duplicates if one is already active or waiting
    const job = await this.queue.add(this.queueName, payload, {
      removeOnComplete: 500,
      removeOnFail: 100,
      ...(options ?? {}),
    });

    this.logger.debug({ jobId: job.id }, 'Sync job added to queue.');
    return job;
  }

  /**
   * Processes a synchronization job. Fetches current Redis state, compares with desired state
   * from the job payload, and calls EventDispatcher to register/unregister differences.
   * Executed by the single worker.
   *
   * @param job The synchronization job.
   */
  async process(job: Job<SyncJobPayload>): Promise<SyncJobReturn> {
    const { taskGroup, taskName, desiredSubscriptions } = job.data;
    const logPrefix = `[Sync Process: ${taskGroup}:${taskName} (Job ${job.id})]`;
    this.logger.info(`${logPrefix} Starting synchronization.`);

    const desiredSubMap = new Map<number, EventSubscriptionInfo>();
    desiredSubscriptions.forEach((sub) => {
      if (sub.triggerId !== undefined) {
        // Only process trigger-based subscriptions here
        desiredSubMap.set(sub.triggerId, sub);
      }
    });
    this.logger.debug(`${logPrefix} Desired trigger subscription count: ${desiredSubMap.size}`);

    let registeredCount = 0;
    let unregisteredCount = 0;
    let errorCount = 0;
    const registrationPromises: Promise<void>[] = [];
    const unregistrationPromises: Promise<void>[] = [];

    try {
      // 1. Get currently registered state from Redis
      const currentlyRegisteredEvents = await this.getRegisteredTaskEvents(taskGroup, taskName, 'trigger');
      const currentlyRegisteredMap = new Map<number, { eventName: string; type: string; id: string }>();
      currentlyRegisteredEvents.forEach((ev) => {
        const triggerId = parseInt(ev.id, 10);
        if (!isNaN(triggerId)) {
          currentlyRegisteredMap.set(triggerId, ev);
        }
      });
      this.logger.debug(`${logPrefix} Found ${currentlyRegisteredMap.size} triggers currently registered in Redis.`);

      // 2. Identify triggers to register
      desiredSubMap.forEach((desiredInfo, triggerId) => {
        if (!currentlyRegisteredMap.has(triggerId)) {
          this.logger.info({ eventName: desiredInfo.eventId, triggerId }, `${logPrefix} Registering trigger...`);
          registrationPromises.push(
            this.registerTaskEvent(desiredInfo.eventId!, desiredInfo)
              .then(() => {
                registeredCount++;
              })
              .catch((err) => {
                this.logger.error(
                  { err, eventName: desiredInfo.eventId, triggerId },
                  `${logPrefix} Failed registration.`
                );
                errorCount++;
              })
          );
        }
      });

      // 3. Identify triggers to unregister
      currentlyRegisteredMap.forEach((redisInfo, triggerId) => {
        if (!desiredSubMap.has(triggerId)) {
          const eventName = redisInfo.eventName;
          this.logger.info({ eventName, triggerId }, `${logPrefix} Unregistering stale trigger...`);
          // Reconstruct minimal info needed for unregistration
          const subscriptionInfo: EventSubscriptionInfo = {
            taskGroup: taskGroup,
            taskName: taskName,
            triggerId: triggerId,
            eventId: eventName,
          };
          unregistrationPromises.push(
            this.unregisterTaskEvent(eventName, subscriptionInfo)
              .then(() => {
                unregisteredCount++;
              })
              .catch((err) => {
                this.logger.error({ err, eventName: eventName, triggerId }, `${logPrefix} Failed unregistration.`);
                errorCount++;
              })
          );
        }
      });

      // 4. Wait for all operations to settle
      await Promise.allSettled([...registrationPromises, ...unregistrationPromises]);

      this.logger.info(
        { registered: registeredCount, unregistered: unregisteredCount, errors: errorCount },
        `${logPrefix} Synchronization finished.`
      );

      return { registered: registeredCount, unregistered: unregisteredCount, errors: errorCount };
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Critical error during synchronization process.`);
      // Throw error to fail the job
      throw error;
    }
  }

  // setupWorkerEventListeners - Helper to attach listeners (could be inherited or defined here)
  // Example:
  private setupWorkerEventListeners(worker: Worker): void {
    worker.on('error', (error) => {
      this.logger.error({ err: error }, 'EventManager worker error.');
    });
    worker.on('failed', (job, error) => {
      this.logger.error({ jobId: job?.id, err: error }, 'EventManager sync job failed.');
    });
    // Add other listeners if needed
  }

  /**
   * Registers a task trigger for a specific event.
   * Persists the relationship in Redis using:
   * - events:by-event:<eventName> -> Set<JSONString<{ groupName, taskName, triggerId }>>
   * - events:by-task:<taskName> -> Set<eventName>
   * @param eventName The name of the event to subscribe to.
   * @param info The EventSubscriptionInfo object containing task group, name, and optional triggerId and data.
   */
  async registerTaskEvent(eventName: string, info: EventSubscriptionInfo): Promise<void> {
    // Assuming task.group.name exists
    const { taskName, triggerId } = info;

    this.logger.debug(info, 'Registering task trigger for event in Redis');
    const subscriptionJson = JSON.stringify(info);

    // --- Redis Persistence ---
    try {
      const redis = await this.getRedisClient();
      const eventKey = this.getEventKey(eventName);
      const taskKey = this.getTaskKey(info);

      const [eventAddResult, taskAddResult] = await Promise.all([
        redis.sadd(eventKey, subscriptionJson), // Add JSON string to event's set
        redis.sadd(taskKey, eventName), // Add event name to task's set
      ]);

      if (eventAddResult > 0) {
        this.logger.info(
          { eventName, taskName, triggerId, redisKey: eventKey },
          'Task trigger added to event set in Redis'
        );
      } else {
        this.logger.debug(
          { eventName, taskName, triggerId, redisKey: eventKey },
          'Task trigger was already in event set in Redis'
        );
      }
      if (taskAddResult > 0) {
        this.logger.info({ eventName, taskName, redisKey: taskKey }, 'Event added to task set in Redis');
      } else {
        this.logger.debug({ eventName, taskName, redisKey: taskKey }, 'Event was already in task set in Redis');
      }
    } catch (error) {
      this.logger.error(
        { err: error, eventName, taskName, triggerId },
        'Failed to register event task trigger relationship in Redis'
      );
      throw error;
    }
  }

  /**
   * Unregisters a specific task trigger from an event in Redis.
   * Removes JSON string from events:by-event:<eventName> set.
   * Removes event name from events:by-task:<taskName> set.
   * @param eventName The name of the event.
   * @param info The EventSubscriptionInfo object containing task group, name, and optional triggerId and eventId.
   */
  async unregisterTaskEvent(eventName: string, info: EventSubscriptionInfo): Promise<void> {
    // Assuming task.group.name exists
    const { taskGroup, taskName, triggerId } = info;
    this.logger.debug(info, 'Unregistering task trigger from event in Redis');

    const subscriptionInfo: EventSubscriptionInfo = { taskGroup, taskName, triggerId };
    const subscriptionJson = JSON.stringify(subscriptionInfo);

    try {
      const redis = await this.getRedisClient();
      const eventKey = this.getEventKey(eventName);
      const taskKey = this.getTaskKey(info);

      // Use Promise.all to remove from both sets concurrently
      // Note: We only remove the specific trigger JSON from the event set.
      // We remove the event name from the task set, but only if no other triggers for this task listen to the same event.
      const [eventRemResult, isTaskStillListening] = await Promise.all([
        redis.srem(eventKey, subscriptionJson), // Remove specific JSON trigger info
        // Check if the task has other triggers for the *same event* before removing from taskKey
        redis
          .smembers(eventKey)
          .then((members) =>
            members
              .map((m) => JSON.parse(m) as EventSubscriptionInfo)
              .some((info) => info.taskName === taskName && info.triggerId !== triggerId)
          ),
        // Alternative simpler approach for taskKey: Remove it, and let register add it back if needed.
        // redis.srem(taskKey, eventName) // Remove event name from task's set (simpler, maybe less accurate if >1 trigger)
      ]);

      // srem returns the number of members removed (0 or 1 in this case)
      if (eventRemResult > 0) {
        this.logger.info(
          { eventName, taskName, triggerId, redisKey: eventKey },
          'Task trigger removed from event set in Redis'
        );
      } else {
        this.logger.warn(
          { eventName, taskName, triggerId, redisKey: eventKey },
          'Task trigger not found in event set in Redis during unregistration'
        );
      }

      // Only remove eventName from taskKey if this was the last trigger for that event on this task
      if (!isTaskStillListening && eventRemResult > 0) {
        // Only proceed if the trigger was actually found and removed
        const taskRemResult = await redis.srem(taskKey, eventName);
        if (taskRemResult > 0) {
          this.logger.info(
            { eventName, taskName, redisKey: taskKey },
            'Event removed from task set in Redis (last trigger)'
          );
        } else {
          // This could happen if taskKey was somehow already cleaned up
          this.logger.warn(
            { eventName, taskName, redisKey: taskKey },
            'Event not found in task set in Redis during final trigger unregistration'
          );
        }
      } else if (isTaskStillListening) {
        this.logger.debug(
          { eventName, taskName, redisKey: taskKey },
          'Task still listening to event via other triggers, not removing event from task set.'
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, eventName, taskName, triggerId },
        'Failed to unregister event task trigger relationship in Redis'
      );
      throw error;
    }
  }

  /**
   * Retrieves all registered event subscriptions for a specific event name from Redis.
   * Fetches members from the events:by-event:<eventName> set and parses them.
   * @param eventName The name of the event.
   * @returns A promise that resolves with an array of EventSubscriptionInfo objects.
   */
  async getRegisteredSubscriptionsForEvent(eventName: string): Promise<EventSubscriptionInfo[]> {
    const logPrefix = '[getRegisteredSubscriptionsForEvent]';
    this.logger.debug({ eventName }, `${logPrefix} Fetching subscriptions from Redis...`);
    const subscriptions: EventSubscriptionInfo[] = [];
    const eventKey = this.getEventKey(eventName); // Use static helper

    try {
      const redis = await this.getRedisClient();
      const jsonStrings = await redis.smembers(eventKey);

      if (!jsonStrings || jsonStrings.length === 0) {
        this.logger.debug({ eventName, eventKey }, `${logPrefix} No subscriptions found in Redis set.`);
        return []; // No subscriptions found
      }

      this.logger.debug(
        { eventName, count: jsonStrings.length },
        `${logPrefix} Found potential subscriptions, parsing...`
      );

      jsonStrings.forEach((jsonString) => {
        try {
          const info = JSON.parse(jsonString) as EventSubscriptionInfo;
          // Basic validation - adjust as needed based on required fields
          if (info && info.taskGroup && info.taskName) {
            subscriptions.push(info);
          } else {
            this.logger.warn(
              { eventName, jsonString },
              `${logPrefix} Skipping invalid/incomplete subscription JSON found in set.`
            );
          }
        } catch (parseError) {
          this.logger.error(
            { err: parseError, eventName, jsonString },
            `${logPrefix} Failed to parse subscription JSON from set.`
          );
          // Decide whether to skip or throw. Skipping is safer for overall processing.
        }
      });

      this.logger.debug({ eventName, count: subscriptions.length }, `${logPrefix} Finished parsing subscriptions.`);
      return subscriptions;
    } catch (error) {
      this.logger.error(
        { err: error, eventName },
        `${logPrefix} Failed to retrieve subscriptions from Redis for event.`
      );
      throw error; // Re-throw error
    }
  }

  /**
   * Retrieves all registered event subscriptions associated with a specific task name and type.
   * Scans for keys matching events:by-task:<taskGroup>:<taskName>:<type>:*
   * NOTE: This uses SCAN and might be less performant for a very large number of triggers per task.
   * @param taskGroup The task group name.
   * @param taskName The task name.
   * @param type The type of event subscription ('trigger', 'event', etc.).
   * @returns A promise resolving to an array of objects { eventName: string, type: string, id: string }.
   */
  async getRegisteredTaskEvents(
    taskGroup: string,
    taskName: string,
    type: string // e.g., 'trigger', 'event'
  ): Promise<{ eventName: string; type: string; id: string }[]> {
    const logPrefix = '[getRegisteredTaskEvents]';
    const redis = await this.getRedisClient();
    // Construct the pattern based on the provided type
    const matchPattern = `${EVENT_BY_TASK_PREFIX}${taskGroup}:${taskName}:${type}:*`;
    const prefixToRemove = `${EVENT_BY_TASK_PREFIX}${taskGroup}:${taskName}:${type}:`; // For extracting the ID
    const events: { eventName: string; type: string; id: string }[] = [];
    let cursor = '0';

    this.logger.debug({ taskGroup, taskName, type, pattern: matchPattern }, `${logPrefix} Scanning for task events...`);

    try {
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100);
        cursor = nextCursor;

        if (keys.length > 0) {
          // Extract ID and get eventName for each key found
          const multi = redis.multi();
          const eventDetails: { key: string; id: string }[] = [];

          keys.forEach((key) => {
            // Extract the ID part (everything after the prefix)
            const id = key.substring(prefixToRemove.length);
            if (id) {
              eventDetails.push({ key, id });
            } else {
              this.logger.warn({ key, type }, `${logPrefix} Could not extract ID from scanned key.`);
            }
          });

          if (eventDetails.length > 0) {
            const results = await multi.exec();
            results?.forEach(([err, eventName], index) => {
              const detail = eventDetails[index];
              if (!err && typeof eventName === 'string') {
                events.push({ eventName, type, id: detail.id });
              } else {
                this.logger.warn({ key: detail.key, err }, `${logPrefix} Failed to get event name for key.`);
              }
            });
          }
        }
      } while (cursor !== '0');

      this.logger.debug({ taskGroup, taskName, type, count: events.length }, `${logPrefix} Finished scan.`);
      return events;
    } catch (error) {
      this.logger.error({ err: error, taskGroup, taskName, type }, `${logPrefix} Failed during SCAN operation.`);
      throw error;
    }
  }
}
