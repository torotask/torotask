import type { JobsOptions } from 'bullmq'; // Added JobProgress

export type TaskJobState = {
  lastStep?: string;
  nextStep?: string;
  stepValues?: Record<string, any>;
  processOrder?: string[];
  customData?: Record<string, any>;
};

export type TaskJobPayload = { [key: string]: any };

export type TaskJobData<
  PayloadType extends TaskJobPayload = TaskJobPayload,
  StateType extends TaskJobState = TaskJobState,
> = {
  payload: PayloadType;
  state: StateType;
};

export type TaskJobOptions<StateType extends TaskJobState = TaskJobState> = JobsOptions & {
  state?: StateType;
};
