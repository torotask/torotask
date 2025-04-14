import { ConnectionOptions } from 'bullmq';
import { getConfigFromEnv } from './utils/get-config-from-env';
import { TaskGroup } from './task-group';
import pino, { Logger } from 'pino';
import { BaseQueue } from './base-queue';

const LOGGER_NAME = 'BullMQ';

/**
 * Options for configuring the ToroTaskClient.
 * Extends BullMQ's ConnectionOptions (as Partial).
 */
export type ToroTaskClientOptions = Partial<ConnectionOptions> & {
  /**
   * A Pino logger instance or configuration options for creating one.
   * If not provided, a default logger will be created.
   */
  logger?: Logger;
  loggerName?: string;
};

/**
 * A client class to manage ToroTask connection settings and TaskGroups.
 */
export class ToroTaskClient {
  public readonly connectionOptions: ConnectionOptions;
  public readonly logger: Logger;
  private readonly taskGroups: Record<string, TaskGroup> = {};

  constructor(options?: ToroTaskClientOptions) {
    const toroTaskEnvConfig = getConfigFromEnv('TOROTASK_REDIS_');
    const redisEnvConfig = getConfigFromEnv('REDIS_');

    const { logger, loggerName, ...connectionOpts } = options || {};

    const mergedConfig: Partial<ConnectionOptions> = {
      ...redisEnvConfig,
      ...toroTaskEnvConfig,
      ...connectionOpts,
    };

    this.connectionOptions = mergedConfig as ConnectionOptions;

    this.logger = (logger ?? pino()).child({ name: loggerName ?? LOGGER_NAME });
    this.logger.info('ToroTaskClient initialized');
  }

  /**
   * Gets the resolved connection options suitable for BullMQ.
   */
  public getConnectionOptions(): ConnectionOptions {
    return this.connectionOptions;
  }

  /**
   * Creates or retrieves a TaskGroup instance.
   */
  public createTaskGroup(name: string): TaskGroup {
    if (this.taskGroups[name]) {
      return this.taskGroups[name];
    }

    this.logger.info({ taskGroupName: name }, 'Creating new TaskGroup');
    const newTaskGroup = new TaskGroup(this, name, this.logger);
    this.taskGroups[name] = newTaskGroup;
    return newTaskGroup;
  }

  /**
   * Retrieves an existing TaskGroup instance by name.
   */
  public getTaskGroup(name: string): TaskGroup | undefined {
    return this.taskGroups[name];
  }

  /**
   * Closes all managed TaskGroups and their associated Tasks gracefully.
   * Iterates through each task and calls its close() method,
   * which handles closing the worker, queue, and queueEvents.
   */
  async close(): Promise<void> {
    this.logger.info('Closing ToroTaskClient resources (Tasks and TaskGroups)...');

    // Close all task resources (worker, queue, events) via task.close()
    const taskClosePromises = Object.values(this.taskGroups).flatMap((group) =>
      Array.from(group.getTasks().values()).map((task) => task.close())
    );

    // Wait for all tasks to close
    await Promise.all(taskClosePromises);
    this.logger.info('All task resources closed.');

    this.logger.info('ToroTaskClient resources closed successfully.');
  }
}

export { Task, TaskOptions, TaskHandler, TaskHandlerContext, TaskHandlerOptions } from './task';
export { TaskGroup } from './task-group';
export { BaseQueue } from './base-queue';
export { SubTask, SubTaskHandler, SubTaskHandlerContext, SubTaskHandlerOptions } from './sub-task';

// Re-export core BullMQ types users might need
export { ConnectionOptions, JobsOptions, Job } from 'bullmq';
