import type { Redis } from 'ioredis';
import type { Buffer } from 'node:buffer';
import type { ToroTaskDataJobMeta, ToroTaskDataStoreOptions } from '../types/data-store.js';
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
const CREATED_AT_FIELD = 'createdAt';

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
    const metaKey = this.buildJobIndexMetaKey(queueName, jobId);

    // `createdAt` is written on every blob, not just referenced ones: orphan cleanup
    // uses it as a retention window so a consumer that has not yet read the job's
    // `completed` event still finds the ref resolvable.
    //
    // Last write wins, deliberately. `clearJob` deletes a job's blobs as a unit, so the
    // window has to be measured from the NEWEST blob. Keeping the first write instead
    // would date a return value externalized at completion from the payload written at
    // enqueue time, leaving any job that queued or ran for longer than the window with
    // no protection at all on the one blob the `completed` event actually references.
    const multi = this.redis.multi().sadd(indexKey, storageKey).hset(metaKey, CREATED_AT_FIELD, Date.now());
    if (referrerJobKey) {
      multi.hset(metaKey, REFERRER_FIELD, referrerJobKey);
    }
    const results = await multi.exec();

    // If the metadata write silently failed we would hand back a valid ref whose blob
    // looks unreferenced and ageless, and a later sweep would delete it while the
    // parent still points at it. Surface it instead so the caller does not externalize.
    const failure = results?.find(entry => Array.isArray(entry) && entry[0]);
    if (!results || failure) {
      throw new Error(
        `Failed to track data-store job key for ${queueName}:${jobId}`,
        { cause: failure?.[0] ?? new Error('MULTI/EXEC returned no result') },
      );
    }
  }

  override async readJobMeta(queueName: string, jobId: string): Promise<ToroTaskDataJobMeta> {
    const meta = await this.redis.hgetall(this.buildJobIndexMetaKey(queueName, jobId));
    const createdAt = Number(meta?.[CREATED_AT_FIELD]);
    return {
      referrerJobKey: meta?.[REFERRER_FIELD] || undefined,
      createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined,
    };
  }

  /**
   * Stamps `createdAt` on a job index that predates metadata tracking.
   *
   * Indexes written before this feature existed have no timestamp, and treating that as
   * "infinitely old" would delete blobs whose `completed` event may still be unread at
   * the moment of deployment. Stamping on first sight gives them exactly one retention
   * window of grace and then lets them age out normally, rather than stranding them.
   */
  override async markJobMetaSeen(queueName: string, jobId: string): Promise<void> {
    await this.redis.hsetnx(this.buildJobIndexMetaKey(queueName, jobId), CREATED_AT_FIELD, Date.now());
  }

  async clearJob(queueName: string, jobId: string): Promise<void> {
    const indexKey = this.buildJobIndexKey(queueName, jobId);
    const metaKey = this.buildJobIndexMetaKey(queueName, jobId);
    const storageKeys = await this.redis.smembers(indexKey);
    await this.redis.del(...storageKeys, indexKey, metaKey);
  }
}
