/**
 * Integration tests for StepExecutor
 * These tests use real Redis to test actual functionality
 */

import { TestRedisServer } from '../helpers/test-redis.js';
import { createMockRedisConfig } from '../helpers/mock-factories.js';
import { waitFor, delay } from '../helpers/test-utils.js';

describe('StepExecutor - Integration Tests', () => {
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

  describe('Redis connectivity', () => {
    it('should connect to test Redis instance', async () => {
      if (!redisServer) {
        console.log('Redis not available, skipping test');
        return;
      }

      const redis = await redisServer.getRedisClient();

      // Test basic Redis operations
      await redis.set('test-key', 'test-value');
      const value = await redis.get('test-key');

      expect(value).toBe('test-value');
    });

    it('should handle Redis URLs correctly', async () => {
      if (!redisServer) {
        console.log('Redis not available, skipping test');
        return;
      }

      const redisUrl = await redisServer.getRedisUrl();

      expect(redisUrl).toMatch(/^redis:\/\/127\.0\.0\.1:\d+$/);
    });

    it('should flush database correctly', async () => {
      if (!redisServer) {
        console.log('Redis not available, skipping test');
        return;
      }

      const redis = await redisServer.getRedisClient();

      // Add some test data
      await redis.set('key1', 'value1');
      await redis.set('key2', 'value2');

      // Verify data exists
      const keys = await redis.keys('*');
      expect(keys).toHaveLength(2);

      // Flush and verify empty
      await redisServer.flushAll();
      const keysAfterFlush = await redis.keys('*');
      expect(keysAfterFlush).toHaveLength(0);
    });
  });

  describe('BullMQ integration preparation', () => {
    it('should be ready for BullMQ queue operations', async () => {
      if (!redisServer) {
        console.log('Redis not available, skipping test');
        return;
      }

      const redis = await redisServer.getRedisClient();

      // Test that Redis supports the operations BullMQ needs
      await redis.hset('test-hash', 'field1', 'value1');
      const hashValue = await redis.hget('test-hash', 'field1');
      expect(hashValue).toBe('value1');

      // Test list operations
      await redis.lpush('test-list', 'item1', 'item2');
      const listLength = await redis.llen('test-list');
      expect(listLength).toBe(2);

      // Test key expiration
      await redis.set('expiring-key', 'value', 'EX', 1);
      const beforeExpiry = await redis.get('expiring-key');
      expect(beforeExpiry).toBe('value');

      // Wait for expiration and verify
      await delay(1100);
      const afterExpiry = await redis.get('expiring-key');
      expect(afterExpiry).toBeNull();
    });
  });
});

// TODO: Once the core API issues are resolved, add these tests:
// - Step execution with real task instances
// - Step state persistence in Redis
// - Sleep functionality with delayed jobs
// - Task-to-task communication via runTask
// - Error handling and job failures
