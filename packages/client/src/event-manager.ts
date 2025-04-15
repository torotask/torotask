import { Queue, Worker, Job, JobsOptions, WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { EventDispatcher } from './event-dispatcher.js';
import type { EventSubscriptionInfo } from './types.js';
import { BaseQueue } from './base-queue.js';

const SYNC_QUEUE_NAME = 'events.sync';

// Define Redis key prefixes
const EVENT_BY_EVENT_PREFIX = 'events:by-event';
const TASK_INDEX_PREFIX = 'events:task-index'; // New prefix for task index sets

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
  public readonly prefix: string;

  constructor(dispatcher: EventDispatcher, parentLogger: Logger, queueName: string = SYNC_QUEUE_NAME, prefix?: string) {
    if (!dispatcher) {
      throw new Error('EventDispatcher instance is required for EventManager.');
    }
    const managerLogger = parentLogger.child({ service: 'EventManager', queue: queueName });
    super(dispatcher.client, queueName, managerLogger);

    // Set prefix
    this.prefix = prefix || dispatcher.client.prefix;
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
    const prefix = this.prefix ? `${this.prefix}:` : '';
    return `${prefix}${EVENT_BY_EVENT_PREFIX}:${eventName}`;
  }

  /**
   * Gets the Redis key for the Set containing event names a task is subscribed to.
   * @param taskGroup Task group name.
   * @param taskName Task name.
   * @returns The Redis key string.
   */
  private getTaskIndexKey(taskGroup: string, taskName: string): string {
    const prefix = this.prefix ? `${this.prefix}:` : '';
    return `${prefix}${TASK_INDEX_PREFIX}:${taskGroup}:${taskName}`;
  }

  /**
   * Generates a unique identifier string for a subscription to be used as a field key in Redis Hashes.
   * @param info The EventSubscriptionInfo object.
   * @returns A string identifier (e.g., "group:task:trigger:123" or "group:task:event:abc").
   */
  private getSubscriptionIdentifier(info: EventSubscriptionInfo): string {
    const { taskGroup, taskName, triggerId, eventId } = info;
    let suffix = '';
    if (triggerId !== undefined) {
      suffix = `:trigger:${triggerId}`;
    } else if (eventId !== undefined) {
      // Use eventId if triggerId is not present (for non-trigger subscriptions)
      suffix = `:event:${eventId}`;
    } else {
      // Fallback or error needed if neither is defined?
      this.logger.warn({ info }, 'Subscription info lacks both triggerId and eventId for identifier generation');
      // Using a generic suffix, but this might cause collisions if multiple non-id event subs exist per task
      suffix = ':event:unidentified';
    }
    // Consistent identifier format
    return `${taskGroup}:${taskName}${suffix}`;
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
    this.logger.info(`${logPrefix} Starting synchronization using Hash strategy.`);

    // --- Prepare desired state map (triggers only for now) ---
    const desiredSubMap = new Map<number, EventSubscriptionInfo>();
    const desiredEventNames = new Set<string>();
    desiredSubscriptions.forEach((sub) => {
      if (sub.triggerId !== undefined) {
        desiredSubMap.set(sub.triggerId, sub);
        if (sub.eventId) {
          desiredEventNames.add(sub.eventId);
        }
      }
    });
    this.logger.debug(
      { desiredCount: desiredSubMap.size, desiredEvents: Array.from(desiredEventNames) },
      `${logPrefix} Desired trigger subscriptions prepared.`
    );

    let registeredCount = 0;
    let unregisteredCount = 0;
    let errorCount = 0;
    const promises: Promise<void>[] = [];

    try {
      // --- 1. Get currently registered state for this task from relevant Redis Hashes ---
      const currentlyRegisteredMap = new Map<number, EventSubscriptionInfo>();
      const redis = await this.getRedisClient();
      const taskIndexKey = this.getTaskIndexKey(taskGroup, taskName);
      let knownEventNames: string[] = [];
      try {
        // Fetch event names associated with this task from the index set
        knownEventNames = await redis.smembers(taskIndexKey);
        this.logger.debug({ taskIndexKey, knownEventNames }, `${logPrefix} Fetched known event names from task index.`);
      } catch (indexError) {
        this.logger.error(
          { err: indexError, taskIndexKey },
          `${logPrefix} Failed to fetch event names from task index.`
        );
        // Decide if we should proceed? If index is missing, we might miss stale entries.
        // For now, we'll proceed but log the error.
        errorCount++;
      }

      // Combine known event names from index with names from desired state
      const relevantEventNames = new Set([...knownEventNames, ...desiredEventNames]);
      this.logger.debug(
        { relevantEvents: Array.from(relevantEventNames) },
        `${logPrefix} Combined list of relevant event names to check.`
      );

      const fetchPromises = Array.from(relevantEventNames).map(async (eventName) => {
        const eventKey = this.getEventKey(eventName);
        try {
          const subscriptionJsonStrings = await redis.hvals(eventKey);
          this.logger.debug(
            { eventName, count: subscriptionJsonStrings.length, key: eventKey },
            `${logPrefix} Fetched subscription JSONs from Hash.`
          );
          subscriptionJsonStrings.forEach((jsonString) => {
            try {
              const info = JSON.parse(jsonString) as EventSubscriptionInfo;
              // Filter for the specific task and ensure it's a trigger we are tracking
              if (info.taskGroup === taskGroup && info.taskName === taskName && info.triggerId !== undefined) {
                currentlyRegisteredMap.set(info.triggerId, info);
              }
            } catch (parseError) {
              this.logger.warn(
                { err: parseError, eventName, key: eventKey, jsonString },
                `${logPrefix} Failed to parse subscription JSON from Hash.`
              );
            }
          });
        } catch (fetchError) {
          this.logger.error(
            { err: fetchError, eventName, key: eventKey },
            `${logPrefix} Failed to fetch subscriptions from Hash.`
          );
          // Decide how to handle: continue with partial data, or abort? We'll log and continue.
          errorCount++; // Increment error count if fetch fails
        }
      });

      await Promise.all(fetchPromises);
      this.logger.debug(
        { currentCount: currentlyRegisteredMap.size },
        `${logPrefix} Current trigger registrations for this task identified from Hashes.`
      );

      // --- 2. Identify triggers to register or update ---
      desiredSubMap.forEach((desiredInfo, triggerId) => {
        const registeredInfo = currentlyRegisteredMap.get(triggerId);

        if (!registeredInfo) {
          // Case 1: Trigger ID is new -> Register it
          this.logger.info({ eventName: desiredInfo.eventId, triggerId }, `${logPrefix} Registering new trigger...`);
          promises.push(
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
        } else {
          // Case 2: Trigger ID exists -> Check if content differs
          // Compare based on eventId. Add more checks (e.g., data deep compare) if needed.
          if (desiredInfo.eventId !== registeredInfo.eventId) {
            this.logger.info(
              { newEvent: desiredInfo.eventId, oldEvent: registeredInfo.eventId, triggerId },
              `${logPrefix} Updating existing trigger registration...`
            );
            // Schedule unregister of old, then register of new
            promises.push(
              this.unregisterTaskEvent(registeredInfo.eventId!, registeredInfo) // Use old info for unregister
                .then(() => this.registerTaskEvent(desiredInfo.eventId!, desiredInfo)) // Use new info for register
                .then(() => {
                  /* Count as modification? */ registeredCount++;
                  unregisteredCount++;
                }) // Increment both for now
                .catch((err) => {
                  this.logger.error({ err, eventName: desiredInfo.eventId, triggerId }, `${logPrefix} Failed update.`);
                  errorCount++;
                })
            );
            // Remove from currentlyRegisteredMap so it's not processed in the unregister loop below
            currentlyRegisteredMap.delete(triggerId);
          } else {
            // Trigger exists and is the same, do nothing. Log for debug?
            this.logger.debug(
              { eventName: desiredInfo.eventId, triggerId },
              `${logPrefix} Trigger already registered and unchanged.`
            );
            // Also remove from map as it's accounted for.
            currentlyRegisteredMap.delete(triggerId);
          }
        }
      });

      // --- 3. Identify and unregister remaining stale triggers ---
      // Any triggerId still in currentlyRegisteredMap was not in desiredSubMap *at all*.
      currentlyRegisteredMap.forEach((registeredInfo, triggerId) => {
        this.logger.info(
          { eventName: registeredInfo.eventId, triggerId },
          `${logPrefix} Unregistering stale trigger (not in desired state)...`
        );
        promises.push(
          this.unregisterTaskEvent(registeredInfo.eventId!, registeredInfo)
            .then(() => {
              unregisteredCount++;
            })
            .catch((err) => {
              this.logger.error(
                { err, eventName: registeredInfo.eventId, triggerId },
                `${logPrefix} Failed stale unregistration.`
              );
              errorCount++;
            })
        );
      });

      // --- 4. Wait for all operations to settle ---
      await Promise.allSettled(promises);

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
   * Registers a task trigger/event subscription for a specific event.
   * Persists the relationship in Redis using:
   * - events:by-event:<eventName> (Hash) -> { <subscriptionId>: JSONString<EventSubscriptionInfo> }
   * @param eventName The name of the event to subscribe to.
   * @param info The EventSubscriptionInfo object containing task group, name, and optional triggerId/eventId and data.
   */
  async registerTaskEvent(eventName: string, info: EventSubscriptionInfo): Promise<void> {
    this.logger.debug(info, 'Registering task subscription for event in Redis Hash');
    const subscriptionJson = JSON.stringify(info);
    const fieldKey = this.getSubscriptionIdentifier(info);

    // --- Redis Persistence ---
    try {
      const redis = await this.getRedisClient();
      const eventKey = this.getEventKey(eventName);
      const taskIndexKey = this.getTaskIndexKey(info.taskGroup, info.taskName);

      // Use HSET to add/update the subscription in the Hash
      // Use SADD to add the event name to the task's index set
      // Run in a MULTI transaction for atomicity
      const multi = redis.multi();
      multi.hset(eventKey, fieldKey, subscriptionJson);
      multi.sadd(taskIndexKey, eventName);
      const results = await multi.exec();

      // Check HSET result (index 0 of results array)
      const hsetResult = results?.[0]?.[1]; // [1] accesses the value part of [error, value]
      if (hsetResult === 1) {
        // Note: ioredis returns number for HSET
        this.logger.info(
          { eventName, fieldKey, redisKey: eventKey },
          'Task subscription added to event Hash in Redis (new field)'
        );
      } else if (hsetResult === 0) {
        this.logger.debug(
          { eventName, fieldKey, redisKey: eventKey },
          'Task subscription updated in event Hash in Redis (existing field)'
        );
      } else {
        // Log if HSET result is unexpected (e.g., error in multi)
        this.logger.warn(
          { eventName, fieldKey, redisKey: eventKey, hsetResult: results?.[0] },
          'Unexpected result from HSET within MULTI'
        );
      }

      // Check SADD result (index 1 of results array)
      const saddResult = results?.[1]?.[1]; // [1] accesses the value part of [error, value]
      if (saddResult === 1) {
        // Note: ioredis returns number for SADD
        this.logger.info({ eventName, taskIndexKey }, 'Event name added to task index set');
      } else if (saddResult === 0) {
        this.logger.debug({ eventName, taskIndexKey }, 'Event name was already in task index set');
      } else {
        this.logger.warn(
          { eventName, taskIndexKey, saddResult: results?.[1] },
          'Unexpected result from SADD within MULTI'
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, eventName, taskGroup: info.taskGroup, taskName: info.taskName },
        'Failed to register event task subscription in Redis Hash'
      );
      throw error;
    }
  }

  /**
   * Unregisters a specific task trigger/event subscription from an event Hash in Redis.
   * Removes the field corresponding to the subscription identifier from the events:by-event:<eventName> Hash.
   * @param eventName The name of the event.
   * @param info The EventSubscriptionInfo object containing task group, name, and optional triggerId/eventId.
   */
  async unregisterTaskEvent(eventName: string, info: EventSubscriptionInfo): Promise<void> {
    const fieldKey = this.getSubscriptionIdentifier(info);
    const { taskGroup, taskName } = info;
    this.logger.debug({ eventName, fieldKey, info }, 'Unregistering task subscription from event Hash in Redis');

    try {
      const redis = await this.getRedisClient();
      const eventKey = this.getEventKey(eventName);
      const taskIndexKey = this.getTaskIndexKey(taskGroup, taskName);

      // 1. Use HDEL to remove the specific field (subscription) from the Hash
      const hashDelResult = await redis.hdel(eventKey, fieldKey);

      // HDEL returns the number of fields removed (0 or 1 in this case)
      if (hashDelResult > 0) {
        this.logger.info(
          { eventName, fieldKey, redisKey: eventKey },
          'Task subscription removed from event Hash in Redis'
        );

        // 2. Check if any other subscriptions for this task remain for this event
        const remainingValues = await redis.hvals(eventKey); // Get remaining JSON strings in the hash
        const taskHasOtherSubscriptionsForEvent = remainingValues.some((jsonString) => {
          try {
            const otherInfo = JSON.parse(jsonString) as EventSubscriptionInfo;
            // Check if any remaining entry belongs to the same task
            return otherInfo.taskGroup === taskGroup && otherInfo.taskName === taskName;
          } catch (parseError) {
            this.logger.warn(
              { err: parseError, eventKey, jsonString },
              'Failed to parse remaining member during unregisterTaskEvent check'
            );
            return false;
          }
        });

        // 3. If no other subscriptions for this task remain for this event, remove event from task index
        if (!taskHasOtherSubscriptionsForEvent) {
          this.logger.info(
            { eventName, taskIndexKey },
            'Last subscription for this task to this event removed. Removing event from task index.'
          );
          const sremResult = await redis.srem(taskIndexKey, eventName);
          if (sremResult === 0) {
            this.logger.warn(
              { eventName, taskIndexKey },
              'Attempted to remove event from task index, but it was not found.'
            );
          }
        } else {
          this.logger.debug(
            { eventName, taskIndexKey },
            'Other subscriptions for this task still exist for this event. Task index unchanged.'
          );
        }
      } else {
        // This is not necessarily an error, the subscription might have already been removed or never existed.
        this.logger.warn(
          { eventName, fieldKey, redisKey: eventKey },
          'Task subscription field not found in event Hash during unregistration'
        );
      }
    } catch (error) {
      this.logger.error(
        { err: error, eventName, taskGroup: info.taskGroup, taskName: info.taskName, fieldKey },
        'Failed to unregister event task subscription from Redis Hash'
      );
      throw error;
    }
  }

  /**
   * Retrieves all registered event subscriptions for a specific event name from the Redis Hash.
   * Fetches values (JSON strings) from the events:by-event:<eventName> Hash and parses them.
   * @param eventName The name of the event.
   * @returns A promise that resolves with an array of EventSubscriptionInfo objects.
   */
  async getRegisteredSubscriptionsForEvent(eventName: string): Promise<EventSubscriptionInfo[]> {
    const logPrefix = '[getRegisteredSubscriptionsForEvent]';
    this.logger.debug({ eventName }, `${logPrefix} Fetching subscriptions from Hash...`);
    const subscriptions: EventSubscriptionInfo[] = [];
    const eventKey = this.getEventKey(eventName); // Gets events:by-event:<eventName>

    try {
      const redis = await this.getRedisClient();
      // Use HVALS to get all subscription JSON strings from the Hash
      const jsonStrings = await redis.hvals(eventKey);

      if (!jsonStrings || jsonStrings.length === 0) {
        this.logger.debug({ eventName, eventKey }, `${logPrefix} No subscriptions found in Redis Hash.`);
        return []; // No subscriptions found
      }

      this.logger.debug(
        { eventName, count: jsonStrings.length },
        `${logPrefix} Found potential subscriptions in Hash, parsing...`
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
              `${logPrefix} Skipping invalid/incomplete subscription JSON found in Hash.`
            );
          }
        } catch (parseError) {
          this.logger.error(
            { err: parseError, eventName, jsonString },
            `${logPrefix} Failed to parse subscription JSON from Hash.`
          );
          // Decide whether to skip or throw. Skipping is safer for overall processing.
        }
      });

      this.logger.debug(
        { eventName, count: subscriptions.length },
        `${logPrefix} Finished parsing subscriptions from Hash.`
      );
      return subscriptions;
    } catch (error) {
      this.logger.error(
        { err: error, eventName },
        `${logPrefix} Failed to retrieve subscriptions from Redis Hash for event.`
      );
      throw error; // Re-throw error
    }
  }
}
