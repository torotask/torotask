import { createSchema, defineTask } from 'torotask';
import { exampleGroup } from './index.js';

export const newTask = defineTask({
  id: 'new-task',
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
      lastname: 'World',
    },
  },*/
  schema: createSchema((z) =>
    z.object({
      lastname: z.string().min(1).max(100),
    })
  ),
  handler: async (options, context) => {
    const { payload } = options;
    const { logger, step } = context;

    logger.debug(`Handler batch received job data: ${JSON.stringify(payload)}`);

    const message = `Hello, ${payload.lastname}!`;
    logger.debug(`Processed batch message: ${message}`);

    await step.sleep('sleep-step', '1 minute');
    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return message; // Return a result
  },
});
