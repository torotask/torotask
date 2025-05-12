import type { TaskGroup } from '../task-group.js';
import { TaskDefinitionRegistry, TaskRegistry } from './task.js';

export interface TaskGroupRegistry {
  [groupName: string]: TaskGroup<any, any>;
}

export type StrictTaskAccess<T extends TaskDefinitionRegistry> = {
  // Only allow access to keys that exist in T
  [K in keyof T]: TaskRegistry<T>[K];
} & {
  // Make indexing with arbitrary strings return undefined
  [key: string]: undefined;
};
