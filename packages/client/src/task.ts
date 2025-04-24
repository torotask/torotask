import { JobsOptions, Job, Worker, WorkerOptions } from 'bullmq';
import cronstrue from 'cronstrue';
import type { Logger } from 'pino';
import prettyMilliseconds from 'pretty-ms';
import slugify from '@sindresorhus/slugify';
import { BaseQueue } from './base-queue.js';
import { SubTask } from './sub-task.js';
import type { TaskGroup } from './task-group.js';
import type {
  EventSubscriptionInfo,
  RepeatOptionsWithoutKey,
  TaskOptions,
  TaskHandlerOptions,
  TaskHandlerContext,
  TaskHandler,
  SubTaskHandlerOptions,
  SubTaskHandlerContext,
  SubTaskHandler,
  TaskTrigger,
  TaskTriggerEvent,
  SingleOrArray,
} from './types.js';

// Add internalId to TaskTrigger type for tracking purposes within the Task class
type InternalTaskTrigger<T> = TaskTrigger<T> & { internalId: number };
type InternalTaskTriggerEvent<T> = TaskTriggerEvent<T> & { internalId: number };

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends BaseQueue to manage its own underlying BullMQ queue and worker.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template T The expected type of the data payload for this task's main handler.
 * @template R The expected return type of the job associated with this task's main handler.
 */
export class Task<T = unknown, R = unknown> extends BaseQueue {
  public readonly name: string;
  public readonly group: TaskGroup;
  public defaultJobOptions: TaskOptions;
  public readonly handler: TaskHandler<T, R>;
  protected readonly subTasks: Map<string, SubTask<any, any>>;
  protected readonly allowCatchAll: boolean;
  // Store the normalized triggers with an internal ID
  public triggers: InternalTaskTrigger<T>[] = [];
  // Map for easy lookup of *current* event triggers by their internalId
  protected currentEventTriggers: Map<number, InternalTaskTriggerEvent<T>> = new Map();
  // Remove internal tracking of registered state, EventManager handles comparison
  // protected _registeredEventTriggers: Map<number, EventSubscriptionInfo> = new Map();

  constructor(
    taskGroup: TaskGroup,
    name: string,
    options: TaskOptions | undefined,
    trigger: SingleOrArray<TaskTrigger<T>> | undefined,
    handler: TaskHandler<T, R>,
    groupLogger: Logger
  ) {
    if (!taskGroup) {
      throw new Error('TaskGroup instance is required.');
    }
    if (!name) {
      throw new Error('Task name is required.');
    }
    if (!handler || typeof handler !== 'function') {
      throw new Error('Task handler is required and must be a function.');
    }

    const client = taskGroup.client;
    const queueName = `${taskGroup.name}.${name}`;
    const taskLogger = groupLogger.child({ taskName: name });

    super(client, queueName, taskLogger);

    this.group = taskGroup;
    this.name = name;
    this.handler = handler;
    this.defaultJobOptions = options ?? {};
    this.subTasks = new Map();
    this.allowCatchAll = this.defaultJobOptions.allowCatchAll ?? false;

    // Initialize triggers and internal maps
    this._initializeTriggers(trigger);

    this.on('ready', () => {
      this.logger.debug('Task is ready. Requesting trigger synchronization...');
      // Request sync instead of running it directly
      this.requestTriggerSync().catch(
        (
          err // Changed method name
        ) => this.logger.error({ err }, 'Error requesting initial trigger synchronization')
      );
    });

    this.logger.debug({ allowCatchAll: this.allowCatchAll, triggerCount: this.triggers.length }, 'Task initialized');
  }

  defineSubTask<ST = T, SR = R>(subTaskName: string, subTaskHandler: SubTaskHandler<ST, SR>): SubTask<ST, SR> {
    if (this.subTasks.has(subTaskName)) {
      this.logger.warn({ subTaskName }, 'SubTask already defined. Overwriting.');
    }
    if (subTaskName === this.name) {
      this.logger.error({ subTaskName }, 'SubTask name cannot be the same as the parent Task name.');
      throw new Error(`SubTask name "${subTaskName}" cannot be the same as the parent Task name "${this.name}".`);
    }

    const newSubTask = new SubTask<ST, SR>(this, subTaskName, subTaskHandler);
    this.subTasks.set(subTaskName, newSubTask);
    this.logger.debug({ subTaskName }, 'SubTask defined');
    return newSubTask;
  }

  getSubTask(subTaskName: string): SubTask<any, any> | undefined {
    return this.subTasks.get(subTaskName);
  }

  async run(data: T, overrideOptions?: JobsOptions): Promise<Job<T, R>> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    return this._runJob<T, R>(this.name, data, finalOptions);
  }

  async runAndWait(data: T, overrideOptions?: JobsOptions): Promise<R> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    return this._runJobAndWait<T, R>(this.name, data, finalOptions);
  }

  /**
   * Routes the job to the appropriate handler (main task or subtask) based on job name.
   * - `__default__` or empty string routes to the main handler.
   * - Matching subtask name routes to the subtask handler.
   * - Other names route to main handler if `allowCatchAll` is true, otherwise error.
   */
  async process(job: Job): Promise<any> {
    const { id, name: jobName } = job;
    const effectiveJobName = jobName === '' || jobName === '__default__' ? this.name : jobName;
    const jobLogger = this.logger.child({ jobId: id, jobName: effectiveJobName });

    const subTask = this.subTasks.get(effectiveJobName);

    try {
      if (subTask) {
        jobLogger.info(`Routing job to SubTask handler: ${effectiveJobName}`);
        const typedJob = job as Job<unknown, unknown>;
        const handlerOptions: SubTaskHandlerOptions<unknown> = { id, name: effectiveJobName, data: typedJob.data };
        const handlerContext: SubTaskHandlerContext = {
          logger: jobLogger,
          client: this.client,
          group: this.group,
          parentTask: this,
          subTaskName: subTask.name,
          job: typedJob,
          queue: this.queue,
        };
        const result = await subTask.handler(handlerOptions, handlerContext);
        jobLogger.info(`SubTask job completed successfully`);
        return result;
      } else if (effectiveJobName === this.name || this.allowCatchAll) {
        if (this.allowCatchAll && effectiveJobName !== this.name) {
          jobLogger.debug(`Routing job to main Task handler (catchAll enabled): ${effectiveJobName}`);
        } else {
          jobLogger.debug(`Routing job to main Task handler: ${effectiveJobName}`);
        }
        const typedJob = job as Job<T, R>;
        const handlerOptions: TaskHandlerOptions<T> = { id, name: this.name, data: typedJob.data };
        const handlerContext: TaskHandlerContext = {
          logger: jobLogger,
          client: this.client,
          group: this.group,
          task: this,
          job: typedJob,
          queue: this.queue,
        };
        const result = await this.handler(handlerOptions, handlerContext);
        jobLogger.debug(`Main task job completed successfully`);
        return result;
      } else {
        jobLogger.error(
          `Job name "${effectiveJobName}" does not match main task or subtasks, and catchAll is disabled.`
        );
        throw new Error(
          `Job name "${effectiveJobName}" on queue "${this.queueName}" not recognized by task "${this.name}".`
        );
      }
    } catch (error) {
      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job processing failed for job name "${effectiveJobName}"`
      );
      throw error;
    }
  }

  /**
   * Requests synchronization of all trigger types via the EventManager queue.
   */

  public async requestTriggerSync(): Promise<void> {
    const logPrefix = `[Request Sync: ${this.name}]`;
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
    const queue = this.queue;
    // Add distinct log prefix
    const logPrefix = `(Cron/Every Sync: ${this.name})`;
    this.logger.debug(`${logPrefix} Starting synchronization...`);

    try {
      // 1. Get existing job schedulers potentially related to this task (CRON/EVERY only)
      const allSchedulers = await queue.getJobSchedulers();
      const schedulerPrefix = `trigger:`;
      const taskSchedulers = allSchedulers.filter((s) => s.key?.startsWith(schedulerPrefix));
      const existingSchedulerKeys = new Set(taskSchedulers.map((s) => s.key).filter(Boolean) as string[]);
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
            if (!trigger.every || trigger.every <= 0) {
              this.logger.warn(`${logPrefix} ${logSuffix} Skipping every trigger due to invalid 'every' value.`);
              return;
            }
            repeatOpts.every = trigger.every;
            description = prettyMilliseconds(trigger.every);
            break;
          default:
            this.logger.warn(`${logPrefix} ${logSuffix} Skipping trigger with unknown type: ${(trigger as any).type}`);
            return;
        }

        const slug = slugify(trigger.name || description);
        const schedulerKey = `trigger:${trigger.internalId}:${trigger.type}-${slug}`;
        desiredSchedulerKeys.add(schedulerKey);

        const jobOptions: Omit<JobsOptions, 'repeat' | 'jobId'> = { ...(this.defaultJobOptions ?? {}) };

        this.logger.debug(`${logPrefix} ${logSuffix} Upserting scheduler '${schedulerKey}'`);
        upsertPromises.push(
          queue.upsertJobScheduler(schedulerKey, repeatOpts, {
            name: this.name,
            data: trigger.data,
            opts: jobOptions,
          })
        );
      });

      await Promise.all(upsertPromises);
      this.logger.info(`${logPrefix} Upserted ${upsertPromises.length} cron/every schedulers.`);

      // 3. Remove obsolete job schedulers (CRON/EVERY only)
      const removePromises: Promise<void>[] = [];
      existingSchedulerKeys.forEach((key) => {
        if (!desiredSchedulerKeys.has(key)) {
          this.logger.info(`${logPrefix} Removing obsolete cron/every scheduler '${key}'`);
          // @ts-expect-error Linter incorrect about return type for removeJobScheduler
          removePromises.push(queue.removeJobScheduler(key));
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
    const logPrefix = `[Event Sync Request: ${this.name}]`;
    this.logger.debug(`${logPrefix} Collecting desired event subscriptions...`);
    const manager = this.group.client.events.manager; // Access manager

    // 1. Build the list of desired subscriptions from current config
    const desiredSubscriptions: EventSubscriptionInfo[] = [];
    this.currentEventTriggers.forEach((trigger) => {
      // Ensure event field exists before pushing
      if (trigger.event) {
        desiredSubscriptions.push({
          taskGroup: this.group.name,
          taskName: this.name,
          triggerId: trigger.internalId,
          eventId: trigger.event, // Include event name
          ...(trigger.data && { data: trigger.data }),
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
      const job = await manager.requestSync(this.group.name, this.name, desiredSubscriptions);
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
  async update(options?: TaskOptions, triggers?: SingleOrArray<TaskTrigger<T>>): Promise<void> {
    const logPrefix = `[Task Update: ${this.name}]`;
    this.logger.debug({ hasNewOptions: !!options, hasNewTriggers: !!triggers }, `${logPrefix} Starting update...`);
    let needsSyncRequest = false; // Renamed for clarity

    if (options !== undefined) {
      this.defaultJobOptions = options;
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
    const logPrefix = `[Remove Triggers: ${this.name}]`;
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
      await manager.requestSync(this.group.name, this.name, []);
      this.logger.info(`${logPrefix} Event trigger removal requested successfully.`);
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Failed to request event trigger removal.`);
      throw error; // Re-throw
    }
  }

  /** Helper method to normalize trigger input and update internal state */
  protected _initializeTriggers(triggersInput?: SingleOrArray<TaskTrigger<T>>): void {
    const logPrefix = `[Init Triggers: ${this.name}]`;
    this.logger.debug(`${logPrefix} Normalizing triggers and updating internal trigger maps...`);
    const normalizedTriggers: InternalTaskTrigger<T>[] = [];

    const inputArray = !triggersInput ? [] : Array.isArray(triggersInput) ? [...triggersInput] : [triggersInput];
    inputArray.forEach((trigger, index) => {
      normalizedTriggers.push({ ...trigger, internalId: index });
    });
    this.triggers = normalizedTriggers;

    // Rebuild the internal map of current event triggers keyed by internalId
    const newEventTriggers = new Map<number, InternalTaskTriggerEvent<T>>();
    this.triggers.forEach((trigger) => {
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
}
