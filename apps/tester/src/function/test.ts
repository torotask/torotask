import { client, logger } from '../client';

// Helper function for delay
export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const queue = client.createQueue('test-queue');
logger.info({ queueName: queue.name }, 'Created queue');

// Define the function FIRST
export const testFunction = queue.defineFunction('test-function', async ({ name, data }, { logger: jobLogger }) => {
  jobLogger.info({ jobName: name, jobData: data }, 'Received job');
  await delay(500); // Simulate some work
  jobLogger.info('Logging from inside job'); // Renamed logger in handler context
  return 'Hello from the worker!!';
});
logger.info({ functionName: testFunction.name }, 'Defined function');
