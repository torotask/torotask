import { defineTaskGroup } from 'torotask';
import { childTask } from './child-task.js';
import { parentTask } from './parent-task.js';
import { realTask } from './real-task.js';

export const differentGroup = defineTaskGroup({
  tasks: {
    realTask,
    childTask,
    parentTask,
  } as const,
});
