import express from 'express';
import { ToroTask } from 'torotask';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { pino } from 'pino';

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
  // Enable queue discovery in ToroTask client
  const client = new ToroTask({
    logger,
    enableQueueDiscovery: true,
  });

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
          queueAdaptersMap.set(queueName, new BullMQAdapter(queue, { delimiter: '.' }));
        }
      }
      // Use type assertion as any to bypass strict type check
      serverAdapter.setQueues(queueAdaptersMap as any);
      logger.info(`Queue list updated with ${queueAdaptersMap.size} queues.`);
    } catch (error) {
      logger.error(error, 'Error refreshing queue list:');
      // Optionally, clear queues or handle the error state in the UI
      // serverAdapter.setQueues([]);
    }
  };

  // Listen for queue discovery events
  client.on('queueCreated', (queueName: string) => {
    logger.info({ queueName }, 'New queue detected, updating dashboard...');
    updateQueues().catch((error) => {
      logger.error({ error, queueName }, 'Failed to update dashboard after queue creation');
    });
  });

  client.on('queueRemoved', (queueName: string) => {
    logger.info({ queueName }, 'Queue removed, updating dashboard...');
    updateQueues().catch((error) => {
      logger.error({ error, queueName }, 'Failed to update dashboard after queue removal');
    });
  });

  client.on('queueDiscoveryStarted', () => {
    logger.info('Queue discovery started - will monitor for new queues in real-time');
  });

  client.on('queueDiscoveryError', (error: Error) => {
    logger.error({ error }, 'Queue discovery error occurred');
  });

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

  // Wait a moment for queue discovery to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // other configurations of your server

  app.listen(3000, () => {
    logger.info('Running on 3000...');
    logger.info('For the UI, open http://localhost:3000/admin/queues');
    logger.info('Make sure Redis is running on port 6379 by default');
    logger.info('Queue discovery is active - new queues will be detected automatically');
  });
}

main().catch((err) => {
  logger.error('Failed to start dashboard:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
