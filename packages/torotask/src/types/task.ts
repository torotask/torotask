import type { StringValue } from 'ms';
import type { Logger } from 'pino';
import type { ZodSchema } from 'zod';
import type { ToroTask } from '../client.js';
import type { TaskJob } from '../job.js';
import type { StepExecutor } from '../step-executor.js';
import type { TaskGroup } from '../task-group.js';
import type { Task } from '../task.js';
import type { TaskWorkerQueue } from '../worker-queue.js';
import type { TaskJobOptions } from './job.js';
import type { TaskQueueOptions } from './queue.js';
import type { EffectivePayloadType, ResolvedSchemaType, SchemaHandler } from './schema.js';
import type { Prettify, SingleOrArray } from './utils.js';
import type { TaskWorkerOptions } from './worker.js';

export type TaskTriggerCronValue = string;
export type TaskTriggerEveryValue = StringValue | number;

/**
 * Options for defining a Task, extending BullMQ's JobsOptions.
 */
export type TaskOptions = Prettify<
  TaskJobOptions & {
    allowCatchAll?: boolean;
    batch?: TaskWorkerOptions['batch'];
    workerOptions?: Partial<Omit<TaskWorkerOptions, 'batch'>>;
    queueOptions?: Partial<TaskQueueOptions>;
    skipSchemaValidation?: boolean;
  }
>;

/** Handler details passed to the task handler */
export interface TaskHandlerOptions<PayloadType = unknown> {
  id?: string;
  name: string;
  payload: PayloadType;
}

export interface BaseHandlerContext<PayloadType = unknown, ResultType = unknown> {
  logger: Logger;
  client: ToroTask;
  group: TaskGroup;
  queue: TaskWorkerQueue<PayloadType, ResultType>;
}

/** Context passed to the task handler */
// Task's third generic (SchemaInputVal) is passed to TaskHandlerContext's third generic slot
// which then uses ResolvedSchemaType internally or for the 'task' property.
// The 'task' property type: Task<PayloadType, ResultType, SchemaInputValueForTask>
export interface TaskHandlerContext<
  PayloadType = unknown,
  ResultType = unknown,
  _CurrentResolvedSchema extends ZodSchema | undefined = undefined,
> extends BaseHandlerContext<PayloadType, ResultType> {
  // The Task type itself is generic over PayloadExplicit, ResultType, SchemaInputVal.
  // So, the 'task' field needs to reflect that if it's to be specific.
  // For now, using 'any' for the third generic of Task to simplify, or it needs careful threading.
  task: Task<PayloadType, ResultType, any>; // any for SchemaInputVal of the Task type
  job: TaskJob<PayloadType, ResultType>;
  step: StepExecutor<TaskJob<PayloadType, ResultType>>;
  token?: string | undefined;
}

/** Task handler function type */
// This Handler is generic over PayloadType, ResultType, and the RESOLVED schema type
export type TaskHandler<
  PayloadType = unknown,
  ResultType = unknown,
  CurrentResolvedSchema extends ZodSchema | undefined = undefined,
> = (
  options: TaskHandlerOptions<PayloadType>,
  context: TaskHandlerContext<PayloadType, ResultType, CurrentResolvedSchema>,
) => Promise<ResultType>;

export interface TaskTriggerBase<PayloadType = unknown> {
  payload?: PayloadType;
}

export interface TaskTriggerEvent<PayloadType = unknown> extends TaskTriggerBase<PayloadType> {
  type: 'event';
  event?: string;
  if?: string;
}

export interface TaskTriggerCron<PayloadType = unknown> extends TaskTriggerBase<PayloadType> {
  type: 'cron';
  name?: string;
  cron?: TaskTriggerCronValue;
}

export interface TaskTriggerEvery<PayloadType = unknown> extends TaskTriggerBase<PayloadType> {
  type: 'every';
  name?: string;
  every?: TaskTriggerEveryValue;
}

export type TaskTrigger<PayloadType = unknown>
  = | TaskTriggerEvent<PayloadType>
    | TaskTriggerCron<PayloadType>
    | TaskTriggerEvery<PayloadType>;

export interface TaskConfig<
  PayloadExplicit = unknown,
  ResultType = unknown,
  SchemaInputValue extends SchemaHandler = undefined,
> {
  handler: TaskHandler<
    EffectivePayloadType<PayloadExplicit, ResolvedSchemaType<SchemaInputValue>>,
    ResultType,
    ResolvedSchemaType<SchemaInputValue>
  >;
  options?: TaskOptions;
  schema?: SchemaInputValue;
  triggers?: SingleOrArray<TaskTrigger<EffectivePayloadType<PayloadExplicit, ResolvedSchemaType<SchemaInputValue>>>>;
}

export interface TaskDefinition<
  PayloadExplicit = unknown,
  ResultType = unknown,
  SchemaInputValue extends SchemaHandler = undefined,
> extends TaskConfig<PayloadExplicit, ResultType, SchemaInputValue> {
  // Removed id field - key is now the ID
}

// export type TaskRegistry = Record<string, Task<any, any, SchemaHandler>>;
export interface TaskDefinitionRegistry {
  [taskName: string]: TaskDefinition<any, any, any>;
}

export type TaskRegistry<TDefs extends TaskDefinitionRegistry> = {
  // For each key K in the input TDefs...
  [K in keyof TDefs]: TDefs[K] extends TaskDefinition<infer P, infer R, infer S> // Infer the Payload (P) and Result (R) types from the definition
    ? Task<P, R, S> // ...the output type is Task<P, R>
    : never; // Should not happen if TDefs is correctly constrained
};
