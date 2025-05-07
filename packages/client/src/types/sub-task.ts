import type { Task } from '../task.js';
import type { TaskHandlerContext } from './task.js';
import type { TaskJobData, TaskJobPayload } from './job.js';

/** Handler details passed to the subtask handler */
export interface SubTaskHandlerOptions<PayloadType extends TaskJobPayload = TaskJobPayload> {
  id?: string; // Job ID
  name: string; // SubTask name
  payload: PayloadType;
}

/** Context passed to the subtask handler */
export interface SubTaskHandlerContext<
  PayloadType extends TaskJobPayload = TaskJobPayload,
  ResultType = unknown,
  DataType extends TaskJobData = TaskJobData<PayloadType>,
> extends Omit<TaskHandlerContext<PayloadType, ResultType>, 'task'> {
  parentTask: Task<DataType, ResultType>; // Reference to the parent Task instance
  subTaskName: string; // The name of this subtask
}

/** SubTask handler function type */
export type SubTaskHandler<PayloadType extends TaskJobPayload = TaskJobPayload, ResultType = unknown> = (
  options: SubTaskHandlerOptions<PayloadType>,
  context: SubTaskHandlerContext<PayloadType, ResultType>
) => Promise<ResultType>;
