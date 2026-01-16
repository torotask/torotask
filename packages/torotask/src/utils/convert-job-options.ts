import type { JobsOptions, ParentOptions } from 'bullmq';
import type { TaskJob } from '../job.js';
import type { TaskDeduplicationOptions, TaskJobOptions } from '../types/job.js';

/**
 * Type guard to check if parent is a TaskJob-like object (has queueQualifiedName)
 */
function isTaskJobParent(parent: Partial<TaskJob> | ParentOptions): parent is Partial<TaskJob> {
  return 'queueQualifiedName' in parent && typeof (parent as Partial<TaskJob>).queueQualifiedName === 'string';
}

/**
 * Resolves deduplication options, generating the ID from a callback if needed.
 * Returns undefined if no valid ID can be determined (deduplication should be skipped).
 */
function resolveDeduplication(
  deduplication: TaskDeduplicationOptions<any>,
  payload?: any,
): { id: string; ttl?: number; extend?: boolean; replace?: boolean } | undefined {
  let resolvedId: string | undefined | null;

  // Priority: literal id > callback > nothing
  if (deduplication.id) {
    resolvedId = deduplication.id;
  }
  else if (deduplication.idFromPayload && payload !== undefined) {
    resolvedId = deduplication.idFromPayload(payload);
  }

  // If no ID could be resolved (undefined, null, or empty string), skip deduplication
  if (!resolvedId) {
    return undefined;
  }

  return {
    id: resolvedId,
    ttl: deduplication.ttl,
    extend: deduplication.extend,
    replace: deduplication.replace,
  };
}

/**
 * Converts TaskJobOptions to BullMQ's JobsOptions.
 * Handles parent conversion and deduplication callback resolution.
 *
 * @param options - TaskJobOptions to convert
 * @param payload - Optional payload for resolving deduplication via callback
 */
export function convertJobOptions(options?: TaskJobOptions, payload?: any): JobsOptions {
  const { parent, deduplication, ...rest } = options || {};

  const jobOptions: JobsOptions = rest;

  // Handle parent conversion
  if (parent && parent.id) {
    // Check if it's a TaskJob object (has queueQualifiedName)
    if (isTaskJobParent(parent) && parent.queueQualifiedName) {
      jobOptions.parent = {
        id: parent.id,
        queue: parent.queueQualifiedName,
      };
    }
    // Otherwise treat it as BullMQ ParentOptions format ({ id, queue })
    else if ('queue' in parent && typeof parent.queue === 'string') {
      jobOptions.parent = {
        id: parent.id,
        queue: parent.queue,
      };
    }
  }

  // Handle deduplication with callback resolution
  if (deduplication) {
    const resolvedDedup = resolveDeduplication(deduplication, payload);
    if (resolvedDedup) {
      jobOptions.deduplication = resolvedDedup;
    }
    // If resolvedDedup is undefined, we intentionally don't set deduplication
    // This means the task defaults are ignored if no ID is available
  }

  return jobOptions;
}
