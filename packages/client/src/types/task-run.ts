import type { Job, JobProgress } from 'bullmq'; // Added JobProgress
import type { Task } from '../task.js'; // Adjust path as needed
import type { Logger } from 'pino';

/**
 * Represents the combined interface for a TaskRun proxy object.
 * It includes all properties and methods of a BullMQ Job,
 * plus the specific properties added by the TaskRun implementation class.
 *
 * @template T Job data type
 * @template R Job return type
 */
export interface TaskRunInterface<T = unknown, R = unknown> extends Job<T, R> {
  /**
   * The Task definition associated with this run.
   */
  readonly task: Task<T, R>;

  /**
   * The logger instance associated with this specific task run.
   */
  readonly logger: Logger;

  // Add custom methods defined on TaskRunImplementation here for explicit typing
  updateProgress(value: JobProgress): Promise<void>;
  // Add other custom methods signatures here...
}
