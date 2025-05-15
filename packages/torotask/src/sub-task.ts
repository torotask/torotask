import type { Logger } from 'pino';
import type { Task } from './task.js';
// Import types from the types file
import type {
  SubTaskHandler,
  SubTaskHandlerContext,
  SubTaskHandlerOptions,
  TaskJobData,
  TaskJobOptions,
} from './types/index.js';
import { TaskJob } from './job.js';
import { StepExecutor } from './step-executor.js';

// --- SubTask Class ---

/**
 * Represents a defined SubTask within a parent Task.
 * Provides methods to enqueue jobs specifically for this subtask's handler,
 * utilizing the parent Task's queue.
 *
 * @template DataType The expected type of the data payload for this subtask.
 * @template ResultType The expected return type of the job associated with this subtask.
 */
export class SubTask<
  PayloadType = any,
  ResultType = unknown,
  const DataType extends TaskJobData = TaskJobData<PayloadType>,
> {
  public readonly parentTask: Task<any, any>; // Keep less specific for simplicity
  public readonly id: string;
  public readonly handler: SubTaskHandler<PayloadType, ResultType>; // Uses imported type
  public readonly logger: Logger;

  constructor(parentTask: Task<any, any>, id: string, handler: SubTaskHandler<PayloadType, ResultType>) {
    if (!parentTask) {
      throw new Error('Parent Task instance is required for SubTask.');
    }
    if (!id) {
      throw new Error('SubTask id is required.');
    }
    if (!handler || typeof handler !== 'function') {
      throw new Error('SubTask handler is required and must be a function.');
    }
    this.parentTask = parentTask;
    this.id = id;
    this.handler = handler;
    // Inherit logger from parent task and add subtask context
    this.logger = parentTask.logger.child({ subTaskId: this.id });

    this.logger.info('SubTask defined');
  }

  /**
   * Adds a job to the parent task's queue, specifically targeting this subtask's handler.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the parent task's defaults.
   * @returns A promise resolving to the enqueued BullMQ Job object.
   */
  async run(payload: PayloadType, overrideOptions?: TaskJobOptions) {
    const finalOptions: TaskJobOptions = {
      ...this.parentTask.jobsOptions,
      ...overrideOptions,
    };
    const data = {
      payload,
    };
    // Call parent task's public helper method directly
    return this.parentTask.queue.add(this.id, data, finalOptions);
  }

  async processSubJob(job: TaskJob<PayloadType, ResultType>, jobName: string, jobLogger: Logger): Promise<any> {
    const stepExecutor = new StepExecutor<TaskJob<PayloadType, ResultType>>(job);
    const handlerOptions: SubTaskHandlerOptions<PayloadType> = { id: job.id, name: jobName, payload: job.payload };
    const handlerContext: SubTaskHandlerContext<PayloadType, ResultType> = {
      logger: jobLogger,
      client: this.parentTask.taskClient,
      group: this.parentTask.group,
      parentTask: this.parentTask,
      subTaskId: this.id,
      job: job as any,
      step: stepExecutor,
      queue: this.parentTask.queue,
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

  /**
   * Adds a job for this subtask and waits for it to complete.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the parent task's defaults.
   * @returns A promise resolving to the return value of the completed job.
   * @throws Throws an error if the job fails or cannot be awaited.
   */
  async runAndWait(data: DataType, overrideOptions?: TaskJobOptions): Promise<ResultType> {
    const finalOptions: TaskJobOptions = {
      ...this.parentTask.jobsOptions,
      ...overrideOptions,
    };
    // Call parent task's public helper method directly
    return this.parentTask.queue._runJobAndWait(this.id, data, finalOptions);
  }
}
