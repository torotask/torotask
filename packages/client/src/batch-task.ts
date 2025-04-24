import { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { TaskGroup } from './task-group.js';
import type {
  TaskHandlerOptions,
  TaskHandlerContext,
  TaskHandler,
  TaskTrigger,
  SingleOrArray,
  BatchTaskOptions,
} from './types.js';
import { BaseTask } from './base-task.js';

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends BaseQueue to manage its own underlying BullMQ queue and worker.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template T The expected type of the data payload for this task's main handler.
 * @template R The expected return type of the job associated with this task's main handler.
 */
export class BatchTask<T = unknown, R = unknown> extends BaseTask<T, R, BatchTaskOptions> {
  constructor(
    taskGroup: TaskGroup,
    name: string,
    options: BatchTaskOptions,
    trigger: SingleOrArray<TaskTrigger<T>> | undefined,
    handler: TaskHandler<T, R>,
    groupLogger: Logger
  ) {
    super(taskGroup, name, options, trigger, handler, groupLogger);
  }

  async process(job: Job): Promise<any> {
    const result = await this.processJob(job);
    return result;
  }

  async processJob(job: Job, jobLogger?: Logger): Promise<any> {
    jobLogger = jobLogger ?? this.getJobLogger(job);
    const typedJob = job as Job<T, R>;
    const handlerOptions: TaskHandlerOptions<T> = { id: job.id, name: this.name, data: typedJob.data };
    const handlerContext: TaskHandlerContext = {
      logger: jobLogger,
      client: this.client,
      group: this.group,
      task: this,
      job: typedJob,
      queue: this.queue,
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
