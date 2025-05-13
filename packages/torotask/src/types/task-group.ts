import type { TaskGroup } from '../task-group.js';
import { TaskDefinitionRegistry, TaskRegistry } from './task.js';

export interface TaskGroupRegistry {
  [groupName: string]: TaskGroup<any, any>;
}

/**
 * Defines a task group with a name and task definitions
 *
 * @template TDefs The type of task definitions contained in this group
 */
export interface TaskGroupDefinition<TDefs extends TaskDefinitionRegistry> {
  /**
   * The name of the task group
   */
  name: string;

  /**
   * The task definitions contained in this group
   */
  tasks: TDefs;
}

/**
 * Registry of task group definitions
 */
export interface TaskGroupDefinitionRegistry {
  [groupName: string]: TaskGroupDefinition<any>;
}

export type StrictTaskAccess<T extends TaskDefinitionRegistry> = {
  // Only allow access to keys that exist in T
  [K in keyof T]: TaskRegistry<T>[K];
} & {
  // Make indexing with arbitrary strings return undefined
  [key: string]: undefined;
};
