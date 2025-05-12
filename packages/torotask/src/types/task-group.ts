import type { TaskGroup } from '../task-group.js';

export interface TaskGroupRegistry {
  [groupName: string]: TaskGroup<any, any>;
}
