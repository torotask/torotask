import { Queue, QueueOptions } from 'bullmq';
import { Logger } from 'pino';
import { ToroTaskClient } from './client.js';
import type { TaskQueueOptions } from './types/index.js';
import { TaskJob } from './job.js';

export class TaskQueue<DataTypeOrJob = any, DefaultResultType = any> extends Queue<DataTypeOrJob, DefaultResultType> {
  public readonly taskClient: ToroTaskClient;
  //public readonly queueEvents: QueueEvents;
  public readonly logger: Logger;

  constructor(client: ToroTaskClient, name: string, parentLogger: Logger, options?: Partial<TaskQueueOptions>) {
    if (!client) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue name is required.');
    }
    options = options || {};
    options.prefix = options.prefix || client.queuePrefix;
    options.connection = options.connection = client.connectionOptions;

    super(name, options as QueueOptions);
    this.taskClient = client;

    // Assign logger
    this.logger = parentLogger.child({ taskQue: this.name });
  }

  /**
   * Override the Job class to use TaskJob
   * @returns {typeof TaskJob}
   */
  protected get Job(): typeof TaskJob {
    return TaskJob;
  }
}
