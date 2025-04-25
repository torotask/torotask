import { defineBatchTask } from '@torotask/server';

// Define the data type the handler expects
interface SayHelloData {
  name: string;
}

// Use the factory function for the default export
export default defineBatchTask<SayHelloData, string>({
  options: {
    batchSize: 10,
    batchTimeout: 50000,

    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
  triggers: {
    type: 'every',
    every: 10000,
  },
  handler: async (options, context) => {
    const { data } = options;
    const { logger } = context;

    logger.info(`Handler  batch received job data: ${JSON.stringify(data)}`);

    const message = `Hello, ${data?.name}!`;
    logger.info(`Processed batch message: ${message}`);

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return message; // Return a result
  },
});
