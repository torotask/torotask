import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import { TaskJob } from '../job.js';

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
};

export type TaskProcessor<T = any, R = any, N extends string = string> = (
  job: TaskJob<T, R, N>,
  token?: string
) => Promise<R>;
