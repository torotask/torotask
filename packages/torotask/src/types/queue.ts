import type { QueueEventsOptions, QueueOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { CreateClientFunction } from './client.js';

export type TaskQueueOptions = QueueOptions & {
  logger?: Logger;
  /**
   * Function to create Redis connections for the queue.
   * Used for connection reusing when enabled in ToroTask client.
   */
  createClient?: CreateClientFunction;
};

export type TaskQueueEventsOptions = QueueEventsOptions & {
  /**
   * Function to create Redis connections for queue events.
   * Used for connection reusing when enabled in ToroTask client.
   */
  createClient?: CreateClientFunction;
};
