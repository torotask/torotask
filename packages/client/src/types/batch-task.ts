import type { JobsOptions } from 'bullmq';
import type { BatchJob } from '../batch-job.js';
import type { BatchTask } from '../batch-task.js';
import type { TaskHandlerContext, TaskHandlerOptions } from './task.js';
import type { Prettify } from './utils.js';

export interface BatchOptions {
  batchSize: number;
  batchMinSize?: number;
  batchTimeout?: number;
}

export type BatchJobOptions = Prettify<JobsOptions & BatchOptions>;
export type BatchTaskOptions = Prettify<BatchJobOptions>;

export interface BatchTaskHandlerContext extends TaskHandlerContext<BatchJob<any, any, string>, BatchTask<any, any>> {}

export interface BatchHandlerOptions<T = unknown> extends TaskHandlerOptions<T> {}

export type BatchTaskHandler<T = unknown, R = unknown> = (
  options: BatchHandlerOptions<T>,
  context: BatchTaskHandlerContext
) => Promise<R>;
