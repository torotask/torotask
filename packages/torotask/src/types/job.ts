import type { JobsOptions, ParentOptions } from 'bullmq';
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

/**
 * Parent option that accepts either:
 * - A TaskJob instance (will extract id and queueQualifiedName)
 * - BullMQ's ParentOptions format ({ id, queue })
 */
export type TaskJobParent = Partial<TaskJob> | ParentOptions;

/**
 * Deduplication options for task definitions.
 * Unlike BullMQ's DeduplicationOptions, `id` is optional here.
 * Use `id` for a literal ID or `idFromPayload` for dynamic ID generation.
 * If neither produces a value at runtime, deduplication is skipped.
 *
 * @template PayloadType - The payload type for typed callback support
 */
export interface TaskDeduplicationOptions<PayloadType = any> {
  /**
   * Literal deduplication ID.
   */
  id?: string;
  /**
   * Callback function to generate deduplication ID from payload.
   * Receives the fully-typed payload and returns the ID string.
   * Return undefined/null to skip deduplication for this job.
   *
   * @example
   * idFromPayload: (payload) => `${payload.userId}:${payload.action}`
   */
  idFromPayload?: (payload: PayloadType) => string | undefined | null;
  /**
   * TTL in milliseconds.
   */
  ttl?: number;
  /**
   * Extend TTL value on duplicate.
   */
  extend?: boolean;
  /**
   * Replace job record while it's in delayed state.
   */
  replace?: boolean;
}

export type TaskJobOptions<
  Datatype = any,
  StateType = TaskJobDataItem<Datatype, 'state'>,
  PayloadType = any,
> = Omit<
  JobsOptions,
  'parent' | 'deduplication'
> & {
  state?: StateType;
  parent?: TaskJobParent;
  deduplication?: TaskDeduplicationOptions<PayloadType>;
};
