import type { ToroTask } from './client.js';
import type { TaskJob } from './job.js';
import type { StepExecutor } from './step-executor.js';
import type { TaskGroup } from './task-group.js';
import type { Task } from './task.js';
import type {
  EffectivePayloadType,
  ResolvedSchemaType,
  SchemaHandler,
  SingleOrArray,
  TaskDefinition,
  TaskDefinitionRegistry,
  TaskGroupDefinition,
  TaskGroupDefinitionRegistry,
  TaskHandler, // Added TaskHandler for DefineTaskInputConfig
  TaskHandlerContext,
  TaskOptions, // Added TaskOptions for DefineTaskInputConfig
  TaskTrigger,
} from './types/index.js';
import { z } from 'zod';

// Helper type for the config object passed to defineTask, designed for inference
interface DefineTaskInputConfig<
  PayloadExplicit,
  SchemaInput extends SchemaHandler | undefined,
  // This InferredHandlerResult is the type that the provided handler function actually returns.
  InferredHandlerResult,
> {
  // The handler's result type is InferredHandlerResult, which TS will infer.
  handler: TaskHandler<
    EffectivePayloadType<PayloadExplicit, ResolvedSchemaType<SchemaInput>>,
    InferredHandlerResult, // Key for inference
    ResolvedSchemaType<SchemaInput>
  >;
  options?: TaskOptions<EffectivePayloadType<PayloadExplicit, ResolvedSchemaType<SchemaInput>>>;
  schema?: SchemaInput;
  triggers?: SingleOrArray<TaskTrigger<EffectivePayloadType<PayloadExplicit, ResolvedSchemaType<SchemaInput>>>>;
  id?: string; // From TaskDefinition
}

/**
 * Defines a task group configuration.
 * This function helps with type inference for task group definitions.
 *
 * @template TTaskMap The type of the task definition registry (a map of task definitions).
 * @param config The task group definition, including an optional `id` and a `tasks` object.
 * @returns The task group definition object, correctly typed.
 */
export function defineTaskGroup<
  // TTaskMap will be inferred from config.tasks, e.g., typeof { taskA, taskB } as const
  TTaskMap extends TaskDefinitionRegistry,
>(
  config: TaskGroupDefinition<TTaskMap>, // config is { id?: 'groupX', tasks: TTaskMap }
): TaskGroupDefinition<TTaskMap> {
  return config;
}
/**
 * Defines a task group registry.
 * This function helps with type inference for task group definitions.
 *
 * @template T The specific type of the task group definitions registry.
 * @param groups The task group definitions.
 * @returns The task group definition registry, preserving its specific type.
 */
export function defineTaskGroupRegistry<const T extends TaskGroupDefinitionRegistry>(
  groups: T,
): T {
  return groups;
}

/**
 * Defines a task configuration.
 * This function helps with type inference for the task definition.
 *
 * @template PayloadExplicit The type of the payload for the task. Defaults to `unknown`.
 *   If a `schema` is provided, this type is typically overridden by the schema's inferred type.
 * @template SchemaInput The type of the schema or schema function.
 * @template ResultExplicit The explicit type of the result returned by the task handler.
 *   If not provided (or set to `unknown`), the result type will be inferred from the handler.
 * @template InferredHandlerResult (Internal) The actual inferred result type from the handler.
 * @param config The task definition object.
 * @returns The task definition object, correctly typed.
 */
export function defineTask<
  PayloadExplicit = unknown,
  ResultExplicit = unknown,
  SchemaInput extends SchemaHandler | undefined = undefined,
  // InferredHandlerResult will be inferred from the `handler` in `config`.
  InferredHandlerResult = unknown,
>(
  config: DefineTaskInputConfig<PayloadExplicit, SchemaInput, InferredHandlerResult>,
): TaskDefinition<
  PayloadExplicit,
  // Conditional type: if ResultExplicit was the default 'unknown' (i.e., not specified), use the inferred type.
  // Otherwise, respect the user's explicit type.
  ResultExplicit extends unknown ? InferredHandlerResult : ResultExplicit,
  SchemaInput
> {
  // The config object, as provided, has a handler that returns InferredHandlerResult.
  // The returned TaskDefinition needs its handler to be typed with the final resolved result type.
  // The underlying handler function is the same.
  return config as unknown as TaskDefinition<
    PayloadExplicit,
    ResultExplicit extends unknown ? InferredHandlerResult : ResultExplicit,
    SchemaInput
  >;
}

/**
 * Defines a task configuration with an explicit result type.
 * Use this when you want to specify the result type explicitly while still
 * inferring the payload from the schema.
 *
 * @example
 * ```ts
 * const myTask = defineTaskWithResult<MyResultType>()({
 *   schema: createSchema(z => z.object({ id: z.string() })),
 *   handler: async (opts, ctx) => { return { success: true }; }
 * })
 * ```
 *
 * @template ResultExplicit The explicit result type for the task handler.
 */
export function defineTaskWithResult<ResultExplicit>() {
  return <
    PayloadExplicit = unknown,
    SchemaInput extends SchemaHandler | undefined = undefined,
  >(
    config: DefineTaskInputConfig<PayloadExplicit, SchemaInput, ResultExplicit>,
  ): TaskDefinition<PayloadExplicit, ResultExplicit, SchemaInput> => {
    return config as unknown as TaskDefinition<PayloadExplicit, ResultExplicit, SchemaInput>;
  };
}

/**
 * Creates a schema directly from a function that receives the Zod builder.
 * This avoids needing to import `zod` in the consumer's file just for the type.
 *
 * @example
 * ```ts
 * const mySchema = createSchema(z => z.object({ id: z.string() }));
 * ```
 */
export function createSchema<T extends z.ZodTypeAny>(schemaFn: (zod: typeof z) => T): T {
  return schemaFn(z);
}

/**
 * Returns a fully typed context for a given task group.
 * This includes strongly-typed `step`, `group`, `client`, `task`, and `job` properties.
 *
 * @template TAllTaskGroupsDefs The type of all task group definitions.
 * @template TCurrentTaskGroup The key of the current task group.
 * @template TContext The original task handler context, used to infer payload and result types.
 * @param context The generic task handler context.
 * @param _currentGroup The identifier for the current task group, used for type inference.
 * @returns A strongly-typed context object.
 */
export function getTypedContext<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry,
  const TCurrentTaskGroup extends keyof TAllTaskGroupsDefs,
  TContext extends TaskHandlerContext<any, any>,
  TPayload = TContext extends TaskHandlerContext<infer P, any> ? P : unknown,
  TResult = TContext extends TaskHandlerContext<any, infer R> ? R : unknown,
>(
  context: TContext,
  _currentGroup: TCurrentTaskGroup,
): Omit<TContext, 'step' | 'group' | 'client' | 'task' | 'job'> & {
  step: StepExecutor<TaskJob<TPayload, TResult, any>, TAllTaskGroupsDefs, TCurrentTaskGroup>;
  group: TaskGroup<TAllTaskGroupsDefs[TCurrentTaskGroup]['tasks']>;
  client: ToroTask<TAllTaskGroupsDefs>;
  task: Task<TPayload, TResult, any>;
  job: TaskJob<TPayload, TResult>;
} {
  return {
    ...context,
    step: context.step as StepExecutor<TaskJob<TPayload, TResult, any>, TAllTaskGroupsDefs, TCurrentTaskGroup>,
    group: context.group as TaskGroup<TAllTaskGroupsDefs[TCurrentTaskGroup]['tasks']>,
    client: context.client as ToroTask<TAllTaskGroupsDefs>,
    task: context.task as Task<TPayload, TResult, any>,
    job: context.job as TaskJob<TPayload, TResult>,
  };
}
