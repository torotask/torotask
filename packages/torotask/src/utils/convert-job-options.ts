import type { JobsOptions, ParentOptions } from 'bullmq';
import type { TaskJob } from '../job.js';
import type { TaskJobOptions } from '../types/job.js';

/**
 * Type guard to check if parent is a TaskJob-like object (has queueQualifiedName)
 */
function isTaskJobParent(parent: Partial<TaskJob> | ParentOptions): parent is Partial<TaskJob> {
  return 'queueQualifiedName' in parent && typeof (parent as Partial<TaskJob>).queueQualifiedName === 'string';
}

export function convertJobOptions(options?: TaskJobOptions): JobsOptions {
  const { parent, ...rest } = options || {};

  const jobOptions: JobsOptions = rest;
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

  return jobOptions;
}
