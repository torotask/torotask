import { defineTask } from '@torotask/client';

// Define the data type the handler expects
interface SayHelloData {
  name: string;
}

// Use the factory function for the default export
export default defineTask<SayHelloData, string>({
  options: {
    name: 'test-task',
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
  triggers: [
    {
      type: 'every',
      every: '10m',
      payload: {
        name: 'Hello World',
      },
    },
    {
      type: 'cron',
      cron: '27 */1 * * *',
    },
    { type: 'event', event: 'item.update' },
    { type: 'event', event: 'item.create' },
  ],
  handler: async (options, context) => {
    const { payload } = options;
    const { logger, job, step } = context;

    const _result1 = await step.run('first-step', async () => {
      logger.info(`Running first step with job data: ${JSON.stringify(job.payload)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'First step completed';
    });

    await step.sleep('sleep-step', 10000);

    await step.run('second-step', async () => {
      logger.info(`Running second step with job data: ${JSON.stringify(job.payload)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return 'Second step completed';
    });

    logger.info(`Handler received job data: ${JSON.stringify(payload)}`);

    const message = `Hello, ${payload.name}!`;
    logger.info(`Processed message: ${message}`);

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return message; // Return a result
  },
});
