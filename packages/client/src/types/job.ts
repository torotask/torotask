import type { JobsOptions } from 'bullmq';
import type { IfAny, UnpackList } from './utils.js';

export type TaskJobState = {
  lastStep?: string;
  nextStep?: string;
  stepValues?: Record<string, any>;
  processOrder?: string[];
  customData?: Record<string, any>;
};

export type TaskJobData<PayloadType = any, StateType extends TaskJobState = TaskJobState> = {
  payload: PayloadType;
  state: StateType;
};

export type TaskJobDataItem<DataType, Item> = IfAny<
  DataType,
  any,
  Item extends keyof DataType ? (UnpackList<DataType[Item]> extends object ? UnpackList<DataType[Item]> : never) : never
>;

export type TaskJobOptions<Datatype = any, StateType = TaskJobDataItem<Datatype, 'state'>> = JobsOptions & {
  state?: StateType;
};
