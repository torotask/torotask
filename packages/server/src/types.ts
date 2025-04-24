import type { ToroTaskClient, SingleOrArray, TaskHandler, TaskOptions, TaskTrigger } from '@torotask/client';
import type { Logger, DestinationStream, LoggerOptions } from 'pino';

/** Options for configuring the TaskServer */
export interface TaskServerOptions {
  /**
   * ToroTaskClient instance to use.
   * If not provided, connection options must be supplied to create one.
   */
  client?: ToroTaskClient;
  /**
   * Options to create a ToroTaskClient if an instance is not provided.
   * Ignored if `client` is provided.
   */
  clientOptions?: ConstructorParameters<typeof ToroTaskClient>[0];
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

export type TaskModuleOptions = TaskOptions & {
  name?: string;
};

/** Type definition for the expected export from a task file */
export interface TaskModule<T = unknown, R = unknown> {
  handler: TaskHandler<T, R>;
  triggers: SingleOrArray<TaskTrigger<T>>;
  options?: TaskModuleOptions;
}
