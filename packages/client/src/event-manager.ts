import { Queue, Worker, Job, JobsOptions, WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { EventDispatcher } from './event-dispatcher.js';
import type { EventSubscriptionInfo } from './types.js';
import { BaseQueue } from './base-queue.js';

const SYNC_QUEUE_NAME = 'events.sync';

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
      const currentlyRegisteredEvents = await this.eventDispatcher.getRegisteredTaskEvents(
        taskGroup,
        taskName,
        'trigger'
      );
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
            this.eventDispatcher
              .registerTaskEvent(desiredInfo.eventId!, desiredInfo)
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
            this.eventDispatcher
              .unregisterTaskEvent(eventName, subscriptionInfo)
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

  // close() method will be inherited from BaseQueue, assuming it handles worker/queue shutdown.
}
