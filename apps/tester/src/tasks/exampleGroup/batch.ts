import { defineTask, createSchema } from 'torotask';

// Define a schema for the payload
const batchTaskPayloadSchema = createSchema((zod) => zod.object({ name: zod.string() }));

export const batchTask = defineTask({
  id: 'batch-task',
  schema: batchTaskPayloadSchema, // Use the schema
  options: {
    batch: {
      size: 10,
      timeout: 50000,
    },
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
  },
  /*triggers: {
    type: 'every',
    every: 10000,
  },*/
  handler: async (options, context) => {
    const { payload } = options; // Payload is now typed thanks to the schema
    const { logger } = context;

    logger.debug(`Handler batch received job data: ${JSON.stringify(payload)}`);

    const message = `Hello, ${payload.name}!`; // No more 'as any'
    logger.debug(`Processed batch message: ${message}`);

    // Simulate some async work
    await new Promise((resolve) => setTimeout(resolve, 100));

    return message; // Return a result
  },
});
