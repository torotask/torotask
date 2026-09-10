/**
 * Integration tests for orphaned artifact reclamation against a real Redis.
 *
 * The unit tests drive a hand-written `scanStream` mock, so these exercise the
 * real ioredis SCAN stream, the real key layout produced by the stores, and the
 * real BullMQ trimming behaviour that motivated the sweep in the first place.
 */

import pino from 'pino';
import { isToroTaskDataRef } from '../../data-store/data-ref.js';
import { defineTask, defineTaskGroup, defineTaskGroupRegistry } from '../../functions.js';
import { MAINTENANCE_GROUP_ID, ORPHAN_CLEANUP_TASK_ID } from '../../maintenance.js';
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

function createLargeEmbedding(length = 600): number[] {
  return Array.from({ length }, (_, i) => i * 0.001);
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}

describe('orphan cleanup integration', () => {
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
    overrides?: { maintenance?: any; autoStart?: boolean },
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
        stepStateStore: { namespace: 'state' },
        // The cron-driven sweep is exercised directly here; leaving the scheduler
        // registered would add an unrelated queue to every assertion.
        maintenance: overrides?.maintenance ?? { orphanCleanup: false },
      },
      groups,
    );
    if (overrides?.autoStart !== false) {
      await instance.start();
    }
    return instance;
  }

  it('reclaims step state and data blobs left behind by removeOnComplete trimming', async () => {
    if (!redisServer) {
      return;
    }

    let resolveDone: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const cleanupGroup = defineTaskGroup({
      tasks: {
        trimmedTask: defineTask({
          id: 'trimmed-task',
          // This is the exact configuration that leaked: BullMQ deletes the job
          // hash inside Lua and never emits a `removed` event.
          options: { removeOnComplete: true },
          handler: async (_options, context) => {
            const { step } = context;
            const embedding = await step.do('build-embedding', async () => ({
              embedding: createLargeEmbedding(),
            }));
            resolveDone();
            return embedding;
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ cleanupGroup }));
    const task = server.taskGroups.cleanupGroup.tasks.trimmedTask;

    const job = await task.run({});
    const jobId = job.id!;
    await done;

    const redis = await redisServer.getRedisClient();
    const queueName = 'cleanupGroup.trimmedTask';
    const jobHash = `${server.queuePrefix}:${queueName}:${jobId}`;

    // Wait for BullMQ to trim the job hash.
    await waitFor(async () => (await redis.exists(jobHash)) === 0);

    const stepStateKey = `${server.prefix}:state:${queueName}:${jobId}`;
    const dataIndexKey = `${server.prefix}:data-index:${queueName}:${jobId}`;

    // The artifacts outlive the job: this is the leak.
    expect(await redis.exists(stepStateKey)).toBe(1);
    expect(await redis.exists(dataIndexKey)).toBe(1);
    const storageKeys = await redis.smembers(dataIndexKey);
    expect(storageKeys.length).toBeGreaterThan(0);

    const result = await server.cleanupOrphanedJobArtifacts({ minArtifactAgeMs: 0 });

    expect(result.removed).toBeGreaterThan(0);
    expect(result.truncated).toBe(false);
    expect(await redis.exists(stepStateKey)).toBe(0);
    expect(await redis.exists(dataIndexKey)).toBe(0);
    for (const storageKey of storageKeys) {
      expect(await redis.exists(storageKey)).toBe(0);
    }

    // Idempotent: a second sweep finds nothing left to do.
    const second = await server.cleanupOrphanedJobArtifacts({ minArtifactAgeMs: 0 });
    expect(second.removed).toBe(0);
  });

  it('retains a recent completed result after explicit job removal', async () => {
    if (!redisServer) {
      return;
    }

    const expectedResult = { embedding: createLargeEmbedding() };
    const cleanupGroup = defineTaskGroup({
      tasks: {
        retainedResultTask: defineTask({
          id: 'retained-result-task',
          handler: async () => expectedResult,
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ cleanupGroup }));
    const task = server.taskGroups.cleanupGroup.tasks.retainedResultTask;
    const job = await task.run({});
    await job.waitUntilFinished(task.queue.queueEvents);

    const redis = await redisServer.getRedisClient();
    const queueName = 'cleanupGroup.retainedResultTask';
    const dataIndexKey = `${server.prefix}:data-index:${queueName}:${job.id}`;
    const storageKeys = await redis.smembers(dataIndexKey);
    expect(storageKeys.length).toBeGreaterThan(0);

    const eventsKey = `${server.queuePrefix}:${queueName}:events`;
    const entries = await redis.xrevrange(eventsKey, '+', '-', 'COUNT', 20);
    const completedEntry = entries.find(([, fields]) => {
      const event = Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, index) => [fields[index * 2], fields[index * 2 + 1]]),
      );
      return event.event === 'completed' && event.jobId === job.id;
    });
    expect(completedEntry).toBeDefined();

    const completedFields = completedEntry![1];
    const completedEvent = Object.fromEntries(
      Array.from(
        { length: completedFields.length / 2 },
        (_, index) => [completedFields[index * 2], completedFields[index * 2 + 1]],
      ),
    );
    const eventResultRef: unknown = JSON.parse(completedEvent.returnvalue);
    expect(isToroTaskDataRef(eventResultRef)).toBe(true);

    // BullMQ leaves the completed event in its stream after explicit removal. Its
    // external result ref must therefore remain resolvable for minArtifactAgeMs.
    await job.remove();

    await expect(server.getDataStore()!.resolve(eventResultRef)).resolves.toEqual(expectedResult);
    expect(await redis.exists(dataIndexKey)).toBe(1);
    for (const storageKey of storageKeys) {
      expect(await redis.exists(storageKey)).toBe(1);
    }
  });

  it('leaves artifacts belonging to a live job untouched', async () => {
    if (!redisServer) {
      return;
    }

    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });

    const cleanupGroup = defineTaskGroup({
      tasks: {
        slowTask: defineTask({
          id: 'slow-task',
          handler: async (_options, context) => {
            const { step } = context;
            await step.do('first-step', async () => ({ embedding: createLargeEmbedding() }));
            started();
            await gate;
            return 'ok';
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ cleanupGroup }));
    const task = server.taskGroups.cleanupGroup.tasks.slowTask;

    const job = await task.run({});
    const jobId = job.id!;
    await running;

    const redis = await redisServer.getRedisClient();
    const queueName = 'cleanupGroup.slowTask';
    const stepStateKey = `${server.prefix}:state:${queueName}:${jobId}`;

    expect(await redis.exists(stepStateKey)).toBe(1);

    // Sweeping mid-execution must not touch a running job's step state, or the
    // completed step would silently re-run.
    const result = await server.cleanupOrphanedJobArtifacts({ minArtifactAgeMs: 0 });

    expect(result.removed).toBe(0);
    expect(await redis.exists(stepStateKey)).toBe(1);

    release!();
  });

  it('preserves artifacts for a locked active job when removal is rejected', async () => {
    if (!redisServer) {
      return;
    }

    let release: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });

    const cleanupGroup = defineTaskGroup({
      tasks: {
        lockedTask: defineTask({
          id: 'locked-task',
          handler: async (_options, context) => {
            await context.step.do('persist-state', async () => ({ embedding: createLargeEmbedding() }));
            started();
            await gate;
            return 'ok';
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ cleanupGroup }));
    const task = server.taskGroups.cleanupGroup.tasks.lockedTask;
    const job = await task.run({ embedding: createLargeEmbedding() });
    await running;

    const redis = await redisServer.getRedisClient();
    const queueName = 'cleanupGroup.lockedTask';
    const jobHash = `${server.queuePrefix}:${queueName}:${job.id}`;
    const stepStateKey = `${server.prefix}:state:${queueName}:${job.id}`;
    const dataIndexKey = `${server.prefix}:data-index:${queueName}:${job.id}`;
    const storageKeys = await redis.smembers(dataIndexKey);

    try {
      await expect(job.remove()).rejects.toThrow(/locked/);
      expect(await redis.exists(jobHash)).toBe(1);
      expect(await redis.exists(stepStateKey)).toBe(1);
      expect(await redis.exists(dataIndexKey)).toBe(1);
      for (const storageKey of storageKeys) {
        expect(await redis.exists(storageKey)).toBe(1);
      }
    }
    finally {
      release!();
      await job.waitUntilFinished(task.queue.queueEvents);
    }
  });

  it('refuses to sweep a queue whose prefix cannot be confirmed', async () => {
    if (!redisServer) {
      return;
    }

    const cleanupGroup = defineTaskGroup({
      tasks: {
        noopTask: defineTask({
          id: 'noop-task',
          handler: async () => 'ok',
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ cleanupGroup }));
    const redis = await redisServer.getRedisClient();

    // Step state for a queue that has no `meta` key under the client prefix: the
    // real queue may live under a caller-supplied prefix, so its job hashes are
    // not where the sweep would look and "absent" would be a false positive.
    await server.getStepStateStore().saveStep('unknown.queue', 'job-1', 'step-1', {
      status: 'completed',
      data: { ok: true },
    });

    const stepStateKey = `${server.prefix}:state:unknown.queue:job-1`;
    expect(await redis.exists(stepStateKey)).toBe(1);

    const result = await server.cleanupOrphanedJobArtifacts({ minArtifactAgeMs: 0 });

    expect(result.removed).toBe(0);
    expect(result.skipped).toBeGreaterThan(0);
    expect(await redis.exists(stepStateKey)).toBe(1);
  });

  it('defers a blob while its parent still references it, then reclaims it', async () => {
    if (!redisServer) {
      return;
    }

    const cleanupGroup = defineTaskGroup({
      tasks: {
        childTask: defineTask({
          id: 'child-task',
          handler: async () => ({ embedding: createLargeEmbedding() }),
        }),
        parentTask: defineTask({
          id: 'parent-task',
          handler: async (_options, context) => {
            const { step } = context;
            const child = await step.runGroupTaskAndWait(
              'invoke-child',
              'childTask',
              {},
            ) as { embedding: number[] };
            return { dims: child.embedding.length };
          },
        }),
      } as const,
    });

    server = await createServer(defineTaskGroupRegistry({ cleanupGroup }));
    const parentTask = server.taskGroups.cleanupGroup.tasks.parentTask;

    const parentJob = await parentTask.run({});
    await parentJob.waitUntilFinished(parentTask.queue.queueEvents);

    const redis = await redisServer.getRedisClient();
    const parentQueue = 'cleanupGroup.parentTask';
    const childQueue = 'cleanupGroup.childTask';

    const processedKey = `${server.queuePrefix}:${parentQueue}:${parentJob.id}:processed`;
    const processedFields = Object.keys(await redis.hgetall(processedKey));
    const childField = processedFields.find(field => field.includes('childTask'));
    expect(childField).toBeDefined();
    const childId = childField!.split(':').pop()!;

    const childIndexKey = `${server.prefix}:data-index:${childQueue}:${childId}`;
    const childStorageKeys = await redis.smembers(childIndexKey);
    expect(childStorageKeys.length).toBeGreaterThan(0);

    // Referrer must have been recorded at write time; it cannot be discovered later.
    const { referrerJobKey: referrer } = await server.getDataStore()!.readJobMeta(childQueue, childId);
    expect(referrer).toBe(`${server.queuePrefix}:${parentQueue}:${parentJob.id}`);

    // Remove only the child job hash, mimicking a trim of the child.
    await redis.del(`${server.queuePrefix}:${childQueue}:${childId}`);

    const deferred = await server.cleanupOrphanedJobArtifacts({ minArtifactAgeMs: 0 });
    expect(deferred.skipped).toBeGreaterThan(0);
    // The parent's `processed` hash still holds the ref, so the blob must survive.
    for (const storageKey of childStorageKeys) {
      expect(await redis.exists(storageKey)).toBe(1);
    }

    // Once the parent is gone the ref is unreachable and the blob is reclaimed.
    await redis.del(`${server.queuePrefix}:${parentQueue}:${parentJob.id}`);
    const reclaimed = await server.cleanupOrphanedJobArtifacts({ minArtifactAgeMs: 0 });
    expect(reclaimed.removed).toBeGreaterThan(0);
    for (const storageKey of childStorageKeys) {
      expect(await redis.exists(storageKey)).toBe(0);
    }
  });

  it('registers the maintenance group only once workers start, and ignores the group filter', async () => {
    if (!redisServer) {
      return;
    }

    const group = defineTaskGroup({
      tasks: {
        noop: defineTask({
          id: 'noop',
          handler: async () => ({ ok: true }),
        }),
      } as const,
    });
    const groups = defineTaskGroupRegistry({ cleanupDemo: group });

    server = await createServer(groups, { maintenance: { orphanCleanup: true }, autoStart: false });

    // Constructing a client must not build the maintenance queue: read-only consumers
    // (dashboards, one-shot producers) would otherwise pay for Redis connections they
    // never use.
    expect(server.getTaskGroup(MAINTENANCE_GROUP_ID)).toBeUndefined();

    // A filter that matches no user group must still leave the cluster with a sweeper.
    await server.start({ groupsById: ['nonexistent'] } as any);

    const maintenance = server.getTaskGroup(MAINTENANCE_GROUP_ID);
    expect(maintenance).toBeDefined();
    expect(maintenance!.tasks[ORPHAN_CLEANUP_TASK_ID]).toBeDefined();

    // A targeted stop is not a shutdown request. It must leave the sweeper, and the
    // client's connections, alone: tearing the server down because a filter matched
    // nothing would be a surprising side effect of asking to stop one group.
    const stopWorkers = jest.spyOn(maintenance!, 'stopWorkers');
    await server.stop({ groupsById: ['nonexistent'] } as any);

    expect(stopWorkers).not.toHaveBeenCalled();
    // Still up: a full shutdown would have closed this connection.
    expect(server.redis.status).toBe('ready');

    // An unfiltered stop is the full shutdown, and must stop maintenance even though
    // start() registered it outside the filter.
    await server.stop();
    server = null;

    expect(stopWorkers).toHaveBeenCalled();
  });
});
