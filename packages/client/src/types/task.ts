import type { Logger } from 'pino';
import type { ToroTaskClient } from '../client.js'; // Assuming client export is in client.ts
import type { TaskGroup } from '../task-group.js';
import type { Prettify } from './utils.js';
import type { Task } from '../task.js';
import type { TaskJob } from '../job.js';
import type { TaskQueue } from '../queue.js';
import type { TaskJobOptions } from './job.js';
import type { TaskWorkerOptions } from './worker.js';

/**
 * Options for defining a Task, extending BullMQ's JobsOptions.
 */
export type TaskOptions = Prettify<
  TaskJobOptions & {
    /**
     * If true, jobs with names that don't match the main task name
     * or any defined subtask names will be routed to the main task handler.
     * Defaults to false (unrecognized job names will throw an error).
     */
    allowCatchAll?: boolean;
    batch?: TaskWorkerOptions['batch'];
    workerOptions?: Partial<Omit<TaskWorkerOptions, 'batch'>>;
  }
>;
/** Handler details passed to the task handler */
export interface TaskHandlerOptions<DataType = any> {
  id?: string; // Job ID
  name: string; // Task name
  data: DataType;
}

export interface BaseHandlerContext {
  logger: Logger; // Job-specific logger
  client: ToroTaskClient;
  group: TaskGroup;
  queue: TaskQueue;
}
/** Context passed to the task handler */
export interface TaskHandlerContext<DataType = any, ResultType = any> extends BaseHandlerContext {
  task: Task<DataType, ResultType>; // Reference to the Task instance
  job: TaskJob<DataType, ResultType>;
  token?: string | undefined; // Optional token for authentication or authorization
}

/** Task handler function type */
export type TaskHandler<DataType = unknown, ResultType = unknown> = (
  options: TaskHandlerOptions<DataType>,
  context: TaskHandlerContext<DataType, ResultType>
) => Promise<ResultType>;

export interface TaskTriggerBase<DataType> {
  /** Data payload to associate with jobs created by this trigger. */
  data?: DataType;
}

/** Defines a potential event trigger condition for a Task */
export interface TaskTriggerEvent<DataType> extends TaskTriggerBase<DataType> {
  type: 'event';
  /** Event name that could trigger the task */
  event?: string;
  /** Conditional logic string (interpretation TBD) */
  if?: string;
}

/** Defines a potential cron trigger condition for a Task */
export interface TaskTriggerCron<DataType> extends TaskTriggerBase<DataType> {
  type: 'cron';
  /** Optional name for the this trigger */
  name?: string;
  /** CRON string for scheduled triggering - uses BullMQ's cron syntax (cron-parser) */
  cron?: string;
}

/** Defines a potential repeat trigger condition for a Task */
export interface TaskTriggerEvery<DataType> extends TaskTriggerBase<DataType> {
  type: 'every';
  /** Optional name for the this trigger */
  name?: string;
  /** Repeat interval in milliseconds for recurring jobs based on this trigger. */
  every?: number;
}

/** Defines a potential trigger condition for a Task */
export type TaskTrigger<DataType = Record<string, any>> =
  | TaskTriggerEvent<DataType>
  | TaskTriggerCron<DataType>
  | TaskTriggerEvery<DataType>;
