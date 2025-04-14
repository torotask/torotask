import { JobsOptions, Job, Queue } from 'bullmq';
import type { Task } from './task.js'; // Use type import for Task
import type { ToroTaskClient } from './client.js';
import type { TaskGroup } from './task-group.js';
import { Logger } from 'pino';

// --- SubTask Types ---

/** Handler details passed to the subtask handler */
export interface SubTaskHandlerOptions<ST = unknown> {
  id?: string; // Job ID
  name: string; // SubTask name
  data: ST;
}

/** Context passed to the subtask handler */
export interface SubTaskHandlerContext {
  logger: Logger; // Job-specific logger
  client: ToroTaskClient;
  group: TaskGroup; // From parent task
  parentTask: Task<any, any>; // Reference to the parent Task instance
  subTaskName: string; // The name of this subtask
  job: Job; // The underlying BullMQ job
  queue: Queue; // The queue instance (from parent Task -> BaseQueue)
}

/** SubTask handler function type */
export type SubTaskHandler<ST = unknown, SR = unknown> = (
  options: SubTaskHandlerOptions<ST>,
  context: SubTaskHandlerContext
) => Promise<SR>;

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
  public readonly handler: SubTaskHandler<ST, SR>;
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
      ...this.parentTask.defaultJobOptions,
      ...overrideOptions,
    };
    // Call parent task's public helper method directly
    return this.parentTask._runJob<ST, SR>(this.name, data, finalOptions);
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
      ...this.parentTask.defaultJobOptions,
      ...overrideOptions,
    };
    // Call parent task's public helper method directly
    return this.parentTask._runJobAndWait<ST, SR>(this.name, data, finalOptions);
  }
}
