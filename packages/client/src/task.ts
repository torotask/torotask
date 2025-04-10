import { JobsOptions, Job, Worker, WorkerOptions } from 'bullmq';
import { BaseQueue } from './base-queue.js';
import { SubTask } from './sub-task.js';
import type { TaskGroup } from './task-group.js';
import type { Logger } from 'pino';
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
} from './types.js';
import { randomUUID } from 'crypto';
import type { ToroTaskClient } from './client.js';

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

  constructor(
    taskGroup: TaskGroup,
    name: string,
    options: TaskOptions | undefined,
    triggerOrTriggers: TaskTrigger<T> | TaskTrigger<T>[] | undefined,
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

    this._initializeTriggers(triggerOrTriggers);
    this.on('ready', () => {
      this.logger.info('Task is ready. Synchronizing schedulers...');
      this.synchronizeSchedulers();
    });

    this.logger.info(
      { allowCatchAll: this.allowCatchAll, triggerCount: this.triggers.length },
      'Task initialized (extending BaseQueue)'
    );
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
   * Synchronizes BullMQ Job Schedulers based on the task's triggers with cron/every.
   * Uses queue.upsertJobScheduler() and queue.removeJobScheduler().
   */
  async synchronizeSchedulers(): Promise<void> {
    const queue = this.queue;
    const logPrefix = `[Scheduler Sync: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting synchronization...`);

    try {
      // 1. Get existing job schedulers potentially related to this task
      const allSchedulers = await queue.getJobSchedulers();
      const prefix = `${this.name}:trigger:`;
      const taskSchedulers = allSchedulers.filter((s) => s.id?.startsWith(prefix));
      const existingSchedulerIds = new Set(taskSchedulers.map((s) => s.id).filter(Boolean) as string[]);
      this.logger.info(`${logPrefix} Found ${existingSchedulerIds.size} existing job schedulers for this task.`);

      // 2. Process current triggers and upsert job schedulers
      const desiredSchedulerIds = new Set<string>();
      const upsertPromises: Promise<Job | void>[] = [];

      this.triggers.forEach((trigger, index) => {
        const hasCron = typeof trigger.cron === 'string' && trigger.cron.length > 0;
        const hasEvery = typeof trigger.every === 'number' && trigger.every > 0;

        if (hasCron || hasEvery) {
          const schedulerId = `${this.name}:trigger:${index}`;
          desiredSchedulerIds.add(schedulerId);

          const repeatOpts: RepeatOptionsWithoutKey = {};
          if (hasCron) {
            repeatOpts.pattern = trigger.cron;
          } else if (hasEvery) {
            repeatOpts.every = trigger.every;
          } else {
            this.logger.warn(`${logPrefix} Trigger ${index} has invalid cron/every. Skipping.`);
            return;
          }

          const jobOptions: Omit<JobsOptions, 'repeat' | 'jobId'> = {
            removeOnComplete: true,
            removeOnFail: true,
            ...(this.defaultJobOptions ?? {}),
          };

          this.logger.info(
            `${logPrefix} Upserting scheduler '${schedulerId}' with repeat: ${JSON.stringify(repeatOpts)}`
          );

          // Cast queue to any to bypass persistent incorrect linter error about argument count
          upsertPromises.push(
            queue.upsertJobScheduler(schedulerId, repeatOpts, {
              name: this.name,
              data: trigger.data,
              opts: jobOptions,
            })
          );
        }
      });

      await Promise.all(upsertPromises);
      this.logger.info(`${logPrefix} Upserted ${upsertPromises.length} schedulers.`);

      // 3. Remove obsolete job schedulers
      const removePromises: Promise<void>[] = [];
      existingSchedulerIds.forEach((id) => {
        if (!desiredSchedulerIds.has(id)) {
          this.logger.info(`${logPrefix} Removing obsolete scheduler '${id}'`);
          // @ts-ignore - Linter incorrect about return type for removeJobScheduler
          removePromises.push(queue.removeJobScheduler(id));
        }
      });

      await Promise.all(removePromises);
      const removedCount = removePromises.length;
      if (removedCount > 0) {
        this.logger.info(`${logPrefix} Removed ${removedCount} obsolete schedulers.`);
      }

      this.logger.info(`${logPrefix} Synchronization complete.`);
    } catch (error: any) {
      this.logger.error(`${logPrefix} Error during scheduler synchronization: ${error?.message || error}`, error);
    }
  }

  /**
   * Updates the task's default job options and triggers.
   * After updating, it re-synchronizes the BullMQ job schedulers.
   * @param options New default job options (optional).
   * @param triggerOrTriggers New triggers (optional). Replaces existing triggers.
   */
  async update(options?: TaskOptions, triggerOrTriggers?: TaskTrigger<T> | TaskTrigger<T>[]): Promise<void> {
    this.logger.info({ hasNewOptions: !!options, hasNewTriggers: !!triggerOrTriggers }, 'Updating task...');

    // Update default job options if provided (should work now)
    if (options !== undefined) {
      this.defaultJobOptions = options;
      this.logger.info('Updated default job options.');
    }

    // Update triggers if provided (should work now)
    if (triggerOrTriggers !== undefined) {
      this._initializeTriggers(triggerOrTriggers);
      this.logger.info(`Updated triggers. New count: ${this.triggers.length}.`);
      this.logger.info('Re-synchronizing schedulers due to trigger update...');
      await this.synchronizeSchedulers();
    } else {
      if (options !== undefined) {
        this.logger.info('Only options updated, triggers remain unchanged. No scheduler sync needed.');
      }
    }

    this.logger.info('Task update complete.');
  }

  /**
   * Removes all BullMQ job schedulers associated with this task.
   * Useful when dynamically removing or disabling a task.
   */
  async removeAllSchedulers(): Promise<void> {
    const queue = this.queue;
    const logPrefix = `[Remove Schedulers: ${this.name}]`;
    this.logger.info(`${logPrefix} Starting removal of all schedulers...`);

    try {
      const allSchedulers = await queue.getJobSchedulers();
      const prefix = `${this.name}:trigger:`;
      const taskSchedulers = allSchedulers.filter((s) => s.id?.startsWith(prefix));
      const schedulerIdsToRemove = taskSchedulers.map((s) => s.id).filter(Boolean) as string[];

      if (schedulerIdsToRemove.length === 0) {
        this.logger.info(`${logPrefix} No schedulers found for this task to remove.`);
        return;
      }

      this.logger.info(`${logPrefix} Found ${schedulerIdsToRemove.length} schedulers to remove.`);

      const removePromises: Promise<boolean | void>[] = schedulerIdsToRemove.map((id) => {
        this.logger.info(`${logPrefix} Removing scheduler '${id}'`);
        // @ts-ignore - Linter incorrect about return type for removeJobScheduler
        return queue.removeJobScheduler(id);
      });

      await Promise.all(removePromises);
      this.logger.info(`${logPrefix} Successfully removed ${removePromises.length} schedulers.`);
    } catch (error: any) {
      this.logger.error(`${logPrefix} Error removing schedulers: ${error?.message || error}`, error);
      // Re-throw or handle as needed
      throw error;
    }
  }

  /** Helper method to normalize and set triggers */
  private _initializeTriggers(triggerOrTriggers?: TaskTrigger<T> | TaskTrigger<T>[]): void {
    if (!triggerOrTriggers) {
      this.triggers = [];
    } else if (Array.isArray(triggerOrTriggers)) {
      this.triggers = triggerOrTriggers;
    } else {
      this.triggers = [triggerOrTriggers];
    }
  }
}
