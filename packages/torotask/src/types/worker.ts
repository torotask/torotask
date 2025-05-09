import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import { TaskJob } from '../job.js';

export type TaskWorkerBatchOptions = {
  size: number;
  minSize?: number;
  /**
   * The maximum time in milliseconds to wait before processing a batch.
   */
  timeout: number;
};

export type TaskWorkerOptions = WorkerOptions & {
  logger?: Logger;
  /** Optional batch processing configuration. If provided, batchProcessor must also be provided. */
  batch?: TaskWorkerBatchOptions;
};

export type TaskProcessor<DataType = any, ResultType = any, NameType extends string = string> = (
  job: TaskJob<DataType, ResultType, NameType>,
  token?: string
) => Promise<ResultType>;
