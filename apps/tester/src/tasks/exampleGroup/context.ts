import type { TaskHandlerContext } from 'torotask';
import { getTaskContext } from '../../helpers.js';

export const GROUP_NAME = 'exampleGroup';

/**
 * A helper to get strongly-typed context utilities for the 'exampleGroup'.
 * This avoids manually passing the group name in every task handler.
 * @param context The generic task handler context.
 * @returns A strongly-typed context object for the 'exampleGroup'.
 */
export function useTaskContext<TContext extends TaskHandlerContext<any, any>>(context: TContext) {
  return getTaskContext(context, GROUP_NAME);
}
