import express from 'express';
import { ToroTaskClient } from '@torotask/client';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';

//import { createQueueDashExpressMiddleware } from '@queuedash/api';

async function main() {
  const client = new ToroTaskClient();
  const queueInstances = await client.getAllQueueInstances();
  const queueAdapters = Object.values(queueInstances).map((queue) => new BullMQAdapter(queue) as any);

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  const _bullBoard = createBullBoard({
    queues: queueAdapters,
    serverAdapter: serverAdapter,
  });

  const app = express();

  app.use('/admin/queues', serverAdapter.getRouter());

  // other configurations of your server

  app.listen(3000, () => {
    console.log('Running on 3000...');
    console.log('For the UI, open http://localhost:3000/admin/queues');
    console.log('Make sure Redis is running on port 6379 by default');
  });
}

main();
