/**
 * Redis integration test
 */

import { TestRedisServer } from '../helpers/test-redis.js';

describe('Redis Integration', () => {
  let redisServer: TestRedisServer | null;

  beforeAll(async () => {
    // Use global Redis server or create new one
    redisServer = globalThis.__REDIS_SERVER__ || new TestRedisServer();
    if (!globalThis.__REDIS_SERVER__) {
      try {
        await redisServer.start();
      } catch (_error) {
        console.log('Redis not available, skipping integration tests');
        redisServer = null;
      }
    }
  });

  afterAll(async () => {
    if (!globalThis.__REDIS_SERVER__ && redisServer) {
      await redisServer.stop();
    }
  });

  beforeEach(async () => {
    // Flush Redis before each test
    if (!redisServer) {
      return;
    }
    await redisServer.flushAll();
  });

  it('should connect to Redis if available', async () => {
    if (!redisServer) {
      console.log('Redis not available, skipping test');
      return;
    }

    const redis = await redisServer.getRedisClient();
    await redis.set('test-key', 'test-value');
    const value = await redis.get('test-key');
    expect(value).toBe('test-value');
  });

  it('should handle Redis operations', async () => {
    if (!redisServer) {
      console.log('Redis not available, skipping test');
      return;
    }

    const redis = await redisServer.getRedisClient();

    // Test hash operations (used by BullMQ)
    await redis.hset('test-hash', 'field1', 'value1');
    const hashValue = await redis.hget('test-hash', 'field1');
    expect(hashValue).toBe('value1');

    // Test list operations
    await redis.lpush('test-list', 'item1', 'item2');
    const listLength = await redis.llen('test-list');
    expect(listLength).toBe(2);
  });
});
