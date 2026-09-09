import type { ToroTaskStepStateStore } from '../stores/base-step-state-store.js';

export interface ToroTaskStepStateStoreOptions {
  /**
   * Redis key namespace segment under the ToroTask prefix.
   * @default 'state'
   */
  namespace?: string;

  /**
   * Optional orphan TTL (seconds) when a worker crashes mid-job.
   *
   * Acts as a backstop only. Step state is normally removed when the job record is
   * deleted, either explicitly or by the periodic orphan sweep
   * ({@link ToroTask.cleanupOrphanedJobArtifacts}).
   *
   * Sleeping steps always extend expiry to their wake time plus a one-day buffer.
   */
  orphanTtlSeconds?: number;
}

export type ToroTaskStepStateStoreConfig
  = | ToroTaskStepStateStoreOptions
    | ToroTaskStepStateStore;

/** Suggested orphan TTL when explicitly enabling crash-safety expiry. */
export const DEFAULT_ORPHAN_STEP_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Grace period after a scheduled wake time before Redis may expire sleeping step state. */
export const STEP_STATE_WAKE_BUFFER_SECONDS = 24 * 60 * 60;
