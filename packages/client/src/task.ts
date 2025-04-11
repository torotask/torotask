import { JobsOptions, Job, Worker, WorkerOptions } from 'bullmq';
import cronstrue from 'cronstrue';
import type { Logger } from 'pino';
import prettyMilliseconds from 'pretty-ms';
import slugify from '@sindresorhus/slugify';
import { BaseQueue } from './base-queue.js';
import { SubTask } from './sub-task.js';
import type { TaskGroup } from './task-group.js';
import type { EventDispatcher } from './event-dispatcher.js';
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
  private readonly subTasks: Map<string, SubTask<any, any>>;
  private readonly allowCatchAll: boolean;
  // Store the normalized triggers with an internal ID
  public triggers: InternalTaskTrigger<T>[] = [];
  // Map for easy lookup of *current* event triggers by their internalId
  private currentEventTriggers: Map<number, InternalTaskTriggerEvent<T>> = new Map();
  // Map to track successfully registered event triggers (internalId -> subscriptionInfo)
  private _registeredEventTriggers: Map<number, EventSubscriptionInfo> = new Map();

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

        this.logger.info(`${logPrefix} ${logSuffix} Upserting scheduler '${schedulerKey}'`);
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
      throw error;
    }
  }

  /**
   * Synchronizes event trigger registrations with the EventDispatcher.
   * Compares current event triggers with the previously registered state and
   * calls register/unregister on the dispatcher as needed.
   */
  private async _synchronizeEventTriggers(): Promise<void> {
    const logPrefix = `[Event Sync: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting event trigger synchronization...`);
    const dispatcher = this.group.client.eventDispatcher;
    const registrationPromises: Promise<void>[] = [];
    const unregistrationPromises: Promise<void>[] = [];

    // --- Registration ---
    const triggersToRegister = new Map<number, EventSubscriptionInfo>();
    this.currentEventTriggers.forEach((trigger) => {
      // Iterate current event triggers map
      const triggerId = trigger.internalId;
      if (!this._registeredEventTriggers.has(triggerId)) {
        // Check if NOT already registered
        const eventName = trigger.event; // Use 'event' field
        this.logger.debug({ eventName, triggerId }, `${logPrefix} Found event trigger to register.`);
        const subscriptionInfo: EventSubscriptionInfo = {
          taskGroup: this.group.name,
          taskName: this.name,
          triggerId: triggerId,
          ...(trigger.data && { data: trigger.data }), // Include optional data
        };
        triggersToRegister.set(triggerId, subscriptionInfo);
        registrationPromises.push(dispatcher.registerTaskEvent(eventName!, subscriptionInfo));
      }
    });

    if (registrationPromises.length > 0) {
      this.logger.info(`${logPrefix} Attempting to register ${registrationPromises.length} event triggers...`);
      try {
        const results = await Promise.allSettled(registrationPromises);
        let successfulRegistrations = 0;
        results.forEach((result, index) => {
          const triggerId = Array.from(triggersToRegister.keys())[index];
          const info = triggersToRegister.get(triggerId)!;
          if (result.status === 'fulfilled') {
            this.logger.info(
              { eventName: info.eventId, triggerId },
              `${logPrefix} Successfully registered event trigger.`
            );
            this._registeredEventTriggers.set(triggerId, info); // Track successful registration
            successfulRegistrations++;
          } else {
            this.logger.error(
              { err: result.reason, eventName: info.eventId, triggerId },
              `${logPrefix} Failed to register event trigger.`
            );
          }
        });
        this.logger.info(
          `${logPrefix} Registration phase complete. ${successfulRegistrations}/${registrationPromises.length} successful.`
        );
      } catch (error) {
        this.logger.error({ err: error }, `${logPrefix} Unexpected error during event trigger registration batch.`);
      }
    } else {
      this.logger.info(`${logPrefix} No new event triggers found to register.`);
    }

    // --- Unregistration ---
    const triggersToUnregister = new Map<number, EventSubscriptionInfo>();
    this._registeredEventTriggers.forEach((info, triggerId) => {
      if (!this.currentEventTriggers.has(triggerId)) {
        // Check if previously registered trigger is NO LONGER current
        this.logger.debug(
          { eventName: info.eventId, triggerId },
          `${logPrefix} Found stale event trigger to unregister.`
        );
        triggersToUnregister.set(triggerId, info);
        // Assuming info.eventId holds the original event name needed for unregistration
        unregistrationPromises.push(
          dispatcher.unregisterTaskEvent(info.eventId!, info) // Pass full info needed by dispatcher
        );
      }
    });

    if (unregistrationPromises.length > 0) {
      this.logger.info(
        `${logPrefix} Attempting to unregister ${unregistrationPromises.length} stale event triggers...`
      );
      try {
        const results = await Promise.allSettled(unregistrationPromises);
        let successfulUnregistrations = 0;
        results.forEach((result, index) => {
          const triggerId = Array.from(triggersToUnregister.keys())[index];
          const info = triggersToUnregister.get(triggerId)!;
          if (result.status === 'fulfilled') {
            this.logger.info(
              { eventName: info.eventId, triggerId },
              `${logPrefix} Successfully unregistered stale event trigger.`
            );
            this._registeredEventTriggers.delete(triggerId); // Remove from tracking on success
            successfulUnregistrations++;
          } else {
            this.logger.error(
              { err: result.reason, eventName: info.eventId, triggerId },
              `${logPrefix} Failed to unregister stale event trigger.`
            );
            // Keep in _registeredEventTriggers map to retry next time? Or handle differently?
          }
        });
        this.logger.info(
          `${logPrefix} Unregistration phase complete. ${successfulUnregistrations}/${unregistrationPromises.length} successful.`
        );
      } catch (error) {
        this.logger.error({ err: error }, `${logPrefix} Unexpected error during event trigger unregistration batch.`);
      }
    } else {
      this.logger.info(`${logPrefix} No stale event triggers found to unregister.`);
    }

    this.logger.info(`${logPrefix} Event trigger synchronization complete.`);
  }

  /**
   * Updates the task's default job options and triggers.
   */
  async update(options?: TaskOptions, triggers?: SingleOrArray<TaskTrigger<T>>): Promise<void> {
    const logPrefix = `[Task Update: ${this.name}]`;
    this.logger.info({ hasNewOptions: !!options, hasNewTriggers: !!triggers }, `${logPrefix} Starting update...`);
    let needsTriggerSync = false;
    if (options !== undefined) {
      this.defaultJobOptions = options;
      this.logger.info(`${logPrefix} Updated default job options.`);
      needsTriggerSync = true;
    }
    if (triggers !== undefined) {
      this._initializeTriggers(triggers); // Re-initializes internal maps and cleans _registeredEventTriggers map
      this.logger.info(
        `${logPrefix} Processed triggers. New total count: ${this.triggers.length}, Event triggers: ${this.currentEventTriggers.size}.`
      );
      needsTriggerSync = true;
    }
    if (needsTriggerSync) {
      this.logger.info(`${logPrefix} Changes detected, synchronizing triggers...`);
      await this.synchronizeTriggers();
    } else {
      this.logger.info(`${logPrefix} No changes requiring trigger synchronization.`);
    }
    this.logger.info(`${logPrefix} Task update complete.`);
  }

  /**
   * Removes all BullMQ job schedulers (cron/every) and attempts to unregister event triggers.
   * Note: Event unregistration relies on the current state before clearing.
   */
  async removeAllTriggers(): Promise<void> {
    const logPrefix = `[Remove Triggers: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting removal of all triggers...`);
    // Create a temporary empty trigger list to sync against
    //const originalTriggers = this.triggers;
    this._initializeTriggers([]); // Clear internal trigger state temporarily

    try {
      // Syncing against empty state should remove/unregister everything
      await this.synchronizeTriggers();
      this.logger.info(`${logPrefix} All trigger types synchronized to empty state.`);
    } catch (error) {
      this.logger.error({ err: error }, `${logPrefix} Error during trigger removal synchronization.`);
      // Restore original triggers if removal sync failed? Or leave empty?
      // For now, leave empty, assuming close/shutdown follows.
      throw error; // Re-throw the error
    } finally {
      // Optional: Restore original trigger list if needed, though likely closing after this.
      // this._initializeTriggers(originalTriggers);
      // Clear the registered map as we attempted removal
      this._registeredEventTriggers.clear();
    }
  }

  /** Helper method to normalize trigger input and update internal state */
  private _initializeTriggers(triggersInput?: SingleOrArray<TaskTrigger<T>>): void {
    const logPrefix = `[Init Triggers: ${this.name}]`;
    this.logger.debug(`${logPrefix} Normalizing triggers and updating internal trigger maps...`);
    const normalizedTriggers: InternalTaskTrigger<T>[] = [];

    // 1. Normalize input and assign internalId
    const inputArray = !triggersInput ? [] : Array.isArray(triggersInput) ? [...triggersInput] : [triggersInput];
    inputArray.forEach((trigger, index) => {
      normalizedTriggers.push({ ...trigger, internalId: index }); // Assign index as internalId
    });
    this.triggers = normalizedTriggers; // Store normalized triggers with internalId

    // 2. Rebuild the internal map of current event triggers keyed by internalId
    const newEventTriggers = new Map<number, InternalTaskTriggerEvent<T>>();
    this.triggers.forEach((trigger) => {
      if (trigger.type === 'event') {
        if (!trigger.event || typeof trigger.event !== 'string' || trigger.event.trim() === '') {
          this.logger.warn(
            `${logPrefix} Trigger ${trigger.internalId} has type 'event' but is missing 'event' field. Skipping.`
          );
          return;
        }
        newEventTriggers.set(trigger.internalId, trigger);
      }
    });
    this.currentEventTriggers = newEventTriggers; // Update the map of *current* event triggers

    this.logger.debug(
      `${logPrefix} Processed ${this.triggers.length} total triggers. Found ${this.currentEventTriggers.size} event triggers.`
    );

    // 3. Clean up registered state for triggers that no longer exist in the input
    const currentTriggerIds = new Set(this.triggers.map((t) => t.internalId));
    const triggersToRemoveFromTracking = new Map<number, EventSubscriptionInfo>();
    for (const [id, info] of this._registeredEventTriggers.entries()) {
      if (!currentTriggerIds.has(id)) {
        // This trigger ID was previously registered but is no longer in the current config
        triggersToRemoveFromTracking.set(id, info);
      }
    }

    // Remove stale entries from the *tracking* map immediately.
    // The actual unregistration call happens in _synchronizeEventTriggers.
    triggersToRemoveFromTracking.forEach((info, id) => {
      this._registeredEventTriggers.delete(id);
      this.logger.debug(
        `${logPrefix} Removed stale trigger registration tracking for internalId: ${id}, event: ${info.eventId}`
      );
    });
    if (triggersToRemoveFromTracking.size > 0) {
      this.logger.info(
        `${logPrefix} Marked ${triggersToRemoveFromTracking.size} previously registered event triggers as stale.`
      );
    }
  }
}
