import { Worker, WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import { ToroTaskClient } from './client.js';
import type { TaskWorkerOptions, TaskProcessor } from './types/index.js';
import { TaskJob } from './job.js';

export class TaskWorker<DataType = any, ResultType = any, NameType extends string = string> extends Worker<
  DataType,
  ResultType,
  NameType
> {
  public readonly logger: Logger;

  constructor(
    public readonly taskClient: ToroTaskClient,
    name: string,
    processor?: string | URL | null | TaskProcessor<DataType, ResultType, string>,
    options?: Partial<TaskWorkerOptions>
  ) {
    if (!taskClient) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue name is required.');
    }
    options = options || {};
    options.prefix = options.prefix || taskClient.queuePrefix;
    options.connection = options.connection = taskClient.connectionOptions;

    super(name, processor as any, options as WorkerOptions);
    this.logger = options.logger || taskClient.logger.child({ taskQueue: name });
  }

  /**
   * Override the Job class to use TaskJob
   * @returns {typeof TaskJob}
   */
  protected get Job(): typeof TaskJob {
    return TaskJob;
  }
}
