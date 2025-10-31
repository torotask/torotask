import { createSchema, defineTask } from 'torotask';

export const realTask = defineTask({
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
  schema: createSchema(z =>
    z.object({
      lastname: z.string().min(1).max(100),
    }),
  ),
  handler: async (options, context) => {
    const { payload } = options;
    const { logger } = context;

    logger.debug(`Handler batch received job data: ${JSON.stringify(payload)}`);

    const message = `Hello, ${payload.lastname}!`;
    logger.debug(`Processed batch message: ${message}`);

    // Simulate some async work
    await new Promise(resolve => setTimeout(resolve, 100));

    return message; // Return a result
  },
});
