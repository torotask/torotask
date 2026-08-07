import type { QueueAdapterOptions } from '@bull-board/api/typings/app';
import type { ToroTaskTruncateOptions } from './truncate-formatter.js';

export interface ToroTaskBullMQAdapterOptions extends Partial<QueueAdapterOptions> {
  /**
   * Optional truncation of large inline values in Bull Board responses.
   * Data refs are never truncated — they are already compact.
   */
  truncate?: ToroTaskTruncateOptions;
}
