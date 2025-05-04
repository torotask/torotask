import { Queue, QueueOptions } from 'bullmq';
import { Logger } from 'pino';
import { ToroTaskClient } from './client.js';
import type { TaskQueueOptions } from './types/index.js';
import { TaskJob } from './job.js';

export class TaskQueue<DataTypeOrJob = any, DefaultResultType = any> extends Queue<DataTypeOrJob, DefaultResultType> {
  public readonly logger: Logger;

  constructor(
    public readonly taskClient: ToroTaskClient,
    name: string,
    options?: Partial<TaskQueueOptions>
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

    super(name, options as QueueOptions);
    this.logger = options.logger || taskClient.logger.child({ taskQueue: name });
  }

  /**
   * Override the Job class to use TaskJob
   * @returns {typeof TaskJob}
   */
  protected get Job(): typeof TaskJob {
    return TaskJob;
  }

  /**
   * Get the Redis client instance used by the queue.
   * @returns The Redis client instance.
   */
  async getRedisClient() {
    return this.client;
  }
}
