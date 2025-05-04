import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';

export type TaskWorkerOptions = WorkerOptions & {
  logger?: Logger;
};
