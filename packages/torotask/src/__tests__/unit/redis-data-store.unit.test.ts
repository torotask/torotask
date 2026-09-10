import type { Redis } from 'ioredis';
import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isToroTaskDataRef } from '../../data-store/data-ref.js';
import { RedisDataStore } from '../../data-store/redis-data-store.js';
import { DEFAULT_DATA_STORE_THRESHOLD_BYTES } from '../../types/data-store.js';

function createMockRedis() {
  const strings = new Map<string, Buffer>();
  const sets = new Map<string, Set<string>>();
  const hashes = new Map<string, Map<string, string>>();

  const saddImpl = (key: string, member: string) => {
    if (!sets.has(key)) {
      sets.set(key, new Set());
    }
    sets.get(key)!.add(member);
    return 1;
  };

  const hsetImpl = (key: string, field: string, value: string, nx = false) => {
    if (!hashes.has(key)) {
      hashes.set(key, new Map());
    }
    const hash = hashes.get(key)!;
    if (nx && hash.has(field)) {
      return 0;
    }
    hash.set(field, value);
    return 1;
  };

  const redis = {
    multi: jest.fn(() => {
      const queued: Array<() => unknown> = [];
      const chain: any = {
        sadd: (key: string, member: string) => {
          queued.push(() => saddImpl(key, member));
          return chain;
        },
        hset: (key: string, f: string, v: string) => {
          queued.push(() => hsetImpl(key, f, v));
          return chain;
        },
        hsetnx: (key: string, f: string, v: string) => {
          queued.push(() => hsetImpl(key, f, v, true));
          return chain;
        },
        exec: jest.fn(async () => queued.map(run => [null, run()] as [null, unknown])),
      };
      return chain;
    }),
    hgetall: jest.fn(async (key: string) => Object.fromEntries(hashes.get(key) ?? new Map())),
    set: jest.fn(async (key: string, value: Buffer) => {
      strings.set(key, value);
      return 'OK';
    }),
    getBuffer: jest.fn(async (key: string) => strings.get(key) ?? null),
    del: jest.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) {
        if (strings.delete(key)) {
          removed++;
        }
        if (sets.delete(key)) {
          removed++;
        }
        if (hashes.delete(key)) {
          removed++;
        }
      }
      return removed;
    }),
    sadd: jest.fn(async (key: string, member: string) => saddImpl(key, member)),
    smembers: jest.fn(async (key: string) => Array.from(sets.get(key) ?? [])),
    _strings: strings,
    _sets: sets,
  };

  return {
    redis: redis as unknown as Redis,
    strings,
    sets,
  };
}

describe('redisDataStore', () => {
  const prefix = 'torotask';
  const queueName = 'exampleGroup.embed';
  const jobId = 'job-456';

  it('keeps small values inline when mode is large', async () => {
    const { redis } = createMockRedis();
    const store = new RedisDataStore(redis, prefix, {
      enabled: true,
      mode: 'large',
      thresholdBytes: DEFAULT_DATA_STORE_THRESHOLD_BYTES,
    });

    const value = { text: 'hello' };
    const externalized = await store.externalize(
      { queueName, jobId, kind: 'payload' },
      value,
    );

    expect(externalized).toEqual(value);
    expect(isToroTaskDataRef(externalized)).toBe(false);
  });

  it('externalizes, compresses, resolves, and clears large values', async () => {
    const { redis, strings, sets } = createMockRedis();
    const store = new RedisDataStore(redis, prefix, {
      enabled: true,
      mode: 'large',
      thresholdBytes: 32,
      compress: true,
      minCompressBytes: 0,
    });

    const value = { embedding: 'x'.repeat(200) };
    const externalized = await store.externalize(
      { queueName, jobId, kind: 'returnValue' },
      value,
    );

    expect(isToroTaskDataRef(externalized)).toBe(true);
    if (!isToroTaskDataRef(externalized)) {
      throw new Error('expected data ref');
    }

    expect(externalized.compressed).toBe(true);
    expect(strings.size).toBe(1);

    const stored = [...strings.values()][0];
    expect(stored.equals(gzipSync(Buffer.from(JSON.stringify(value), 'utf8')))).toBe(true);

    const indexKey = `torotask:data-index:${queueName}:${jobId}`;
    expect(sets.get(indexKey)?.size).toBe(1);

    const resolved = await store.resolve(externalized);
    expect(resolved).toEqual(value);

    await store.clearJob(queueName, jobId);
    expect(strings.size).toBe(0);
    expect(sets.has(indexKey)).toBe(false);
  });

  it('resolveDeep preserves Date instances in payloads', async () => {
    const { redis } = createMockRedis();
    const store = new RedisDataStore(redis, prefix, { enabled: true, mode: 'all', compress: false });

    const createdAt = new Date('2026-01-15T12:00:00.000Z');
    const payload = { name: 'Hello World', createdAt };
    const resolved = await store.resolveDeep(payload);

    expect(resolved.createdAt).toBeInstanceOf(Date);
    expect((resolved.createdAt as Date).toISOString()).toBe(createdAt.toISOString());
  });

  it('resolves refs nested in objects', async () => {
    const { redis } = createMockRedis();
    const store = new RedisDataStore(redis, prefix, {
      enabled: true,
      mode: 'all',
      compress: false,
    });

    const value = { items: [{ score: 1 }, { score: 2 }] };
    const ref = await store.externalize(
      { queueName, jobId, kind: 'stepData', stepId: 'step1_0' },
      value,
    );

    const resolved = await store.resolveDeep({ nested: { result: ref } });
    expect(resolved).toEqual({ nested: { result: value } });
  });

  it('decodeBuffer round-trips uncompressed payloads', () => {
    const { redis } = createMockRedis();
    const store = new RedisDataStore(redis, prefix, { enabled: true, compress: false });
    const json = JSON.stringify({ ok: true });
    const buffer = Buffer.from(json, 'utf8');
    expect(store.decodeBuffer(buffer, false)).toBe(json);
    expect(store.decodeBuffer(gzipSync(buffer), true)).toBe(json);
    expect(gunzipSync(gzipSync(buffer)).toString('utf8')).toBe(json);
  });
});
