import type { Job, JobsOptions, Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { BaseTask } from '../base-task.js';
import type { ToroTaskClient } from '../client.js'; // Assuming client export is in client.ts
import type { TaskGroup } from '../task-group.js';
import type { Prettify } from './utils.js';

/**
 * Options for defining a Task, extending BullMQ's JobsOptions.
 */
export type TaskOptions = Prettify<
  JobsOptions & {
    /**
     * If true, jobs with names that don't match the main task name
     * or any defined subtask names will be routed to the main task handler.
     * Defaults to false (unrecognized job names will throw an error).
     */
    allowCatchAll?: boolean;
  }
>;
/** Handler details passed to the task handler */
export interface TaskHandlerOptions<T = unknown> {
  id?: string; // Job ID
  name: string; // Task name
  data: T;
}

/** Context passed to the task handler */
export interface TaskHandlerContext<TJob extends Job = Job, TTask extends BaseTask<any, any> = BaseTask<any, any>> {
  logger: Logger; // Job-specific logger
  client: ToroTaskClient;
  group: TaskGroup;
  task: TTask; // Reference to the Task instance
  job: TJob;
  queue: Queue; // The queue instance (from BaseQueue)
}

/** Task handler function type */
export type TaskHandler<T = unknown, R = unknown> = (
  options: TaskHandlerOptions<T>,
  context: TaskHandlerContext
) => Promise<R>;

export interface TaskTriggerBase<TData> {
  /** Data payload to associate with jobs created by this trigger. */
  data?: TData;
}

/** Defines a potential event trigger condition for a Task */
export interface TaskTriggerEvent<TData> extends TaskTriggerBase<TData> {
  type: 'event';
  /** Event name that could trigger the task */
  event?: string;
  /** Conditional logic string (interpretation TBD) */
  if?: string;
}

/** Defines a potential cron trigger condition for a Task */
export interface TaskTriggerCron<TData> extends TaskTriggerBase<TData> {
  type: 'cron';
  /** Optional name for the this trigger */
  name?: string;
  /** CRON string for scheduled triggering - uses BullMQ's cron syntax (cron-parser) */
  cron?: string;
}

/** Defines a potential repeat trigger condition for a Task */
export interface TaskTriggerEvery<TData> extends TaskTriggerBase<TData> {
  type: 'every';
  /** Optional name for the this trigger */
  name?: string;
  /** Repeat interval in milliseconds for recurring jobs based on this trigger. */
  every?: number;
}

/** Defines a potential trigger condition for a Task */
export type TaskTrigger<TData = Record<string, any>> =
  | TaskTriggerEvent<TData>
  | TaskTriggerCron<TData>
  | TaskTriggerEvery<TData>;
