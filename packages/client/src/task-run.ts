import { Job } from 'bullmq';
import { Logger } from 'pino';
import { BaseTask } from './base-task.js';
import type { TaskRunInterface } from './types/task-run.js';
import { TaskRunImplementation } from './utils/task-run-proxy.js';

export interface TaskRun<T, R> extends TaskRunInterface<T, R> {}

export function createTaskRun<T, R>(task: BaseTask<T, R>, job: Job<T, R>, logger: Logger): TaskRun<T, R> {
  return TaskRunImplementation.create<T, R>(task, job, logger);
}
