import type { Logger } from 'pino';
import type { ToroTaskClient } from '../client.js'; // Assuming client export is in client.ts
import type { TaskGroup } from '../task-group.js';
import type { Prettify } from './utils.js';
import type { Task } from '../task.js';
import type { TaskJob } from '../job.js';
import type { TaskQueue } from '../queue.js';
import type { TaskJobData, TaskJobOptions } from './job.js';
import type { TaskWorkerOptions } from './worker.js';
import { StepExecutor } from '../step-executor.js';

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
export interface TaskHandlerOptions<PayloadType = any> {
  id?: string; // Job ID
  name: string; // Task name
  payload: PayloadType;
}

export interface BaseHandlerContext<PayloadType = any, ResultType = any> {
  logger: Logger; // Job-specific logger
  client: ToroTaskClient;
  group: TaskGroup;
  queue: TaskQueue<PayloadType, ResultType>;
}
/** Context passed to the task handler */
export interface TaskHandlerContext<PayloadType = any, ResultType = any>
  extends BaseHandlerContext<PayloadType, ResultType> {
  task: Task<PayloadType, ResultType>; // Reference to the Task instance
  job: TaskJob<PayloadType, ResultType>;
  step: StepExecutor<TaskJob<PayloadType, ResultType>>;
  token?: string | undefined; // Optional token for authentication or authorization
}

/** Task handler function type */
export type TaskHandler<PayloadType = any, ResultType = any> = (
  options: TaskHandlerOptions<PayloadType>,
  context: TaskHandlerContext<PayloadType, ResultType>
) => Promise<ResultType>;

export interface TaskTriggerBase<PayloadType = any> {
  /** Payload to associate with jobs created by this trigger. */
  payload?: PayloadType;
}

/** Defines a potential event trigger condition for a Task */
export interface TaskTriggerEvent<PayloadType> extends TaskTriggerBase<PayloadType> {
  type: 'event';
  /** Event name that could trigger the task */
  event?: string;
  /** Conditional logic string (interpretation TBD) */
  if?: string;
}

/** Defines a potential cron trigger condition for a Task */
export interface TaskTriggerCron<PayloadType> extends TaskTriggerBase<PayloadType> {
  type: 'cron';
  /** Optional name for the this trigger */
  name?: string;
  /** CRON string for scheduled triggering - uses BullMQ's cron syntax (cron-parser) */
  cron?: string;
}

/** Defines a potential repeat trigger condition for a Task */
export interface TaskTriggerEvery<PayloadType> extends TaskTriggerBase<PayloadType> {
  type: 'every';
  /** Optional name for the this trigger */
  name?: string;
  /** Repeat interval in milliseconds for recurring jobs based on this trigger. */
  every?: number;
}

/** Defines a potential trigger condition for a Task */
export type TaskTrigger<PayloadType = any> =
  | TaskTriggerEvent<PayloadType>
  | TaskTriggerCron<PayloadType>
  | TaskTriggerEvery<PayloadType>;
