// Explicitly re-export to avoid ambiguity
export { BaseQueue } from './base-queue.js';
export {
  ToroTaskClient,
  ToroTaskClientOptions,
  WorkerFilter,
  // Avoid re-exporting types already exported by other files below
  // Task, TaskOptions, TaskHandler, TaskHandlerContext, TaskHandlerOptions,
  // TaskGroup,
  // BaseQueue, (already exported above)
  // SubTask, SubTaskHandler, SubTaskHandlerContext, SubTaskHandlerOptions,
} from './client.js';
export {
  SubTask,
  SubTaskHandler,
  SubTaskHandlerContext,
  SubTaskHandlerOptions,
} from './sub-task.js';
export { TaskGroup } from './task-group.js';
export {
  Task,
  TaskHandler,
  TaskHandlerContext,
  TaskHandlerOptions,
  TaskOptions,
} from './task.js';
export { getConfigFromEnv } from './utils/get-config-from-env.js';

// Re-export core BullMQ types users might need from client.ts instead
// export { ConnectionOptions, JobsOptions, Job } from 'bullmq';
export type { ConnectionOptions, JobsOptions, Job } from 'bullmq';
