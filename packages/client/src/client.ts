import { ConnectionOptions, WorkerOptions } from 'bullmq';
import { getConfigFromEnv } from './utils/get-config-from-env.js';
import { TaskGroup } from './task-group.js';
import { pino, type Logger } from 'pino';

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

/** Interface for filtering workers in start/stop operations */
export interface WorkerFilter {
  /** Array of group names to target. If omitted, targets all groups. */
  groups?: string[];
  /** Map where keys are group names and values are arrays of task names within that group. */
  tasks?: { [groupName: string]: string[] };
}

/**
 * A client class to manage BullMQ connection settings and TaskGroups.
 */
export class ToroTaskClient {
  public readonly connectionOptions: ConnectionOptions;
  public readonly logger: Logger;
  private readonly taskGroups: Record<string, TaskGroup> = {};

  constructor(options?: ToroTaskClientOptions) {
    const bullmqEnvConfig = getConfigFromEnv('BULLMQ_REDIS_');
    const redisEnvConfig = getConfigFromEnv('REDIS_');

    const { logger, loggerName, ...connectionOpts } = options || {};

    const mergedConfig: Partial<ConnectionOptions> = {
      ...redisEnvConfig,
      ...bullmqEnvConfig,
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
   * Starts workers based on the provided filter.
   *
   * @param filter Optional filter to target specific groups or tasks.
   * @param workerOptions Optional default WorkerOptions to pass down.
   */
  startWorkers(filter?: WorkerFilter, workerOptions?: WorkerOptions): void {
    this.logger.info({ filter }, 'Starting workers across task groups');
    let groupsToProcess: TaskGroup[] = [];

    if (filter?.groups) {
      // Filter by specified group names
      groupsToProcess = filter.groups
        .map((name) => this.taskGroups[name])
        .filter((group): group is TaskGroup => !!group);
      const requested = filter.groups.length;
      const found = groupsToProcess.length;
      if (requested !== found) {
        this.logger.warn({ requested, found }, 'Some requested groups for starting workers were not found.');
      }
    } else {
      // Process all known groups
      groupsToProcess = Object.values(this.taskGroups);
    }

    groupsToProcess.forEach((group) => {
      // Determine task filter for this specific group
      const taskFilter = filter?.tasks?.[group.name] ? { tasks: filter.tasks[group.name] } : undefined;
      if (filter?.tasks && !filter.groups?.includes(group.name) && !taskFilter) {
        // If task filters exist but don't include this group (and group wasn't explicitly listed),
        // skip this group entirely.
        return;
      }
      group.startWorkers(taskFilter, workerOptions);
    });
    this.logger.info('Finished request to start workers');
  }

  /**
   * Stops workers based on the provided filter.
   *
   * @param filter Optional filter to target specific groups or tasks.
   * @returns A promise that resolves when all targeted workers have been requested to stop.
   */
  async stopWorkers(filter?: WorkerFilter): Promise<void> {
    this.logger.info({ filter }, 'Stopping workers across task groups');
    let groupsToProcess: TaskGroup[] = [];

    if (filter?.groups) {
      groupsToProcess = filter.groups
        .map((name) => this.taskGroups[name])
        .filter((group): group is TaskGroup => !!group);
      const requested = filter.groups.length;
      const found = groupsToProcess.length;
      if (requested !== found) {
        this.logger.warn({ requested, found }, 'Some requested groups for stopping workers were not found.');
      }
    } else {
      groupsToProcess = Object.values(this.taskGroups);
    }

    const stopPromises = groupsToProcess.map((group) => {
      const taskFilter = filter?.tasks?.[group.name] ? { tasks: filter.tasks[group.name] } : undefined;
      if (filter?.tasks && !filter.groups?.includes(group.name) && !taskFilter) {
        // If task filters exist but don't include this group (and group wasn't explicitly listed),
        // skip stopping workers in this group.
        return Promise.resolve(); // Resolve immediately, nothing to stop here based on filter
      }
      return group.stopWorkers(taskFilter);
    });

    await Promise.all(stopPromises);
    this.logger.info('Finished request to stop workers');
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

export { Task, TaskOptions, TaskHandler, TaskHandlerContext, TaskHandlerOptions } from './task.js';
export { TaskGroup } from './task-group.js';
export { BaseQueue } from './base-queue.js';
export { SubTask, SubTaskHandler, SubTaskHandlerContext, SubTaskHandlerOptions } from './sub-task.js';

// Re-export core BullMQ types users might need
export { ConnectionOptions, JobsOptions, Job } from 'bullmq';
