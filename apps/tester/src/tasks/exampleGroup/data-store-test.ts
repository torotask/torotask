import { Buffer } from 'node:buffer';
import { createSchema, defineTask, isToroTaskDataRef } from 'torotask';
import { getTaskContext } from '../../helpers.js';

/** ~4 KiB of text — above the tester spill threshold. */
export function createLargeTestText(): string {
  return 'embedding-input:'.repeat(300);
}

/**
 * Child task: receives a large payload and returns a large embedding-like vector.
 * Useful for verifying externalized payloads and return values (incl. parent :processed).
 */
export const dataStoreTestChild = defineTask({
  id: 'data-store-test-child',
  schema: createSchema(z => z.object({
    text: z.string(),
  })),
  handler: async (options, context) => {
    const { payload } = options;
    const { logger, job } = context;

    logger.info({
      jobId: job.id,
      textLength: payload.text.length,
      textPreview: payload.text.slice(0, 40),
    }, 'dataStoreTestChild: payload hydrated for handler');

    const embedding = Array.from({ length: 768 }, (_, i) => Math.sin(i * 0.01));
    return {
      dimensions: embedding.length,
      embedding,
      checksum: payload.text.length,
    };
  },
});

/**
 * Runner: sends a large payload to a child via runTaskAndWait, then returns a large result.
 *
 * After running, inspect Redis:
 *   KEYS torotask:data:*
 *   HGETALL torotask:state:exampleGroup.dataStoreTest:<parentJobId>
 *   HGET torotask:tasks:exampleGroup.dataStoreTest:<jobId> data
 *   HGET torotask:tasks:exampleGroup.dataStoreTest-child:<childJobId> returnvalue
 *
 * Inline job fields should contain `_torotaskDataRef` objects instead of full blobs.
 */
export const dataStoreTest = defineTask({
  id: 'data-store-test',
  schema: createSchema(z => z.object({
    repeat: z.number().int().min(1).max(5).default(1),
  })),
  handler: async (options, context): Promise<{
    childDimensions: number;
    childChecksum: number;
    returnBlobLength: number;
  }> => {
    const { payload } = options;
    const { logger, step, job } = getTaskContext(context, 'exampleGroup');

    const largeText = createLargeTestText();
    logger.info({
      jobId: job.id,
      inputBytes: Buffer.byteLength(largeText, 'utf8'),
      repeat: payload.repeat,
    }, 'dataStoreTest: starting');

    const childResult = await step.runGroupTaskAndWait(
      'invoke-child',
      'dataStoreTestChild',
      { text: largeText },
    ) as { dimensions: number; checksum: number; embedding: number[] };

    const returnBlob = 'result-padding:'.repeat(400 * payload.repeat);

    logger.info({
      jobId: job.id,
      childDimensions: childResult.dimensions,
      childChecksum: childResult.checksum,
      returnBlobBytes: Buffer.byteLength(returnBlob, 'utf8'),
      payloadIsRef: isToroTaskDataRef(job.data?.payload),
    }, 'dataStoreTest: completed handler (payload in job.data may still be a ref until hydrated)');

    return {
      childDimensions: childResult.dimensions,
      childChecksum: childResult.checksum,
      returnBlobLength: returnBlob.length,
    };
  },
});
