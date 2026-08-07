import type { Redis } from 'ioredis';
import type { StepResult } from './types/step.js';

/**
 * Suggested orphan TTL when explicitly enabling crash-safety expiry.
 * Not applied by default — step state lifetime follows the job lifecycle.
 */
export const DEFAULT_ORPHAN_STEP_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Grace period after a scheduled wake time before Redis may expire sleeping step state. */
export const STEP_STATE_WAKE_BUFFER_SECONDS = 24 * 60 * 60;

export function buildStepStateKey(prefix: string, queueName: string, jobId: string): string {
  return `${prefix}:state:${queueName}:${jobId}`;
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
 * Stores per-step execution state in a Redis hash instead of inside BullMQ job.data.
 * Each step is written with HSET so later steps do not rewrite prior step results.
 *
 * Cleanup is driven by job removal (explicit delete, queue.remove, queue.clean), not completion.
 * EXPIRE is only set when a TTL is explicitly derived (sleep-until steps or optional orphan TTL).
 */
export class RedisStepStateStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly orphanTtlSeconds?: number,
  ) {}

  async exists(queueName: string, jobId: string): Promise<boolean> {
    const key = buildStepStateKey(this.prefix, queueName, jobId);
    return (await this.redis.exists(key)) > 0;
  }

  async loadSteps(queueName: string, jobId: string): Promise<Record<string, StepResult>> {
    const key = buildStepStateKey(this.prefix, queueName, jobId);
    const raw = await this.redis.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) {
      return {};
    }

    const result: Record<string, StepResult> = {};
    for (const [stepId, json] of Object.entries(raw)) {
      try {
        result[stepId] = JSON.parse(json) as StepResult;
      }
      catch {
        // Skip corrupted entries rather than failing the whole job.
      }
    }
    return result;
  }

  async saveStep(
    queueName: string,
    jobId: string,
    stepId: string,
    stepResult: StepResult,
    ttlSeconds?: number,
  ): Promise<void> {
    const key = buildStepStateKey(this.prefix, queueName, jobId);
    const effectiveTtl = ttlSeconds ?? computeStepStateTtlSeconds(stepResult, this.orphanTtlSeconds);

    if (effectiveTtl !== undefined && effectiveTtl > 0) {
      const multi = this.redis.multi();
      multi.hset(key, stepId, JSON.stringify(stepResult));
      multi.expire(key, effectiveTtl);
      await multi.exec();
      return;
    }

    await this.redis.hset(key, stepId, JSON.stringify(stepResult));
  }

  async clear(queueName: string, jobId: string): Promise<void> {
    const key = buildStepStateKey(this.prefix, queueName, jobId);
    await this.redis.del(key);
  }
}
