import type { FlowChildJob, FlowJob, Job } from 'bullmq';
import { ConnectionOptions } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';
import { type Logger, P, pino } from 'pino';
import { LRU } from 'tiny-lru';
import { EventDispatcher } from './event-dispatcher.js';
import { TaskQueue } from './queue.js';
import { TaskGroup } from './task-group.js';
import type {
  BulkTaskRun,
  BulkTaskRunChild,
  BulkTaskRunNode,
  SchemaHandler,
  TaskDefinitionRegistry,
  TaskGroupDefinitionRegistry,
  TaskJobOptions,
  TaskRegistry,
  TaskGroupRegistry,
  TaskGroupDefinition,
  ToroTaskOptions,
} from './types/index.js';
import { getConfigFromEnv } from './utils/get-config-from-env.js';
import { TaskWorkflow } from './workflow.js';
import type { Task } from './task.js';
import { TaskJob } from './job.js';

const LOGGER_NAME = 'ToroTask';
const BASE_PREFIX = 'torotask';
const QUEUE_PREFIX = 'tasks';

/**
 * A client class to manage BullMQ connection settings, TaskGroups, and an EventDispatcher.
 */
export class ToroTask<
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry = TaskGroupDefinitionRegistry,
  TGroups extends TaskGroupRegistry<TAllTaskGroupsDefs> = TaskGroupRegistry<TAllTaskGroupsDefs>,
> {
  public readonly connectionOptions: ConnectionOptions;
  public readonly logger: Logger;
  public readonly prefix: string;
  public readonly queuePrefix: string;

  private _eventDispatcher: EventDispatcher | null = null; // Backing field for lazy loading
  private _workflow: TaskWorkflow | null = null; // Backing field for lazy loading
  private _redis: Redis | null = null;
  private _consumerQueues = new LRU<TaskQueue>(
    100, // Max number of cached queues
    5 * 60_000 // TTL in ms (default: 5 minutes)
  );

  public readonly taskGroups: TGroups;
  public readonly taskGroupsById: Record<string, TaskGroup<any, any>>;

  constructor(options?: ToroTaskOptions, taskGroupDefs?: TAllTaskGroupsDefs) {
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

    this.taskGroups = {} as TGroups;
    this.taskGroupsById = {};
    // Initialize task groups from definitions if provided
    if (taskGroupDefs) {
      this.initializeTaskGroups(taskGroupDefs);
    }

    this.logger.debug('ToroTask initialized');
  }

  /**
   * Initializes task groups from the provided task group definitions.
   * This creates all task groups and their tasks, and adds them to the server.
   */
  private initializeTaskGroups(taskGroupDefinitions: TAllTaskGroupsDefs): void {
    const groupCount = Object.keys(taskGroupDefinitions).length;
    this.logger.debug({ groupCount }, 'Initializing task groups from definitions');

    for (const [groupKey, groupDef] of Object.entries(taskGroupDefinitions)) {
      const typedGroupDef = groupDef as TaskGroupDefinition<any>;

      const groupId = typedGroupDef.id || groupKey;
      const group = this.createTaskGroup(groupId, typedGroupDef.tasks);
      this.taskGroups[groupKey as keyof TAllTaskGroupsDefs] = group as any;

      const taskCount = Object.keys(typedGroupDef.tasks).length;
      this.logger.debug(
        {
          groupId: groupKey,
          taskCount,
        },
        'Task group initialized'
      );
    }
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
  public createTaskGroup<TDefs extends TaskDefinitionRegistry>(
    id: string,
    definitions?: TDefs
  ): TaskGroup<TDefs, TaskRegistry<TDefs>> {
    if (this.taskGroupsById[id]) {
      return this.taskGroupsById[id] as TaskGroup<TDefs, TaskRegistry<TDefs>>;
    }
    this.logger.debug({ taskGroupid: id }, 'Creating new TaskGroup');
    const newTaskGroup = new TaskGroup<TDefs, TaskRegistry<TDefs>>(this, id, this.logger, definitions);
    this.taskGroupsById[id] = newTaskGroup;
    return newTaskGroup;
  }

  /**
   * Retrieves an existing TaskGroup instance by id.
   */
  public getTaskGroup(id: string): TaskGroup | undefined {
    return this.taskGroupsById[id];
  }

  /**
   * Retrieves an existing TaskGroup instance by key.
   */
  public getTaskGroupByKey<G extends keyof TGroups, SpecificTaskGroup extends TGroups[G] = TGroups[G]>(
    key: G
  ): SpecificTaskGroup | undefined {
    return this.taskGroups[key] as SpecificTaskGroup;
  }

  /**
   * Retrieves an existing Task instance by group and id.
   */
  public getTask<PayloadType = any, ResultType = unknown>(
    groupId: string,
    id: string
    // The Task class is generic as Task<PayloadExplicit, ResultType, SchemaInputVal extends ActualSchemaInputType = undefined>
    // We need to ensure the SchemaInputVal part of the return type matches what group.getTask returns.
  ): Task<PayloadType, ResultType, SchemaHandler> | undefined {
    const group = this.getTaskGroup(groupId);
    if (!group) return undefined;

    // group.getTask(id) returns Task<any, any, ActualSchemaInputType> | undefined
    // We cast to the user-specified PayloadType and ResultType, while maintaining ActualSchemaInputType for the schema part.
    return group.getTask(id) as Task<PayloadType, ResultType, SchemaHandler> | undefined;
  }

  public getTaskByKey<
    G extends keyof TGroups,
    SpecificTaskGroup extends TGroups[G] = TGroups[G],
    TaskName extends keyof SpecificTaskGroup['tasks'] = keyof SpecificTaskGroup['tasks'],
  >(groupId: G, taskId: TaskName): SpecificTaskGroup['tasks'][TaskName] | undefined {
    const group = this.taskGroups[groupId];
    if (group && group.tasks && Object.prototype.hasOwnProperty.call(group.tasks, taskId)) {
      return group.tasks[taskId as any] as any;
    }
    return undefined;
  }

  /**
   * Gets a task in the specified group with the provided data.
   *
   * @param taskPath The path of the task to run in format group.task.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  public getTaskByPath<PayloadType = any, ResultType = unknown>(
    taskKey: `${string}.${string}`
  ): Task<PayloadType, ResultType, SchemaHandler> | undefined {
    const [groupId, taskId] = taskKey.split('.');
    return this.getTask<PayloadType, ResultType>(groupId, taskId);
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
   * @param group The group id of the task.
   * @param task The task id.
   * @returns A promise that resolves to the Queue instance or null if it doesn't exist.
   */
  private async getConsumerQueue<PayloadType = any, ResultType = any>(group: string, task: string) {
    const key = `${group}.${task}`;
    const cached = this._consumerQueues.get(key);
    if (cached) return cached;

    const exists = await this.queueExists(key);
    if (!exists) return null;

    const queue = new TaskQueue<PayloadType, ResultType>(this, key);
    this._consumerQueues.set(key, queue as any);
    return queue;
  }

  /**
   * Runs a task in the specified group with the provided data.
   *
   * @param groupId The id of the task group.
   * @param taskId The id of the task to run.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  async runTask<PayloadType = any, ResultType = any>(
    groupId: string,
    taskId: string,
    payload: PayloadType,
    options?: TaskJobOptions
  ) {
    const task = this.getTask<PayloadType, ResultType>(groupId, taskId);
    if (task) {
      return await task.run(payload);
    }

    const queue = await this.getConsumerQueue<PayloadType, ResultType>(groupId, taskId);
    if (!queue) {
      throw new Error(`Queue ${groupId}.${taskId} is not registered`);
    }

    return await queue.add(taskId, payload, options);
  }

  /**
   * Runs a task in the specified group with the provided data.
   *
   * @param taskPath The key of the task to run in format group.task.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  async runTaskByPath<PayloadType = any, ResultType = any>(taskPath: `${string}.${string}`, payload: PayloadType) {
    const [groupId, taskId] = taskPath.split('.');
    return this.runTask<PayloadType, ResultType>(groupId, taskId, payload);
  }

  /**
   * Runs a task in the specified group with the provided data.
   *
   * @param groupKey The key of the task group.
   * @param taskName The name of the task to run.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */

  async runTaskByKey<
    G extends keyof TGroups,
    SpecificTaskGroup extends TGroups[G] = TGroups[G],
    TaskName extends keyof SpecificTaskGroup['tasks'] = keyof SpecificTaskGroup['tasks'],
    ActualTask extends SpecificTaskGroup['tasks'][TaskName] = SpecificTaskGroup['tasks'][TaskName],
    // Payload is the ActualPayloadType inferred from the Task instance
    Payload = ActualTask extends Task<any, any, any, infer P> ? P : unknown,
    Result = ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
  >(groupId: G, taskName: TaskName, payload: ActualPayload): Promise<TaskJob<ActualPayload, Result>> {
    const group = this.taskGroups[groupId];
    if (group && group.runTaskByKey) {
      return group.runTaskByKey<string, ActualTask, ActualPayload>(taskName as string, payload);
    } else {
      throw new Error(`Task group "${groupId as string}" not found.`);
    }
  }

  _convertToFlow(run: BulkTaskRun): FlowJob {
    const task = this.getTask(run.taskGroup, run.taskId);
    if (!task) {
      throw new Error(`Task ${run.taskGroup}.${run.taskId} not found`);
    }
    const queueName = task.queueName;
    const options = {
      ...task.jobsOptions,
      ...run.options,
    };

    return {
      name: run.name,
      queueName: queueName,
      data: {
        payload: run.payload,
        state: run.state,
      },
      opts: options,
      children: run.children?.map((child) => this._convertToChildFlow(child)) || undefined,
    };
  }

  _convertToChildFlow(run: BulkTaskRunChild): FlowChildJob {
    const task = this.getTask(run.taskGroup, run.taskId);
    if (!task) {
      throw new Error(`Task ${run.taskGroup}.${run.taskId} not found`);
    }
    const queueName = task.queueName;
    const options = {
      ...task.jobsOptions,
      ...run.options,
    };

    return {
      name: run.name,
      queueName: queueName,
      data: {
        payload: run.payload,
        state: run.state,
      },
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
   *  Sends an event to the EventDispatcher.
   *  This method is a wrapper around the EventDispatcher's send method.
   *  It allows sending events with a specific name and data payload.
   * @param eventName
   * @param data
   * @param options
   * @returns
   */
  async sendEvent<E = unknown>(eventName: string, data: E, options?: TaskJobOptions) {
    return this.events.send(eventName, data, options);
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
   * Closes all managed TaskGroups, their Tasks, the EventDispatcher, Queues and redis gracefully.
   */
  async close(): Promise<void> {
    this.logger.info('Closing ToroTask resources (Tasks, TaskGroups, EventDispatcher)...');
    const closePromises: Promise<void>[] = [];

    // Close all task resources (worker, queue, events) via task.close()
    const taskClosePromises = Object.values(this.taskGroups).flatMap((group) => group.close());
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
      this.logger.error({ err: error }, 'Error during ToroTask resource closure.');
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
