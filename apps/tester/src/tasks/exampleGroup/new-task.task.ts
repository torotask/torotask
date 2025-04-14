import { defineTask } from '@torotask/server';

// Define the data type the handler expects
interface SayHelloData {
  name: string;
}

// Use the factory function for the default export
export default defineTask<SayHelloData, string>(
  {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
  {
    type: 'every',
    every: 20000,
  },
  async (options, context) => {
    const { data } = options;
    const { logger } = context;

    logger.info(`Handler received job data: ${JSON.stringify(data)}`);

    const message = `Hello, ${data.name}!`;
    logger.info(`Processed message: ${message}`);

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return message; // Return a result
  }
);
