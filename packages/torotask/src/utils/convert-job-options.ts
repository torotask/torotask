import type { JobsOptions } from 'bullmq';
import type { TaskJobOptions } from '../types/job.js';

export function convertJobOptions(options?: TaskJobOptions): JobsOptions {
  const { parent, ...rest } = options || {};

  const jobOptions: JobsOptions = rest;
  if (parent && parent.id && parent.queueQualifiedName) {
    jobOptions.parent = {
      id: parent.id,
      queue: parent.queueQualifiedName,
    };
  }

  return jobOptions;
}
