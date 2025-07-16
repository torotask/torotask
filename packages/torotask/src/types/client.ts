import type { ConnectionOptions as BullMQConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';

/** BullMQ Client Options using intersection */
export type ToroTaskOptions = Partial<BullMQConnectionOptions> & {
  /**
   * A Pino logger instance or configuration options for creating one.
   * If not provided, a default logger will be created.
   */
  logger?: Logger;
  loggerName?: string;
  env?: Record<string, any>;
  prefix?: string;
  queuePrefix?: string;
  queueTTL?: number;
  allowNonExistingQueues?: boolean;
};
