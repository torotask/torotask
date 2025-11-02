import { createSchema, defineTask } from 'torotask';

export const newTask = defineTask({
  id: 'new-task',
  options: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
  /* triggers: {
    type: 'every',
    every: 3000,
    payload: {
      lastname: 'World',
    },
  }, */
  schema: createSchema(z =>
    z.object({
      lastname: z.string().min(1).max(100),
    }),
  ),
  handler: async (options, context) => {
    const { payload } = options;
    const { logger } = context;

    logger.debug(`Handler received job data: ${JSON.stringify(payload)}`);

    const message = `Hello, ${payload.lastname}!`;
    logger.debug(`Processed message: ${message}`);

    return message; // Return a result
  },
});
