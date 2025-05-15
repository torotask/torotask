import type { JobNode } from 'bullmq';
import type { TaskJobOptions, TaskJobState } from './job.js';
import { P } from 'pino';

export type BulkRunOptions = Omit<TaskJobOptions, 'repeat'>;

export type BulkJob<T = any> = {
  name: string;
  data: T;
  state?: TaskJobState;
  options?: BulkRunOptions;
};

export type BulkTaskRunBase<T> = {
  taskGroup: string;
  taskId: string;
  name: string;
  payload?: T;
  state?: TaskJobState;
  options?: T;
  children?: BulkTaskRunChild[];
};

export type BulkTaskRunChild = BulkTaskRunBase<Omit<BulkRunOptions, 'parent'>>;
export type BulkTaskRun = BulkTaskRunBase<BulkRunOptions>;

export type BulkTaskGroupRun = BulkTaskRunBase<BulkRunOptions> & {
  taskGroup?: string;
};

export type BulkTaskRunNode = JobNode;
