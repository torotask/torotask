import type { ConnectionOptions as BullMQConnectionOptions, FlowChildJob, FlowJob, Job } from 'bullmq';
import { ConnectionOptions, WorkerOptions } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';
import { type Logger, pino } from 'pino';
import { LRU } from 'tiny-lru';
import { EventDispatcher } from './event-dispatcher.js';
import { TaskQueue } from './queue.js';
import { TaskGroup } from './task-group.js';
import type { AnyTask, BulkTaskRun, BulkTaskRunChild, BulkTaskRunNode, TaskJobOptions } from './types/index.js';
import { getConfigFromEnv } from './utils/get-config-from-env.js';
import { TaskWorkflow } from './workflow.js';

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
  env?: Record<string, any>;
  prefix?: string;
  queuePrefix?: string;
  queueTTL?: number;
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
  private _workflow: TaskWorkflow | null = null; // Backing field for lazy loading
  private _redis: Redis | null = null;
  private _consumerQueues = new LRU<TaskQueue>(
    100, // Max number of cached queues
    5 * 60_000 // TTL in ms (default: 5 minutes)
  );

  constructor(options?: ToroTaskClientOptions) {
    const { env, logger, loggerName, prefix, queuePrefix, queueTTL, ...connectionOpts } = options || {};

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
    this.logger.debug('ToroTaskClient initialized');
  }

  /**
   * Gets the lazily-initialized EventDispatcher instance.
   * Creates the instance on first access.
   */
  public get events(): EventDispatcher {
    if (!this._eventDispatcher) {
      this.logger.debug('Initializing EventDispatcher...');
      // Pass 'this' (the client instance) and its logger
      this._eventDispatcher = new EventDispatcher(this, this.logger);
      this.logger.debug('EventDispatcher initialized successfully.');
    }
    return this._eventDispatcher;
  }

  /**
   * Gets the lazily-initialized TaskWorkflow instance.
   * Creates the instance on first access.
   */
  public get workflow(): TaskWorkflow {
    if (!this._workflow) {
      this.logger.debug('Initializing Workflow...');
      this._workflow = new TaskWorkflow(this);
      this.logger.debug('Workflow initialized successfully.');
    }
    return this._workflow;
  }

  /**
   * Gets the resolved connection options suitable for BullMQ.
   */
  public getConnectionOptions(): ConnectionOptions {
    return this.connectionOptions;
  }

  /**
   * Gets the lazily-initialized Redis client instance.
   * Creates the instance on first access.
   */
  public get redis(): Redis {
    if (!this._redis) {
      this._redis = new Redis(this.connectionOptions as RedisOptions);
    }
    return this._redis;
  }

  /**
   * Creates or retrieves a TaskGroup instance.
   */
  public createTaskGroup(name: string): TaskGroup {
    if (this.taskGroups[name]) {
      return this.taskGroups[name];
    }

    this.logger.debug({ taskGroupName: name }, 'Creating new TaskGroup');
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
   * Retrieves an existing Task instance by group and name.
   */
  public getTask<T = any, R = any>(groupName: string, name: string): AnyTask<T, R> | undefined {
    const group = this.getTaskGroup(groupName);
    if (!group) return undefined;

    return group.getTask(name);
  }

  /**
   * Gets a task in the specified group with the provided data.
   *
   * @param taskKey The key of the task to run in format group.task.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  public getTaskByKey<T = any, R = any>(taskKey: `${string}.${string}`): AnyTask<T, R> | undefined {
    const [groupName, taskName] = taskKey.split('.');
    return this.getTask<T, R>(groupName, taskName);
  }

  /**
   * Checks if a queue exists in Redis.
   *
   * @param queueName The name of the queue to check.
   * @returns A promise that resolves to a boolean indicating if the queue exists.
   */
  private async queueExists(queueName: string): Promise<boolean> {
    return (await this.redis.exists(`${this.queuePrefix}:${queueName}:meta`)) > 0;
  }

  /**
   * Retrieves a consumer queue, creating it if it doesn't exist.
   *
   * @param group The group name of the task.
   * @param task The task name.
   * @returns A promise that resolves to the Queue instance or null if it doesn't exist.
   */
  private async getConsumerQueue(group: string, task: string): Promise<TaskQueue | null> {
    const key = `${group}.${task}`;
    const cached = this._consumerQueues.get(key);
    if (cached) return cached;

    const exists = await this.queueExists(key);
    if (!exists) return null;

    const queue = new TaskQueue(this, key);
    this._consumerQueues.set(key, queue);
    return queue;
  }

  /**
   * Runs a task in the specified group with the provided data.
   *
   * @param groupName The name of the task group.
   * @param taskName The name of the task to run.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  async runTask<T = any, R = any>(
    groupName: string,
    taskName: string,
    data: T,
    options?: TaskJobOptions
  ): Promise<Job<T, R>> {
    const task = this.getTask<T, R>(groupName, taskName);
    if (task) {
      return await task.run(data);
    }

    const queue = await this.getConsumerQueue(groupName, taskName);
    if (!queue) {
      throw new Error(`Queue ${groupName}.${taskName} is not registered`);
    }

    return await queue.add(taskName, data, options);
  }

  /**
   * Runs a task in the specified group with the provided data.
   *
   * @param taskKey The key of the task to run in format group.task.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  async runTaskByKey<T = any, R = any>(taskKey: `${string}.${string}`, data: T): Promise<Job<T, R>> {
    const [groupName, taskName] = taskKey.split('.');
    return this.runTask<T, R>(groupName, taskName, data);
  }

  _convertToFlow(run: BulkTaskRun): FlowJob {
    const task = this.getTask(run.taskGroup, run.taskName);
    if (!task) {
      throw new Error(`Task ${run.taskGroup}.${run.taskName} not found`);
    }
    const queueName = task.queueName;
    const options = {
      ...task.jobsOptions,
      ...run.options,
    };

    return {
      name: run.name,
      queueName: queueName,
      data: run.data,
      opts: options,
      children: run.children?.map((child) => this._convertToChildFlow(child)) || undefined,
    };
  }

  _convertToChildFlow(run: BulkTaskRunChild): FlowChildJob {
    const task = this.getTask(run.taskGroup, run.taskName);
    if (!task) {
      throw new Error(`Task ${run.taskGroup}.${run.taskName} not found`);
    }
    const queueName = task.queueName;
    const options = {
      ...task.jobsOptions,
      ...run.options,
    };

    return {
      name: run.name,
      queueName: queueName,
      data: run.data,
      opts: options,
      children: run.children?.map((child) => this._convertToChildFlow(child)) || undefined,
    };
  }

  /**
   * Runs multiple task in the specified groups with the provided data.
   *
   */
  async runBulkTasks(runs: BulkTaskRun[]): Promise<BulkTaskRunNode[]> {
    const flows: FlowJob[] = runs.map((run) => {
      return this._convertToFlow(run);
    });

    return await this.workflow.addBulk(flows);
  }

  /**
   * Fetches all BullMQ queue names from the Redis instance.
   * This method creates a temporary connection to scan for queue keys.
   *
   * @returns A promise that resolves with an array of unique queue names.
   */
  async getAllQueueNames(): Promise<string[]> {
    this.logger.debug('Attempting to fetch all queue names from Redis...');
    const redis = this.redis;
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
  async getAllQueueInstances(): Promise<Record<string, TaskQueue>> {
    this.logger.info('Fetching all queue names and creating Queue instances...');
    const queueNames = await this.getAllQueueNames();
    const queueInstances: Record<string, TaskQueue> = {};

    for (const queueName of queueNames) {
      this.logger.debug({ queueName }, 'Creating Queue instance');
      // Use the client's connection options to instantiate each queue
      queueInstances[queueName] = new TaskQueue(this, queueName);
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
  async startWorkers(filter?: WorkerFilter, workerOptions?: WorkerOptions): Promise<void> {
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

    groupsToProcess.forEach(async (group) => {
      // Determine task filter for this specific group
      const taskFilter = filter?.tasks?.[group.name] ? { tasks: filter.tasks[group.name] } : undefined;
      if (filter?.tasks && !filter.groups?.includes(group.name) && !taskFilter) {
        // If task filters exist but don't include this group (and group wasn't explicitly listed),
        // skip this group entirely.
        return;
      }
      await group.startWorkers(taskFilter, mergedOptions);
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
   * Closes all managed TaskGroups, their Tasks, the EventDispatcher, Queues and redis gracefully.
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
      this.logger.debug('Closing EventDispatcher...');
      closePromises.push(this._eventDispatcher.close());
    } else {
      this.logger.debug('EventDispatcher was not initialized, skipping closure.');
    }

    for (const queue of this._consumerQueues.values()) {
      closePromises.push(queue.close());
    }

    // Wait for all tasks and the event dispatcher to close
    try {
      await Promise.all(closePromises);
      this._consumerQueues.clear();
      await this.redis.quit();
      this.logger.info('All managed resources (tasks, event dispatcher, queues, redis) closed.');
    } catch (error) {
      this.logger.error({ err: error }, 'Error during ToroTaskClient resource closure.');
      // Potentially re-throw or handle aggregate error
    }
  }
}

// --- Exports ---
export { BaseQueue } from './base-queue.js';
// Only export SubTask class itself from sub-task.ts
export { SubTask } from './sub-task.js';
// Other types (SubTaskHandler etc.) are handled by index.ts exporting from types.ts

// Re-export core BullMQ types users might need
export { ConnectionOptions, Job, JobsOptions, Queue } from 'bullmq';
export { EventDispatcher } from './event-dispatcher.js'; // Re-export EventDispatcher
