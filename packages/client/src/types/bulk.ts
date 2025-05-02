import type { JobNode } from 'bullmq';
import type { TaskRunOptions } from './task.js';
import { P } from 'pino';

export type BulkRunOptions = Omit<TaskRunOptions, 'repeat'>;

export type BulkJob<T = any> = {
  name: string;
  data: T;
  options?: BulkRunOptions;
};

export type BulkTaskRunBase<T> = {
  taskGroup: string;
  taskName: string;
  name: string;
  data?: any;
  options?: T;
  children?: BulkTaskRunChild[];
};

export type BulkTaskRunChild = BulkTaskRunBase<Omit<BulkRunOptions, 'parent'>>;
export type BulkTaskRun = BulkTaskRunBase<BulkRunOptions>;

export type BulkTaskGroupRun = BulkTaskRunBase<BulkRunOptions> & {
  taskGroup?: string;
};

export type BulkTaskRunNode = JobNode;
