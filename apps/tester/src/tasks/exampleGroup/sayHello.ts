import { createSchema, defineTask } from 'torotask';
import { useTaskContext } from './context.js';

export const helloTask = defineTask({
  id: 'hello-task',
  options: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    deduplication: {
      id: 'test',
    },
  },
  triggers: [
    {
      type: 'every',
      every: '5 minutes',
      payload: {
        name: 'Hello World',
        createdAt: new Date(),
      },
    },
    // {
    //    type: 'cron',
    //      cron: '27 */1 * * *',
    // },
    { type: 'event', event: 'item.update' },
    { type: 'event', event: 'item.create' },
  ],
  schema: createSchema(z =>
    z.object({
      name: z.string().min(1).max(100),
      age: z.number().optional(), // Optional field
      email: z.string().email().optional(), // Optional field
      isActive: z.boolean().default(true).optional(), // Default value
      createdAt: z.coerce.date().default(() => new Date()), // Default to current date
      tags: z.array(z.string()).optional(), // Optional array of strings
    }),
  ),
  handler: async (options, context) => {
    const { payload } = options;
    const { logger, job, step, group } = useTaskContext(context);

    group.runTask('batchTask', { name: 'Batch User', createdAt: new Date() });

    console.log('payload', payload);
    const _result1 = await step.do('first-step', async () => {
      logger.info(`Running first step with job data: ${JSON.stringify(job.payload)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      return 'First step completed';
    });

    const _newItem = await step.runTaskAndWait('rtest', 'exampleGroup', 'newTask', { lastname: 'Hello World' });

    // await step.sleep('sleep-step', 10000);
    const subTask = await step.runFlows('flow', [
      {
        taskGroup: 'exampleGroup',
        taskName: 'newTask',
        payload: {
          lastname: 'Hello World',
        },
        children: [
          {
            taskGroup: 'exampleGroup',
            taskName: 'batchTask',
            payload: {
              name: 'test',
            },
          },
        ],
      },
    ]);
    await step.waitForChildTasks('subtask');

    console.log('subTask', subTask);

    await step.do('first-step', async () => {
      const result = 'Second step completed';
      logger.info(`Subtask result: ${subTask}`);
      logger.info(`Running second step with job data: ${JSON.stringify(job.payload)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
      return result;
    });

    await step.runTask('test', 'exampleGroup', 'helloTask', {
      age: 30,
      name: 'Test User',
      createdAt: new Date(),
    });

    await step.runTasks('test-run', 'differentGroup', 'realTask', [
      {
        payload: {
          firstname: 'John',
          lastname: 'Doe',
        },
      },
    ]);
    await step.runGroupTask('test', 'helloTask', {
      name: 'Test User',
      createdAt: new Date(),
    });

    logger.info(`Handler received job data: ${JSON.stringify(payload)}`);

    const message = `Hello, ${payload.name}!`;
    logger.info(`Processed message: ${message}`);

    // Simulate some async work
    await new Promise(resolve => setTimeout(resolve, 100));

    return message; // Return a result
  },
});
