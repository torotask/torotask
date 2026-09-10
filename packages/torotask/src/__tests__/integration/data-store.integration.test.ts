/**
 * Integration tests for external data store wiring:
 * add → spill → process → hydrate, and child return → parent :processed refs.
 */

import pino from 'pino';
import { isToroTaskDataRef } from '../../data-store/data-ref.js';
import { defineTask, defineTaskGroup, defineTaskGroupRegistry } from '../../functions.js';
import { TaskServer } from '../../server.js';
import { TestRedisServer } from '../helpers/test-redis.js';

function redisConnectionFromUrl(url: string) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port),
    maxRetriesPerRequest: null as null,
  };
}

function createLargeText(charCount = 400): string {
  return 'payload:'.repeat(Math.ceil(charCount / 8)).slice(0, charCount);
}

function createLargeEmbedding(length = 600): number[] {
  return Array.from({ length }, (_, i) => i * 0.001);
}

function jobHashKey(queuePrefix: string, queueName: string, jobId: string): string {
  return `${queuePrefix}:${queueName}:${jobId}`;
}

describe('dataStore integration', () => {
  let redisServer: TestRedisServer | null;
  let server: TaskServer | null;

  beforeAll(async () => {
    redisServer = globalThis.__REDIS_SERVER__ || new TestRedisServer();
    if (!globalThis.__REDIS_SERVER__) {
      try {
        await redisServer.start();
      }
      catch {
        redisServer = null;
      }
    }
  });

  beforeEach(async () => {
    if (!redisServer) {
      return;
    }
    await redisServer.flushAll();
    server = null;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  afterAll(async () => {
    if (!globalThis.__REDIS_SERVER__ && redisServer) {
      await redisServer.stop();
    }
  });

  async function createServer(
    groups: ReturnType<typeof defineTaskGroupRegistry>,
  ): Promise<TaskServer> {
    if (!redisServer) {
      throw new Error('Redis not available');
    }
    const redisUrl = await redisServer.getRedisUrl();
    const instance = new TaskServer(
      {
        ...redisConnectionFromUrl(redisUrl),
        handleGlobalErrors: false,
        logger: pino({ level: 'silent' }),
        dataStore: {
          enabled: true,
          mode: 'large',
          thresholdBytes: 128,
          compress: false,
        },
        stepStateStore: {
          namespace: 'state',
        },
      },
      groups,
    );
    await instance.start();
    return instance;
  }

  it('spills large payloads on add and hydrates them in the worker', async () => {
    if (!redisServer) {
      return;
    }

    let receivedTextLength = 0;

    const dsGroup = defineTaskGroup({
      tasks: {
        payloadTask: defineTask({
          id: 'payload-task',
          handler: async (options) => {
            receivedTextLength = (options.payload as { text: string }).text.length;
            return 'ok';
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ dsGroup }));
    const task = server.taskGroups.dsGroup.tasks.payloadTask;
    const payload = { text: createLargeText(400) };

    const job = await task.run(payload);
    expect(job.id).toBeDefined();

    const redis = await redisServer.getRedisClient();
    const queueName = 'dsGroup.payloadTask';
    const rawData = await redis.hget(
      jobHashKey(server.queuePrefix, queueName, job.id!),
      'data',
    );

    expect(rawData).toContain('"_torotaskDataRef"');
    expect(rawData).not.toContain(payload.text);

    await job.waitUntilFinished(task.queue.queueEvents);
    expect(receivedTextLength).toBe(400);

    const dataKeys = await redis.keys(`${server.prefix}:data:*`);
    expect(dataKeys.length).toBeGreaterThan(0);
  });

  it('spills large return values on complete and hydrates via getResult', async () => {
    if (!redisServer) {
      return;
    }

    const embedding = createLargeEmbedding(800);

    const dsGroup = defineTaskGroup({
      tasks: {
        returnTask: defineTask({
          id: 'return-task',
          handler: async () => {
            return { embedding };
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ dsGroup }));
    const task = server.taskGroups.dsGroup.tasks.returnTask;

    const job = await task.run({});
    await job.waitUntilFinished(task.queue.queueEvents);

    const redis = await redisServer.getRedisClient();
    const queueName = 'dsGroup.returnTask';
    const rawReturn = await redis.hget(
      jobHashKey(server.queuePrefix, queueName, job.id!),
      'returnvalue',
    );

    expect(rawReturn).toContain('"_torotaskDataRef"');
    expect(rawReturn).not.toContain('"embedding"');

    const result = await job.getResult() as { embedding: number[] };
    expect(result.embedding).toHaveLength(800);
    expect(isToroTaskDataRef(job.returnvalue)).toBe(false);
  });

  it('spills child return values into the parent processed set as refs', async () => {
    if (!redisServer) {
      return;
    }

    const dsGroup = defineTaskGroup({
      tasks: {
        childTask: defineTask({
          id: 'child-task',
          handler: async (options) => {
            const text = (options.payload as { text: string }).text;
            return {
              embedding: createLargeEmbedding(700),
              textLength: text.length,
            };
          },
        }),
        parentTask: defineTask({
          id: 'parent-task',
          handler: async (_options, context) => {
            const { step } = context;
            const childResult = await step.runGroupTaskAndWait(
              'invoke-child',
              'childTask',
              { text: createLargeText(350) },
            ) as { embedding: number[]; textLength: number };

            return {
              childDims: childResult.embedding.length,
              childTextLength: childResult.textLength,
            };
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ dsGroup }));
    const parentTask = server.taskGroups.dsGroup.tasks.parentTask;

    const parentJob = await parentTask.run({});
    await parentJob.waitUntilFinished(parentTask.queue.queueEvents);

    const parentResult = await parentJob.getResult() as {
      childDims: number;
      childTextLength: number;
    };
    expect(parentResult.childDims).toBe(700);
    expect(parentResult.childTextLength).toBe(350);

    const redis = await redisServer.getRedisClient();
    const parentQueue = 'dsGroup.parentTask';
    const childQueue = 'dsGroup.childTask';

    const processedKey = `${server.queuePrefix}:${parentQueue}:${parentJob.id}:processed`;
    const processedEntries = await redis.hgetall(processedKey);
    const processedValues = Object.values(processedEntries);
    const processedFields = Object.keys(processedEntries);

    expect(processedFields.length).toBeGreaterThan(0);
    expect(
      processedValues.some(value => value.includes('"_torotaskDataRef"')),
    ).toBe(true);
    expect(
      processedValues.some(value => value.includes('"embedding"')),
    ).toBe(false);

    const childField = processedFields.find(field => field.includes('childTask'));
    expect(childField).toBeDefined();
    const childId = childField!.split(':').pop();
    expect(childId).toBeDefined();

    const childRawReturn = await redis.hget(
      jobHashKey(server.queuePrefix, childQueue, childId!),
      'returnvalue',
    );
    expect(childRawReturn).toContain('"_torotaskDataRef"');

    const stepStateKey = `${server.prefix}:state:${parentQueue}:${parentJob.id}`;
    const stepFields = await redis.hkeys(stepStateKey);
    expect(stepFields.length).toBeGreaterThan(0);
  });

  it('hydrates small payloads without corrupting fields when dataStore is enabled', async () => {
    if (!redisServer) {
      return;
    }

    let received: { label: string; count: number; createdAt: string } | undefined;

    const dsGroup = defineTaskGroup({
      tasks: {
        smallTask: defineTask({
          id: 'small-task',
          handler: async (options) => {
            received = options.payload as typeof received;
            return 'ok';
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ dsGroup }));
    const task = server.taskGroups.dsGroup.tasks.smallTask;

    const job = await task.run({
      label: 'test',
      count: 42,
      createdAt: '2026-03-01T10:00:00.000Z',
    });
    await job.waitUntilFinished(task.queue.queueEvents);

    expect(received).toEqual({
      label: 'test',
      count: 42,
      createdAt: '2026-03-01T10:00:00.000Z',
    });
    expect(isToroTaskDataRef(job.data?.payload)).toBe(false);
  });

  it('completes jobs that return undefined when dataStore is enabled', async () => {
    if (!redisServer) {
      return;
    }

    const dsGroup = defineTaskGroup({
      tasks: {
        voidTask: defineTask({
          id: 'void-task',
          handler: async () => {
            // No return value.
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ dsGroup }));
    const task = server.taskGroups.dsGroup.tasks.voidTask;

    const job = await task.run({});
    await expect(job.waitUntilFinished(task.queue.queueEvents)).resolves.toBeUndefined();
  });
});
