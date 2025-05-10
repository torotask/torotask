import type { SingleOrArray } from './utils.js';
import type { TaskHandler, TaskOptions, TaskTrigger } from './task.js';
import type { ToroTask } from '../client.js';

import type { DestinationStream, Logger, LoggerOptions } from 'pino';

/** Options for configuring the TaskServer */
export interface TaskServerOptions {
  /**
   * ToroTask instance to use.
   * If not provided, connection options must be supplied to create one.
   */
  client?: ToroTask;
  /**
   * Options to create a ToroTask if an instance is not provided.
   * Ignored if `client` is provided.
   */
  clientOptions?: ConstructorParameters<typeof ToroTask>[0];
  /**
   * Pino logger instance or options.
   * If neither is provided, a default logger will be created.
   */
  logger?: Logger | DestinationStream | LoggerOptions;
  /** Logger name to use if creating a logger */
  loggerName?: string;
  /**
   * Whether the server should attach listeners to
   * process.on('unhandledRejection') and process.on('uncaughtException').
   * Defaults to true.
   */
  handleGlobalErrors?: boolean;
  /**
   * The root directory for resolving relative paths, typically the directory
   * of the script creating the TaskServer instance (e.g., `__dirname`).
   * Required if using relative paths in `loadTasksFromDirectory`.
   */
  rootDir?: string;
}

1;
export type BaseConfig<PayloadType = any> = {
  triggers?: SingleOrArray<TaskTrigger<PayloadType>>;
};
