import type { QueueListener, WorkerListener } from 'bullmq'; // Assuming these are accessible
import type { TaskJob } from '../job.js'; // Your specific Job type

// Combine Queue and Worker listeners with prefixing for worker events
export interface TaskWorkerQueueListener<DataType = any, ResultType = any, NameType extends string = string>
  extends QueueListener<TaskJob<DataType, ResultType, NameType>> {
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

export type WorkerEventHandlers<DataType = any, ResultType = any, NameType extends string = string> = {
  // Map over the keys of WorkerListener using the extracted generic types
  [K in keyof WorkerListener<DataType, ResultType, NameType>]?: WorkerListener<DataType, ResultType, NameType>[K];
};
