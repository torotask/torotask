import type { TaskConfig } from './types/index.js';
import z, { ZodSchema } from 'zod';
import * as zod from 'zod';
export type ZodNamespace = typeof zod;
/**
 * Factory function to create a valid TaskModule definition.
 * Simplifies the creation of task definition files.
 *
 * @template T Data type for the task handler.
 * @template R Return type for the task handler.
 * @param options Default job options for the task.
 * @param handler The task handler function.
 * @returns A TaskModule object.
 */
export function defineTask<PayloadType = any, ResultType = any>(
  config: TaskConfig<PayloadType, ResultType>
): TaskConfig<PayloadType, ResultType> {
  const { options, triggers, handler } = config;
  if (!handler || typeof handler !== 'function') {
    throw new Error('defineTask requires a valid handler function.');
  }
  return { options, triggers, handler };
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
