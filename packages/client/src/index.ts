// Export Classes/Functions directly
export { BaseQueue } from './base-queue.js';
export { ToroTaskClient } from './client.js';
export { EventDispatcher } from './event-dispatcher.js';
export { EventManager } from './event-manager.js';
export { Task } from './task.js';
export { TaskGroup } from './task-group.js';
export { SubTask } from './sub-task.js'; // Only export the SubTask class
export { getConfigFromEnv } from './utils/get-config-from-env.js';

// Export specific types defined in client.ts
export type { ToroTaskClientOptions, WorkerFilter } from './client.js';

// Export all types defined in types.ts
// This includes TaskOptions, TaskHandler, TaskHandlerContext, TaskHandlerOptions,
// SubTaskHandlerOptions, SubTaskHandlerContext, SubTaskHandler
export * from './types.js';

// Re-export core BullMQ types
export type { ConnectionOptions, JobsOptions, Job } from 'bullmq';
