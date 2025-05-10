import type { StringValue } from 'ms';
import type { Logger } from 'pino';
import { type z, type ZodSchema } from 'zod'; // Ensure z is imported if z.infer is used directly in this file, otherwise ZodSchema is enough
import type { ToroTask } from '../client.js';
import type { TaskJob } from '../job.js';
import type { TaskQueue } from '../queue.js';
import type { StepExecutor } from '../step-executor.js';
import type { TaskGroup } from '../task-group.js';
import type { Task } from '../task.js';
import type { TaskJobOptions } from './job.js';
import type { TaskQueueOptions } from './queue.js';
import type { EffectivePayloadType, Prettify, SingleOrArray } from './utils.js';
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
    queueOptions?: Partial<TaskQueueOptions>;
  }
>;
/** Handler details passed to the task handler */
export interface TaskHandlerOptions<PayloadType = unknown> {
  // Default to unknown
  id?: string; // Job ID
  name: string; // Task name
  payload: PayloadType;
}

export interface BaseHandlerContext<PayloadType = unknown, ResultType = unknown> {
  // Default to unknown
  logger: Logger; // Job-specific logger
  client: ToroTask;
  group: TaskGroup;
  queue: TaskQueue<PayloadType, ResultType>;
}
/** Context passed to the task handler */
export interface TaskHandlerContext<
    PayloadType = unknown,
    ResultType = unknown,
    Schema extends ZodSchema | undefined = undefined,
  > // Default to unknown
  extends BaseHandlerContext<PayloadType, ResultType> {
  task: Task<PayloadType, ResultType, Schema>; // Reference to the Task instance
  job: TaskJob<PayloadType, ResultType>;
  step: StepExecutor<TaskJob<PayloadType, ResultType>>;
  token?: string | undefined; // Optional token for authentication or authorization
}

/** Task handler function type */
export type TaskHandler<
  PayloadType = unknown,
  ResultType = unknown,
  Schema extends ZodSchema | undefined = undefined,
> = (
  // Default to unknown
  options: TaskHandlerOptions<PayloadType>,
  context: TaskHandlerContext<PayloadType, ResultType, Schema>
) => Promise<ResultType>;

export interface TaskTriggerBase<PayloadType = unknown> {
  // Default to unknown
  /** Payload to associate with jobs created by this trigger. */
  payload?: PayloadType;
}

/** Defines a potential event trigger condition for a Task */
export interface TaskTriggerEvent<PayloadType = unknown> extends TaskTriggerBase<PayloadType> {
  type: 'event';
  /** Event name that could trigger the task */
  event?: string;
  /** Conditional logic string (interpretation TBD) */
  if?: string;
}

/** Defines a potential cron trigger condition for a Task */
export interface TaskTriggerCron<PayloadType = unknown> extends TaskTriggerBase<PayloadType> {
  type: 'cron';
  /** Optional name for the this trigger */
  name?: string;
  /** CRON string for scheduled triggering - uses BullMQ's cron syntax (cron-parser) */
  cron?: string;
}

/** Defines a potential repeat trigger condition for a Task */
export interface TaskTriggerEvery<PayloadType = unknown> extends TaskTriggerBase<PayloadType> {
  type: 'every';
  /** Optional name for the this trigger */
  name?: string;
  /** Repeat interval in milliseconds for recurring jobs based on this trigger. */
  every?: number | StringValue;
}

/** Defines a potential trigger condition for a Task */
export type TaskTrigger<PayloadType = unknown> =
  // Default to unknown
  TaskTriggerEvent<PayloadType> | TaskTriggerCron<PayloadType> | TaskTriggerEvery<PayloadType>;

export interface TaskDefinition<
  PayloadExplicit = unknown, // Renamed and default to unknown
  ResultType = unknown,
  Schema extends ZodSchema | undefined = undefined,
> {
  name: string;
  // The handler's first generic (PayloadType) will be the EffectivePayloadType
  handler: TaskHandler<EffectivePayloadType<PayloadExplicit, Schema>, ResultType, Schema>;
  options?: TaskOptions;
  schema?: Schema;
  // Triggers' payload type will also be the EffectivePayloadType
  triggers?: SingleOrArray<TaskTrigger<EffectivePayloadType<PayloadExplicit, Schema>>>;
}
