import type { JobsOptions } from 'bullmq';
import type { BatchContainer } from '../batch-container.js';
import type { BatchTask } from '../batch-task.js';
import type { BaseHandlerContext, TaskHandlerContext, TaskHandlerOptions, TaskOptions } from './task.js';
import type { Prettify } from './utils.js';
import type { TaskJob } from '../job.js'; // Added

export interface BatchOptions {
  batchSize: number;
  batchMinSize?: number;
  /**
   * The maximum time in milliseconds to wait before processing a batch.
   */
  batchTimeout: number;
}

// New: Type for the batch processor function used by TaskWorker
export type BatchProcessor<DataType = any, ResultType = any, NameType extends string = string> = (
  jobs: TaskJob<DataType, ResultType, NameType>[]
) => Promise<any>;

export type BatchJobOptions = Prettify<JobsOptions & BatchOptions> & {
  lockDuration?: number;
};
export type BatchTaskOptions = Prettify<TaskOptions & BatchOptions>;

export interface BatchTaskHandlerContext<T, R> extends BaseHandlerContext {
  task: BatchTask<T, R>;
  batch: BatchContainer<T, R>;
}

export type BatchHandlerOptions<T = unknown> = Omit<TaskHandlerOptions<T>, 'data'> & {
  data?: T;
};

export type BatchTaskHandler<T = unknown, R = unknown> = (
  options: BatchHandlerOptions<T>,
  context: BatchTaskHandlerContext<T, R>
) => Promise<R>;
