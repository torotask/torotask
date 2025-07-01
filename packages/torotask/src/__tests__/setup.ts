import { TestRedisServer } from './helpers/test-redis.js';

// Extend Jest global for better typing
declare global {
  var __REDIS_SERVER__: TestRedisServer | undefined;
}

// Suppress console.debug during tests for cleaner output
beforeAll(() => {
  // Mock console.debug to be silent during tests
  console.debug = jest.fn();

  // Restore original after tests if needed for debugging
  // Uncomment the next lines if you need to see debug logs:
  // const originalDebug = console.debug;
  // console.debug = originalDebug;
});

// Global test timeout for integration tests
jest.setTimeout(30000);

// Global Redis server for integration tests
let globalRedisServer: TestRedisServer | null = null;

// Setup global Redis server before all tests
beforeAll(async () => {
  // Only start Redis for integration tests
  if (process.env.TEST_TYPE === 'integration' || process.env.NODE_ENV === 'test') {
    globalRedisServer = new TestRedisServer();
    await globalRedisServer.start();

    // Set environment variable for Redis connection
    process.env.REDIS_URL = await globalRedisServer.getRedisUrl();

    // Store globally for access in tests
    globalThis.__REDIS_SERVER__ = globalRedisServer;
  }
});

// Cleanup global Redis server after all tests
afterAll(async () => {
  if (globalRedisServer) {
    await globalRedisServer.stop();
    globalRedisServer = null;
    globalThis.__REDIS_SERVER__ = undefined;
  }
});

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
