import { defineTask } from 'torotask';

// Define the data type the handler expects
interface SayHelloData {
  name: string;
}

// Use the factory function for the default export
export default defineTask<SayHelloData, string>({
  options: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    batch: {
      size: 10,
      minSize: 10,
      timeout: 20000,
    },
  },
  /*triggers: {
    type: 'every',
    every: 3000,
    payload: {
      name: 'World',
    },
  },*/
  handler: async (options, context) => {
    const { payload } = options;
    const { logger } = context;

    logger.info(`Handler  batch received job data: ${JSON.stringify(payload)}`);

    const message = `Hello, ${payload?.name}!`;
    logger.info(`Processed batch message: ${message}`);

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return message; // Return a result
  },
});
