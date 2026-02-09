import type { JobsOptions, QueueOptions, WorkerOptions } from 'bullmq';
import type { ToroTaskOptions } from './client.js';
import type { TaskJobOptions } from './job.js';
import type { TaskTrigger } from './task.js';
import type { SingleOrArray } from './utils.js';

/**
 * Options for configuring event queues (EventDispatcher/EventManager).
 * Combines queue, worker, and job configuration.
 */
export interface EventQueueOptions {
  /** BullMQ QueueOptions for the event queue (prefix, streams, etc.) */
  queueOptions?: Partial<QueueOptions>;
  /** BullMQ WorkerOptions for the event queue worker */
  workerOptions?: Partial<WorkerOptions>;
  /** Default job options applied to all jobs added to this queue */
  defaultJobOptions?: Partial<JobsOptions>;
}

/** Options for configuring the TaskServer */
export type TaskServerOptions = ToroTaskOptions & {
  /**
   * Whether the server should attach listeners to
   * process.on('unhandledRejection') and process.on('uncaughtException').
   * Defaults to true.
   */
  handleGlobalErrors?: boolean;

  /**
   * Default task options applied to all task jobs.
   * Includes task-specific options like deduplication, parent, and state.
   * Can be overridden by task-specific options.
   */
  defaultTaskOptions?: Partial<TaskJobOptions>;

  /**
   * Options for the EventDispatcher queue (events.dispatch).
   * Controls how event dispatch jobs are processed.
   */
  eventDispatcherOptions?: EventQueueOptions;

  /**
   * Options for the EventManager queue (events.sync).
   * Controls how event synchronization jobs are processed.
   */
  eventManagerOptions?: EventQueueOptions;
};

export interface BaseConfig<PayloadType = any> {
  triggers?: SingleOrArray<TaskTrigger<PayloadType>>;
}
