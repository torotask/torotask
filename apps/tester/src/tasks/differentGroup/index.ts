import { defineTaskGroup } from 'torotask';
import { realTask } from './real-task.js';

export const differentGroup = defineTaskGroup({
  tasks: {
    realTask,
  } as const,
});
