import type { SchemaHandler, TaskDefinition } from './types/index.js';
import z, { ZodSchema } from 'zod';
import * as zod from 'zod';
export type ZodNamespace = typeof zod;
/**
 * Factory function to create a valid TaskDefinition object.
 * Simplifies the creation of task definition files by ensuring the handler is present
 * and allowing for generic type inference.
 *
 * @template PayloadType The explicit type of the payload if no schema is provided or if overriding schema inference. Defaults to `unknown`.
 * @template ResultType The return type of the task handler. Defaults to `unknown`.
 * @template SchemaVal The type of the Zod schema provided in the configuration. Inferred from `config.schema`.
 * @param config The task definition configuration object.
 * @returns The validated TaskDefinition object.
 * @throws Error if the handler function is not provided in the config.
 */
export function defineTask<PayloadType = unknown, ResultType = unknown, SchemaVal extends SchemaHandler = undefined>(
  config: TaskDefinition<PayloadType, ResultType, SchemaVal>
): TaskDefinition<PayloadType, ResultType, SchemaVal> {
  const { handler } = config;
  if (!handler || typeof handler !== 'function') {
    throw new Error('defineTask requires a valid handler function.');
  }
  return config;
}

/**
 * A helper function to create a Zod schema by invoking a schema-building function.
 * This allows consumers to define schemas without needing to import `zod` directly
 * for the schema builder, if they use this helper.
 *
 * @param schemaFn A function that takes a Zod instance and returns a ZodSchema.
 * @returns The ZodSchema instance created by the schemaFn.
 */
export function createSchema<T extends ZodSchema>(schemaFn: (zod: typeof z) => T): T {
  return schemaFn(z);
}
