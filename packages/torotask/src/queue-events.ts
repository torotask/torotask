import { QueueEvents, QueueEventsOptions } from 'bullmq';
import { ToroTask } from './client.js';
import type { TaskQueueEventsOptions } from './types/queue.js';

export class TaskQueueEvents extends QueueEvents {
  constructor(
    public readonly taskClient: ToroTask,
    name: string,
    options?: Partial<TaskQueueEventsOptions>
  ) {
    if (!taskClient) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue events name is required.');
    }
    options = options || {};
    options.prefix = options.prefix || taskClient.queuePrefix;
    options.connection = options.connection || taskClient.getQueueConnectionOptions();

    // Note: QueueEvents cannot reuse connections because they require blocking connections

    super(name, options as QueueEventsOptions);
  }
}
