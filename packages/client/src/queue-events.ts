import { QueueEvents, QueueEventsOptions } from 'bullmq';
import { Logger } from 'pino';
import { ToroTaskClient } from './client.js';
import type { TaskQueueEventsOptions } from './types/queue.js';

export class TaskQueueEvents extends QueueEvents {
  public readonly taskClient: ToroTaskClient;

  constructor(client: ToroTaskClient, name: string, options?: Partial<TaskQueueEventsOptions>) {
    if (!client) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue events name is required.');
    }
    options = options || {};
    options.prefix = options.prefix || client.queuePrefix;
    options.connection = options.connection || client.connectionOptions;

    super(name, options as QueueEventsOptions);
    this.taskClient = client;
  }
}
