import { Processor, Worker, WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import { ToroTaskClient } from './client.js';
import type { TaskWorkerOptions } from './types/index.js';
import { TaskJob } from './job.js';

export class TaskWorker<DataType = any, ResultType = any> extends Worker<DataType, ResultType> {
  public readonly taskClient: ToroTaskClient;
  //public readonly queueEvents: QueueEvents;
  public readonly logger: Logger;

  constructor(
    client: ToroTaskClient,
    name: string,
    parentLogger: Logger,
    processor?: string | URL | null | Processor<DataType, ResultType, string>,
    options?: Partial<TaskWorkerOptions>
  ) {
    if (!client) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue name is required.');
    }
    options = options || {};
    options.prefix = options.prefix || client.queuePrefix;
    options.connection = options.connection = client.connectionOptions;

    super(name, processor, options as WorkerOptions);
    this.taskClient = client;

    // Assign logger
    this.logger = parentLogger.child({ taskQueue: this.name });
  }

  /**
   * Override the Job class to use TaskJob
   * @returns {typeof TaskJob}
   */
  protected get Job(): typeof TaskJob {
    return TaskJob;
  }
}
