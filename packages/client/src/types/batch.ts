import type { JobsOptions } from 'bullmq';
import type { BatchContainer } from '../batch-container.js';
import type { BatchTask } from '../batch-task.js';
import type { BaseHandlerContext, TaskHandlerContext, TaskHandlerOptions, TaskOptions } from './task.js';
import type { Prettify } from './utils.js';

export interface BatchOptions {
  batchSize: number;
  batchMinSize?: number;
  /**
   * The maximum time in milliseconds to wait before processing a batch.
   */
  batchTimeout: number;
}

export type BatchJobOptions = Prettify<JobsOptions & BatchOptions> & {
  lockDuration?: number;
};
export type BatchTaskOptions = Prettify<TaskOptions & BatchOptions>;

export interface BatchTaskHandlerContext<T, R> extends BaseHandlerContext {
  task: BatchTask<T, R>;
  container: BatchContainer<T, R>;
}

export type BatchHandlerOptions<T = unknown> = Omit<TaskHandlerOptions<T>, 'data'> & {
  data?: T;
};

export type BatchTaskHandler<T = unknown, R = unknown> = (
  options: BatchHandlerOptions<T>,
  context: BatchTaskHandlerContext<T, R>
) => Promise<R>;
