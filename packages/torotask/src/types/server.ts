import type { ToroTaskOptions } from './client.js';
import type { TaskTrigger } from './task.js';
import type { SingleOrArray } from './utils.js';

/** Options for configuring the TaskServer */
export type TaskServerOptions = ToroTaskOptions & {
  /**
   * Whether the server should attach listeners to
   * process.on('unhandledRejection') and process.on('uncaughtException').
   * Defaults to true.
   */
  handleGlobalErrors?: boolean;
};

export interface BaseConfig<PayloadType = any> {
  triggers?: SingleOrArray<TaskTrigger<PayloadType>>;
}
