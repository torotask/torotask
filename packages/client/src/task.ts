import { JobsOptions, Job, Worker, WorkerOptions } from 'bullmq';
import cronstrue from 'cronstrue';
import type { Logger } from 'pino';
import prettyMilliseconds from 'pretty-ms';
import slugify from '@sindresorhus/slugify';
import { BaseQueue } from './base-queue.js';
import { SubTask } from './sub-task.js';
import type { TaskGroup } from './task-group.js';
import type {
  RepeatOptionsWithoutKey,
  TaskOptions,
  TaskHandlerOptions,
  TaskHandlerContext,
  TaskHandler,
  SubTaskHandlerOptions,
  SubTaskHandlerContext,
  SubTaskHandler,
  TaskTrigger,
  SingleOrArray,
} from './types.js';

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
  private readonly subTasks: Map<string, SubTask<any, any>>;
  private readonly allowCatchAll: boolean;
  public triggers: TaskTrigger<T>[] = [];
  private currentEventTriggers: Map<string, TaskTrigger<T>> = new Map();

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

    this._initializeTriggers(trigger);
    this.on('ready', () => {
      this.logger.info('Task is ready. Synchronizing triggers...');
      this.synchronizeTriggers().catch((err) =>
        this.logger.error({ err }, 'Error during initial trigger synchronization')
      );
    });

    this.logger.info({ allowCatchAll: this.allowCatchAll, triggerCount: this.triggers.length }, 'Task initialized');
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
    this.logger.info({ subTaskName }, 'SubTask defined');
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
          jobLogger.info(`Routing job to main Task handler (catchAll enabled): ${effectiveJobName}`);
        } else {
          jobLogger.info(`Routing job to main Task handler: ${effectiveJobName}`);
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
        jobLogger.info(`Main task job completed successfully`);
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
   * Orchestrates the synchronization of all trigger types (cron/every schedulers and event registrations).
   */
  public async synchronizeTriggers(): Promise<void> {
    const logPrefix = `[Trigger Sync: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting full trigger synchronization...`);
    try {
      // Run sync operations concurrently
      await Promise.all([this._synchronizeCronEverySchedulers(), this._synchronizeEventTriggers()]);
      this.logger.info(`${logPrefix} Full trigger synchronization complete.`);
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Error during full trigger synchronization.`);
      // Decide if errors from individual syncs should propagate here or be handled within them
      throw error; // Re-throw by default
    }
  }

  /**
   * Synchronizes BullMQ Job Schedulers based on the task's triggers with cron/every.
   * (Previously synchronizeSchedulers)
   */
  private async _synchronizeCronEverySchedulers(): Promise<void> {
    const queue = this.queue;
    // Add distinct log prefix
    const logPrefix = `[Cron/Every Sync: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting synchronization...`);

    try {
      // 1. Get existing job schedulers potentially related to this task (CRON/EVERY only)
      const allSchedulers = await queue.getJobSchedulers();
      const schedulerPrefix = `trigger:`;
      const taskSchedulers = allSchedulers.filter((s) => s.key?.startsWith(schedulerPrefix));
      const existingSchedulerKeys = new Set(taskSchedulers.map((s) => s.key).filter(Boolean) as string[]);
      this.logger.info(
        `${logPrefix} Found ${existingSchedulerKeys.size} existing cron/every job schedulers for this task.`
      );

      // 2. Process current CRON/EVERY triggers and upsert job schedulers
      const desiredSchedulerKeys = new Set<string>();
      const upsertPromises: Promise<Job | void>[] = [];

      this.triggers.forEach((trigger, index) => {
        if (trigger.type === 'event') {
          return; // Skip event triggers
        }

        const logSuffix = `[Trigger ${index}]`;
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
        const schedulerKey = `trigger:${index}:${trigger.type}-${slug}`;
        desiredSchedulerKeys.add(schedulerKey);

        const jobOptions: Omit<JobsOptions, 'repeat' | 'jobId'> = { ...(this.defaultJobOptions ?? {}) };

        this.logger.info(
          `${logPrefix} ${logSuffix} Upserting scheduler '${schedulerKey}' with repeat: ${JSON.stringify(repeatOpts)}`
        );
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

      this.logger.info(`${logPrefix} Synchronization complete.`);
    } catch (error: any) {
      this.logger.error({ err: error }, `${logPrefix} Error during synchronization.`);
      throw error; // Re-throw
    }
  }

  /**
   * Synchronizes event trigger registrations with the EventDispatcher.
   * Compares current event triggers with the previously registered state (if tracked)
   * and calls register/unregister on the dispatcher as needed.
   */
  private async _synchronizeEventTriggers(): Promise<void> {
    const logPrefix = `[Event Sync: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting event trigger synchronization...`);

    // TODO: Implement the core logic:
    // 1. Get the current desired state (this.currentEventTriggers map).
    // 2. Get the previously registered state (Need a way to track this, maybe another map `this.registeredEventTriggers`).
    // 3. Compare the two states:
    //    - Find triggers to register (in desired, not in registered).
    //    - Find triggers to unregister (in registered, not in desired).
    // 4. Call `this.group.client.eventDispatcher.registerTaskEvent(eventName, this, triggerId)` for new ones.
    // 5. Call `this.group.client.eventDispatcher.unregisterTaskEvent(eventName, this, triggerId)` for removed ones.
    // 6. Update the `this.registeredEventTriggers` map to reflect the new state.
    // 7. Handle potential errors during registration/unregistration.

    try {
      // Placeholder implementation
      this.logger.debug(`${logPrefix} Current event triggers map size: ${this.currentEventTriggers.size}`);
      // --- Example placeholder logic ---
      // const dispatcher = this.group.client.eventDispatcher;
      // const previousTriggers = this.registeredEventTriggers; // Assuming this exists
      // const currentTriggers = this.currentEventTriggers;
      // // ... comparison logic ...
      // await Promise.all([ ... register calls ..., ... unregister calls ... ]);
      // this.registeredEventTriggers = new Map(currentTriggers); // Update tracked state
      // --- End Example ---

      this.logger.info(`${logPrefix} Event trigger synchronization complete (Placeholder).`);
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Error during synchronization.`);
      throw error; // Re-throw
    }
  }

  /**
   * Updates the task's default job options and triggers.
   * After updating, it re-synchronizes the BullMQ job schedulers.
   * @param options New default job options (optional).
   * @param triggers New triggers (optional). Replaces existing triggers.
   */
  async update(options?: TaskOptions, triggers?: SingleOrArray<TaskTrigger<T>>): Promise<void> {
    const logPrefix = `[Task Update: ${this.name}]`;
    this.logger.info({ hasNewOptions: !!options, hasNewTriggers: !!triggers }, `${logPrefix} Starting update...`);

    let needsTriggerSync = false;

    // Update default job options if provided
    if (options !== undefined) {
      this.defaultJobOptions = options;
      this.logger.info(`${logPrefix} Updated default job options.`);
      // Options update might affect scheduled jobs, safer to sync triggers if options change
      needsTriggerSync = true;
    }

    // Update triggers if provided
    if (triggers !== undefined) {
      this._initializeTriggers(triggers); // Normalize triggers and update internal state
      this.logger.info(
        `${logPrefix} Processed triggers. New total count: ${this.triggers.length}, Event triggers: ${this.currentEventTriggers.size}.`
      );
      needsTriggerSync = true; // Always sync if triggers explicitly change
    }

    // Perform synchronization if needed
    if (needsTriggerSync) {
      this.logger.info(`${logPrefix} Changes detected, synchronizing triggers...`);
      await this.synchronizeTriggers(); // Call the main sync method
    } else {
      this.logger.info(`${logPrefix} No changes requiring trigger synchronization.`);
    }

    this.logger.info(`${logPrefix} Task update complete.`);
  }

  /**
   * Removes all BullMQ job schedulers (cron/every) and event trigger registrations
   * associated with this task.
   */
  async removeAllTriggers(): Promise<void> {
    const logPrefix = `[Remove Triggers: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting removal of all triggers (schedulers and event registrations)...`);
    let schedulerError: Error | null = null;
    let eventError: Error | null = null;

    // 1. Remove Cron/Every Schedulers (Using the private method)
    try {
      await this._synchronizeCronEverySchedulers(); // Syncing with empty desired state removes all
      this.logger.info(`${logPrefix} Cron/every schedulers removed via sync.`);
    } catch (error: any) {
      this.logger.error({ err: error }, `${logPrefix} Error removing cron/every schedulers.`);
      schedulerError = error instanceof Error ? error : new Error(String(error));
    }

    // 2. Unregister Event Triggers
    try {
      // TODO: Implement logic to call unregisterTaskEvent for all currentEventTriggers
      // Example:
      // const dispatcher = this.group.client.eventDispatcher;
      // const unregisterPromises = [];
      // for (const [eventName, trigger] of this.currentEventTriggers.entries()) {
      //    // Assuming trigger object has an id or we use index as id
      //    const triggerId = trigger.id || /* get index */;
      //    unregisterPromises.push(dispatcher.unregisterTaskEvent(eventName, this, triggerId));
      // }
      // await Promise.allSettled(unregisterPromises);
      // this.currentEventTriggers.clear(); // Clear internal map
      this.logger.info(`${logPrefix} Event trigger registrations cleared (Placeholder).`);
    } catch (error: any) {
      this.logger.error({ err: error }, `${logPrefix} Error unregistering event triggers.`);
      eventError = error instanceof Error ? error : new Error(String(error));
    }

    this.logger.info(`${logPrefix} Trigger removal process finished.`);

    // Rethrow if any part failed
    if (schedulerError || eventError) {
      const combinedMessage = [
        schedulerError ? `Scheduler removal error: ${schedulerError.message}` : '',
        eventError ? `Event unregistration error: ${eventError.message}` : '',
      ]
        .filter(Boolean)
        .join('; ');
      throw new Error(combinedMessage || 'Unknown error during trigger removal.');
    }
  }

  /** Helper method to normalize trigger input and update internal state */
  private _initializeTriggers(triggersInput?: SingleOrArray<TaskTrigger<T>>): void {
    const logPrefix = `[Init Triggers: ${this.name}]`;
    this.logger.debug(`${logPrefix} Normalizing triggers and updating internal event trigger map...`);

    // 1. Normalize input to this.triggers array
    if (!triggersInput) {
      this.triggers = [];
    } else if (Array.isArray(triggersInput)) {
      this.triggers = [...triggersInput];
    } else {
      this.triggers = [triggersInput];
    }

    // 2. Update the internal map of current event triggers based on the normalized array
    const newEventTriggers = new Map<string, TaskTrigger<T>>();
    this.triggers.forEach((trigger, index) => {
      // Use index as a potential triggerId if none provided
      if (trigger.type === 'event') {
        if (!trigger.event || typeof trigger.event !== 'string' || trigger.event.trim() === '') {
          this.logger.warn(`${logPrefix} Trigger ${index} has type 'event' but is missing a valid 'name'. Skipping.`);
          return;
        }
        const eventName = trigger.event.trim();
        if (newEventTriggers.has(eventName)) {
          // If allowing multiple triggers for the same event, this check needs adjustment
          // For now, assume last one wins for simplicity, but log warning
          this.logger.warn(
            `${logPrefix} Duplicate event trigger name "${eventName}" found (Trigger ${index}). Overwriting previous definition in internal map.`
          );
        }
        // Store the trigger definition itself, keyed by event name
        // We might need a different structure if multiple triggers per event are allowed
        // e.g., Map<string, TaskTrigger<T>[]> or Map<string, Map<number, TaskTrigger<T>>>
        newEventTriggers.set(eventName, trigger);
      }
    });
    this.currentEventTriggers = newEventTriggers; // Update the task's internal tracking map

    this.logger.debug(
      `${logPrefix} Processed ${this.triggers.length} total triggers. Found ${this.currentEventTriggers.size} unique event triggers to manage.`
    );
  }
}
