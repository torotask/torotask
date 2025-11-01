import type { taskGroups } from './tasks/index.js';
import { getTypedClient, getTypedGroup, getTypedStep } from 'torotask';

/**
 * This function is used to get a step executor for a specific task group and task.
 * It takes a context object that contains the task job and the task group definitions.
 * The function returns a step executor that can be used to execute steps for the specified task.
 *
 * @param context - The context object containing the task job and task group definitions.
 * @returns A step executor for the specified task group and task.
 */
export function getStep<TCurrentTaskGroup extends keyof typeof taskGroups = never>(
  context: any,
  currentGroup?: TCurrentTaskGroup,
) {
  // Use the getTypedStep function to retrieve the step executor
  return getTypedStep<typeof taskGroups, TCurrentTaskGroup>(context, currentGroup);
}

/**
 * Retrieves the client from the task handler context, strongly typed for this project.
 *
 * @param context The task handler context.
 * @returns The client, correctly typed.
 */
export function getClient(context: any) {
  return getTypedClient<typeof taskGroups>(context);
}

/**
 * Retrieves the task group from the task handler context, strongly typed for this project.
 *
 * @param context The task handler context.
 * @param currentGroup The identifier for the current task group, used for type inference.
 * @returns The task group, correctly typed.
 */
export function getGroup<TCurrentTaskGroup extends keyof typeof taskGroups>(
  context: any,
  currentGroup: TCurrentTaskGroup,
) {
  return getTypedGroup<typeof taskGroups, TCurrentTaskGroup>(context, currentGroup);
}
