import type { ToroTaskDataStore } from '../data-store/base-data-store.js';

export const TOROTASK_DATA_REF = '_torotaskDataRef' as const;

/**
 * Marker stored inline in job.data / return values / step state when the
 * actual payload is held in an external {@link ToroTaskDataStore}.
 */
export interface ToroTaskDataRef {
  [TOROTASK_DATA_REF]: true;
  /** Logical key (queue-scoped); resolved via the store backend. */
  key: string;
  /** Whether the stored bytes are gzip-compressed. */
  compressed: boolean;
  /** Original JSON byte length before optional compression. */
  byteLength: number;
}

export type ToroTaskDataKind = 'payload' | 'returnValue' | 'stepData';

export interface ToroTaskDataStoreContext {
  queueName: string;
  jobId: string;
  kind: ToroTaskDataKind;
  /** Required when kind is `stepData`. */
  stepId?: string;
  /**
   * Job hash key (`<prefix>:<queueName>:<jobId>`) of another job that will retain a
   * ref to this value after this job's own record is gone.
   *
   * BullMQ copies a child's return value into `<parentKey>:processed`, so a parent
   * outlives its child's ref. Recording the referrer here lets orphan cleanup defer
   * deleting the blob until the referrer is gone too.
   */
  referrerJobKey?: string;
}

export type ToroTaskDataStoreMode = 'large' | 'all';

export type ToroTaskDataStoreCompress = boolean | 'auto';

export interface ToroTaskDataStoreOptions {
  /**
   * When true, payloads and return values are externalized according to `mode`.
   * @default false
   */
  enabled?: boolean;

  /**
   * `large` — only values at or above `thresholdBytes` are stored externally.
   * `all` — always store externally (inline value is replaced by a ref).
   * @default 'large'
   */
  mode?: ToroTaskDataStoreMode;

  /**
   * Minimum JSON byte size before externalizing when `mode` is `large`.
   * @default 65536 (64 KiB)
   */
  thresholdBytes?: number;

  /**
   * Compress stored JSON. `auto` compresses only when it reduces size.
   * @default 'auto'
   */
  compress?: ToroTaskDataStoreCompress;

  /**
   * Minimum JSON byte size before attempting compression when `compress` is `auto`.
   * @default 1024
   */
  minCompressBytes?: number;

  /**
   * Redis key namespace segment under the ToroTask prefix.
   * @default 'data'
   */
  namespace?: string;
}

export interface ResolvedToroTaskDataStoreOptions {
  enabled: boolean;
  mode: ToroTaskDataStoreMode;
  thresholdBytes: number;
  compress: ToroTaskDataStoreCompress;
  minCompressBytes: number;
  namespace: string;
}

export const DEFAULT_DATA_STORE_THRESHOLD_BYTES = 64 * 1024;
export const DEFAULT_DATA_STORE_MIN_COMPRESS_BYTES = 1024;

export function resolveDataStoreOptions(
  options?: ToroTaskDataStoreOptions,
): ResolvedToroTaskDataStoreOptions {
  return {
    enabled: options?.enabled ?? false,
    mode: options?.mode ?? 'large',
    thresholdBytes: options?.thresholdBytes ?? DEFAULT_DATA_STORE_THRESHOLD_BYTES,
    compress: options?.compress ?? 'auto',
    minCompressBytes: options?.minCompressBytes ?? DEFAULT_DATA_STORE_MIN_COMPRESS_BYTES,
    namespace: options?.namespace ?? 'data',
  };
}
