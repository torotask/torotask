import { Job, JobsOptions, Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { ToroTaskClient } from './client.js';
import type { TaskGroup } from './task-group.js';
import type { Task } from './task.js';
// Import types from the types file
import type { SubTaskHandler, SubTaskHandlerContext, SubTaskHandlerOptions } from './types/index.js';

// --- SubTask Types ---

// Removed SubTaskHandlerOptions interface

// Removed SubTaskHandlerContext interface

// Removed SubTaskHandler type

// --- SubTask Class ---

/**
 * Represents a defined SubTask within a parent Task.
 * Provides methods to enqueue jobs specifically for this subtask's handler,
 * utilizing the parent Task's queue.
 *
 * @template ST The expected type of the data payload for this subtask.
 * @template SR The expected return type of the job associated with this subtask.
 */
export class SubTask<ST = unknown, SR = unknown> {
  public readonly parentTask: Task<any, any>; // Keep less specific for simplicity
  public readonly name: string;
  public readonly handler: SubTaskHandler<ST, SR>; // Uses imported type
  public readonly logger: Logger;

  constructor(parentTask: Task<any, any>, name: string, handler: SubTaskHandler<ST, SR>) {
    if (!parentTask) {
      throw new Error('Parent Task instance is required for SubTask.');
    }
    if (!name) {
      throw new Error('SubTask name is required.');
    }
    if (!handler || typeof handler !== 'function') {
      throw new Error('SubTask handler is required and must be a function.');
    }
    this.parentTask = parentTask;
    this.name = name;
    this.handler = handler;
    // Inherit logger from parent task and add subtask context
    this.logger = parentTask.logger.child({ subTaskName: this.name });

    this.logger.info('SubTask defined');
  }

  /**
   * Adds a job to the parent task's queue, specifically targeting this subtask's handler.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the parent task's defaults.
   * @returns A promise resolving to the enqueued BullMQ Job object.
   */
  async run(data: ST, overrideOptions?: JobsOptions): Promise<Job<ST, SR>> {
    const finalOptions: JobsOptions = {
      ...this.parentTask.jobsOptions,
      ...overrideOptions,
    };
    // Call parent task's public helper method directly
    return this.parentTask._runJob<ST, SR>(this.name, data, finalOptions);
  }

  async processSubJob(job: Job, jobName: string, jobLogger: Logger): Promise<any> {
    const typedJob = job as Job<ST, SR>;
    const handlerOptions: SubTaskHandlerOptions<ST> = { id: job.id, name: jobName, data: typedJob.data };
    const handlerContext: SubTaskHandlerContext = {
      logger: jobLogger,
      client: this.parentTask.client,
      group: this.parentTask.group,
      parentTask: this.parentTask,
      subTaskName: this.name,
      job: typedJob,
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
  async runAndWait(data: ST, overrideOptions?: JobsOptions): Promise<SR> {
    const finalOptions: JobsOptions = {
      ...this.parentTask.jobsOptions,
      ...overrideOptions,
    };
    // Call parent task's public helper method directly
    return this.parentTask._runJobAndWait<ST, SR>(this.name, data, finalOptions);
  }
}
