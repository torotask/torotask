import { server, logger } from './server.js';

const main = async () => {
  const tasks = await server.loadTasksFromDirectory('./tasks');
  logger.info({ tasks }, 'Loaded tasks');

  // Start the worker AFTER defining functions
  /*  logger.info({ queueName: queue.name }, 'Worker starting');

  // Wait a moment for the worker to initialize before invoking
  logger.info('Waiting for worker to initialize...');
  await delay(2000); // Wait 2 seconds (adjust if needed)

  logger.info('Invoking function...');
  try {
    const result = await testFunction.run({ data: 'test' });
    logger.info({ result }, 'Invoke Result'); // SUCCESS!
  } catch (error) {
    logger.error({ err: error }, 'Invocation failed');
  }*/

  //logger.info('Worker process running. Waiting for jobs...');
  setInterval(
    () => {
      // Optional: Add a heartbeat log or check worker status
      // logger.debug(`Worker for ${queue.name} is alive...`);
    },
    1000 * 60 * 5
  ); // Keep alive, check every 5 minutes
};

main().catch((err) => logger.error({ err }, 'Application error'));
