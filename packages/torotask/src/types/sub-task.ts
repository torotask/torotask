import type { Task } from '../task.js';
import type { TaskHandlerContext } from './task.js';
import type { TaskJobData } from './job.js';

/** Handler details passed to the subtask handler */
export interface SubTaskHandlerOptions<PayloadType = any> {
  id?: string; // Job ID
  name: string; // SubTask name
  payload: PayloadType;
}

/** Context passed to the subtask handler */
export interface SubTaskHandlerContext<
  PayloadType = any,
  ResultType = unknown,
  DataType extends TaskJobData = TaskJobData<PayloadType>,
> extends Omit<TaskHandlerContext<PayloadType, ResultType>, 'task'> {
  parentTask: Task<DataType, ResultType>; // Reference to the parent Task instance
  subTaskId: string;
}

/** SubTask handler function type */
export type SubTaskHandler<PayloadType = any, ResultType = unknown> = (
  options: SubTaskHandlerOptions<PayloadType>,
  context: SubTaskHandlerContext<PayloadType, ResultType>
) => Promise<ResultType>;
