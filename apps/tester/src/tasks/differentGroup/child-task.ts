import { createSchema, defineTaskWithResult } from 'torotask';

export const childTask = defineTaskWithResult<string>()({
  id: 'child-task',
  options: {
    attempts: 3,
  },
  schema: createSchema(z =>
    z.object({
      name: z.string().min(1).max(100),
      errorOnFirstAttempt: z.boolean().optional(),
    }),
  ),
  handler: async (options, context) => {
    const { payload } = options;
    const { job, logger } = context;

    if (payload.errorOnFirstAttempt) {
      if (job.attemptsMade <= 3) {
        throw new Error('Error on first attempts');
      }
    }

    logger.debug(`Handler received job data: ${JSON.stringify(payload)}`);

    await new Promise(resolve => setTimeout(resolve, 10000));

    const message = `Hello, ${payload.name}!`;
    logger.debug(`Processed message: ${message}`);

    return message; // Return a result
  },
});
