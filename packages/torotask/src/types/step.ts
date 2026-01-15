import type { BulkJob } from './bulk.js';
import type { TaskJobOptions } from './job.js';

export type StepStatus = 'completed' | 'errored' | 'sleeping' | 'waiting_for_child' | 'waiting_for_children';
// | 'waiting_for_event';

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
    containedJobReference?: boolean;
    truncated?: boolean;
  };
  sleepUntil?: number; // Timestamp (ms since epoch)
  // For pending states
  eventName?: string;
  timeoutAt?: number; // Timestamp (ms since epoch)
  childIdentifier?: string; // For runTask
  childTaskIds?: string[]; // For waitForChildTasks
}

export interface SimplifiedJob {
  jobId: string;
  queue: string;
  state?: string;
  timestamp?: number;
  returnValue?: any;
  _isMemoizedTaskJob: boolean;
}

export interface BulkJobsReference {
  _isBulkJobsReference: true;
  count: number;
  queueName: string;
  timestamp: number;
  // Optional sample of first few job IDs for debugging
  sampleJobIds?: string[];
}

export type StepTaskJobOptions = TaskJobOptions;

export type StepBulkJob<Payload> = Omit<BulkJob<Payload>, 'data' | 'state'>;

export type StepInnerString = string | number | symbol;
