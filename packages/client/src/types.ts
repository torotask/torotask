import type { Job, JobsOptions, Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { ToroTaskClient } from './client.js'; // Assuming client export is in client.ts
import type { TaskGroup } from './task-group.js';
import type { Task } from './task.js'; // Needed for TaskHandlerContext

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
export interface TaskHandlerContext {
  logger: Logger; // Job-specific logger
  client: ToroTaskClient;
  group: TaskGroup;
  task: Task<any, any>; // Reference to the Task instance
  job: Job;
  queue: Queue; // The queue instance (from BaseQueue)
}

/** Task handler function type */
export type TaskHandler<T = unknown, R = unknown> = (
  options: TaskHandlerOptions<T>,
  context: TaskHandlerContext
) => Promise<R>;

/** Defines a potential trigger condition for a Task */
export interface TaskTrigger<TData = Record<string, any>> {
  /** Event name that could trigger the task */
  event?: string;
  /** Conditional logic string (interpretation TBD) */
  if?: string;
  /** CRON string for scheduled triggering - uses BullMQ's cron syntax (cron-parser) */
  cron?: string;
  /** Repeat interval in milliseconds for recurring jobs based on this trigger. */
  every?: number;
  /** Data payload to associate with jobs created by this trigger. */
  data?: TData;
}

// --- SubTask Types ---

/** Handler details passed to the subtask handler */
export interface SubTaskHandlerOptions<ST = unknown> {
  id?: string; // Job ID
  name: string; // SubTask name
  data: ST;
}

/** Context passed to the subtask handler */
export interface SubTaskHandlerContext {
  logger: Logger; // Job-specific logger
  client: ToroTaskClient;
  group: TaskGroup; // From parent task
  parentTask: Task<any, any>; // Reference to the parent Task instance
  subTaskName: string; // The name of this subtask
  job: Job; // The underlying BullMQ job
  queue: Queue; // The queue instance (from parent Task -> BaseQueue)
}

/** SubTask handler function type */
export type SubTaskHandler<ST = unknown, SR = unknown> = (
  options: SubTaskHandlerOptions<ST>,
  context: SubTaskHandlerContext
) => Promise<SR>;
