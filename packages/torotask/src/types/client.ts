import type { ConnectionOptions as BullMQConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

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

  /**
   * Enable automatic queue discovery using Redis keyspace notifications.
   * When enabled, the client will emit events when new queues are created or removed.
   *
   * **Events emitted:**
   * - 'queueCreated' - when a new queue is detected
   * - 'queueRemoved' - when a queue is deleted/expired
   * - 'queueDiscoveryStarted' - when discovery is started
   * - 'queueDiscoveryStopped' - when discovery is stopped
   * - 'queueDiscoveryError' - when an error occurs during discovery
   *
   * **Important notes:**
   * - Requires Redis keyspace notifications to be enabled (notify-keyspace-events)
   * - Uses an additional Redis subscriber connection
   * - Automatically configures keyspace notifications if Redis has CONFIG permissions
   * - Call `client.startQueueDiscovery()` to begin monitoring
   *
   * @default false
   */
  enableQueueDiscovery?: boolean;
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

/**
 * Queue discovery events emitted by ToroTask client
 */
export interface QueueDiscoveryEvents {
  queueCreated: (queueName: string) => void;
  queueRemoved: (queueName: string) => void;
  queueDiscoveryStarted: () => void;
  queueDiscoveryStopped: () => void;
  queueDiscoveryError: (error: Error) => void;
}
