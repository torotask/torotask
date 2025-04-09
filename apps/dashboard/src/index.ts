import express from 'express';
import { ToroTaskClient } from '@torotask/client';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';
import { pino } from 'pino';
// How often to refresh the list of queues (in milliseconds)
const REFRESH_INTERVAL_MS = 30000; // 30 seconds

export const logger = pino({
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      levelFirst: true,
      translateTime: 'SYS:standard', // More readable time format
    },
  },
});

async function main() {
  const client = new ToroTaskClient({ logger });

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  // Function to fetch queues and update Bull Board
  const updateQueues = async () => {
    logger.info('Refreshing queue list...');
    try {
      const queueInstances = await client.getAllQueueInstances();
      // Use BullMQAdapter type for the Map value
      const queueAdaptersMap = new Map<string, BullMQAdapter>();
      for (const queueName in queueInstances) {
        if (Object.prototype.hasOwnProperty.call(queueInstances, queueName)) {
          const queue = queueInstances[queueName];
          queueAdaptersMap.set(queueName, new BullMQAdapter(queue));
        }
      }
      // Use type assertion as any to bypass strict type check
      serverAdapter.setQueues(queueAdaptersMap as any);
      logger.info(`Queue list updated with ${queueAdaptersMap.size} queues.`);
    } catch (error) {
      logger.error('Error refreshing queue list:', error);
      // Optionally, clear queues or handle the error state in the UI
      // serverAdapter.setQueues([]);
    }
  };

  // Initial Bull Board setup with the server adapter
  // Queues will be populated by the first call to updateQueues
  const _bullBoard = createBullBoard({
    queues: [], // Start with empty queues, will be updated dynamically
    serverAdapter: serverAdapter,
  });

  const app = express();

  app.use('/admin/queues', serverAdapter.getRouter());

  // Run the initial update
  await updateQueues();

  // Set interval to refresh queues periodically
  setInterval(updateQueues, REFRESH_INTERVAL_MS);

  // other configurations of your server

  app.listen(3000, () => {
    logger.info('Running on 3000...');
    logger.info('For the UI, open http://localhost:3000/admin/queues');
    logger.info('Make sure Redis is running on port 6379 by default');
    logger.info(`Queue list will refresh every ${REFRESH_INTERVAL_MS / 1000} seconds.`);
  });
}

main().catch((err) => {
  logger.error('Failed to start dashboard:', err);
  process.exit(1);
});
