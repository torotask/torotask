import type { QueueEventsOptions, QueueOptions } from 'bullmq';
import type { Logger } from 'pino';

export type TaskQueueOptions = QueueOptions & {
  logger?: Logger;
};

export type TaskQueueEventsOptions = QueueEventsOptions;
