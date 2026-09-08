import type { ToroTaskStepStateStoreOptions } from '../types/step-state-store.js';
import type { StepResult } from '../types/step.js';
import {
  STEP_STATE_WAKE_BUFFER_SECONDS,
} from '../types/step-state-store.js';
import { ToroTaskStoreBase } from './store-base.js';

export function buildStepStateJobKey(prefix: string, namespace: string, queueName: string, jobId: string): string {
  return `${prefix}:${namespace}:${queueName}:${jobId}`;
}

/**
 * Derives an optional EXPIRE for step-state keys.
 * Sleeping steps extend TTL to wake time + buffer; optional orphan TTL is a floor.
 */
export function computeStepStateTtlSeconds(
  stepResult: StepResult,
  orphanTtlSeconds?: number,
): number | undefined {
  let ttl = orphanTtlSeconds;

  if (stepResult.sleepUntil) {
    const wakeTtl = Math.ceil(
      (stepResult.sleepUntil + STEP_STATE_WAKE_BUFFER_SECONDS * 1000 - Date.now()) / 1000,
    );
    if (wakeTtl > 0) {
      ttl = ttl ? Math.max(ttl, wakeTtl) : wakeTtl;
    }
  }

  return ttl;
}

/**
 * Pluggable store for per-step job execution state (outside BullMQ job.data).
 * Default implementation: {@link RedisStepStateStore}.
 */
export abstract class ToroTaskStepStateStore extends ToroTaskStoreBase {
  protected readonly orphanTtlSeconds?: number;

  /** Whether a job's step state is dropped as soon as it completes successfully. */
  readonly clearOnComplete: boolean;

  constructor(prefix: string, options?: ToroTaskStepStateStoreOptions) {
    super(prefix, options?.namespace ?? 'state');
    this.orphanTtlSeconds = options?.orphanTtlSeconds;
    this.clearOnComplete = options?.clearOnComplete ?? true;
  }

  protected buildJobKey(queueName: string, jobId: string): string {
    return buildStepStateJobKey(this.prefix, this.namespace, queueName, jobId);
  }

  abstract exists(queueName: string, jobId: string): Promise<boolean>;

  abstract loadSteps(queueName: string, jobId: string): Promise<Record<string, StepResult>>;

  abstract saveStep(
    queueName: string,
    jobId: string,
    stepId: string,
    stepResult: StepResult,
    ttlSeconds?: number,
  ): Promise<void>;

  /** @deprecated Use {@link clearJob} */
  async clear(queueName: string, jobId: string): Promise<void> {
    await this.clearJob(queueName, jobId);
  }
}
