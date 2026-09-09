import type { Redis } from 'ioredis';
import type { Buffer } from 'node:buffer';
import type { ToroTaskDataStoreOptions } from '../types/data-store.js';
import { ToroTaskDataStore } from './base-data-store.js';

export function buildDataStorageKey(prefix: string, namespace: string, refKey: string): string {
  return `${prefix}:${namespace}:${refKey}`;
}

export function buildDataJobIndexKey(
  prefix: string,
  namespace: string,
  queueName: string,
  jobId: string,
): string {
  return `${prefix}:${namespace}-index:${queueName}:${jobId}`;
}

/**
 * Per-job cleanup metadata (currently the referrer job key). Deliberately under its
 * own `-index-meta` namespace rather than a `:meta` suffix on the index key, so the
 * orphan sweep's SCAN over `-index:` never has to disambiguate it from a job id
 * (job ids may legitimately contain colons).
 */
export function buildDataJobIndexMetaKey(
  prefix: string,
  namespace: string,
  queueName: string,
  jobId: string,
): string {
  return `${prefix}:${namespace}-index-meta:${queueName}:${jobId}`;
}

const REFERRER_FIELD = 'referrer';

/**
 * Redis-backed {@link ToroTaskDataStore}. Uses the ToroTask client's Redis connection
 * by default; pass a dedicated Redis instance for a separate embeddings cache later.
 */
export class RedisDataStore extends ToroTaskDataStore {
  constructor(
    private readonly redis: Redis,
    prefix: string,
    options?: ToroTaskDataStoreOptions,
  ) {
    super(prefix, options);
  }

  protected buildStorageKey(refKey: string): string {
    return this.buildNamespacedKey(refKey);
  }

  private buildJobIndexKey(queueName: string, jobId: string): string {
    return buildDataJobIndexKey(this.prefix, this.options.namespace, queueName, jobId);
  }

  private buildJobIndexMetaKey(queueName: string, jobId: string): string {
    return buildDataJobIndexMetaKey(this.prefix, this.options.namespace, queueName, jobId);
  }

  protected async putRaw(storageKey: string, data: Buffer): Promise<void> {
    await this.redis.set(storageKey, data);
  }

  protected async getRaw(storageKey: string): Promise<Buffer | null> {
    const value = await this.redis.getBuffer(storageKey);
    return value ?? null;
  }

  protected async deleteRaw(storageKey: string): Promise<void> {
    await this.redis.del(storageKey);
  }

  protected async trackJobKey(
    queueName: string,
    jobId: string,
    storageKey: string,
    referrerJobKey?: string,
  ): Promise<void> {
    const indexKey = this.buildJobIndexKey(queueName, jobId);
    if (!referrerJobKey) {
      await this.redis.sadd(indexKey, storageKey);
      return;
    }

    await this.redis
      .multi()
      .sadd(indexKey, storageKey)
      .hset(this.buildJobIndexMetaKey(queueName, jobId), REFERRER_FIELD, referrerJobKey)
      .exec();
  }

  override async readJobReferrer(queueName: string, jobId: string): Promise<string | undefined> {
    const referrer = await this.redis.hget(this.buildJobIndexMetaKey(queueName, jobId), REFERRER_FIELD);
    return referrer ?? undefined;
  }

  async clearJob(queueName: string, jobId: string): Promise<void> {
    const indexKey = this.buildJobIndexKey(queueName, jobId);
    const metaKey = this.buildJobIndexMetaKey(queueName, jobId);
    const storageKeys = await this.redis.smembers(indexKey);
    await this.redis.del(...storageKeys, indexKey, metaKey);
  }
}
