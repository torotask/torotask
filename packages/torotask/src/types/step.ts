import type { TaskJobState } from './job.js';

export type StepStatus = 'completed' | 'errored' | 'sleeping' | 'waiting_for_child' | 'waiting_for_children';
//| 'waiting_for_event';

/**
 * Represents the result of a single step execution.
 */
export interface StepResult<T = any> {
  status: StepStatus;
  data?: T;
  error?: {
    message: string;
    name?: string;
    stack?: string;
  };
  sleepUntil?: number; // Timestamp (ms since epoch)
  // For pending states
  eventName?: string;
  timeoutAt?: number; // Timestamp (ms since epoch)
  childIdentifier?: string; // For invoke
  childTaskIds?: string[]; // For waitForChildTasks
}
