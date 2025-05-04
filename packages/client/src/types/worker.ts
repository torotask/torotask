import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import { TaskJob } from '../job.js';

export type TaskWorkerOptions = WorkerOptions & {
  logger?: Logger;
};

export type TaskProcessor<T = any, R = any, N extends string = string> = (
  job: TaskJob<T, R, N>,
  token?: string
) => Promise<R>;
