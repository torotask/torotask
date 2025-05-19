import { z } from 'zod';
import type {
  TaskDefinition,
  TaskGroupDefinition,
  TaskGroupDefinitionRegistry,
  SchemaHandler,
  TaskTrigger,
  SingleOrArray,
  ResolvedSchemaType,
  TaskDefinitionRegistry,
  TaskHandlerContext,
  EffectivePayloadType,
} from './types/index.js';
import type { StepExecutor } from './step-executor.js';
import type { TaskJob } from './job.js';

// Helper type to redefine config for defineTask input
type DefineTaskConfigInput<PayloadType, ResultType, SchemaVal extends SchemaHandler> = Omit<
  TaskDefinition<PayloadType, ResultType, SchemaVal>,
  'triggers'
> & {
  triggers?: SingleOrArray<TaskTrigger<EffectivePayloadType<PayloadType, ResolvedSchemaType<SchemaVal>>>>;
};

/**
 * Defines a task group configuration.
 * This function helps with type inference for task group definitions.
 *
 * @template TDefs The type of task definitions contained in this group.
 * @param name The name of the task group.
 * @param definitions The task definitions for this group.
 * @returns The task group definition object, correctly typed.
 */
export function defineTaskGroup<
  // TTaskMap will be inferred from config.tasks, e.g., typeof { taskA, taskB } as const
  TTaskMap extends TaskDefinitionRegistry,
>(
  config: TaskGroupDefinition<TTaskMap> // config is { id?: 'groupX', tasks: TTaskMap }
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
export function defineTaskGroupRegistry<T extends TaskGroupDefinitionRegistry>(groups: T): T {
  return groups;
}

/**
 * Defines a task configuration.
 * This function helps with type inference for the task definition.
 *
 * @template PayloadType The type of the payload for the task. Defaults to `unknown`.
 *   If a `schema` is provided, this type is typically overridden by the schema's inferred type for the handler.
 * @template ResultType The type of the result returned by the task handler. Defaults to `unknown`.
 * @template SchemaVal The type of the schema or schema function.
 * @param config The task definition object.
 * @returns The task definition object, correctly typed.
 */
export function defineTask<
  ResultExplicit = unknown,
  PayloadExplicit = unknown,
  SchemaInput extends SchemaHandler | undefined = undefined,
>(
  config: DefineTaskConfigInput<PayloadExplicit, ResultExplicit, SchemaInput>
): TaskDefinition<PayloadExplicit, ResultExplicit, SchemaInput> {
  return config as TaskDefinition<PayloadExplicit, ResultExplicit, SchemaInput>;
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
 * Retrieves the step executor from the task handler context.
 * This function is useful for accessing the step executor in a strongly typed manner.
 *
 * @template TAllTaskGroupsDefs The type of all task group definitions.
 * @template TActualPayload The actual payload type for the task.
 * @template TResult The result type for the task.
 * @param context The task handler context.
 * @returns The step executor, correctly typed.
 */
export function getTypedStep<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry,
  const TCurrentTaskGroup extends keyof TAllTaskGroupsDefs = never,
  TActualPayload = any,
  TResult = any,
>(
  context: TaskHandlerContext<TActualPayload, TResult>,
  _currentGroup?: TCurrentTaskGroup
): StepExecutor<TaskJob<TActualPayload, TResult, any>, TAllTaskGroupsDefs, TCurrentTaskGroup> {
  return context.step;
}
