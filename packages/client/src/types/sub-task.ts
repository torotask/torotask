import type { Job } from 'bullmq';
import type { Task } from '../task.js';
import type { TaskHandlerContext } from './task.js';

/** Handler details passed to the subtask handler */
export interface SubTaskHandlerOptions<DataType = unknown> {
  id?: string; // Job ID
  name: string; // SubTask name
  data: DataType;
}

/** Context passed to the subtask handler */
export interface SubTaskHandlerContext<DataType = unknown, ResultType = unknown>
  extends Omit<TaskHandlerContext<DataType, ResultType>, 'task'> {
  parentTask: Task<DataType, ResultType>; // Reference to the parent Task instance
  subTaskName: string; // The name of this subtask
}

/** SubTask handler function type */
export type SubTaskHandler<DataType = unknown, ResultType = unknown> = (
  options: SubTaskHandlerOptions<DataType>,
  context: SubTaskHandlerContext<DataType, ResultType>
) => Promise<ResultType>;
