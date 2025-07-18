import type { WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { TaskJob } from '../job.js';
import type { TaskDefinitionRegistry, TaskRegistry } from './task.js';
import { TaskGroupDefinitionRegistry, TaskGroupRegistry } from './task-group.js';
import type { CreateClientFunction } from './client.js';

export type TaskWorkerBatchOptions = {
  size: number;
  minSize?: number;
  /**
   * The maximum time in milliseconds to wait before processing a batch.
   */
  timeout: number;
};

export type TaskWorkerOptions = WorkerOptions & {
  logger?: Logger;
  /** Optional batch processing configuration. If provided, batchProcessor must also be provided. */
  batch?: TaskWorkerBatchOptions;
  /**
   * Function to create Redis connections for the worker.
   * Used for connection reusing when enabled in ToroTask client.
   */
  createClient?: CreateClientFunction;
};

export type TaskProcessor<PayloadType = any, ResultType = any, NameType extends string = string> = (
  job: TaskJob<PayloadType, ResultType, NameType>,
  token?: string
) => Promise<ResultType>;

export type TaskValidator<PayloadType = any, ResultType = any, NameType extends string = string> = (
  job: TaskJob<PayloadType, ResultType, NameType>
) => Promise<PayloadType>;

/** Worker Filter defined here */
export interface WorkerFilterTasks<
  TTasks extends TaskRegistry<TaskDefinitionRegistry>,
  TTaskKeys extends keyof TTasks = keyof TTasks,
> {
  tasksById?: Array<TTaskKeys extends string ? TTaskKeys : never>;
}
export interface WorkerFilterGroups<
  TGroups extends TaskGroupRegistry<TaskGroupDefinitionRegistry>,
  TGroupKeys extends string = Extract<keyof TGroups, string>,
> {
  groupsById?: Array<TGroupKeys extends string ? TGroupKeys : never>;
}
