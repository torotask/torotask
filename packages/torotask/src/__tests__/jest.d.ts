/// <reference types="jest" />

import { TestRedisServer } from './helpers/test-redis.js';

// Extend Jest global for better typing
declare global {
  var __REDIS_SERVER__: TestRedisServer | undefined;
}

export {};
