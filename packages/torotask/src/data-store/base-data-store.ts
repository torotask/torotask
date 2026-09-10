import type {
  ResolvedToroTaskDataStoreOptions,
  ToroTaskDataJobMeta,
  ToroTaskDataStoreContext,
  ToroTaskDataStoreOptions,
} from '../types/data-store.js';
import { Buffer } from 'node:buffer';
import { gunzipSync, gzipSync } from 'node:zlib';
import { isPlainObject } from 'lodash-es';
import { ToroTaskStoreBase } from '../stores/store-base.js';
import { resolveDataStoreOptions } from '../types/data-store.js';
import { createToroTaskDataRef, isToroTaskDataRef } from './data-ref.js';

/**
 * Pluggable store for large job payloads, return values, and step results.
 * Subclass for non-Redis backends (S3, dedicated cache Redis, etc.).
 */
export abstract class ToroTaskDataStore extends ToroTaskStoreBase {
  protected readonly options: ResolvedToroTaskDataStoreOptions;

  constructor(prefix: string, options?: ToroTaskDataStoreOptions) {
    const resolved = resolveDataStoreOptions(options);
    super(prefix, resolved.namespace);
    this.options = resolved;
  }

  get isEnabled(): boolean {
    return this.options.enabled;
  }

  /** Prefix for all per-job index keys, e.g. `torotask:data-index:`. */
  indexKeysPrefix(): string {
    return `${this.prefix}:${this.namespace}-index:`;
  }

  /** Prefix for per-job index keys in a queue, excluding the job id (trailing `:`). */
  jobIndexKeysPrefix(queueName: string): string {
    return `${this.indexKeysPrefix()}${queueName}:`;
  }

  /** Builds the backend-specific storage key for a logical ref key. */
  protected abstract buildStorageKey(refKey: string): string;

  protected abstract putRaw(storageKey: string, data: Buffer): Promise<void>;

  protected abstract getRaw(storageKey: string): Promise<Buffer | null>;

  protected abstract deleteRaw(storageKey: string): Promise<void>;

  /** Tracks a storage key so it can be removed when the job is deleted. */
  protected abstract trackJobKey(
    queueName: string,
    jobId: string,
    storageKey: string,
    referrerJobKey?: string,
  ): Promise<void>;

  /**
   * Metadata recorded for a job's blobs by {@link trackJobKey}.
   *
   * Orphan cleanup uses this to avoid deleting a blob a surviving parent still
   * references, and to honour a retention window. Backends that record nothing return
   * an empty object, which means "no known referrer and unknown age" and lets cleanup
   * proceed on job-presence alone.
   */
  async readJobMeta(_queueName: string, _jobId: string): Promise<ToroTaskDataJobMeta> {
    return {};
  }

  /**
   * Records a first-observation timestamp for a job whose metadata predates tracking.
   *
   * Called by orphan cleanup when {@link readJobMeta} reports no `createdAt`, so that
   * artifacts written before this feature existed get one retention window of grace
   * instead of being deleted on the first sweep after an upgrade. Backends that do not
   * record metadata leave this as a no-op and are swept on job presence alone.
   */
  async markJobMetaSeen(_queueName: string, _jobId: string): Promise<void> {
    // No-op by default.
  }

  /** Removes all blobs tracked for a job. */
  abstract clearJob(queueName: string, jobId: string): Promise<void>;

  buildRefKey(context: ToroTaskDataStoreContext): string {
    if (context.kind === 'stepData') {
      if (!context.stepId) {
        throw new Error('stepId is required when kind is stepData');
      }
      return `${context.queueName}:${context.jobId}:step:${context.stepId}`;
    }
    return `${context.queueName}:${context.jobId}:${context.kind}`;
  }

  shouldExternalize(byteLength: number): boolean {
    if (!this.options.enabled) {
      return false;
    }
    if (this.options.mode === 'all') {
      return true;
    }
    return byteLength >= this.options.thresholdBytes;
  }

  encodeValue(value: unknown): { json: string; byteLength: number } | undefined {
    const json = JSON.stringify(value);
    if (typeof json !== 'string') {
      return undefined;
    }
    return { json, byteLength: Buffer.byteLength(json, 'utf8') };
  }

  prepareBuffer(json: string, byteLength: number): { buffer: Buffer; compressed: boolean } {
    const raw = Buffer.from(json, 'utf8');
    const { compress, minCompressBytes } = this.options;

    if (compress === false || byteLength < minCompressBytes) {
      return { buffer: raw, compressed: false };
    }

    const compressed = gzipSync(raw);
    if (compress === 'auto' && compressed.length >= raw.length) {
      return { buffer: raw, compressed: false };
    }

    return { buffer: compressed, compressed: true };
  }

  decodeBuffer(buffer: Buffer, compressed: boolean): string {
    const bytes = compressed ? gunzipSync(buffer) : buffer;
    return bytes.toString('utf8');
  }

  /**
   * Stores `value` externally when configured to do so; otherwise returns `value` unchanged.
   */
  async externalize(context: ToroTaskDataStoreContext, value: unknown): Promise<unknown> {
    if (!this.options.enabled || isToroTaskDataRef(value)) {
      return value;
    }

    const encoded = this.encodeValue(value);
    if (!encoded) {
      return value;
    }

    const { json, byteLength } = encoded;
    if (!this.shouldExternalize(byteLength)) {
      return value;
    }

    const refKey = this.buildRefKey(context);
    const storageKey = this.buildStorageKey(refKey);
    const { buffer, compressed } = this.prepareBuffer(json, byteLength);

    await this.putRaw(storageKey, buffer);
    await this.trackJobKey(context.queueName, context.jobId, storageKey, context.referrerJobKey);

    return createToroTaskDataRef(refKey, compressed, byteLength);
  }

  /** Resolves a single ref, or returns the value unchanged. */
  async resolve<T = unknown>(value: T): Promise<T> {
    if (!isToroTaskDataRef(value)) {
      return value;
    }

    const storageKey = this.buildStorageKey(value.key);
    const buffer = await this.getRaw(storageKey);
    if (!buffer) {
      throw new Error(`External data not found for ref key: ${value.key}`);
    }

    const json = this.decodeBuffer(buffer, value.compressed);
    return JSON.parse(json) as T;
  }

  /** Recursively resolves refs in arrays and plain objects. */
  async resolveDeep<T = unknown>(value: T): Promise<T> {
    if (isToroTaskDataRef(value)) {
      return this.resolve(value);
    }

    if (Array.isArray(value)) {
      const resolved = await Promise.all(value.map(item => this.resolveDeep(item)));
      return resolved as T;
    }

    if (value instanceof Date) {
      return value;
    }

    if (isPlainObject(value)) {
      const entries = await Promise.all(
        Object.entries(value as Record<string, unknown>).map(async ([key, item]) => {
          return [key, await this.resolveDeep(item)] as const;
        }),
      );
      return Object.fromEntries(entries) as T;
    }

    return value;
  }
}
