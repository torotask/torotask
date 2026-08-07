import type { Redis } from 'ioredis';
import {
  buildStepStateKey,
  computeStepStateTtlSeconds,
  DEFAULT_ORPHAN_STEP_STATE_TTL_SECONDS,
  RedisStepStateStore,
  STEP_STATE_WAKE_BUFFER_SECONDS,
} from '../../redis-step-state-store.js';

function createMockRedis() {
  const storage: Record<string, Record<string, string>> = {};
  const expireCalls: Array<{ key: string; ttl: number }> = [];

  const redis = {
    exists: jest.fn(async (key: string) => storage[key] ? 1 : 0),
    hgetall: jest.fn(async (key: string) => storage[key] ?? {}),
    hset: jest.fn(async (key: string, field: string, value: string) => {
      if (!storage[key]) {
        storage[key] = {};
      }
      storage[key][field] = value;
      return 1;
    }),
    del: jest.fn(async (key: string) => {
      delete storage[key];
      return 1;
    }),
    multi: jest.fn(() => {
      const commands: Array<() => Promise<void>> = [];
      return {
        hset: jest.fn((key: string, field: string, value: string) => {
          commands.push(async () => {
            if (!storage[key]) {
              storage[key] = {};
            }
            storage[key][field] = value;
          });
        }),
        expire: jest.fn((key: string, ttl: number) => {
          commands.push(async () => {
            expireCalls.push({ key, ttl });
          });
        }),
        exec: jest.fn(async () => {
          for (const command of commands) {
            await command();
          }
          return [];
        }),
      };
    }),
    _storage: storage,
    _expireCalls: expireCalls,
  };

  return {
    redis: redis as unknown as Redis,
    storage,
    expireCalls,
  };
}

describe('redisStepStateStore', () => {
  const prefix = 'torotask';
  const queueName = 'exampleGroup.sayHello';
  const jobId = 'job-123';

  it('builds keys under the torotask prefix', () => {
    expect(buildStepStateKey(prefix, queueName, jobId)).toBe(
      'torotask:state:exampleGroup.sayHello:job-123',
    );
  });

  it('saves and loads individual step fields without TTL by default', async () => {
    const { redis, expireCalls } = createMockRedis();
    const store = new RedisStepStateStore(redis, prefix);

    await store.saveStep(queueName, jobId, 'step1_0', {
      status: 'completed',
      data: { value: 1 },
    });
    await store.saveStep(queueName, jobId, 'step2_0', {
      status: 'completed',
      data: { value: 2 },
    });

    const loaded = await store.loadSteps(queueName, jobId);

    expect(loaded.step1_0).toEqual({ status: 'completed', data: { value: 1 } });
    expect(loaded.step2_0).toEqual({ status: 'completed', data: { value: 2 } });
    expect(expireCalls).toHaveLength(0);
    expect(redis.hset).toHaveBeenCalled();
  });

  it('clears all step state for a job', async () => {
    const { redis } = createMockRedis();
    const store = new RedisStepStateStore(redis, prefix);

    await store.saveStep(queueName, jobId, 'step1_0', { status: 'completed' });
    await store.clear(queueName, jobId);

    expect(await store.exists(queueName, jobId)).toBe(false);
    expect(await store.loadSteps(queueName, jobId)).toEqual({});
  });

  it('sets EXPIRE for sleeping steps based on sleepUntil', async () => {
    const { redis, expireCalls } = createMockRedis();
    const store = new RedisStepStateStore(redis, prefix);
    const sleepUntil = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

    await store.saveStep(queueName, jobId, 'sleep_0', {
      status: 'sleeping',
      sleepUntil,
    });

    expect(expireCalls).toHaveLength(1);
    const expectedMinTtl = Math.ceil(
      (sleepUntil + STEP_STATE_WAKE_BUFFER_SECONDS * 1000 - Date.now()) / 1000,
    );
    expect(expireCalls[0].ttl).toBeGreaterThanOrEqual(expectedMinTtl - 2);
    expect(expireCalls[0].key).toBe(buildStepStateKey(prefix, queueName, jobId));
  });

  it('uses orphan TTL as a floor when configured', async () => {
    const { redis, expireCalls } = createMockRedis();
    const orphanTtl = 3600;
    const store = new RedisStepStateStore(redis, prefix, orphanTtl);

    await store.saveStep(queueName, jobId, 'step1_0', { status: 'completed' });

    expect(expireCalls).toHaveLength(1);
    expect(expireCalls[0].ttl).toBe(orphanTtl);
  });

  it('computeStepStateTtlSeconds extends past wake time for long sleeps', () => {
    const sleepUntil = Date.now() + 60 * 24 * 60 * 60 * 1000; // 60 days
    const ttl = computeStepStateTtlSeconds({ status: 'sleeping', sleepUntil });

    expect(ttl).toBeDefined();
    expect(ttl!).toBeGreaterThan(59 * 24 * 60 * 60);
  });

  it('suggests seven days as optional orphan TTL constant', () => {
    expect(DEFAULT_ORPHAN_STEP_STATE_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
