import type { JobNode } from 'bullmq';
import type { TaskJobData, TaskJobOptions, TaskJobState } from './job.js';
import { P } from 'pino';
import { Task } from '../task.js';

export type BulkRunOptions = Omit<TaskJobOptions, 'repeat'>;

export type BulkJob<PayloadType = any, DataType extends TaskJobData<PayloadType> = TaskJobData<PayloadType>> = {
  name?: string;
  payload?: PayloadType;
  data?: DataType;
  state?: TaskJobState;
  options?: BulkRunOptions;
};

export type BulkTaskRunBase<TPayload> = {
  taskGroup: string;
  taskId: string;
  name: string;
  payload?: TPayload;
  state?: TaskJobState;
  options?: TaskJobOptions;
  children?: BulkTaskRunChild[];
};

export type BulkTaskRunChild = BulkTaskRunBase<Omit<BulkRunOptions, 'parent'>>;
export type BulkTaskRun = BulkTaskRunBase<BulkRunOptions>;

export type BulkTaskGroupRun = BulkTaskRunBase<BulkRunOptions> & {
  taskGroup?: string;
};

export type BulkTaskRunNode = JobNode;
