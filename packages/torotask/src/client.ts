import type { FlowChildJob, FlowJob, Job } from 'bullmq';
import { ConnectionOptions } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';
import { type Logger, P, pino } from 'pino';
import { LRU } from 'tiny-lru';
import { EventDispatcher } from './event-dispatcher.js';
import { TaskQueue } from './queue.js';
import { TaskGroup } from './task-group.js';
import type {
  SchemaHandler,
  TaskDefinitionRegistry,
  TaskFlowRun,
  TaskFlowRunNode,
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
import { convertJobOptions } from './utils/convert-job-options.js';

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
  private readonly _isTyped: boolean;
  private readonly _allowNonExistingQueues: boolean;

  constructor(options?: ToroTaskOptions, taskGroupDefs?: TAllTaskGroupsDefs) {
    const { env, logger, loggerName, prefix, queuePrefix, queueTTL, allowNonExistingQueues, ...connectionOpts } =
      options || {};

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
    this._isTyped = !!taskGroupDefs;
    this._allowNonExistingQueues = allowNonExistingQueues ?? false;

    // Initialize task groups from definitions if provided
    if (taskGroupDefs) {
      this.initializeTaskGroups(taskGroupDefs);
    }

    this.logger.debug(
      { isTyped: this._isTyped, allowNonExistingQueues: this._allowNonExistingQueues },
      'ToroTask initialized'
    );
  }

  /**
   * Initializes task groups from the provided task group definitions.
   * This creates all task groups and their tasks, and adds them to the server.
   */
  private initializeTaskGroups(taskGroupDefinitions: TAllTaskGroupsDefs): void {
    const groupCount = Object.keys(taskGroupDefinitions).length;
    this.logger.debug({ groupCount }, 'Initializing task groups from definitions');

    for (const [groupId, groupDef] of Object.entries(taskGroupDefinitions)) {
      const typedGroupDef = groupDef as TaskGroupDefinition<any>;

      // Use groupId directly as the group ID
      const group = this.createTaskGroup(groupId, typedGroupDef.tasks);
      this.taskGroups[groupId as keyof TAllTaskGroupsDefs] = group as any;

      const taskCount = Object.keys(typedGroupDef.tasks).length;
      this.logger.debug(
        {
          groupId: groupId,
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
    if (this.taskGroups[id as keyof TGroups]) {
      return this.taskGroups[id as keyof TGroups] as TaskGroup<TDefs, TaskRegistry<TDefs>>;
    }
    this.logger.debug({ taskGroupId: id }, 'Creating new TaskGroup');
    const newTaskGroup = new TaskGroup<TDefs, TaskRegistry<TDefs>>(this, id, this.logger, definitions);
    this.taskGroups[id as keyof TGroups] = newTaskGroup as any;
    return newTaskGroup;
  }

  /**
   * Retrieves an existing TaskGroup instance by id.
   */
  public getTaskGroup<G extends keyof TGroups, SpecificTaskGroup extends TGroups[G] = TGroups[G]>(
    id: G
  ): SpecificTaskGroup | undefined {
    return this.taskGroups[id] as SpecificTaskGroup;
  }

  /**
   * Retrieves an existing Task instance by group and id (internal method).
   * Note: This method now uses the task id since we've unified key and ID concepts.
   * @internal
   */
  private _getTask<PayloadType = any, ResultType = unknown>(
    groupId: string,
    taskId: string
  ): Task<PayloadType, ResultType, SchemaHandler> | undefined {
    const group = this.getTaskGroup(groupId as any);
    if (!group) return undefined;

    // Use getTask since id is now the same as ID
    return group.getTask(taskId as any) as Task<PayloadType, ResultType, SchemaHandler> | undefined;
  }

  public getTask<
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
   * Gets a task in the specified group with the provided path.
   *
   * @param taskPath The path of the task to get in format group.task.
   * @returns The Task instance if found, otherwise undefined.
   */
  public getTaskByPath<PayloadType = any, ResultType = unknown>(
    taskPath: `${string}.${string}`
  ): Task<PayloadType, ResultType, SchemaHandler> | undefined {
    const [groupId, taskId] = taskPath.split('.');
    return this._getTask<PayloadType, ResultType>(groupId, taskId);
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
    if (!exists && !this._allowNonExistingQueues) {
      return null;
    }

    const queue = new TaskQueue<PayloadType, ResultType>(this, key);
    this._consumerQueues.set(key, queue as any);
    return queue;
  }

  public async getJobById<PayloadType = any, ResultType = any>(
    queueName: string,
    jobId: string
  ): Promise<TaskJob<PayloadType, ResultType> | undefined> {
    const queue = this._consumerQueues.get(queueName);

    if (queue) {
      const job = await queue.getJob(jobId);
      return job as TaskJob<PayloadType, ResultType>;
    }
  }

  /**
   * Gets all child jobs for a specific parent job from a given queue.
   * Used primarily for optimized reconstruction of bulk job references.
   *
   * @param queueName The name of the queue to search in
   * @param parentId The ID of the parent job
   * @param afterTimestamp Optional timestamp to filter jobs created after this time
   * @returns Array of child jobs
   */
  public async getChildJobs<PayloadType = any, ResultType = any>(
    queueName: string,
    parentId: string,
    afterTimestamp?: number
  ): Promise<TaskJob<PayloadType, ResultType>[]> {
    const queue = this._consumerQueues.get(queueName);
    if (!queue) {
      this.logger.debug({ queueName, parentId }, 'Queue not found for getChildJobs');
      return [];
    }

    // Get all jobs from the queue - this could be expensive for large queues
    // In a production environment, you might want to implement a more efficient
    // approach using Redis directly to query by parent ID
    const jobs = await queue.getJobs(['completed', 'waiting', 'active', 'delayed', 'failed']);

    const childJobs = jobs.filter((job) => {
      // Check if this job has the specified parent
      const isChild = job.opts?.parent?.id === parentId;

      // Apply timestamp filter if provided
      if (afterTimestamp && isChild) {
        return job.timestamp >= afterTimestamp;
      }
      return isChild;
    });

    this.logger.debug(
      { queueName, parentId, foundCount: childJobs.length },
      `Found ${childJobs.length} child jobs for parent ${parentId}`
    );

    return childJobs as TaskJob<PayloadType, ResultType>[];
  }

  /**
   * Runs a task in the specified group with the provided data (internal method).
   *
   * @param groupId The id of the task group.
   * @param taskId The id of the task to run.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   * @internal
   */
  private async _runTask<PayloadType = any, ResultType = any>(
    groupId: string,
    taskId: string,
    payload: PayloadType,
    options?: TaskJobOptions
  ) {
    const task = this._getTask<PayloadType, ResultType>(groupId, taskId);
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
   * @param taskPath The id of the task to run in format group.task.
   * @param data The data to pass to the task.
   * @returns A promise that resolves to the Job instance.
   */
  async runTaskByPath<PayloadType = any, ResultType = any>(taskPath: `${string}.${string}`, payload: PayloadType) {
    const [groupId, taskId] = taskPath.split('.');
    return this._runTask<PayloadType, ResultType>(groupId, taskId, payload);
  }

  /**
   * Runs a task in the specified group with the provided data.
   * In typed mode, provides full type safety and uses local task instances when available.
   * In generic mode, allows any group/task combination and always uses queue-based execution.
   *
   * @param groupId The id of the task group.
   * @param taskName The name of the task to run.
   * @param payload The data to pass to the task.
   * @param options Optional job options for queue-based execution.
   * @returns A promise that resolves to the Job instance.
   */
  async runTask<
    G extends TAllTaskGroupsDefs extends undefined ? string : keyof TGroups,
    SpecificTaskGroup extends TAllTaskGroupsDefs extends undefined ? any : TGroups[G],
    TaskName extends TAllTaskGroupsDefs extends undefined ? string : keyof SpecificTaskGroup['tasks'],
    ActualTask extends TAllTaskGroupsDefs extends undefined ? any : SpecificTaskGroup['tasks'][TaskName],
    Payload = TAllTaskGroupsDefs extends undefined
      ? any
      : ActualTask extends Task<any, any, any, infer P>
        ? P
        : unknown,
    Result = TAllTaskGroupsDefs extends undefined ? any : ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
  >(
    groupId: G,
    taskName: TaskName,
    payload: ActualPayload,
    options?: TaskJobOptions
  ): Promise<TaskJob<ActualPayload, Result>> {
    if (this._isTyped) {
      // Typed mode - use existing logic with local task groups
      const group = this.taskGroups[groupId as keyof TGroups];
      if (group && group.runTask) {
        return group.runTask<string, ActualTask, ActualPayload>(taskName as string, payload);
      } else {
        throw new Error(`Task group "${groupId as string}" not found.`);
      }
    } else {
      // Generic mode - use _runTask directly for queue-based execution
      return this._runTask<ActualPayload, Result>(groupId as string, taskName as string, payload, options);
    }
  }

  /**
   * Runs multiple task in the specified groups with the provided data.
   *
   */
  async runFlow<TFlowRun extends TaskFlowRun<TAllTaskGroupsDefs> = TaskFlowRun<TAllTaskGroupsDefs>>(
    run: TFlowRun,
    options?: Partial<TaskJobOptions>
  ): Promise<TaskFlowRunNode> {
    return await this.workflow.runFlow(run as any, options);
  }

  /**
   * Runs multiple task in the specified groups with the provided data.
   */
  async runFlows<TFlowRun extends TaskFlowRun<TAllTaskGroupsDefs> = TaskFlowRun<TAllTaskGroupsDefs>>(
    runs: TFlowRun[],
    options?: Partial<TaskJobOptions>
  ): Promise<TaskFlowRunNode[]> {
    return await this.workflow.runFlows(runs as any, options);
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
// Re-export core BullMQ types users might need
export { ConnectionOptions, Job, JobsOptions, Queue } from 'bullmq';
export { EventDispatcher } from './event-dispatcher.js'; // Re-export EventDispatcher
