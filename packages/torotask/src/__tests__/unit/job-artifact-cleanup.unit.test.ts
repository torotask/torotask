import type { Redis } from 'ioredis';
import type { ToroTask } from '../../client.js';
import { RedisDataStore } from '../../data-store/redis-data-store.js';
import { RedisStepStateStore } from '../../stores/redis-step-state-store.js';
import {
  cleanupOrphanedJobArtifacts,
  clearJobArtifacts,
  escapeRedisGlob,
  jobPresence,
} from '../../utils/job-artifact-cleanup.js';

type PipelineMode = 'ok' | 'commandError' | 'nullReply' | 'throws';

function createMockRedis(options?: { pipelineMode?: PipelineMode }) {
  const mode: PipelineMode = options?.pipelineMode ?? 'ok';
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const sets = new Map<string, Set<string>>();

  const existsCount = (key: string) => (strings.has(key) || hashes.has(key) || sets.has(key) ? 1 : 0);

  const hsetnxImpl = (key: string, field: string, value: string) => {
    if (!hashes.has(key)) {
      hashes.set(key, new Map());
    }
    const hash = hashes.get(key)!;
    if (hash.has(field)) {
      return 0;
    }
    hash.set(field, value);
    return 1;
  };

  const hsetImpl = (key: string, field: string, value: string) => {
    if (!hashes.has(key)) {
      hashes.set(key, new Map());
    }
    hashes.get(key)!.set(field, value);
    return 1;
  };

  const saddImpl = (key: string, member: string) => {
    if (!sets.has(key)) {
      sets.set(key, new Set());
    }
    sets.get(key)!.add(member);
    return 1;
  };

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
    hset: jest.fn(async (key: string, field: string, value: string) => hsetImpl(key, field, value)),
    sadd: jest.fn(async (key: string, member: string) => saddImpl(key, member)),
    smembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    set: jest.fn(async (key: string, value: string) => {
      strings.set(key, value);
      return 'OK';
    }),
    hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.get(field) ?? null),
    hgetall: jest.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map())),
    hsetnx: jest.fn(async (key: string, field: string, value: string) => hsetnxImpl(key, field, value)),
    expire: jest.fn(async () => 1),
    multi: jest.fn(() => {
      const queued: Array<() => unknown> = [];
      const chain: any = {
        sadd(key: string, member: string) {
          queued.push(() => saddImpl(key, member));
          return chain;
        },
        hset(key: string, field: string, value: string) {
          queued.push(() => hsetImpl(key, field, value));
          return chain;
        },
        hsetnx(key: string, field: string, value: string) {
          queued.push(() => hsetnxImpl(key, field, value));
          return chain;
        },
        exec: jest.fn(async () => queued.map(run => [null, run()] as [null, unknown])),
      };
      return chain;
    }),
    pipeline: jest.fn(() => {
      const queued: Array<() => unknown> = [];
      const chain: any = {
        exists(key: string) {
          queued.push(() => existsCount(key));
          return chain;
        },
        hget(key: string, field: string) {
          queued.push(() => hashes.get(key)?.get(field) ?? null);
          return chain;
        },
        exec: jest.fn(async () => {
          switch (mode) {
            case 'throws':
              throw new Error('connection lost');
            case 'nullReply':
              return null;
            case 'commandError':
              return queued.map(() => [new Error('READONLY'), null] as [Error, null]);
            default:
              return queued.map(run => [null, run()] as [null, unknown]);
          }
        }),
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

      let destroyed = false;
      return {
        destroy: () => {
          destroyed = true;
        },
        // Deliberately yields in small batches so budget/backpressure paths are exercised.
        async* [Symbol.asyncIterator]() {
          for (let i = 0; i < matchingKeys.length; i += 2) {
            if (destroyed) {
              return;
            }
            yield matchingKeys.slice(i, i + 2);
          }
        },
      };
    }),
  };

  return {
    redis: redis as unknown as Redis,
    strings,
    hashes,
    sets,
  };
}

const PREFIX = 'torotask';
const QUEUE_PREFIX = 'torotask:tasks';

function createMockTaskClient(redis: Redis): ToroTask {
  const stepStore = new RedisStepStateStore(redis, PREFIX, { namespace: 'state' });
  const dataStore = new RedisDataStore(redis, PREFIX, { enabled: true, namespace: 'data', mode: 'all' });

  return {
    prefix: PREFIX,
    queuePrefix: QUEUE_PREFIX,
    redis,
    getStepStateStore: () => stepStore,
    getDataStore: () => dataStore,
    getOrphanCleanupOptions: () => ({
      enabled: true,
      cron: '17 * * * *',
      maxDeletions: 10_000,
      maxDurationMs: 60_000,
      minArtifactAgeMs: 3_600_000,
    }),
  } as unknown as ToroTask;
}

describe('jobArtifactCleanup', () => {
  const queueName = 'lexonis.competenciesCharacteristics';

  /**
   * The sweep refuses to touch a queue until it has confirmed the queue's job hashes
   * really live under the client's prefix, which it does by probing the `meta` key.
   */
  function seedQueueMeta(strings: Map<string, string>, queue: string = queueName): void {
    strings.set(`${QUEUE_PREFIX}:${queue}:meta`, '1');
  }

  function jobKey(queue: string, jobId: string): string {
    return `${QUEUE_PREFIX}:${queue}:${jobId}`;
  }

  it('escapes Redis SCAN glob metacharacters', () => {
    expect(escapeRedisGlob('lexonis.competenciesCharacteristics')).toBe(
      'lexonis.competenciesCharacteristics',
    );
    expect(escapeRedisGlob('foo*bar?[x]')).toBe('foo\\*bar\\?\\[x\\]');
  });

  describe('jobPresence', () => {
    it('classifies existing and missing keys', async () => {
      const { redis, strings } = createMockRedis();
      strings.set('present-key', '1');

      const presence = await jobPresence(redis as any, ['present-key', 'missing-key']);

      expect(presence.get('present-key')).toBe('present');
      expect(presence.get('missing-key')).toBe('absent');
    });

    it('treats non 0/1 EXISTS replies as unknown', async () => {
      const { redis } = createMockRedis();
      (redis as any).pipeline = () => ({
        exists() {
          return this;
        },
        exec: async () => [
          [null, null],
          [null, ''],
          [null, false],
          [null, -1],
        ],
      });

      const presence = await jobPresence(redis as any, ['a', 'b', 'c', 'd']);

      // Number(null|''|false) is 0 and would coerce to 'absent', authorising a delete.
      for (const key of ['a', 'b', 'c', 'd']) {
        expect(presence.get(key)).toBe('unknown');
      }
    });

    it.each<[string, PipelineMode]>([
      ['a per-command error', 'commandError'],
      ['a null pipeline reply', 'nullReply'],
      ['a thrown pipeline error', 'throws'],
    ])('fails closed on %s', async (_label, pipelineMode) => {
      const { redis } = createMockRedis({ pipelineMode });

      const presence = await jobPresence(redis as any, ['some-key']);

      // Never 'absent': an unreadable reply must not authorise a delete.
      expect(presence.get('some-key')).toBe('unknown');
    });
  });

  describe('clearJobArtifacts', () => {
    it('removes step state and data blobs', async () => {
      const { redis, hashes, strings, sets } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
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

      await expect(clearJobArtifacts(taskClient, queueName, jobId)).resolves.toBe(2);

      expect(hashes.has(stepKey)).toBe(false);
      expect(strings.has(dataKey)).toBe(false);
      expect(sets.has(indexKey)).toBe(false);
    });

    it('clears step state but defers blobs while a referrer job is still alive', async () => {
      const { redis, hashes, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      const jobId = 'child-1';
      const parentKey = jobKey('parent.queue', 'parent-1');

      strings.set(parentKey, 'live-parent');
      await taskClient.getStepStateStore().saveStep(queueName, jobId, 'step-1', {
        status: 'completed',
        data: {},
      });
      await taskClient.getDataStore()!.externalize(
        { queueName, jobId, kind: 'returnValue', referrerJobKey: parentKey },
        { large: 'payload' },
      );

      const cleared = await clearJobArtifacts(taskClient, queueName, jobId, { respectReferrer: true });

      expect(cleared).toBe(1);
      expect(hashes.has(`torotask:state:${queueName}:${jobId}`)).toBe(false);
      // The parent's `processed` hash still holds this ref, so the blob must survive.
      expect(strings.has(`torotask:data:${queueName}:${jobId}:returnValue`)).toBe(true);
    });

    it('clears blobs once the referrer job is gone', async () => {
      const { redis, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      const jobId = 'child-1';
      const parentKey = jobKey('parent.queue', 'parent-1');

      await taskClient.getDataStore()!.externalize(
        { queueName, jobId, kind: 'returnValue', referrerJobKey: parentKey },
        { large: 'payload' },
      );

      await clearJobArtifacts(taskClient, queueName, jobId, { respectReferrer: true, minArtifactAgeMs: 0 });

      expect(strings.has(`torotask:data:${queueName}:${jobId}:returnValue`)).toBe(false);
    });

    it('applies the retention window to explicit removal, not just the sweep', async () => {
      const { redis, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      const jobId = 'child-1';

      await taskClient.getDataStore()!.externalize(
        { queueName, jobId, kind: 'returnValue' },
        { large: 'payload' },
      );

      // No referrer and no job record, but the `completed` event may still be unread.
      // job.remove() / queue.clean() must honour the same window the sweep does.
      const cleared = await clearJobArtifacts(taskClient, queueName, jobId, { respectReferrer: true });

      expect(cleared).toBe(1);
      expect(strings.has(`torotask:data:${queueName}:${jobId}:returnValue`)).toBe(true);
    });
  });

  describe('cleanupOrphanedJobArtifacts', () => {
    it('removes artifacts when the BullMQ job hash is gone', async () => {
      const { redis, hashes, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);

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

      strings.set(jobKey(queueName, 'kept-1'), 'job-record');

      const result = await cleanupOrphanedJobArtifacts(taskClient, { queueName, minArtifactAgeMs: 0 });

      expect(result.removed).toBe(2);
      expect(result.truncated).toBe(false);
      expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(false);
      expect(strings.has(`torotask:data:${queueName}:orphan-2:payload`)).toBe(false);
      expect(hashes.has(`torotask:state:${queueName}:kept-1`)).toBe(true);
      expect(hashes.has('torotask:state:other.queue:orphan-other')).toBe(true);
    });

    it('sweeps every queue when no queue name is given', async () => {
      const { redis, hashes, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);
      seedQueueMeta(strings, 'other.queue');

      await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
        status: 'completed',
        data: {},
      });
      await taskClient.getStepStateStore().saveStep('other.queue', 'orphan-other', 'step-1', {
        status: 'completed',
        data: {},
      });

      const result = await cleanupOrphanedJobArtifacts(taskClient, { minArtifactAgeMs: 0 });

      expect(result.removed).toBe(2);
      expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(false);
      expect(hashes.has('torotask:state:other.queue:orphan-other')).toBe(false);
    });

    it('preserves artifacts for job ids that contain colons', async () => {
      const { redis, hashes, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);
      const jobId = 'repeat:abc123:1710000000000';

      await taskClient.getStepStateStore().saveStep(queueName, jobId, 'step-1', {
        status: 'completed',
        data: {},
      });
      strings.set(jobKey(queueName, jobId), 'job-record');

      const result = await cleanupOrphanedJobArtifacts(taskClient, { minArtifactAgeMs: 0 });

      expect(result.removed).toBe(0);
      expect(hashes.has(`torotask:state:${queueName}:${jobId}`)).toBe(true);
    });

    it('refuses to sweep a queue whose key prefix cannot be confirmed', async () => {
      const { redis, hashes } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      // No `meta` key seeded: the queue may live under a caller-supplied prefix, so its
      // job hashes are not where we would look and "absent" would be a false positive.
      await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
        status: 'completed',
        data: {},
      });

      const result = await cleanupOrphanedJobArtifacts(taskClient, { minArtifactAgeMs: 0 });

      expect(result.removed).toBe(0);
      expect(result.skipped).toBeGreaterThan(0);
      expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(true);
    });

    it('deletes nothing when Redis cannot answer EXISTS', async () => {
      const { redis, hashes } = createMockRedis({ pipelineMode: 'commandError' });
      const taskClient = createMockTaskClient(redis);

      await taskClient.getStepStateStore().saveStep(queueName, 'orphan-1', 'step-1', {
        status: 'completed',
        data: {},
      });

      const result = await cleanupOrphanedJobArtifacts(taskClient, { minArtifactAgeMs: 0 });

      expect(result.removed).toBe(0);
      expect(hashes.has(`torotask:state:${queueName}:orphan-1`)).toBe(true);
    });

    it('defers orphaned blobs whose referrer job is still present', async () => {
      const { redis, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);
      const parentKey = jobKey('parent.queue', 'parent-1');
      strings.set(parentKey, 'live-parent');

      await taskClient.getDataStore()!.externalize(
        { queueName, jobId: 'child-1', kind: 'returnValue', referrerJobKey: parentKey },
        { large: 'payload' },
      );
      await taskClient.getDataStore()!.externalize(
        { queueName, jobId: 'child-2', kind: 'returnValue' },
        { large: 'payload' },
      );

      const deferred = await cleanupOrphanedJobArtifacts(taskClient, { queueName, minArtifactAgeMs: 0 });

      expect(deferred.removed).toBe(1);
      expect(strings.has(`torotask:data:${queueName}:child-1:returnValue`)).toBe(true);
      expect(strings.has(`torotask:data:${queueName}:child-2:returnValue`)).toBe(false);

      // Once the parent is trimmed, a later sweep reclaims the deferred blob.
      strings.delete(parentKey);
      const reclaimed = await cleanupOrphanedJobArtifacts(taskClient, { queueName, minArtifactAgeMs: 0 });

      expect(reclaimed.removed).toBe(1);
      expect(strings.has(`torotask:data:${queueName}:child-1:returnValue`)).toBe(false);
    });

    it('retains orphaned blobs that are younger than the retention window', async () => {
      const { redis, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);

      await taskClient.getDataStore()!.externalize(
        { queueName, jobId: 'fresh-1', kind: 'returnValue' },
        { large: 'payload' },
      );

      // The job is gone and nothing references the blob, but a lagging QueueEvents
      // consumer may still be holding the ref from the `completed` event.
      const held = await cleanupOrphanedJobArtifacts(taskClient, { queueName, minArtifactAgeMs: 60_000 });

      expect(held.removed).toBe(0);
      expect(held.skipped).toBeGreaterThan(0);
      expect(strings.has(`torotask:data:${queueName}:fresh-1:returnValue`)).toBe(true);

      const expired = await cleanupOrphanedJobArtifacts(taskClient, { queueName, minArtifactAgeMs: 0 });

      expect(expired.removed).toBe(1);
      expect(strings.has(`torotask:data:${queueName}:fresh-1:returnValue`)).toBe(false);
    });

    it('retains orphaned blobs when the referrer lookup fails', async () => {
      const { redis, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);

      await taskClient.getDataStore()!.externalize(
        { queueName, jobId: 'child-1', kind: 'returnValue' },
        { large: 'payload' },
      );

      const dataStore = taskClient.getDataStore()!;
      jest.spyOn(dataStore, 'readJobMeta').mockRejectedValue(new Error('READONLY'));

      const result = await cleanupOrphanedJobArtifacts(taskClient, { queueName, minArtifactAgeMs: 0 });

      // An unreadable referrer must never be treated as "no referrer".
      expect(result.removed).toBe(0);
      expect(result.skipped).toBeGreaterThan(0);
      expect(strings.has(`torotask:data:${queueName}:child-1:returnValue`)).toBe(true);
    });

    it('dates the retention window from the newest blob, not the earliest', async () => {
      const { redis, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);
      const jobId = 'slow-job';
      const dataStore = taskClient.getDataStore()!;
      const metaKey = `torotask:data-index-meta:${queueName}:${jobId}`;

      // Payload written at enqueue time.
      await dataStore.externalize({ queueName, jobId, kind: 'payload' }, { large: 'payload' });
      // ...the job then queued or ran for longer than the retention window.
      await redis.hset(metaKey, 'createdAt', String(Date.now() - 7_200_000));
      // ...and only now externalizes its return value, which the `completed` event refs.
      await dataStore.externalize({ queueName, jobId, kind: 'returnValue' }, { large: 'result' });

      const result = await cleanupOrphanedJobArtifacts(taskClient, {
        queueName,
        minArtifactAgeMs: 3_600_000,
      });

      // Keeping the earliest timestamp would date the return value from the payload and
      // delete it immediately, which is precisely the blob that needs protecting.
      expect(result.removed).toBe(0);
      expect(result.skipped).toBeGreaterThan(0);
      expect(strings.has(`torotask:data:${queueName}:${jobId}:returnValue`)).toBe(true);
    });

    it('gives blobs that predate metadata tracking one window of grace', async () => {
      const { redis, strings, hashes } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);
      const jobId = 'legacy-1';
      const metaKey = `torotask:data-index-meta:${queueName}:${jobId}`;

      await taskClient.getDataStore()!.externalize(
        { queueName, jobId, kind: 'returnValue' },
        { large: 'payload' },
      );
      // Simulate an index written before createdAt was tracked.
      hashes.delete(metaKey);

      const first = await cleanupOrphanedJobArtifacts(taskClient, {
        queueName,
        minArtifactAgeMs: 3_600_000,
      });

      expect(first.removed).toBe(0);
      expect(first.skipped).toBeGreaterThan(0);
      expect(strings.has(`torotask:data:${queueName}:${jobId}:returnValue`)).toBe(true);
      // Stamped on first sight so it ages out normally instead of being stranded.
      expect(hashes.get(metaKey)?.get('createdAt')).toBeDefined();

      // Once the stamp is older than the window it is reclaimed.
      hashes.get(metaKey)!.set('createdAt', String(Date.now() - 7_200_000));
      const second = await cleanupOrphanedJobArtifacts(taskClient, {
        queueName,
        minArtifactAgeMs: 3_600_000,
      });

      expect(second.removed).toBe(1);
      expect(strings.has(`torotask:data:${queueName}:${jobId}:returnValue`)).toBe(false);
    });

    it('stops at maxDeletions and reports the sweep as truncated', async () => {
      const { redis, strings } = createMockRedis();
      const taskClient = createMockTaskClient(redis);
      seedQueueMeta(strings);

      for (let i = 0; i < 6; i++) {
        await taskClient.getStepStateStore().saveStep(queueName, `orphan-${i}`, 'step-1', {
          status: 'completed',
          data: {},
        });
      }

      const result = await cleanupOrphanedJobArtifacts(taskClient, { queueName, maxDeletions: 2, minArtifactAgeMs: 0 });

      expect(result.removed).toBe(2);
      expect(result.truncated).toBe(true);

      // Idempotent: the remainder is picked up by the next run.
      const rest = await cleanupOrphanedJobArtifacts(taskClient, { queueName, minArtifactAgeMs: 0 });
      expect(rest.removed).toBe(4);
    });
  });
});
