import { defineTaskGroup } from 'torotask';
import { batchTask } from './batch.js';
import { dataStoreTest, dataStoreTestChild } from './data-store-test.js';
import { newTask } from './new-task.js';
import { parentOverrideTestChild, parentOverrideTestRunner } from './parent-override-test.js';
import { helloTask } from './sayHello.js';

export const exampleGroup = defineTaskGroup({
  tasks: {
    batchTask,
    newTask,
    helloTask,
    parentOverrideTestChild,
    parentOverrideTestRunner,
    dataStoreTest,
    dataStoreTestChild,
  } as const,
});
