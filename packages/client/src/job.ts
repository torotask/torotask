import { Job, MinimalQueue } from 'bullmq';
import { Logger } from 'pino';
import { BaseTask } from './base-task.js';
import type { TaskJobOptions } from './types/index.js';
import { TaskQueue } from './queue.js';

export class TaskJob<DataType = any, ReturnType = any, NameType extends string = string> extends Job<
  DataType,
  ReturnType,
  NameType
> {
  public logger?: Logger;
  public task?: BaseTask<DataType, ReturnType>;
  public taskQueue?: TaskQueue; // Add this new property

  constructor(queue: MinimalQueue, name: NameType, data: DataType, opts: TaskJobOptions = {}, id?: string) {
    super(queue, name, data, opts, id);

    // Check if the queue is an instance of TaskQueue
    if (queue instanceof TaskQueue) {
      this.taskQueue = queue;
      this.logger = queue.logger.child({ taskRun: this.name, taskId: this.id });
    }
  }
}
