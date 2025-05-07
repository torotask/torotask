import type { Logger, P } from 'pino';
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
import { TaskJob } from './job.js';

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends BaseQueue to manage its own underlying BullMQ queue and worker.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template T The expected type of the data payload for this task's main handler.
 * @template R The expected return type of the job associated with this task's main handler.
 */
export class Task<PayloadType = any, ResultType = unknown> extends BaseTask<PayloadType, ResultType, TaskOptions> {
  protected readonly subTasks: Map<string, SubTask<any, any>>;
  protected readonly allowCatchAll: boolean;

  constructor(
    taskGroup: TaskGroup,
    name: string,
    options: TaskOptions | undefined,
    trigger: SingleOrArray<TaskTrigger<PayloadType>> | undefined,
    protected handler: TaskHandler<PayloadType, ResultType>,
    groupLogger: Logger
  ) {
    super(taskGroup, name, options ?? {}, trigger, groupLogger);

    this.subTasks = new Map();
    this.allowCatchAll = this.taskOptions.allowCatchAll ?? true;

    this.logger.debug({ allowCatchAll: this.allowCatchAll, triggerCount: this.triggers.length }, 'Task initialized');
  }

  defineSubTask<SubTaskPayloadType = PayloadType, SubTaskResultType = ResultType>(
    subTaskName: string,
    subTaskHandler: SubTaskHandler<SubTaskPayloadType, SubTaskResultType>
  ): SubTask<SubTaskPayloadType, SubTaskResultType> {
    if (this.subTasks.has(subTaskName)) {
      this.logger.warn({ subTaskName }, 'SubTask already defined. Overwriting.');
    }
    if (subTaskName === this.taskName) {
      this.logger.error({ subTaskName }, 'SubTask name cannot be the same as the parent Task name.');
      throw new Error(`SubTask name "${subTaskName}" cannot be the same as the parent Task name "${this.taskName}".`);
    }

    const newSubTask = new SubTask<SubTaskPayloadType, SubTaskResultType>(this, subTaskName, subTaskHandler);
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
  async process(job: TaskJob<PayloadType, ResultType>, token?: string): Promise<any> {
    const { id, name: jobName } = job;
    const effectiveJobName = jobName === '' || jobName === '__default__' ? this.taskName : jobName;
    const jobLogger = this.logger.child({ jobId: id, jobName: effectiveJobName });

    const subTask = this.subTasks.get(effectiveJobName);

    try {
      if (subTask) {
        jobLogger.info(`Routing job to SubTask handler: ${effectiveJobName}`);
        const result = await subTask.processSubJob(job, effectiveJobName, jobLogger);
        jobLogger.info(`SubTask job completed successfully`);
        return result;
      } else if (effectiveJobName === this.taskName || this.allowCatchAll) {
        const result = await this.processJob(job, token);
        jobLogger.debug(`Main task job completed successfully`);
        return result;
      } else {
        jobLogger.error(
          `Job name "${effectiveJobName}" does not match main task or subtasks, and catchAll is disabled.`
        );
        throw new Error(
          `Job name "${effectiveJobName}" on queue "${this.queueName}" not recognized by task "${this.taskName}".`
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

  async processJob(job: TaskJob<PayloadType, ResultType>, token?: string, jobLogger?: Logger): Promise<any> {
    jobLogger = jobLogger ?? this.getJobLogger(job);
    const handlerOptions: TaskHandlerOptions<PayloadType> = {
      id: job.id,
      name: this.taskName,
      payload: job.payload as any,
    };
    const handlerContext: TaskHandlerContext<PayloadType, ResultType> = {
      logger: jobLogger,
      client: this.taskClient,
      group: this.group,
      task: this,
      job: job,
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
