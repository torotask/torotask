import type { ConnectionOptions as BullMQConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { ToroTaskDataStore } from '../data-store/base-data-store.js';
import type { EventDispatcherOptions } from '../event-dispatcher.js';
import type { ToroTaskDataStoreOptions } from './data-store.js';
import type { ToroTaskStepStateStoreConfig } from './step-state-store.js';

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

  /**
   * Options for configuring the EventDispatcher and EventManager.
   * Controls job options and worker settings for event queues.
   */
  eventOptions?: EventDispatcherOptions;

  /**
   * Optional orphan TTL (seconds) for step-state hashes when a worker crashes mid-job.
   * Shorthand for `stepStateStore.orphanTtlSeconds`.
   *
   * @default undefined (no orphan TTL)
   */
  stepStateTTL?: number;

  /**
   * Pluggable store for per-step execution state (outside BullMQ job.data).
   * Defaults to {@link RedisStepStateStore} on the client's Redis connection.
   */
  stepStateStore?: ToroTaskStepStateStoreConfig;

  /**
   * External store for large job payloads, return values, and step result data.
   * When enabled, values are replaced with compact refs in BullMQ job data and
   * events — reducing memory use for child-job processed sets and completed events.
   */
  dataStore?: ToroTaskDataStoreOptions | ToroTaskDataStore;

  /**
   * Built-in maintenance work registered as ordinary scheduled tasks.
   */
  maintenance?: ToroTaskMaintenanceOptions;
};

export interface ToroTaskMaintenanceOptions {
  /**
   * Periodic sweep that removes step-state and data-store keys whose BullMQ job
   * record is gone. Needed because `removeOnComplete` / `removeOnFail` trim jobs
   * inside Lua without emitting a `removed` event, so nothing else observes them.
   *
   * Registered as a BullMQ job scheduler, which is idempotent across processes — it
   * therefore runs once per cluster per interval, not once per worker. Set to `false`
   * and drive {@link ToroTask.cleanupOrphanedJobArtifacts} externally if you would
   * rather control when `SCAN` load hits Redis.
   *
   * @default true
   */
  orphanCleanup?: boolean | ToroTaskOrphanCleanupOptions;
}

export interface ToroTaskOrphanCleanupOptions {
  /** @default true */
  enabled?: boolean;

  /**
   * Cron expression for the sweep. Defaults to hourly at 17 minutes past, offset
   * from the hour so it does not pile onto the usual `0 * * * *` herd.
   *
   * @default '17 * * * *'
   */
  cron?: string;

  /**
   * Maximum artifacts removed per run. The sweep is idempotent, so anything left
   * over is picked up by the next run.
   *
   * @default 10000
   */
  maxDeletions?: number;

  /**
   * Maximum wall-clock time for a single run.
   *
   * @default 60000
   */
  maxDurationMs?: number;
}

export interface ResolvedToroTaskOrphanCleanupOptions {
  enabled: boolean;
  cron: string;
  maxDeletions: number;
  maxDurationMs: number;
}

export const DEFAULT_ORPHAN_CLEANUP_CRON = '17 * * * *';
export const DEFAULT_ORPHAN_CLEANUP_MAX_DELETIONS = 10_000;
export const DEFAULT_ORPHAN_CLEANUP_MAX_DURATION_MS = 60_000;

export function resolveOrphanCleanupOptions(
  options?: boolean | ToroTaskOrphanCleanupOptions,
): ResolvedToroTaskOrphanCleanupOptions {
  const resolved = typeof options === 'boolean' ? { enabled: options } : options;
  return {
    enabled: resolved?.enabled ?? true,
    cron: resolved?.cron ?? DEFAULT_ORPHAN_CLEANUP_CRON,
    maxDeletions: Math.max(1, resolved?.maxDeletions ?? DEFAULT_ORPHAN_CLEANUP_MAX_DELETIONS),
    maxDurationMs: Math.max(1000, resolved?.maxDurationMs ?? DEFAULT_ORPHAN_CLEANUP_MAX_DURATION_MS),
  };
}

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
