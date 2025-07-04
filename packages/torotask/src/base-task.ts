import slugify from '@sindresorhus/slugify';
import { Job, JobSchedulerJson, Processor } from 'bullmq';
import cronstrue from 'cronstrue';
import ms from 'ms';
import type { Logger } from 'pino';
import prettyMilliseconds from 'pretty-ms';
import type { TaskGroup } from './task-group.js';
import type {
  BulkJob,
  EventSubscriptionInfo,
  RepeatOptionsWithoutKey,
  SingleOrArray,
  TaskOptions,
  TaskJobOptions,
  TaskTrigger,
  TaskTriggerEvent,
  TaskWorkerOptions,
  TaskJobData,
  TaskWorkerQueueListener,
} from './types/index.js';
import { TaskWorkerQueue } from './worker-queue.js';
import EventEmitter from 'node:events';
import { ToroTask } from './client.js';
import { convertJobOptions } from './utils/convert-job-options.js';
import { TaskJob } from './job.js'; // Import TaskJob

// Add internalId to TaskTrigger type for tracking purposes within the Task class
type InternalTaskTrigger<PayloadType> = TaskTrigger<PayloadType> & { internalId: number };
type InternalTaskTriggerEvent<PayloadType> = TaskTriggerEvent<PayloadType> & {
  internalId: number;
};

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends EventEmitter to allow for event handling.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template T The expected type of the data payload for this task's main handler.
 * @template R The expected return type of the job associated with this task's main handler.
 */
export abstract class BaseTask<
  PayloadType = any,
  ResultType = any,
  DataType extends TaskJobData<PayloadType> = TaskJobData<PayloadType>,
  TOptions extends TaskOptions = TaskOptions,
> extends EventEmitter {
  public taskClient: ToroTask;
  public jobsOptions: TaskJobOptions;
  public workerOptions: Partial<TaskWorkerOptions> | undefined;
  public queue: TaskWorkerQueue<PayloadType, ResultType>;
  public logger: Logger;
  // Store the normalized triggers with an internal ID
  public triggers: InternalTaskTrigger<PayloadType>[] = [];
  // Map for easy lookup of *current* event triggers by their internalId
  protected currentEventTriggers: Map<number, InternalTaskTriggerEvent<PayloadType>> = new Map();
  // Remove internal tracking of registered state, EventManager handles comparison
  // protected _registeredEventTriggers: Map<number, EventSubscriptionInfo> = new Map();

  constructor(
    public readonly group: TaskGroup,
    public readonly id: string,
    public options: TOptions,
    triggers: SingleOrArray<TaskTrigger<PayloadType>> | undefined,
    parentLogger?: Logger
  ) {
    if (!group) {
      throw new Error('TaskGroup instance is required.');
    }
    if (!id) {
      throw new Error('Task id is required.');
    }
    parentLogger = parentLogger || group.logger;

    const queueName = `${group.id}.${id}`;
    const logger = parentLogger.child({ taskId: id });
    super(); // Pass the calculated queueName

    this.taskClient = group.client;
    const { queueOptions, workerOptions, batch: batchOptions, ...jobsOptions } = options ?? {};

    this.queue = new TaskWorkerQueue<PayloadType, ResultType, string>(this.taskClient, queueName, {
      processor: this.process.bind(this),
      ...queueOptions,
    });

    this.logger = logger;

    this.jobsOptions = jobsOptions;
    this.workerOptions = {
      batch: batchOptions,
      ...workerOptions,
    };

    // Initialize triggers and internal maps
    this._initializeTriggers(triggers);

    // Relay events from the worker queue
    const eventNames = this.queue.eventNames(); // eventNames is (string | symbol)[]
    for (const eventNameSymbol of eventNames) {
      if (typeof eventNameSymbol === 'string') {
        const eventName = eventNameSymbol; // eventName is now a string
        // Cast eventName to the specific keyof TaskWorkerQueueListener with full generic arguments
        this.queue.on(
          eventName as keyof TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>,
          (...args: any[]) => {
            // This will now call the strongly-typed emit below
            this.emit(
              eventName as keyof TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>,
              ...(args as any) // Cast args for the strongly-typed emit
            );
          }
        );
      }
      // Symbol-based events are not relayed by this loop for now.
      // If needed, TaskWorkerQueueListener and this logic would need to account for them.
    }

    this.queue.on('worker:ready', () => {
      this.logger.debug('Task is ready. Requesting trigger synchronization...');
      // Request sync instead of running it directly
      this.requestTriggerSync().catch((err) =>
        this.logger.error({ err }, 'Error requesting initial trigger synchronization')
      );
    });
  }

  public get queueName(): string {
    return this.queue.name;
  }

  getWorkerOptions(): Partial<TaskWorkerOptions> {
    return {
      ...this.workerOptions,
    };
  }

  async run(payload: PayloadType, overrideOptions?: TaskJobOptions) {
    const finalOptions: TaskJobOptions = {
      ...this.jobsOptions,
      ...overrideOptions,
    };
    // Use id for the default job name if needed, queue handles its own naming
    return this.queue.add(this.id, payload, finalOptions);
  }

  async runMany(jobs: Omit<BulkJob, 'data'>[], overrideOptions?: TaskJobOptions) {
    const bulkJobs = jobs.map((job) => {
      return {
        ...job,
        name: job.name ?? this.id,
        options: {
          ...this.jobsOptions,
          ...(overrideOptions ?? {}),
          ...(job.options ?? {}),
        },
      };
    });

    return this.queue.addBulk(bulkJobs);
  }

  async runAndWait(
    payload: PayloadType,
    overrideOptions?: TaskJobOptions,
    state?: TaskJobOptions['state']
  ): Promise<ResultType> {
    const finalOptions: TaskJobOptions = {
      ...this.jobsOptions,
      ...overrideOptions,
    };
    // Use task id for the default job name if needed
    return this.queue._runJobAndWait(this.id, payload, finalOptions, state);
  }

  protected getJobName(job: Job): string {
    // Use task id for the default if job.name is empty or default
    return job.name === '' || job.name === '__default__' ? this.id : job.name;
  }

  protected getJobLogger(job: Job): Logger {
    const effectiveJobName = this.getJobName(job);
    // Include task id in the job logger context
    return this.logger.child({ jobId: job.id, jobName: effectiveJobName, taskId: this.id });
  }

  async process(job: TaskJob<PayloadType, ResultType, string>, token?: string): Promise<ResultType> {
    const result = await this.processJob(job, token);
    return result;
  }

  // Subclasses implement this. It receives the TaskJob from the `process` method.
  processJob(
    _job: TaskJob<PayloadType, ResultType, string>,
    _token?: string,
    _jobLogger?: Logger
  ): Promise<ResultType> {
    throw new Error('processJob method must be implemented in a subclass.');
  }

  /**
   * Requests synchronization of all trigger types via the EventManager queue.
   */

  public async requestTriggerSync(): Promise<void> {
    const logPrefix = `[Request Sync: ${this.id}]`; // Use task id in log
    this.logger.debug(`${logPrefix} Requesting trigger synchronization via EventManager.`);
    try {
      // Only need to sync event triggers via the manager
      await this._requestEventTriggerSync();
      // Cron/Every schedulers are still managed locally by this Task instance
      await this._synchronizeCronEverySchedulers();
      this.logger.debug(`${logPrefix} Synchronization request sent and local schedulers updated.`);
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Error requesting trigger synchronization.`);
      // Decide if errors should propagate
      throw error;
    }
  }

  /**
   * Synchronizes BullMQ Job Schedulers based on the task's triggers with cron/every.
   * This remains local to the Task instance.
   */
  protected async _synchronizeCronEverySchedulers(): Promise<void> {
    // Add distinct log prefix
    const logPrefix = `(Cron/Every Sync: ${this.id})`; // Use task id in log
    this.logger.debug(`${logPrefix} Starting synchronization...`);

    try {
      // 1. Get existing job schedulers potentially related to this task (CRON/EVERY only)
      const allSchedulers = await this.queue.getJobSchedulers();
      const schedulerPrefix = `trigger:`;
      const taskSchedulers = allSchedulers.filter((s: JobSchedulerJson) => s.key?.startsWith(schedulerPrefix));
      const existingSchedulerKeys = new Set(
        taskSchedulers.map((s: JobSchedulerJson) => s.key).filter(Boolean) as string[]
      );
      this.logger.debug(
        `${logPrefix} Found ${existingSchedulerKeys.size} existing cron/every job schedulers for this task.`
      );

      // 2. Process current CRON/EVERY triggers and upsert job schedulers
      const desiredSchedulerKeys = new Set<string>();
      const upsertPromises: Promise<Job | void>[] = [];

      this.triggers.forEach((trigger) => {
        // Iterate internal triggers
        if (trigger.type === 'event') {
          return; // Skip event triggers
        }

        const logSuffix = `[Trigger ${trigger.internalId}]`; // Use internalId for logging
        const repeatOpts: RepeatOptionsWithoutKey = {};
        let description = '';

        switch (trigger.type) {
          case 'cron':
            if (!trigger.cron) {
              this.logger.warn(`${logPrefix} ${logSuffix} Skipping cron trigger due to missing pattern.`);
              return;
            }
            repeatOpts.pattern = trigger.cron;
            try {
              description = cronstrue.toString(trigger.cron);
            } catch (_e) {
              description = trigger.cron;
            }
            break;
          case 'every':
            if (!trigger.every) {
              this.logger.warn(`${logPrefix} ${logSuffix} Skipping every trigger due to missing interval.`);
              return;
            }
            repeatOpts.every = typeof trigger.every === 'number' ? trigger.every : ms(trigger.every);

            if (!repeatOpts.every) {
              this.logger.warn(`${logPrefix} ${logSuffix} Skipping every trigger due to invalid 'every' value.`);
              return;
            }

            description = prettyMilliseconds(repeatOpts.every);
            break;
          default:
            this.logger.warn(`${logPrefix} ${logSuffix} Skipping trigger with unknown type: ${(trigger as any).type}`);
            return;
        }

        const slug = slugify(trigger.name || description);
        const schedulerKey = `trigger:${trigger.internalId}:${trigger.type}-${slug}`;
        desiredSchedulerKeys.add(schedulerKey);

        const jobOptions: Omit<TaskJobOptions, 'repeat' | 'jobId'> = { ...(this.jobsOptions ?? {}) };

        this.logger.debug(`${logPrefix} ${logSuffix} Upserting scheduler '${schedulerKey}'`);
        upsertPromises.push(
          this.queue.upsertJobScheduler(schedulerKey, repeatOpts, {
            name: this.id, // Use task id for the job name within the scheduler
            data: { payload: trigger.payload },
            opts: convertJobOptions(jobOptions),
          })
        );
      });

      await Promise.all(upsertPromises);
      this.logger.info(`${logPrefix} Upserted ${upsertPromises.length} cron/every schedulers.`);

      // 3. Remove obsolete job schedulers (CRON/EVERY only)
      const removePromises: Promise<boolean>[] = []; // Changed type to Promise<boolean>[]
      existingSchedulerKeys.forEach((key) => {
        if (!desiredSchedulerKeys.has(key)) {
          this.logger.info(`${logPrefix} Removing obsolete cron/every scheduler '${key}'`);
          removePromises.push(this.queue.removeJobScheduler(key));
        }
      });

      await Promise.all(removePromises);
      const removedCount = removePromises.length;
      if (removedCount > 0) {
        this.logger.info(`${logPrefix} Removed ${removedCount} obsolete cron/every schedulers.`);
      }

      this.logger.info(`${logPrefix} Cron/Every synchronization complete.`);
    } catch (error: any) {
      this.logger.error({ err: error }, `${logPrefix} Error during Cron/Every synchronization.`);
      throw error;
    }
  }

  /**
   * Collects desired event subscriptions and requests synchronization via the EventManager.
   */
  protected async _requestEventTriggerSync(): Promise<void> {
    const logPrefix = `[Event Sync Request: ${this.id}]`;
    this.logger.debug(`${logPrefix} Collecting desired event subscriptions...`);
    const manager = this.group.client.events.manager; // Access manager

    // 1. Build the list of desired subscriptions from current config
    const desiredSubscriptions: EventSubscriptionInfo[] = [];
    this.currentEventTriggers.forEach((trigger) => {
      // Ensure event field exists before pushing
      if (trigger.event) {
        desiredSubscriptions.push({
          taskGroup: this.group.id,
          taskId: this.id,
          triggerId: trigger.internalId,
          eventId: trigger.event,
          payload: trigger.payload,
        });
      } else {
        this.logger.warn(
          { triggerId: trigger.internalId },
          `${logPrefix} Skipping event trigger due to missing 'event' field.`
        );
      }
    });

    this.logger.debug(
      `${logPrefix} Found ${desiredSubscriptions.length} desired event subscriptions. Requesting sync job.`
    );

    // 2. Request the sync job via the manager
    try {
      const job = await manager.requestSync(this.group.id, this.id, desiredSubscriptions); // Use task id
      if (job) {
        this.logger.debug({ jobId: job.id }, `${logPrefix} Sync job successfully requested.`);
      } else {
        this.logger.debug(`${logPrefix} Sync job request skipped (already exists/pending).`);
      }
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Failed to request event trigger sync job.`);
      throw error; // Re-throw error to signal failure
    }
  }

  /**
   * Updates the task's default job options and triggers, then requests synchronization.
   */
  async update(options?: TOptions, triggers?: SingleOrArray<TaskTrigger<PayloadType>>): Promise<void> {
    const logPrefix = `[Task Update: ${this.id}]`; // Use task id in log
    this.logger.debug({ hasNewOptions: !!options, hasNewTriggers: !!triggers }, `${logPrefix} Starting update...`);
    let needsSyncRequest = false; // Renamed for clarity

    if (options !== undefined) {
      this.jobsOptions = options;
      this.logger.debug(`${logPrefix} Updated default job options.`);
      // Sync local cron/every schedulers immediately if options change
      await this._synchronizeCronEverySchedulers();
      needsSyncRequest = true; // Still request event sync
    }

    if (triggers !== undefined) {
      this._initializeTriggers(triggers); // Re-initializes internal maps
      this.logger.debug(
        `${logPrefix} Processed triggers. New total count: ${this.triggers.length}, Event triggers: ${this.currentEventTriggers.size}.`
      );
      needsSyncRequest = true; // Request sync if triggers changed
    }

    if (needsSyncRequest) {
      this.logger.info(`${logPrefix} Changes detected, requesting trigger synchronization...`);
      await this.requestTriggerSync(); // Request sync via EventManager
    } else {
      this.logger.debug(`${logPrefix} No changes requiring trigger synchronization request.`);
    }
    this.logger.info(`${logPrefix} Task update complete.`);
  }

  /**
   * Removes all BullMQ job schedulers (cron/every) and requests event trigger unregistration.
   */
  async removeAllTriggers(): Promise<void> {
    const logPrefix = `[Remove Triggers: ${this.id}]`; // Use task id in log
    this.logger.info(`${logPrefix} Starting removal of all triggers...`);
    const manager = this.group.client.events.manager;

    // 1. Remove Cron/Every Schedulers locally
    try {
      // Sync local schedulers to an empty state
      const currentTriggers = this.triggers; // Store current state temporarily
      this._initializeTriggers([]); // Set desired state to empty
      await this._synchronizeCronEverySchedulers(); // Syncs local queue schedulers
      this._initializeTriggers(currentTriggers); // Restore internal state if needed elsewhere
      this.logger.info(`${logPrefix} Cron/every schedulers removed via sync.`);
    } catch (error: any) {
      this.logger.error({ err: error }, `${logPrefix} Error removing cron/every schedulers.`);
      // Decide if we should still attempt event removal
      throw error; // Re-throw by default
    }

    // 2. Request EventManager to unregister all events for this task
    this.logger.info(`${logPrefix} Requesting removal of all event triggers via EventManager...`);
    try {
      // Pass empty array to signal removal
      await manager.requestSync(this.group.id, this.id, []); // Use task id
      this.logger.info(`${logPrefix} Event trigger removal requested successfully.`);
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Failed to request event trigger removal.`);
      throw error; // Re-throw
    }
  }

  /** Helper method to normalize trigger input and update internal state */
  protected _initializeTriggers(triggersInput?: SingleOrArray<TaskTrigger<PayloadType>>): void {
    const logPrefix = `[Init Triggers: ${this.id}]`; // Use task id in log
    this.logger.debug(`${logPrefix} Normalizing triggers and updating internal trigger maps...`);
    const normalizedTriggers: InternalTaskTrigger<PayloadType>[] = [];

    const inputArray = !triggersInput ? [] : Array.isArray(triggersInput) ? [...triggersInput] : [triggersInput];
    inputArray.forEach((trigger: TaskTrigger<PayloadType>, index) => {
      normalizedTriggers.push({ ...trigger, internalId: index });
    });
    this.triggers = normalizedTriggers;

    // Rebuild the internal map of current event triggers keyed by internalId
    const newEventTriggers = new Map<number, InternalTaskTriggerEvent<PayloadType>>();
    this.triggers.forEach((trigger: InternalTaskTrigger<PayloadType>) => {
      if (trigger.type === 'event') {
        // Type guard to ensure it's an event trigger before accessing 'event'
        if (trigger.event && typeof trigger.event === 'string' && trigger.event.trim() !== '') {
          newEventTriggers.set(trigger.internalId, trigger);
        } else {
          this.logger.warn(
            `${logPrefix} Trigger ${trigger.internalId} type 'event' missing valid 'event' field. Skipping.`
          );
        }
      }
    });
    this.currentEventTriggers = newEventTriggers; // Update the map of *current* event triggers

    this.logger.debug(
      `${logPrefix} Processed ${this.triggers.length} total triggers. Found ${this.currentEventTriggers.size} event triggers.`
    );

    // No longer need to clean _registeredEventTriggers here, manager handles state comparison
  }

  // --- Event Emitter Signatures ---
  // Typed to match TaskWorkerQueueListener as BaseTask relays these events.

  emit<U extends keyof TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>>(
    event: U,
    ...args: Parameters<TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>[U]>
  ): boolean {
    return super.emit(event, ...args);
  }

  on<U extends keyof TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>>(
    event: U,
    listener: TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>[U]
  ): this {
    super.on(event, listener);
    return this;
  }

  off<U extends keyof TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>>(
    event: U,
    listener: TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>[U]
  ): this {
    super.off(event, listener);
    return this;
  }

  once<U extends keyof TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>>(
    event: U,
    listener: TaskWorkerQueueListener<PayloadType, ResultType, string, DataType>[U]
  ): this {
    super.once(event, listener);
    return this;
  }

  async startWorker(options?: TaskWorkerOptions) {
    return this.queue.startWorker(options);
  }

  async stopWorker(): Promise<void> {
    return this.queue.stopWorker();
  }

  async close(): Promise<void> {
    return this.queue.close();
  }
}
