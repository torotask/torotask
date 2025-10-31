import type { TaskJobData, TaskJobOptions, TaskJobState } from './job.js';

export type BulkRunOptions = Omit<TaskJobOptions, 'repeat'>;

export interface BulkJob<PayloadType = any, DataType extends TaskJobData<PayloadType> = TaskJobData<PayloadType>> {
  name?: string;
  payload?: PayloadType;
  data?: DataType;
  state?: TaskJobState;
  options?: BulkRunOptions;
}
