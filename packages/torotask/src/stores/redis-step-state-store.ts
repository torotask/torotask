import type { Redis } from 'ioredis';
import type { ToroTaskStepStateStoreOptions } from '../types/step-state-store.js';
import type { StepResult } from '../types/step.js';
import {
  computeStepStateTtlSeconds,
  ToroTaskStepStateStore,
} from './base-step-state-store.js';

/**
 * Redis hash-backed {@link ToroTaskStepStateStore}.
 * One hash per job (`HSET` per step) to avoid rewriting prior step results.
 */
export class RedisStepStateStore extends ToroTaskStepStateStore {
  constructor(
    private readonly redis: Redis,
    prefix: string,
    options?: ToroTaskStepStateStoreOptions,
  ) {
    super(prefix, options);
  }

  async exists(queueName: string, jobId: string): Promise<boolean> {
    const key = this.buildJobKey(queueName, jobId);
    return (await this.redis.exists(key)) > 0;
  }

  async loadSteps(queueName: string, jobId: string): Promise<Record<string, StepResult>> {
    const key = this.buildJobKey(queueName, jobId);
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
    const key = this.buildJobKey(queueName, jobId);
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

  async clearJob(queueName: string, jobId: string): Promise<void> {
    await this.redis.del(this.buildJobKey(queueName, jobId));
  }
}
