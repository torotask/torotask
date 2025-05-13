import type { TaskGroup } from '../task-group.js';
import type { TaskDefinitionRegistry, TaskRegistry } from './task.js';
import type { TaskGroupDefinition, TaskGroupDefinitionRegistry } from './task-group-definition.js';
import type { TaskServer } from '../server.js';

/**
 * Helper type to get strongly-typed task groups from a TaskServer instance
 * based on the task group definitions used to initialize it.
 *
 * @example
 * ```
 * const taskGroupDefs = {
 *   groupA: { name: 'groupA', definitions: { ... } },
 *   groupB: { name: 'groupB', definitions: { ... } }
 * } as const;
 *
 * const server = new TaskServer({ taskGroupDefinitions: taskGroupDefs });
 *
 * // Get strongly-typed task groups
 * const groups = getTypedTaskGroups<typeof taskGroupDefs>(server);
 *
 * // Now you have type-safe access to task groups and their tasks
 * const taskA = groups.groupA.tasks.taskA;
 * ```
 */
export function getTypedTaskGroups<TGroupDefs extends TaskGroupDefinitionRegistry>(
  server: TaskServer
): {
  [K in keyof TGroupDefs]: TGroupDefs[K] extends TaskGroupDefinition<infer TDefs>
    ? TaskGroup<TDefs, TaskRegistry<TDefs>>
    : never;
} {
  return server.taskGroups as any;
}
