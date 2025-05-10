import { DelayedError, WaitingChildrenError } from 'bullmq';
import type { Logger, P } from 'pino';
import { z, type ZodSchema } from 'zod';
import { BaseTask } from './base-task.js';
import { SubTask } from './sub-task.js';
import type { TaskGroup } from './task-group.js';
import type {
  SubTaskHandler,
  TaskDefinition,
  TaskHandler,
  TaskHandlerContext,
  TaskHandlerOptions,
  TaskOptions,
  TaskJobData,
} from './types/index.js';
import { TaskJob } from './job.js';
import { StepExecutor } from './step-executor.js';

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends BaseQueue to manage its own underlying BullMQ queue and worker.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template T The expected type of the data payload for this task's main handler.
 * @template R The expected return type of the job associated with this task's main handler.
 */
export class Task<PayloadType = any, ResultType = unknown> extends BaseTask<
  PayloadType,
  ResultType,
  string, // NameType
  TaskJobData<PayloadType>, // DataType
  TaskOptions // TOptions
> {
  protected readonly subTasks: Map<string, SubTask<any, any>>;
  protected readonly allowCatchAll: boolean;
  protected handler: TaskHandler<PayloadType, ResultType>;
  public readonly schema: ZodSchema<PayloadType> | undefined;

  constructor(taskGroup: TaskGroup, config: TaskDefinition<PayloadType, ResultType>, groupLogger: Logger) {
    super(taskGroup, config.name, config.options ?? {}, config.triggers, groupLogger);

    this.handler = config.handler;
    this.schema = config.schema;
    this.subTasks = new Map();
    this.allowCatchAll = this.options.allowCatchAll ?? true;

    this.logger.debug({ allowCatchAll: this.allowCatchAll, triggerCount: this.triggers.length }, 'Task initialized');
  }

  defineSubTask<SubTaskPayloadType = PayloadType, SubTaskResultType = ResultType>(
    subTaskName: string,
    subTaskHandler: SubTaskHandler<SubTaskPayloadType, SubTaskResultType>
  ): SubTask<SubTaskPayloadType, SubTaskResultType> {
    if (this.subTasks.has(subTaskName)) {
      this.logger.warn({ subTaskName }, 'SubTask already defined. Overwriting.');
    }
    if (subTaskName === this.name) {
      this.logger.error({ subTaskName }, 'SubTask name cannot be the same as the parent Task name.');
      throw new Error(`SubTask name "${subTaskName}" cannot be the same as the parent Task name "${this.name}".`);
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
    } catch (error: any) {
      if (
        error instanceof DelayedError ||
        error.name == 'DelayedError' ||
        error instanceof WaitingChildrenError ||
        error.name == 'WaitingChildrenError'
      ) {
        return;
      }

      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job processing failed for job name "${effectiveJobName}"`
      );
      throw error;
    }
  }

  async processJob(job: TaskJob<PayloadType, ResultType>, token?: string, jobLogger?: Logger): Promise<any> {
    const effectiveJobLogger = jobLogger ?? this.getJobLogger(job);

    let validatedPayload: PayloadType = job.payload;

    if (this.schema) {
      try {
        validatedPayload = this.schema.parse(job.payload);
        effectiveJobLogger.debug('Payload validated successfully.');
      } catch (error) {
        effectiveJobLogger.error(
          {
            err: error instanceof z.ZodError ? error.format() : error,
            originalPayload: job.payload,
          },
          `Payload validation failed for job "${job.name}" (id: ${job.id})`
        );
        if (error instanceof z.ZodError) {
          // Construct a more user-friendly error message
          const messages = error.errors.map((e) => `${e.path.join('.') || 'payload'}: ${e.message}`);
          throw new Error(`Payload validation failed: ${messages.join('; ')}`);
        }
        throw error; // Re-throw other errors
      }
    }

    const handlerOptions: TaskHandlerOptions<PayloadType> = {
      id: job.id,
      name: this.name,
      payload: validatedPayload,
    };
    const stepExecutor = new StepExecutor<TaskJob<PayloadType, ResultType>>(job);
    const handlerContext: TaskHandlerContext<PayloadType, ResultType> = {
      logger: effectiveJobLogger,
      client: this.taskClient,
      group: this.group,
      task: this,
      job: job,
      step: stepExecutor,
      token,
      queue: this.queue,
    };
    try {
      return await this.handler(handlerOptions, handlerContext);
    } catch (error) {
      effectiveJobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job processing failed for job name "${job.name}"`
      );
      throw error;
    }
  }
}
