import { defineTask, createSchema } from 'torotask';

// Define a schema for the payload
const batchTaskPayloadSchema = createSchema((zod) => zod.object({ name: zod.string() }));

export const batchTask = defineTask({
  id: 'batch-task',
  schema: batchTaskPayloadSchema, // Use the schema
  options: {
    batch: {
      size: 5,
      timeout: 50000,
    },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
  triggers: {
    type: 'every',
    every: 10000,
    payload: {
      name: 'Batch Task Trigger',
    },
  },
  handler: async (_options, context) => {
    const { job, logger } = context;

    const messages: string[] = [];

    if (job.isBatch) {
      for (const item of job.getBatch()) {
        const itemPayload = item.payload;
        logger.debug(`Job ID: ${item.id}`);
        logger.debug(`Handler batch received job data: ${JSON.stringify(itemPayload)}`);
        const message = `Hello, ${itemPayload.name}!`; // No more 'as any'
        logger.debug(`Processed batch message: ${message}`);
        messages.push(message);
      }
    }

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 100));
  },
});
