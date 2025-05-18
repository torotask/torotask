import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import type { ToroTask } from './client.js';
import { Task } from './task.js';
import type {
  SchemaHandler,
  TaskDefinitionRegistry,
  TaskFlowRun,
  TaskFlowRunNode,
  TaskFlowGroupRun,
  TaskRegistry,
  WorkerFilterTasks,
} from './types/index.js';
import type { TaskJob } from './job.js';
import { filterGroupTasks } from './utils/filter-group-tasks.js';

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
  getTaskByKey<Key extends Extract<keyof TTasks, string>>(key: Key): TTasks[Key] | undefined {
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
  getTask<Payload = any, ResultType = any>(id: string): Task<Payload, ResultType, SchemaHandler> | undefined {
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
  async runTaskByKey<
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
  async runBulkTasks(runs: TaskFlowRun[]): Promise<TaskFlowRunNode[]> {
    const processed: TaskFlowRun[] = runs.map((run) => {
      return {
        ...run,
        taskGroup: run.taskGroup || this.id,
      };
    });
    return await this.client.runFlows(processed);
  }

  // --- Worker Orchestration ---

  /**
   * Starts background workers for specified tasks or all tasks in the group.
   * @param filter Optional filter to specify which tasks to start workers for.
   * Uses the exact keys defined for the tasks in this group.
   * @param workerOptions Optional configuration for the workers being started.
   */
  async startWorkers(filter?: WorkerFilterTasks<TTasks>, workerOptions?: WorkerOptions): Promise<void> {
    const actionContext = 'starting';
    this.logger.debug({ filter: filter?.tasksByKey?.join(', ') ?? 'all' }, `${actionContext} workers for task group`);

    // Use the helper method to get tasks
    const tasksToStart = filterGroupTasks<TDefs, TTasks>(this, filter, actionContext);

    if (tasksToStart.length === 0) {
      this.logger.info({ filter: filter?.tasksByKey?.join(', ') ?? 'all' }, 'No tasks found to start workers for.');
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
    filter?: WorkerFilterTasks<TTasks>
  ): Promise<void> {
    const actionContext = 'stopping';
    this.logger.info({ filter: filter?.tasksByKey?.join(', ') ?? 'all' }, `${actionContext} workers for task group`);

    // Use the helper method to get tasks
    const tasksToStop = filterGroupTasks<TDefs, TTasks>(this, filter, actionContext);

    if (tasksToStop.length === 0) {
      this.logger.info({ filter: filter?.tasksByKey?.join(', ') ?? 'all' }, 'No tasks found to stop workers for.');
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
    filter?: WorkerFilterTasks<TTasks>
  ): Promise<void> {
    const actionContext = 'closing';
    this.logger.info(
      { group: this.id, filter: filter?.tasksByKey?.join(', ') ?? 'all' },
      `Attempting to ${actionContext} task(s)`
    );

    // Use the helper method to get tasks
    const tasksToClose = filterGroupTasks<TDefs, TTasks>(this, filter, actionContext);

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
