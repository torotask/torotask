import { Job, MinimalQueue } from 'bullmq';
import { Logger } from 'pino';
import { BaseTask } from './base-task.js';
import type { TaskRunOptions } from './types/task-run.js';
export class TaskRun<DataType = any, ReturnType = any> extends Job<DataType, ReturnType> {
  //public readonly queueEvents: QueueEvents;
  public logger?: Logger;
  public task?: BaseTask<DataType, ReturnType>;

  constructor(
    protected queue: MinimalQueue,
    public name: string,
    public data: DataType,
    public opts: TaskRunOptions = {},
    public id?: string
  ) {
    super(queue, name, data, opts, id);
  }
}
