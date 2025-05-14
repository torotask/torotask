import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import type { ToroTask } from './client.js';
import { Task } from './task.js';
import type {
  BulkTaskGroupRun,
  BulkTaskRun,
  BulkTaskRunNode,
  SchemaHandler,
  TaskDefinitionRegistry,
  TaskRegistry,
} from './types/index.js';
import type { TaskJob } from './job.js';

/**
 * Represents a logical group of related Tasks.
 */
export class TaskGroup<
  TDefs extends TaskDefinitionRegistry = TaskDefinitionRegistry,
  // TTasks is *derived* from TDefs using our mapped type
  TTasks extends TaskRegistry<TDefs> = TaskRegistry<TDefs>,
> {
  public readonly id: string;
  public readonly client: ToroTask;
  public readonly logger: Logger;

  /**
   * Collection of tasks indexed by the task name from definitions.
   * This provides strict typing based on the definition keys.
   */
  public tasks: TTasks;

  /**
   * Collection of tasks indexed by their IDs.
   * Used internally for lookups where the ID might differ from the definition key.
   * No strict typing is enforced on task IDs.
   */
  public tasksById: Record<string, Task<any, any, SchemaHandler>> = {};

  constructor(client: ToroTask, id: string, parentLogger: Logger, definitions?: TDefs) {
    if (!client) {
      throw new Error('ToroTask instance is required.');
    }
    if (!id) {
      throw new Error('TaskGroup id is required.');
    }
    this.client = client;
    this.id = id;
    // Create a child logger for this task group
    this.logger = parentLogger.child({ taskGroupId: this.id });

    this.logger.debug('TaskGroup initialized');

    this.tasks = {} as TTasks; // Initialize tasks
    if (definitions) {
      for (const key of Object.keys(definitions) as Array<Extract<keyof TDefs, string>>) {
        const definition = definitions[key]; // definition is TDefs[key]
        // Add the ID to the config if it doesn't have one (or use the key as the ID)
        this.createTask(key, definition as TDefs[Extract<keyof TDefs, string>]);
      }
    }
  }

  /**
   * Creates a new Task within this group using a configuration object.
   * Task Id ensures that config matches a specific definition in TDefs.
   * The created Task type matches TTasks[TaskId].
   */
  createTask<TaskId extends Extract<keyof TDefs, string>>(
    // Config is the specific definition from TDefs
    key: string,
    config: TDefs[TaskId]
  ): TTasks[TaskId] {
    // Return type is the specific task type from TTasks
    // Generics for Task <P,R,S> are inferred from config (TDefs[TaskId])
    // because Task constructor takes config: TaskDefinition<P,R,S>

    const id = config.id || key;
    const taskDefinitionKey = key as Extract<keyof TDefs, string>;

    const task = new Task(
      this as any, // Pass the TaskGroup instance
      id, // Pass the actualRuntimeId to the Task constructor
      config, // Pass the original config (typed as TDefs[TaskId])
      this.logger.child({ task: id }) // Use actualRuntimeId for logger
    );

    // TaskId is the camelCase definition key (e.g., "myTask")
    // 'id' (actualRuntimeId) is the ID for BullMQ (e.g., "my_task" or "explicit_id")

    if (this.tasks[taskDefinitionKey]) {
      // Use TaskId (the definition key) for this.tasks
      this.logger.warn(
        { definitionKey: taskDefinitionKey, taskId: id }, // Log with definitionKey and actualRuntimeId
        'Task with definitionKey already defined in this group. Overwriting.'
      );
    }
    if (this.tasksById[id] && this.tasksById[id] !== task) {
      this.logger.warn(
        { currentDefinitionKey: taskDefinitionKey, existingTaskId: id },
        `Task with actualRuntimeId "${id}" is already registered in tasksById, possibly from a different definition key. Overwriting.`
      );
    }

    // Register by definition key (TaskId) in the type-safe map
    this.tasks[taskDefinitionKey] = task as TTasks[TaskId];

    // Also register by actual task ID (id parameter) in the ID-indexed collection
    this.tasksById[id] = task;

    this.logger.debug({ definitionKey: taskDefinitionKey, taskId: id }, 'Task defined');
    return task as TTasks[TaskId];
  }

  /**
   * Retrieves a defined Task by its definition name (which is also its ID).
   * This method expects the `nameOrId` to be a known key of the task definitions for this group.
   *
   * @param key The definition name (key from TDefs, e.g., 'myTask'). Must be a key of TTasks.
   * @returns The specifically typed Task instance (TTasks[Key]) if found, otherwise undefined.
   */
  getTask<Key extends Extract<keyof TTasks, string>>(key: Key): TTasks[Key] | undefined {
    // `nameOrId` is a key of TTasks, which are indexed by task ID (definition name).
    if (Object.prototype.hasOwnProperty.call(this.tasks, key)) {
      return this.tasks[key];
    }
    return undefined;
  }

  /**
   * Retrieves a defined Task strictly by its ID.
   * This method expects the `id` to be a known key of the task definitions for this group
   * to return a specifically typed Task.
   *
   * @param id The ID of the task. Must be a key of TTasks.
   * @returns The specifically typed Task instance (TTasks[Key]) if found, otherwise undefined.
   */
  getTaskById<Payload = any, ResultType = any>(id: string): Task<Payload, ResultType, SchemaHandler> | undefined {
    return this.tasksById[id];
  }

  /**
   * Gets all defined tasks in this group.
   *
   * @returns A map of task names to Task instances.
   */
  getTasks(): TTasks {
    return this.tasks;
  }

  /**
   * Runs a task within this group with the provided payload.
   *
   * @param taskName The name of the task to run (must be a key of TTasks).
   * @param payload The payload to pass to the task, inferred from the task's definition.
   * @returns A promise that resolves to the TaskJob instance.
   */
  async runTask<
    TaskName extends Extract<keyof TTasks, string>,
    ActualTask extends TTasks[TaskName] = TTasks[TaskName],
    // Payload is the ActualPayloadType inferred from the Task instance
    Payload = ActualTask extends Task<any, any, any, infer P> ? P : unknown,
    Result = ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
  >(taskName: TaskName, payload: ActualPayload): Promise<TaskJob<ActualPayload, Result>> {
    return this.client.runTask<ActualPayload, Result>(this.id, taskName, payload);
  }

  /**
   * Runs multiple task in the specified groups with the provided data.
   *
   */
  async runBulkTasks(runs: BulkTaskGroupRun[]): Promise<BulkTaskRunNode[]> {
    const processed: BulkTaskRun[] = runs.map((run) => {
      return {
        ...run,
        taskGroup: run.taskGroup || this.id,
      };
    });
    return await this.client.runBulkTasks(processed);
  }

  // --- Worker Orchestration ---

  private _getFilteredTasks(
    filter?: { tasks?: Array<Extract<keyof TTasks, string>> }, // Ensure filter tasks are specific keys
    actionContext: 'starting' | 'stopping' | 'closing' | string = 'processing'
  ): Array<TTasks[Extract<keyof TTasks, string>]> {
    // Return type reflects specific tasks
    let tasksToProcess: Array<TTasks[Extract<keyof TTasks, string>]> = [];
    const notFoundKeys: Array<Extract<keyof TTasks, string>> = [];

    if (filter?.tasks && filter.tasks.length > 0) {
      tasksToProcess = filter.tasks
        .map((name) => {
          // name is Extract<keyof TTasks, string>
          const task = this.getTask(name); // Directly use the typed getTask
          if (!task) {
            notFoundKeys.push(name);
          }
          return task;
        })
        .filter((task): task is TTasks[Extract<keyof TTasks, string>] => Boolean(task));

      const requestedCount = filter.tasks.length;
      const foundCount = tasksToProcess.length;

      if (requestedCount !== foundCount) {
        this.logger.warn(
          {
            requested: requestedCount,
            found: foundCount,
            missingKeys: notFoundKeys.map(String), // Convert keys to strings for logging
            context: actionContext,
          },
          `Some requested tasks for ${actionContext} workers were not found in this group.`
        );
      }
    } else {
      // Get all tasks if no filter is provided or if filter.tasks is empty
      // Object.values(this.tasks) will correctly return Array<TTasks[keyof TTasks]>
      // which is compatible with Array<TTasks[Extract<keyof TTasks, string>]>
      tasksToProcess = Object.values(this.tasks) as Array<TTasks[Extract<keyof TTasks, string>]>;
    }

    if (tasksToProcess.length === 0 && (filter?.tasks?.length ?? 0) > 0) {
      this.logger.info(
        { filter: filter?.tasks?.join(', ') ?? 'all', context: actionContext },
        `No matching tasks found to process workers for.`
      );
    } else if (tasksToProcess.length === 0) {
      this.logger.info({ context: actionContext }, `No tasks available in the group to process workers for.`);
    }

    return tasksToProcess;
  }

  /**
   * Starts background workers for specified tasks or all tasks in the group.
   * @param filter Optional filter to specify which tasks to start workers for.
   * Uses the exact keys defined for the tasks in this group.
   * @param workerOptions Optional configuration for the workers being started.
   */
  async startWorkers(
    filter?: { tasks?: Array<Extract<keyof TTasks, string>> },
    workerOptions?: WorkerOptions
  ): Promise<void> {
    const actionContext = 'starting';
    this.logger.debug({ filter: filter?.tasks?.join(', ') ?? 'all' }, `${actionContext} workers for task group`);

    // Use the helper method to get tasks
    const tasksToStart = this._getFilteredTasks(filter, actionContext);

    if (tasksToStart.length === 0) {
      this.logger.info({ filter: filter?.tasks?.join(', ') ?? 'all' }, 'No tasks found to start workers for.');
      return;
    }

    this.logger.debug(
      { count: tasksToStart.length },
      `Attempting to start workers for ${tasksToStart.length} tasks...`
    );

    const results = await Promise.allSettled(
      tasksToStart.map(async (task) => {
        await task.startWorker(workerOptions);
      })
    );

    const failedStarts = results.filter((r) => r.status === 'rejected').length;
    if (failedStarts > 0) {
      this.logger.warn(
        { success: tasksToStart.length - failedStarts, failed: failedStarts },
        'Some workers failed to start.'
      );
    } else {
      this.logger.debug({ count: tasksToStart.length }, 'All requested workers started successfully.');
    }

    this.logger.debug({ count: tasksToStart.length }, `Finished ${actionContext} workers for task group`);
  }

  /**
   * Stops workers for tasks within this group, optionally filtered by task names.
   *
   * @param filter Optional filter object. If `filter.tasks` is provided, only stops workers for task names in the array.
   * @returns A promise that resolves when all targeted workers have been requested to stop.
   */
  async stopWorkers(
    // Use keyof TTasks for compile-time safety on task names
    filter?: { tasks?: Array<Extract<keyof TTasks, string>> }
  ): Promise<void> {
    const actionContext = 'stopping';
    this.logger.info({ filter: filter?.tasks?.join(', ') ?? 'all' }, `${actionContext} workers for task group`);

    // Use the helper method to get tasks
    const tasksToStop = this._getFilteredTasks(filter, actionContext);

    if (tasksToStop.length === 0) {
      this.logger.info({ filter: filter?.tasks?.join(', ') ?? 'all' }, 'No tasks found to stop workers for.');
      return;
    }

    this.logger.debug({ count: tasksToStop.length }, `Attempting to stop workers for ${tasksToStop.length} tasks...`);

    // Use allSettled for stopping as well, in case some fail
    const results = await Promise.allSettled(
      tasksToStop.map(async (task) => {
        await task.stopWorker();
      })
    );

    const failedStops = results.filter((r) => r.status === 'rejected').length;
    if (failedStops > 0) {
      this.logger.warn(
        { success: tasksToStop.length - failedStops, failed: failedStops },
        'Some workers failed to stop.'
      );
    } else {
      this.logger.info({ count: tasksToStop.length }, 'All requested workers stopped successfully.');
    }

    this.logger.info({ count: tasksToStop.length }, `Finished ${actionContext} workers for task group`);
  }

  /**
   * Closes specified tasks or all tasks within this group, releasing resources.
   *
   * @param filter Optional filter to specify which tasks to close.
   * Uses the exact keys defined for the tasks in this group.
   * @returns A promise that resolves when all targeted tasks have attempted to close.
   */
  async close(
    // Add the filter parameter
    filter?: { tasks?: Array<Extract<keyof TTasks, string>> }
  ): Promise<void> {
    const actionContext = 'closing';
    this.logger.info(
      { group: this.id, filter: filter?.tasks?.join(', ') ?? 'all' },
      `Attempting to ${actionContext} task(s)`
    );

    // Use the helper method to get tasks
    const tasksToClose = this._getFilteredTasks(filter, actionContext);

    if (tasksToClose.length === 0) {
      // _getFilteredTasks already logs if no tasks are found or if the filter was empty
      return;
    }

    this.logger.debug(
      { group: this.id, count: tasksToClose.length },
      `Processing ${actionContext} for ${tasksToClose.length} task(s)...`
    );

    const results = await Promise.allSettled(
      tasksToClose.map(async (task) => {
        await task.close();
      })
    );

    const failedCloses = results.filter((r) => r.status === 'rejected').length;
    if (failedCloses > 0) {
      this.logger.warn(
        {
          group: this.id,
          success: tasksToClose.length - failedCloses,
          failed: failedCloses,
        },
        `Some tasks failed to close cleanly.`
      );
    } else {
      this.logger.info({ group: this.id, count: tasksToClose.length }, 'All targeted tasks closed successfully.');
    }
    this.logger.info({ group: this.id, count: tasksToClose.length }, `Finished ${actionContext} task(s)`);
  }

  // --- Potential future methods ---
  // - Methods to trigger tasks directly?
  // - Methods related to worker processing specific to this group?
}
