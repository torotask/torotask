import { defineTaskGroup } from 'torotask';
import { batchTask } from './batch.js';
import { newTask } from './new-task.js';
import { helloTask } from './sayHello.js';

export const exampleGroup = defineTaskGroup({
  tasks: {
    batchTask,
    newTask,
    helloTask,
  } as const,
});
