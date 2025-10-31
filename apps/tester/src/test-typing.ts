import { server } from './server.js';

// A valid group should have no errors
const validGroup = server.taskGroups.exampleGroup;

server.runFlow({
  taskGroup: 'differentGroup',
  taskName: 'realTask',
  payload: {
    lastname: 'test',
    createdAt: new Date(),
  },
});

const _task2 = server.getTask('differentGroup', 'realTask');

validGroup.getTask('helloTask')?.run({
  name: 'test',
  createdAt: new Date(),
});

const task = validGroup.getTask('helloTask');
task?.run({
  name: 'test',
  createdAt: new Date(),
});

validGroup.runTask('helloTask', {
  name: 'test',
  createdAt: new Date(),
});
validGroup.startWorkers({ tasksById: ['helloTask', 'batchTask'] });
// This should show a TypeScript error as 'test' is not a valid key in our taskGroups
// const invalidGroup = server.taskGroups.exampleGroup.tasks.helloTask;

// We can access tasks within the valid group with type safety too
const helloTask = server.getTask('exampleGroup', 'helloTask');

helloTask?.run({
  name: 'test',
  createdAt: new Date(),
});

// We can run the task with proper typing
async function runHelloTask() {
  // This will be properly typed based on the task definition
  const job = await server.runTask('exampleGroup', 'helloTask', {
    name: 'test',
    createdAt: new Date(),
  });
  return job;
}

export { runHelloTask };
