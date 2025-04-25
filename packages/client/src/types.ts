import type { Job, JobsOptions, Queue, RepeatOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { BaseTask } from './base-task.js';
import type { ToroTaskClient } from './client.js'; // Assuming client export is in client.ts
import type { TaskGroup } from './task-group.js';
import type { Task } from './task.js'; // Needed for TaskHandlerContext
import type { BatchJob } from './batch-job.js';
import type { BatchTask } from './batch-task.js';

/**
 * Returns generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];

/**
 * With type `T`, return it as an array even if not already an array.
 */
export type AsArray<T> = T extends any[] ? T : [T];

export type AnyTask<T, R> = Task<T, R> | BatchTask<T, R>;

// Interface for the data stored in the event set
export interface EventSubscriptionInfo {
  taskGroup: string;
  taskName: string;
  triggerId?: number;
  eventId?: string;
  data?: Record<string, any>;
}

export type RepeatOptionsWithoutKey = Omit<RepeatOptions, 'key'>;

// Return value for the EventManager sync job
export interface SyncJobReturn {
  registered: number;
  unregistered: number;
  errors: number;
}

/**
 * Options for defining a Task, extending BullMQ's JobsOptions.
 */
export interface TaskOptions extends JobsOptions {
  /**
   * If true, jobs with names that don't match the main task name
   * or any defined subtask names will be routed to the main task handler.
   * Defaults to false (unrecognized job names will throw an error).
   */
  allowCatchAll?: boolean;
}
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

// -- Batch Task Types ---
export interface BatchOptions {
  batchSize: number;
  batchMinSize?: number;
  batchTimeout?: number;
}

export interface BatchJobOptions extends JobsOptions, BatchOptions {}
export interface BatchTaskOptions extends BatchJobOptions {}

export interface BatchTaskHandlerContext extends TaskHandlerContext<BatchJob<any, any, string>, BatchTask<any, any>> {}

export interface BatchHandlerOptions<T = unknown> extends TaskHandlerOptions<T> {}

export type BatchTaskHandler<T = unknown, R = unknown> = (
  options: BatchHandlerOptions<T>,
  context: BatchTaskHandlerContext
) => Promise<R>;

// --- SubTask Types ---

/** Handler details passed to the subtask handler */
export interface SubTaskHandlerOptions<ST = unknown> {
  id?: string; // Job ID
  name: string; // SubTask name
  data: ST;
}

/** Context passed to the subtask handler */
export interface SubTaskHandlerContext extends Omit<TaskHandlerContext<Job>, 'task'> {
  parentTask: Task<any, any>; // Reference to the parent Task instance
  subTaskName: string; // The name of this subtask
}

/** SubTask handler function type */
export type SubTaskHandler<ST = unknown, SR = unknown> = (
  options: SubTaskHandlerOptions<ST>,
  context: SubTaskHandlerContext
) => Promise<SR>;
