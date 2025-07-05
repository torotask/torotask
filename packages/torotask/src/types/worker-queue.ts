import type { JobProgress, QueueListener, WorkerListener } from 'bullmq'; // Assuming these are accessible
import type { TaskJob } from '../job.js'; // Your specific Job type
import type { TaskJobData } from './job.js';
import type { TaskQueueOptions } from './queue.js';
import type { TaskProcessor, TaskValidator } from './worker.js';
import type { TaskWorkerOptions } from './worker.js';

export type TaskWorkerQueueOptions<
  PayloadType = any,
  ResultType = any,
  NameType extends string = string,
> = TaskQueueOptions & {
  processor?: string | URL | null | TaskProcessor<PayloadType, ResultType, NameType>;
  validator?: null | TaskValidator<PayloadType, ResultType, NameType>;
  workerOptions?: Partial<TaskWorkerOptions>;
};
// Combine Queue and Worker listeners with prefixing for worker events
export interface TaskWorkerQueueListener<
  PayloadType = any,
  ResultType = any,
  NameType extends string = string,
  DataType extends TaskJobData = TaskJobData<PayloadType>,
> extends QueueListener<TaskJob<PayloadType, ResultType, NameType>> {
  // Worker events prefixed with 'worker:'
  'worker:active': WorkerListener<DataType, ResultType, NameType>['active'];
  'worker:closed': WorkerListener<DataType, ResultType, NameType>['closed'];
  'worker:closing': WorkerListener<DataType, ResultType, NameType>['closing'];
  'worker:completed': WorkerListener<DataType, ResultType, NameType>['completed'];
  'worker:drained': WorkerListener<DataType, ResultType, NameType>['drained'];
  'worker:error': WorkerListener<DataType, ResultType, NameType>['error'];
  'worker:failed': WorkerListener<DataType, ResultType, NameType>['failed'];
  'worker:paused': WorkerListener<DataType, ResultType, NameType>['paused'];
  'worker:progress': WorkerListener<DataType, ResultType, NameType>['progress'];
  'worker:ready': WorkerListener<DataType, ResultType, NameType>['ready'];
  'worker:resumed': WorkerListener<DataType, ResultType, NameType>['resumed'];
  'worker:stalled': WorkerListener<DataType, ResultType, NameType>['stalled'];

  // Note: Queue events like 'cleaned', 'error', 'paused', 'progress', 'removed', 'resumed', 'waiting'
  // are inherited directly from QueueListener without prefix.
}
export interface WorkerEventHandlers<PayloadType = any, ResultType = any, NameType extends string = string>
  extends Omit<WorkerListener, 'active' | 'completed' | 'failed' | 'progress'> {
  active: (job: TaskJob<PayloadType, ResultType, NameType>, prev: string) => void;
  completed: (job: TaskJob<PayloadType, ResultType, NameType>, result: ResultType, prev: string) => void;
  failed: (job: TaskJob<PayloadType, ResultType, NameType> | undefined, error: Error, prev: string) => void;
  progress: (job: TaskJob<PayloadType, ResultType, NameType>, progress: JobProgress) => void;
}
