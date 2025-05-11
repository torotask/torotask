import { z } from 'zod';
import type {
  TaskDefinition,
  // TaskHandler, // Not directly used in this part of the file for defineTask/createSchema
  // TaskOptions, // Not directly used in this part of the file for defineTask/createSchema
  SchemaHandler,
  TaskTrigger,
  SingleOrArray,
  ResolvedSchemaType, // Added ResolvedSchemaType
} from './types/index.js';
// import { ToroTaskError } from './utils/error.js'; // Not used here

// Helper type to redefine config for defineTask input
type DefineTaskConfigInput<PayloadType, ResultType, SchemaVal extends SchemaHandler> = Omit<
  TaskDefinition<PayloadType, ResultType, SchemaVal>,
  'triggers'
> & {
  triggers?: SchemaVal extends undefined // If SchemaVal is not provided (no schema for the task)
    ? SingleOrArray<TaskTrigger<PayloadType>> // Then triggers can infer/use PayloadType
    : ResolvedSchemaType<SchemaVal> extends infer ActualSchema extends z.ZodTypeAny // Else (SchemaVal IS provided)
      ? SingleOrArray<TaskTrigger<z.infer<ActualSchema>>>
      : SingleOrArray<TaskTrigger<unknown>>; // Fallback for triggers if schema exists but isn't a ZodTypeAny
};

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
export function defineTask<PayloadType = unknown, ResultType = unknown, SchemaVal extends SchemaHandler = undefined>(
  config: DefineTaskConfigInput<PayloadType, ResultType, SchemaVal>
): TaskDefinition<PayloadType, ResultType, SchemaVal> {
  // The return type is still the original TaskDefinition.
  // The input type is just more constrained to guide inference.
  return config as TaskDefinition<PayloadType, ResultType, SchemaVal>;
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
