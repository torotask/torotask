import type { WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { TaskJob } from '../job.js';
import type { TaskDefinitionRegistry, TaskRegistry } from './task.js';
import { TaskGroupDefinitionRegistry, TaskGroupRegistry } from './task-group.js';

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
};

export type TaskProcessor<PayloadType = any, ResultType = any, NameType extends string = string> = (
  job: TaskJob<PayloadType, ResultType, NameType>,
  token?: string
) => Promise<ResultType>;

/** Worker Filter defined here */
export interface WorkerFilterTasks<
  TTasks extends TaskRegistry<TaskDefinitionRegistry>,
  TTaskKeys extends keyof TTasks = keyof TTasks,
> {
  tasksByKey?: Array<TTaskKeys extends string ? TTaskKeys : never>;
  tasksById?: Array<string>;
}
export interface WorkerFilterGroups<
  TGroups extends TaskGroupRegistry<TaskGroupDefinitionRegistry>,
  TGroupKeys extends string = Extract<keyof TGroups, string>,
> {
  groupsByKey?: Array<TGroupKeys extends string ? TGroupKeys : never>;
  groupsById?: Array<string>;
}
