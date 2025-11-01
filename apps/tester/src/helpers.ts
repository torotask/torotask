import type { TaskHandlerContext } from 'torotask';
import type { taskGroups } from './tasks/index.js';
import { getTypedContext } from 'torotask';

/**
 * A project-specific helper to get a fully typed context for a given task group.
 * This wraps the core `getTypedContext` and pre-fills it with the project's `taskGroups` type.
 *
 * @template TContext The original task handler context, used to infer payload and result types.
 * @template TCurrentTaskGroup The key of the current task group.
 * @param context The generic task handler context.
 * @param currentGroup The key of the current task group.
 * @returns A strongly-typed context object for the specified task group.
 */
export function getTaskContext<TContext extends TaskHandlerContext<any, any>, TCurrentTaskGroup extends keyof typeof taskGroups>(context: TContext, currentGroup: TCurrentTaskGroup,
) {
  return getTypedContext<typeof taskGroups, TCurrentTaskGroup, TContext>(context, currentGroup);
}
