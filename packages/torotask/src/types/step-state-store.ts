import type { ToroTaskStepStateStore } from '../stores/base-step-state-store.js';

export interface ToroTaskStepStateStoreOptions {
  /**
   * Redis key namespace segment under the ToroTask prefix.
   * @default 'state'
   */
  namespace?: string;

  /**
   * Optional orphan TTL (seconds) when a worker crashes mid-job.
   * Acts as a backstop only; step state is normally removed when the job
   * succeeds or when its BullMQ job record is deleted.
   * Sleeping steps always extend expiry to their wake time plus a one-day buffer.
   */
  orphanTtlSeconds?: number;

  /**
   * Delete a job's step state as soon as it completes successfully, instead of
   * keeping it until the BullMQ job record is removed.
   *
   * Step state is execution scratch, so retaining it for every job kept by
   * `removeOnComplete` is usually just Redis memory. Set to `false` to keep it
   * for post-run inspection (e.g. step-level history in Bull Board).
   *
   * @default true
   */
  clearOnComplete?: boolean;
}

export type ToroTaskStepStateStoreConfig
  = | ToroTaskStepStateStoreOptions
    | ToroTaskStepStateStore;

/** Suggested orphan TTL when explicitly enabling crash-safety expiry. */
export const DEFAULT_ORPHAN_STEP_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Grace period after a scheduled wake time before Redis may expire sleeping step state. */
export const STEP_STATE_WAKE_BUFFER_SECONDS = 24 * 60 * 60;
