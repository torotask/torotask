import { ConnectionOptions, WorkerOptions, Queue } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';
import { getConfigFromEnv } from './utils/get-config-from-env.js';
import { TaskGroup } from './task-group.js';
import { pino, type Logger } from 'pino';
import type { BaseQueue } from './base-queue.js';
import type { ConnectionOptions as BullMQConnectionOptions } from 'bullmq'; // Import ConnectionOptions if needed
import { EventDispatcher } from './event-dispatcher.js'; // Import EventDispatcher

const LOGGER_NAME = 'ToroTask';
const BASE_PREFIX = 'torotask';
const QUEUE_PREFIX = 'tasks';

/** BullMQ Client Options using intersection */
export type ToroTaskClientOptions = Partial<BullMQConnectionOptions> & {
  /**
   * A Pino logger instance or configuration options for creating one.
   * If not provided, a default logger will be created.
   */
  logger?: Logger;
  loggerName?: string;
  prefix?: string;
  queuePrefix?: string;
  env?: Record<string, any>;
};

/** Worker Filter defined here */
export interface WorkerFilter {
  /** Array of group names to target. If omitted, targets all groups. */
  groups?: string[];
  /** Map where keys are group names and values are arrays of task names within that group. */
  tasks?: { [groupName: string]: string[] };
}

/**
 * A client class to manage BullMQ connection settings, TaskGroups, and an EventDispatcher.
 */
export class ToroTaskClient {
  public readonly connectionOptions: ConnectionOptions;
  public readonly logger: Logger;
  public readonly prefix: string;
  public readonly queuePrefix: string;
  private readonly taskGroups: Record<string, TaskGroup> = {};
  private _eventDispatcher: EventDispatcher | null = null; // Backing field for lazy loading

  constructor(options?: ToroTaskClientOptions) {
    const { env, logger, loggerName, prefix, queuePrefix, ...connectionOpts } = options || {};

    const toroTaskEnvConfig = getConfigFromEnv('TOROTASK_REDIS_', env);
    const redisEnvConfig = getConfigFromEnv('REDIS_', env);

    const mergedConfig: Partial<ConnectionOptions> = {
      ...redisEnvConfig,
      ...toroTaskEnvConfig,
      ...connectionOpts,
    };

    this.connectionOptions = mergedConfig as ConnectionOptions;

    this.logger = (logger ?? pino()).child({ name: loggerName ?? LOGGER_NAME });
    this.prefix = prefix || BASE_PREFIX;
    this.queuePrefix = [this.prefix, queuePrefix || QUEUE_PREFIX].join(':');
    this.logger.info('ToroTaskClient initialized');
  }

  /**
   * Gets the lazily-initialized EventDispatcher instance.
   * Creates the instance on first access.
   */
  public get eventDispatcher(): EventDispatcher {
    if (!this._eventDispatcher) {
      this.logger.info('Initializing EventDispatcher...');
      // Pass 'this' (the client instance) and its logger
      this._eventDispatcher = new EventDispatcher(this, this.logger);
      this.logger.info('EventDispatcher initialized successfully.');
    }
    return this._eventDispatcher;
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
   * Fetches all BullMQ queue names from the Redis instance.
   * This method creates a temporary connection to scan for queue keys.
   *
   * @returns A promise that resolves with an array of unique queue names.
   */
  async getAllQueueNames(): Promise<string[]> {
    this.logger.debug('Attempting to fetch all queue names from Redis...');
    const redis = new Redis(this.connectionOptions as RedisOptions);
    const queueNames = new Set<string>();
    const stream = redis.scanStream({
      match: `${this.queuePrefix}:*:meta`, // BullMQ uses this pattern for queue metadata
      count: 100, // Adjust count for performance if needed
    });

    const escapedPrefix = this.queuePrefix.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const queueRegex = new RegExp(`^${escapedPrefix}:(.+):meta$`);

    return new Promise((resolve, reject) => {
      stream.on('data', (keys: string[]) => {
        keys.forEach((key) => {
          const match = key.match(queueRegex);
          if (match && match[1]) {
            queueNames.add(match[1]);
          }
        });
      });

      stream.on('end', async () => {
        this.logger.debug({ count: queueNames.size }, 'Finished scanning Redis for queue names.');
        try {
          await redis.quit(); // Ensure the temporary connection is closed
          // Sort the names alphabetically before resolving
          resolve(Array.from(queueNames).sort());
        } catch (quitError) {
          this.logger.error({ err: quitError }, 'Error closing temporary Redis connection');
          reject(quitError); // Reject if closing fails
        }
      });

      stream.on('error', (err: Error) => {
        this.logger.error({ err }, 'Error scanning Redis for queue names');
        redis
          .quit()
          .catch((quitErr: Error) => this.logger.error({ err: quitErr }, 'Error quitting Redis after scan error'));
        reject(err);
      });
    });
  }

  /**
   * Fetches all BullMQ queue names and returns a map of queue names to Queue instances.
   *
   * @returns A promise that resolves with a Record mapping queue names to Queue instances.
   */
  async getAllQueueInstances(): Promise<Record<string, Queue>> {
    this.logger.info('Fetching all queue names and creating Queue instances...');
    const queueNames = await this.getAllQueueNames();
    const queueInstances: Record<string, Queue> = {};

    for (const queueName of queueNames) {
      this.logger.debug({ queueName }, 'Creating Queue instance');
      // Use the client's connection options to instantiate each queue
      queueInstances[queueName] = new Queue(queueName, {
        prefix: this.queuePrefix,
        connection: this.connectionOptions,
      });
    }

    this.logger.info({ count: queueNames.length }, 'Finished creating Queue instances for all found queues.');
    return queueInstances;
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

    const mergedOptions: WorkerOptions = {
      prefix: this.queuePrefix,
      connection: this.connectionOptions,
      ...workerOptions,
    };

    groupsToProcess.forEach((group) => {
      // Determine task filter for this specific group
      const taskFilter = filter?.tasks?.[group.name] ? { tasks: filter.tasks[group.name] } : undefined;
      if (filter?.tasks && !filter.groups?.includes(group.name) && !taskFilter) {
        // If task filters exist but don't include this group (and group wasn't explicitly listed),
        // skip this group entirely.
        return;
      }
      group.startWorkers(taskFilter, mergedOptions);
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
   * Closes all managed TaskGroups, their Tasks, and the EventDispatcher gracefully.
   */
  async close(): Promise<void> {
    this.logger.info('Closing ToroTaskClient resources (Tasks, TaskGroups, EventDispatcher)...');
    const closePromises: Promise<void>[] = [];

    // Close all task resources (worker, queue, events) via task.close()
    const taskClosePromises = Object.values(this.taskGroups).flatMap((group) =>
      Array.from(group.getTasks().values()).map((task) => task.close())
    );
    closePromises.push(...taskClosePromises);

    // Close EventDispatcher if it was initialized
    if (this._eventDispatcher) {
      this.logger.info('Closing EventDispatcher...');
      closePromises.push(this._eventDispatcher.close());
    } else {
      this.logger.debug('EventDispatcher was not initialized, skipping closure.');
    }

    // Wait for all tasks and the event dispatcher to close
    try {
      await Promise.all(closePromises);
      this.logger.info('All managed resources (tasks, event dispatcher) closed.');
    } catch (error) {
      this.logger.error({ err: error }, 'Error during ToroTaskClient resource closure.');
      // Potentially re-throw or handle aggregate error
    }

    this.logger.info('ToroTaskClient resources closed successfully.');
  }
}

// --- Exports ---
export { BaseQueue } from './base-queue.js';
// Only export SubTask class itself from sub-task.ts
export { SubTask } from './sub-task.js';
// Other types (SubTaskHandler etc.) are handled by index.ts exporting from types.ts

// Re-export core BullMQ types users might need
export { ConnectionOptions, JobsOptions, Job, Queue } from 'bullmq';
export { EventDispatcher } from './event-dispatcher.js'; // Re-export EventDispatcher
