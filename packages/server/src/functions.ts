import { Task } from 'packages/client/dist/index.js';
import type { TaskConfig } from './types.js'; // Added .js extension

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
