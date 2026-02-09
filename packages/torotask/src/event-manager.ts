import type { JobsOptions, WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { ToroTask } from './client.js';
import type { TaskJob } from './job.js';
import type { EventQueueOptions, EventSubscriptionInfo, SyncJobPayload, SyncJobReturn, TaskJobOptions } from './types/index.js';
import { EventSubscriptions } from './event-subscriptions.js';
import { TaskWorkerQueue } from './worker-queue.js';

const SYNC_QUEUE_NAME = 'events.sync';
type PayloadType = SyncJobPayload;
type ReturnType = SyncJobReturn;

/**
 * Manages the synchronization of event trigger registrations using a dedicated queue
 * processed by a single worker. Ensures atomic updates across multiple Task instances.
 * Uses EventSubscriptionRepository for persistence.
 */
export class EventManager extends TaskWorkerQueue<PayloadType, ReturnType> {
  // Store reference to the repository for persistence operations
  public readonly subscriptions: EventSubscriptions;
  public readonly prefix: string;
  /** Default job options for sync jobs */
  public readonly eventDefaultJobOptions: Partial<JobsOptions>;
  /** Worker options for this queue */
  public readonly eventWorkerOptions: Partial<WorkerOptions>;

  // Update constructor signature to accept ToroTask
  constructor(
    taskClient: ToroTask, // Accept ToroTask
    parentLogger: Logger,
    name: string = SYNC_QUEUE_NAME,
    prefix?: string,
    subscriptions?: EventSubscriptions, // Allow injecting subscriptions
    eventQueueOptions?: EventQueueOptions, // New: accept event queue options
  ) {
    const logger = parentLogger.child({ service: 'EventManager', queue: name });
    prefix = prefix || taskClient.queuePrefix;
    // Merge queueOptions into the super constructor options
    super(taskClient, name, {
      logger,
      prefix,
      ...eventQueueOptions?.queueOptions,
    });

    this.prefix = prefix;
    // Instantiate repository if not provided, passing Redis client and prefix from ToroTask
    this.subscriptions = subscriptions || new EventSubscriptions(taskClient.redis, prefix, logger);
    // Store default job options and worker options
    this.eventDefaultJobOptions = eventQueueOptions?.defaultJobOptions ?? {};
    this.eventWorkerOptions = eventQueueOptions?.workerOptions ?? {};
  }

  /**
   * Overrides BaseQueue's startWorker with concurrency option
   */
  getWorkerOptions(): Partial<WorkerOptions> {
    return {
      concurrency: 1, // Ensure only one sync job runs at a time globally
      ...this.eventWorkerOptions,
    };
  }

  /**
   * Adds a job to the synchronization queue to update event registrations for a specific task.
   * Uses a job ID based on the task to prevent duplicate concurrent syncs.
   *
   * @param taskGroup The group name of the task.
   * @param taskId The id of the task.
   * @param desiredSubscriptions The complete list of event subscriptions the task should have.
   * @param options Optional BullMQ job options.
   */
  async requestSync(
    taskGroup: string,
    taskId: string,
    desiredSubscriptions: EventSubscriptionInfo[],
    options?: TaskJobOptions,
  ): Promise<TaskJob<PayloadType, ReturnType, string>> {
    const payload: PayloadType = {
      taskGroup,
      taskId,
      desiredSubscriptions,
    };
    this.logger.debug(
      { taskGroup, taskId, desiredCount: desiredSubscriptions.length },
      `Requesting event trigger sync job.`,
    );

    // Add job, merging defaultJobOptions with per-job options
    const job = await this.add(this.name, payload, {
      removeOnComplete: 500,
      removeOnFail: 100,
      ...this.eventDefaultJobOptions,
      ...(options ?? {}),
    });

    this.logger.debug({ jobId: job.id }, 'Sync job added to queue.');
    return job;
  }

  /**
   * Processes a synchronization job. Fetches current Redis state via the repository,
   * compares with desired state from the job payload, and calls repository methods
   * to register/unregister differences. Executed by the single worker.
   *
   * @param job The synchronization job.
   */
  async process(job: TaskJob<PayloadType, ReturnType, string>): Promise<ReturnType> {
    const { taskGroup, taskId, desiredSubscriptions } = job.payload;
    const logPrefix = `[Sync Process: ${taskGroup}:${taskId} (Job ${job.id})]`;
    this.logger.debug(`${logPrefix} Starting synchronization using Repository.`);

    // --- Prepare desired state map (using triggerId as key, matching original logic) ---
    const desiredSubMap = new Map<number, EventSubscriptionInfo>(); // Use triggerId as key
    const desiredEventNames = new Set<string>();
    desiredSubscriptions.forEach((sub) => {
      // Original logic primarily keyed off triggerId for comparison
      if (sub.triggerId !== undefined) {
        desiredSubMap.set(sub.triggerId, sub);
        if (sub.eventId) {
          desiredEventNames.add(sub.eventId);
        }
      }
      else {
        // Handle non-trigger subscriptions if necessary based on original logic
        // For now, assuming triggerId was the main comparison point
        this.logger.warn({ sub }, `${logPrefix} Desired subscription lacks triggerId, skipping comparison.`);
      }
    });
    this.logger.debug(
      { desiredCount: desiredSubMap.size, desiredEvents: Array.from(desiredEventNames) },
      `${logPrefix} Desired trigger subscriptions prepared.`,
    );

    let registeredCount = 0;
    let unregisteredCount = 0;
    let errorCount = 0;
    const promises: Promise<void>[] = [];

    try {
      // --- 1. Get currently registered state for this task using the repository ---
      let currentlyRegisteredSubscriptions: EventSubscriptionInfo[] = [];
      try {
        // Fetch all subscriptions for the task
        currentlyRegisteredSubscriptions = await this.subscriptions.getForTask(taskGroup, taskId);
        this.logger.debug(
          { currentCount: currentlyRegisteredSubscriptions.length },
          `${logPrefix} Fetched current subscriptions for task via repository.`,
        );
      }
      catch (fetchError) {
        this.logger.error(
          { err: fetchError, taskGroup, taskId },
          `${logPrefix} Failed to fetch current subscriptions via repository.`,
        );
        errorCount++;
        // Abort if we can't get the current state.
        throw new Error(`Failed to fetch current state for ${taskGroup}:${taskId}`);
      }

      // Create map using triggerId as key, matching original logic
      const currentlyRegisteredMap = new Map<number, EventSubscriptionInfo>();
      currentlyRegisteredSubscriptions.forEach((sub) => {
        if (sub.triggerId !== undefined) {
          currentlyRegisteredMap.set(sub.triggerId, sub);
        }
        else {
          // Handle non-trigger subscriptions if needed
        }
      });
      this.logger.debug(
        { currentCount: currentlyRegisteredMap.size },
        `${logPrefix} Current trigger registrations map prepared.`,
      );

      // --- 2. Identify subscriptions to register or update (based on triggerId) ---
      desiredSubMap.forEach((desiredInfo, triggerId) => {
        const registeredInfo = currentlyRegisteredMap.get(triggerId);
        // Assuming getSubscriptionIdentifier is public now
        const subId = this.subscriptions.getIdentifier(desiredInfo);

        if (!registeredInfo) {
          // Case 1: Trigger ID is new -> Register it
          this.logger.info(
            { eventName: desiredInfo.eventId, triggerId, subId },
            `${logPrefix} Registering new trigger subscription...`,
          );
          promises.push(
            this.subscriptions
              .register(desiredInfo.eventId!, desiredInfo)
              .then(() => {
                registeredCount++;
              })
              .catch((err) => {
                this.logger.error(
                  { err, eventName: desiredInfo.eventId, triggerId, subId },
                  `${logPrefix} Failed registration.`,
                );
                errorCount++;
              }),
          );
        }
        else {
          // Case 2: Trigger ID exists -> Check if content differs (simple eventId check for now)
          if (desiredInfo.eventId !== registeredInfo.eventId) {
            this.logger.info(
              { newEvent: desiredInfo.eventId, oldEvent: registeredInfo.eventId, triggerId, subId },
              `${logPrefix} Updating existing trigger subscription registration (event changed)...`,
            );
            // Schedule unregister of old, then register of new
            promises.push(
              this.subscriptions
                .unregister(registeredInfo.eventId!, registeredInfo) // Use old info for unregister
                .then(() => this.subscriptions.register(desiredInfo.eventId!, desiredInfo)) // Use new info for register
                .then(() => {
                  registeredCount++;
                  unregisteredCount++;
                })
                .catch((err) => {
                  this.logger.error(
                    { err, eventName: desiredInfo.eventId, triggerId, subId },
                    `${logPrefix} Failed update.`,
                  );
                  errorCount++;
                }),
            );
          }
          else {
            // Trigger exists and is the same (based on eventId).
            this.logger.debug(
              { eventName: desiredInfo.eventId, triggerId, subId },
              `${logPrefix} Trigger subscription already registered and unchanged.`,
            );
          }
          // Remove from currentlyRegisteredMap whether updated or unchanged, as it's accounted for.
          currentlyRegisteredMap.delete(triggerId);
        }
      });

      // --- 3. Identify and unregister remaining stale trigger subscriptions ---
      // Any triggerId still in currentlyRegisteredMap was not in desiredSubMap.
      currentlyRegisteredMap.forEach((registeredInfo, triggerId) => {
        // Assuming getSubscriptionIdentifier is public now
        const subId = this.subscriptions.getIdentifier(registeredInfo);
        this.logger.info(
          { eventName: registeredInfo.eventId, triggerId, subId },
          `${logPrefix} Unregistering stale trigger subscription (not in desired state)...`,
        );
        promises.push(
          this.subscriptions
            .unregister(registeredInfo.eventId!, registeredInfo)
            .then(() => {
              unregisteredCount++;
            })
            .catch((err) => {
              this.logger.error(
                { err, eventName: registeredInfo.eventId, triggerId, subId },
                `${logPrefix} Failed stale unregistration.`,
              );
              errorCount++;
            }),
        );
      });

      // --- 4. Wait for all operations to settle ---
      await Promise.allSettled(promises);

      this.logger.debug(
        { registered: registeredCount, unregistered: unregisteredCount, errors: errorCount },
        `${logPrefix} Synchronization finished.`,
      );

      return { registered: registeredCount, unregistered: unregisteredCount, errors: errorCount };
    }
    catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Critical error during synchronization process.`);
      // Throw error to fail the job
      throw error;
    }
  }
}
