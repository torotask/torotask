import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import { TaskJob } from '../job.js';
import type { BatchProcessor } from './batch.js'; // Added

export type TaskWorkerOptions = WorkerOptions & {
  logger?: Logger;
  /** Optional batch processing configuration. If provided, batchProcessor must also be provided. */
  batch?: {
    size: number;
    minSize?: number;
    /**
     * The maximum time in milliseconds to wait before processing a batch.
     */
    timeout: number;
  };
  /** Processor for handling batches. Required if `batch` options are set. */
  batchProcessor?: BatchProcessor<any, any, any>; // Using 'any' for now, generics can be tricky here
};

/** Processor for handling single jobs. Required if `batch` options are NOT set. */
export type TaskProcessor<T = any, R = any, N extends string = string> = (
  job: TaskJob<T, R, N>,
  token?: string
) => Promise<R>;
