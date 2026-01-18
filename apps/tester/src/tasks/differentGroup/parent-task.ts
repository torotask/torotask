import { defineTask } from 'torotask';
import { getTaskContext } from '../../index.js';

export const parentTask = defineTask({
  id: 'parent-task',
  options: {
    attempts: 3,
  },
  handler: async (options, context) => {
    const { job, step } = getTaskContext(context, 'differentGroup');

    job.log('Hello from parent task');

    const childResultA = await step.runTaskAndWait('test', 'differentGroup', 'childTask', {
      errorOnFirstAttempt: true,
      name: 'Test User A',
    });

    const childJobB = await step.runTask('test-b', 'differentGroup', 'childTask', {
      name: 'Test User B',
      errorOnFirstAttempt: true,
    });

    const childJobC = await step.runTask('test-c', 'differentGroup', 'childTask', {
      name: 'Test User C',

    });

    await step.waitForChildTasks('wait-for-child-tasks');

    // Get typed results from child tasks using step.getTaskResult()
    const childResultB = await step.getTaskResult(childJobB);
    const childResultC = await step.getTaskResult(childJobC);

    const childResultD = await step.runTaskAndWait('test-d', 'differentGroup', 'childTask', {
      name: 'Test User D',
    });

    job.log(`Child result A: ${childResultA}`);
    job.log(`Child result B: ${childResultB}`);
    job.log(`Child result C: ${childResultC}`);
    job.log(`Child result D: ${childResultD}`);

    return {
      success: true,
      message: 'Hello from parent task',
    };
  },
});
