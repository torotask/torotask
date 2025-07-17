import type { ConnectionOptions as BullMQConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { Redis } from 'ioredis';

/** BullMQ Client Options using intersection */
export type ToroTaskOptions = Partial<BullMQConnectionOptions> & {
  /**
   * A Pino logger instance or configuration options for creating one.
   * If not provided, a default logger will be created.
   */
  logger?: Logger;
  loggerName?: string;
  env?: Record<string, any>;
  prefix?: string;
  queuePrefix?: string;
  queueTTL?: number;
  allowNonExistingQueues?: boolean;
  /**
   * Enable Redis connection reusing to minimize connection count.
   * When enabled, client and subscriber connections are shared across queues.
   *
   * **Why use this:**
   * - Reduces total Redis connection count
   * - Helpful on platforms with connection limits (e.g., Heroku)
   * - More efficient resource usage for applications with many queues
   *
   * **Important notes:**
   * - bclient connections cannot be reused and will create new connections per queue
   * - Shared connections are not closed when individual queues close
   * - You must call `client.close()` to properly clean up shared connections
   * - Compatible with BullMQ's createClient pattern
   *
   * @default false
   */
  reuseConnections?: boolean;
};

/**
 * Connection types used by BullMQ queues
 */
export type RedisConnectionType = 'client' | 'subscriber' | 'bclient';

/**
 * Function to create Redis connections for BullMQ queues
 * @param type - The type of connection needed
 * @param redisOpts - Redis options including connectionName
 * @returns Redis instance
 */
export type CreateClientFunction = (type: RedisConnectionType, redisOpts?: any) => Redis;
