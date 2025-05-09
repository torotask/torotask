import { FlowProducer, Job } from 'bullmq';
import { ToroTaskClient } from './client.js';
import type { TaskQueueOptions } from './types/index.js';
import { TaskJob } from './job.js';

export class TaskWorkflow extends FlowProducer {
  constructor(
    public readonly taskClient: ToroTaskClient,
    options?: Partial<TaskQueueOptions>
  ) {
    options = options || {};
    options.prefix = options.prefix || taskClient.queuePrefix;
    options.connection = options.connection = taskClient.connectionOptions;

    super(options as TaskQueueOptions);
  }

  /**
   * Override the Job class to use TaskJob
   * @returns {typeof Job}
   */
  protected get Job(): typeof Job {
    return TaskJob as any;
  }
}
