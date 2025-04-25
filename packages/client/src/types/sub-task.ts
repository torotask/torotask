import type { Job } from 'bullmq';
import type { Task } from '../task.js';
import type { TaskHandlerContext } from './task.js';

/** Handler details passed to the subtask handler */
export interface SubTaskHandlerOptions<ST = unknown> {
  id?: string; // Job ID
  name: string; // SubTask name
  data: ST;
}

/** Context passed to the subtask handler */
export interface SubTaskHandlerContext extends Omit<TaskHandlerContext<Job>, 'task'> {
  parentTask: Task<any, any>; // Reference to the parent Task instance
  subTaskName: string; // The name of this subtask
}

/** SubTask handler function type */
export type SubTaskHandler<ST = unknown, SR = unknown> = (
  options: SubTaskHandlerOptions<ST>,
  context: SubTaskHandlerContext
) => Promise<SR>;
