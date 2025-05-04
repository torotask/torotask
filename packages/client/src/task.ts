import { Job } from 'bullmq';
import type { Logger } from 'pino';
import { BaseTask } from './base-task.js';
import { SubTask } from './sub-task.js';
import type { TaskGroup } from './task-group.js';
import type {
  SingleOrArray,
  SubTaskHandler,
  TaskHandler,
  TaskHandlerContext,
  TaskHandlerOptions,
  TaskOptions,
  TaskTrigger,
} from './types/index.js';

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends BaseQueue to manage its own underlying BullMQ queue and worker.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template T The expected type of the data payload for this task's main handler.
 * @template R The expected return type of the job associated with this task's main handler.
 */
export class Task<T = unknown, R = unknown> extends BaseTask<T, R, TaskOptions> {
  protected readonly subTasks: Map<string, SubTask<any, any>>;
  protected readonly allowCatchAll: boolean;

  constructor(
    taskGroup: TaskGroup,
    name: string,
    options: TaskOptions | undefined,
    trigger: SingleOrArray<TaskTrigger<T>> | undefined,
    protected handler: TaskHandler<T, R>,
    groupLogger: Logger
  ) {
    super(taskGroup, name, options ?? {}, trigger, groupLogger);

    this.subTasks = new Map();
    this.allowCatchAll = this.taskOptions.allowCatchAll ?? false;

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

  /**
   * Routes the job to the appropriate handler (main task or subtask) based on job name.
   * - `__default__` or empty string routes to the main handler.
   * - Matching subtask name routes to the subtask handler.
   * - Other names route to main handler if `allowCatchAll` is true, otherwise error.
   */
  async process(job: Job, token?: string): Promise<any> {
    const { id, name: jobName } = job;
    const effectiveJobName = jobName === '' || jobName === '__default__' ? this.name : jobName;
    const jobLogger = this.logger.child({ jobId: id, jobName: effectiveJobName });

    const subTask = this.subTasks.get(effectiveJobName);

    try {
      if (subTask) {
        jobLogger.info(`Routing job to SubTask handler: ${effectiveJobName}`);
        const result = await subTask.processSubJob(job, effectiveJobName, jobLogger);
        jobLogger.info(`SubTask job completed successfully`);
        return result;
      } else if (effectiveJobName === this.name || this.allowCatchAll) {
        const result = await this.processJob(job, token);
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

  async processJob(job: Job, token?: string, jobLogger?: Logger): Promise<any> {
    jobLogger = jobLogger ?? this.getJobLogger(job);
    const typedJob = job as Job<T, R>;
    const handlerOptions: TaskHandlerOptions<T> = { id: job.id, name: this.name, data: typedJob.data };
    const handlerContext: TaskHandlerContext<T, R> = {
      logger: jobLogger,
      client: this.taskClient,
      group: this.group,
      task: this,
      job: typedJob,
      token,
      queue: this,
    };
    try {
      return await this.handler(handlerOptions, handlerContext);
    } catch (error) {
      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job processing failed for job name "${job.name}"`
      );
      throw error;
    }
  }
}
