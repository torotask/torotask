import { TaskGroup } from '../task-group.js';
import { TaskDefinitionRegistry, TaskRegistry } from './task.js';

export type TaskGroupRegistry<TGroupDefs extends TaskGroupDefinitionRegistry> = {
  [K in keyof TGroupDefs]: TGroupDefs[K] extends TaskGroupDefinition<infer T> // Infer the Payload (P) and Result (R) types from the definition
    ? TaskGroup<T>
    : never; // Should not happen if TGroupDefs is correctly constrained
};

/**
 * Defines a task group with a name and task definitions
 *
 * @template TDefs The type of task definitions contained in this group
 */
export interface TaskGroupDefinition<TDefs extends TaskDefinitionRegistry> {
  /**
   * The name of the task group
   */
  id?: string;

  /**
   * The task definitions contained in this group
   */
  tasks: TDefs;
}

/**
 * Registry of task group definitions
 */
export interface TaskGroupDefinitionRegistry {
  [groupKey: string]: TaskGroupDefinition<any>;
}
