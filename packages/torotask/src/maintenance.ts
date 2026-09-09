import type { TaskDefinition } from './types/task.js';
import type { OrphanSweepResult } from './utils/job-artifact-cleanup.js';

/** Task group id under which ToroTask registers its own housekeeping tasks. */
export const MAINTENANCE_GROUP_ID = 'torotask.maintenance';

/** Task id of the orphan-artifact sweep. */
export const ORPHAN_CLEANUP_TASK_ID = 'orphanCleanup';

export interface OrphanCleanupPayload {
  /** Limit the sweep to a single queue. Omit to sweep all queues. */
  queueName?: string;
  maxDeletions?: number;
  maxDurationMs?: number;
}

/**
 * Builds the definition for the periodic orphan-artifact sweep.
 *
 * Registered as an ordinary task with a cron trigger, which becomes a BullMQ job
 * scheduler. Schedulers are idempotent across processes and produce exactly one job
 * per interval, so this runs **once per cluster** rather than once per worker — no
 * leader election required.
 *
 * The sweep is safe to run concurrently with normal traffic: it only deletes artifacts
 * whose job hash is confirmed absent, and it defers blobs a live parent still references.
 */
export function createOrphanCleanupTaskDefinition(options: {
  cron: string;
  maxDeletions: number;
  maxDurationMs: number;
}): TaskDefinition<OrphanCleanupPayload, OrphanSweepResult> {
  return {
    triggers: [{ type: 'cron', name: 'orphan-cleanup', cron: options.cron }],
    options: {
      // Housekeeping runs forever; keep just enough history to diagnose it.
      removeOnComplete: 24,
      removeOnFail: 50,
      workerOptions: { concurrency: 1 },
    },
    handler: async ({ payload }, { client, logger }) => {
      const result = await client.cleanupOrphanedJobArtifacts({
        queueName: payload?.queueName,
        maxDeletions: payload?.maxDeletions ?? options.maxDeletions,
        maxDurationMs: payload?.maxDurationMs ?? options.maxDurationMs,
        logger,
      });

      if (result.truncated) {
        logger.warn(
          result,
          'Orphan sweep hit its budget before finishing; remaining artifacts will be picked up next run',
        );
      }
      else {
        logger.info(result, 'Orphan sweep finished');
      }

      return result;
    },
  };
}
