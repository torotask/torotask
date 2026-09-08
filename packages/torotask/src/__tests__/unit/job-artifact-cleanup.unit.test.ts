import type { Redis } from 'ioredis';
import type { ToroTask } from '../../client.js';
import { EventEmitter } from 'node:events';
import { RedisDataStore } from '../../data-store/redis-data-store.js';
import { RedisStepStateStore } from '../../stores/redis-step-state-store.js';
import {
  cancelOrphanedArtifactCleanup,
  cleanupOrphanedJobArtifacts,
  clearJobArtifacts,
  escapeRedisGlob,
  readJobRecordState,
  scheduleOrphanedArtifactCleanup,
} from '../../utils/job-artifact-cleanup.js';

function createMockRedis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();

  const existsCount = (key: string) => (strings.has(key) || hashes.has(key) || sets.has(key) ? 1 : 0);

  const redis = {
    exists: jest.fn(async (key: string) => existsCount(key)),
    del: jest.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (strings.delete(key)) {
          removed++;
        }
        if (hashes.delete(key)) {
          removed++;
        }
        if (sets.delete(key)) {
          removed++;
        }
      }
      return removed;
    }),
    hset: jest.fn(async (key: string, field: string, value: string) => {
      if (!hashes.has(key)) {
        hashes.set(key, new Map());
      }
      hashes.get(key)!.set(field, value);
      return 1;
    }),
    sadd: jest.fn(async (key: string, member: string) => {
      if (!sets.has(key)) {
        sets.set(key, new Set());
      }
      sets.get(key)!.add(member);
      return 1;
    }),
    smembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    set: jest.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return 'OK';
    }),
    hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.get(field) ?? null),
    pipeline: jest.fn(() => {
      const queued: Array<() => unknown> = [];
      const chain = {
        exists(key: string) {
          queued.push(() => existsCount(key));
          return chain;
        },
        hget(key: string, field: string) {
          queued.push(() => hashes.get(key)?.get(field) ?? null);
          return chain;
        },
        exec: jest.fn(async () => queued.map(run => [null, run()] as [null, unknown])),
      };
      return chain;
    }),
    scanStream: jest.fn(({ match }: { match: string }) => {
      const prefix = match.endsWith('*') ? match.slice(0, -1).replace(/\\/g, '') : match;
      const matchingKeys = [
        ...strings.keys(),
        ...hashes.keys(),
        ...sets.keys(),
      ].filter(key => key.startsWith(prefix));

      const stream = new EventEmitter();
      queueMicrotask(() => {
        if (matchingKeys.length > 0) {
          stream.emit('data', matchingKeys);
        }
        stream.emit('end');
      });
      return stream;
    }),
    _strings: strings,
    _hashes: hashes,
    _sets: sets,
  };

  return {
    redis: redis as unknown as Redis,
    strings,
    hashes,
    sets,
  };
}

function createMockTaskClient(
  redis: Redis,
  orphanCleanup: { enabled: boolean; intervalMs: number } = { enabled: true, intervalMs: 30_000 },
): ToroTask {
  const prefix = 'torotask';
  const queuePrefix = 'torotask:tasks';
  const stepStore = new RedisStepStateStore(redis, prefix, { namespace: 'state' });
  const dataStore = new RedisDataStore(redis, prefix, { enabled: true, namespace: 'data', mode: 'all' });

  return {
    prefix,
    queuePrefix,
    redis,
    getStepStateStore: () => stepStore,
    getDataStore: () => dataStore,
    getOrphanCleanupOptions: () => orphanCleanup,
  } as unknown as ToroTask;
}

describe('jobArtifactCleanup', () => {
  const queueName = 'lexonis.competenciesCharacteristics';
  const clients: ToroTask[] = [];

  function trackedClient(
    redis: Redis,
    orphanCleanup?: { enabled: boolean; intervalMs: number },
  ): ToroTask {
    const client = createMockTaskClient(redis, orphanCleanup);
    clients.push(client);
    return client;
  }

  afterEach(() => {
    clients.splice(0).forEach(cancelOrphanedArtifactCleanup);
    jest.useRealTimers();
  });

  it('escapes Redis SCAN glob metacharacters', () => {
    expect(escapeRedisGlob('lexonis.competenciesCharacteristics')).toBe(
      'lexonis.competenciesCharacteristics',
    );
    expect(escapeRedisGlob('foo*bar?[x]')).toBe('foo\\*bar\\?\\[x\\]');
  });

  it('clearJobArtifacts removes step state and data blobs', async () => {
    const { redis, hashes, strings, sets } = createMockRedis();
    const taskClient = trackedClient(redis);
    const jobId = '42';

    await taskClient.getStepStateStore().saveStep(queueName, jobId, 'step-1', {
      status: 'completed',
      data: { ok: true },
    });
    await taskClient.getDataStore()!.externalize(
      { queueName, jobId, kind: 'returnValue' },
      { large: 'payload' },
    );

    const stepKey = `torotask:state:${queueName}:${jobId}`;
    const dataKey = `torotask:data:${queueName}:${jobId}:returnValue`;
    const indexKey = `torotask:data-index:${queueName}:${jobId}`;

    expect(hashes.has(stepKey)).toBe(true);
    expect(strings.has(dataKey)).toBe(true);
    expect(sets.has(indexKey)).toBe(true);

    await clearJobArtifacts(taskClient, queueName, jobId);

    expect(hashes.has(stepKey)).toBe(false);
    expect(strings.has(dataKey)).toBe(false);
    expect(sets.has(indexKey)).toBe(false);
  });

  it('cleanupOrphanedJobArtifacts removes artifacts when the BullMQ job hash is gone', async () => {
    const { redis, hashes, strings } = createMockRedis();
    const taskClient = trackedClient(redis);

    await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
      status: 'completed',
      data: {},
    });
    await taskClient.getDataStore()!.externalize(
      { queueName, jobId: 'orphan-2', kind: 'payload' },
      { kept: false },
    );
    await taskClient.getStepStateStore().saveStep(queueName, 'kept-1', 'step-1', {
      status: 'completed',
      data: {},
    });
    await taskClient.getStepStateStore().saveStep('other.queue', 'orphan-other', 'step-1', {
      status: 'completed',
      data: {},
    });

    strings.set(`torotask:tasks:${queueName}:kept-1`, 'job-record');

    const removed = await cleanupOrphanedJobArtifacts(taskClient, queueName);

    expect(removed).toBe(2);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(false);
    expect(strings.has(`torotask:data:${queueName}:orphan-2:payload`)).toBe(false);
    expect(hashes.has(`torotask:state:${queueName}:kept-1`)).toBe(true);
    expect(hashes.has('torotask:state:other.queue:orphan-other')).toBe(true);
  });

  it('cleanupOrphanedJobArtifacts without a queue name sweeps every queue', async () => {
    const { redis, hashes } = createMockRedis();
    const taskClient = trackedClient(redis);

    await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
      status: 'completed',
      data: {},
    });
    await taskClient.getStepStateStore().saveStep('other.queue', 'orphan-other', 'step-1', {
      status: 'completed',
      data: {},
    });

    const removed = await cleanupOrphanedJobArtifacts(taskClient);

    expect(removed).toBe(2);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(false);
    expect(hashes.has('torotask:state:other.queue:orphan-other')).toBe(false);
  });

  it('preserves artifacts for custom job ids that contain colons', async () => {
    const { redis, hashes, strings } = createMockRedis();
    const taskClient = trackedClient(redis);
    const jobId = 'repeat:abc123:1710000000000';

    await taskClient.getStepStateStore().saveStep(queueName, jobId, 'step-1', {
      status: 'completed',
      data: {},
    });
    strings.set(`torotask:tasks:${queueName}:${jobId}`, 'job-record');

    const removed = await cleanupOrphanedJobArtifacts(taskClient);

    expect(removed).toBe(0);
    expect(hashes.has(`torotask:state:${queueName}:${jobId}`)).toBe(true);
  });

  it('schedules a trailing sweep instead of scanning on every completion', async () => {
    jest.useFakeTimers();
    const { redis, hashes } = createMockRedis();
    const taskClient = trackedClient(redis);

    await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
      status: 'completed',
      data: {},
    });

    scheduleOrphanedArtifactCleanup(taskClient);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(true);

    await jest.advanceTimersByTimeAsync(29_000);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(true);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(false);
  });

  it('still sweeps within the debounce window while completions keep arriving', async () => {
    jest.useFakeTimers();
    const { redis, hashes } = createMockRedis();
    const taskClient = trackedClient(redis);

    await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
      status: 'completed',
      data: {},
    });

    // A steady stream of completions must not postpone the sweep indefinitely.
    for (let i = 0; i < 6; i++) {
      scheduleOrphanedArtifactCleanup(taskClient);
      await jest.advanceTimersByTimeAsync(5_000);
    }

    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(false);
  });

  it('does not sweep when orphan cleanup is disabled', async () => {
    jest.useFakeTimers();
    const { redis, hashes } = createMockRedis();
    const taskClient = trackedClient(redis, { enabled: false, intervalMs: 30_000 });

    await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
      status: 'completed',
      data: {},
    });

    scheduleOrphanedArtifactCleanup(taskClient);
    await jest.advanceTimersByTimeAsync(120_000);

    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(true);
    expect(redis.scanStream).not.toHaveBeenCalled();
  });

  it('honours a custom sweep interval', async () => {
    jest.useFakeTimers();
    const { redis, hashes } = createMockRedis();
    const taskClient = trackedClient(redis, { enabled: true, intervalMs: 5_000 });

    await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
      status: 'completed',
      data: {},
    });

    scheduleOrphanedArtifactCleanup(taskClient);

    await jest.advanceTimersByTimeAsync(4_000);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(true);

    await jest.advanceTimersByTimeAsync(1_500);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(false);
  });

  it('cancelOrphanedArtifactCleanup prevents a pending sweep from running', async () => {
    jest.useFakeTimers();
    const { redis, hashes } = createMockRedis();
    const taskClient = trackedClient(redis);

    await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
      status: 'completed',
      data: {},
    });

    scheduleOrphanedArtifactCleanup(taskClient);
    cancelOrphanedArtifactCleanup(taskClient);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(true);
  });

  it('keeps sweeps isolated per client', async () => {
    jest.useFakeTimers();
    const first = createMockRedis();
    const second = createMockRedis();
    const clientA = trackedClient(first.redis);
    const clientB = trackedClient(second.redis);

    await clientA.getStepStateStore().saveStep(queueName, 'orphan-a', 'step-1', {
      status: 'completed',
      data: {},
    });
    await clientB.getStepStateStore().saveStep(queueName, 'orphan-b', 'step-1', {
      status: 'completed',
      data: {},
    });

    scheduleOrphanedArtifactCleanup(clientA);
    scheduleOrphanedArtifactCleanup(clientB);
    await jest.advanceTimersByTimeAsync(31_000);

    expect(first.hashes.has(`torotask:state:${queueName}:orphan-a`)).toBe(false);
    expect(second.hashes.has(`torotask:state:${queueName}:orphan-b`)).toBe(false);
  });

  describe('readJobRecordState', () => {
    it('reports missing when removeOnComplete dropped the job hash', async () => {
      const { redis } = createMockRedis();
      const taskClient = trackedClient(redis);

      await expect(readJobRecordState(taskClient, queueName, 'gone')).resolves.toBe('missing');
    });

    it('reports finished for a retained completed job', async () => {
      const { redis } = createMockRedis();
      const taskClient = trackedClient(redis);

      await redis.hset(`torotask:tasks:${queueName}:kept`, 'finishedOn', '1710000000000');

      await expect(readJobRecordState(taskClient, queueName, 'kept')).resolves.toBe('finished');
    });

    it('reports restarted when a new run reused the same job id', async () => {
      const { redis } = createMockRedis();
      const taskClient = trackedClient(redis);

      // Re-added job: hash exists again but has not finished.
      await redis.hset(`torotask:tasks:${queueName}:dedup-id`, 'name', 'task');

      await expect(readJobRecordState(taskClient, queueName, 'dedup-id')).resolves.toBe('restarted');
    });
  });
});
