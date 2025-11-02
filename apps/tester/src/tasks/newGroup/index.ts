import { defineTaskGroup } from 'torotask';
import { realTask } from './real-task.js';

export const newGroup = defineTaskGroup({
  tasks: {
    realTask,
  } as const,
});
