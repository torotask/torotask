// Export Classes/Functions directly
export * from './batch-task.js';
export * from './client.js';
export * from './event-dispatcher.js';
export * from './event-manager.js';
export * from './sub-task.js'; // Only export the SubTask class
export * from './task-group.js';
export * from './task.js';
export * from './types/index.js';
export * from './utils/get-config-from-env.js';

// Re-export core BullMQ types
export type { ConnectionOptions, Job, JobsOptions } from 'bullmq';
