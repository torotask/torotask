import type { JobsOptions } from 'bullmq';
import type { TaskJob } from '../job.js';
import type { StepResult } from './step.js';
import type { IfAny, UnpackList } from './utils.js';

/**
 * Defines the structure of the state object used by StepExecutor,
 * intended to be part of the TaskJob's overall state.
 */
export interface TaskJobStepState {
  stepState?: Record<string, StepResult>;
  stepOrder?: string[];
  _currentStepIndex?: number;
}

export type TaskJobState = TaskJobStepState & {
  customData?: Record<string, any>;
};

export interface TaskJobData<PayloadType = any, StateType extends TaskJobState = TaskJobState> {
  payload: PayloadType;
  state: StateType;
}

export type TaskJobDataItem<DataType, Item> = IfAny<
  DataType,
  any,
  Item extends keyof DataType ? (UnpackList<DataType[Item]> extends object ? UnpackList<DataType[Item]> : never) : never
>;

export type TaskJobOptions<Datatype = any, StateType = TaskJobDataItem<Datatype, 'state'>> = Omit<
  JobsOptions,
  'parent'
> & {
  state?: StateType;
  parent?: Partial<TaskJob>;
};
