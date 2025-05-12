import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import type { ToroTask } from './client.js';
import { Task } from './task.js';
import type {
  BulkTaskGroupRun,
  BulkTaskRun,
  BulkTaskRunNode,
  SchemaHandler,
  TaskDefinition,
  TaskDefinitionRegistry,
  TaskRegistry,
} from './types/index.js';

/**
 * Represents a logical group of related Tasks.
 */
export class TaskGroup<
  TDefs extends TaskDefinitionRegistry = TaskDefinitionRegistry,
  // TTasks is *derived* from TDefs using our mapped type
  TTasks extends TaskRegistry<TDefs> = TaskRegistry<TDefs>,
> {
  public readonly name: string;
  public readonly client: ToroTask;
  public readonly logger: Logger;
  // Changed the type of the tasks map to allow any ActualSchemaInputType for the third generic
  public tasks: TTasks;

  constructor(client: ToroTask, name: string, parentLogger: Logger, definitions?: TDefs) {
    if (!client) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('TaskGroup name is required.');
    }
    this.client = client;
    this.name = name;
    // Create a child logger for this task group
    this.logger = parentLogger.child({ taskGroupName: this.name });

    this.logger.debug('TaskGroup initialized');

    this.tasks = {} as TTasks;
    for (const key in definitions) {
      // Ensure we are iterating over own properties
      if (Object.prototype.hasOwnProperty.call(definitions, key)) {
        const definition = definitions[key];
        this.createTask(definition) as TTasks[keyof TTasks];
      }
    }
  }

  /**
   * Creates a new Task within this group using a configuration object.
   *
   * @template T Data type for the task. Default is `unknown`.
   * @template R Return type for the task. Default is `unknown`.
   * @template SchemaVal extends ActualSchemaInputType
   * @param config The configuration object for the task.
   * @param config.name The name of the task (must be unique within the group).
   * @param config.options Optional default job options for this task.
   * @param config.triggers Optional TaskTrigger or array of TaskTriggers to associate with this task.
   * @param config.handler The function to execute when the task runs.
   * @returns The created Task instance.
   */
  createTask<
    PayloadExplicit = unknown, // Defaulting to unknown to align with TaskDefinition
    ResultType = unknown,
    SchemaVal extends SchemaHandler = undefined, // Crucial generic for schema
  >(config: TaskDefinition<PayloadExplicit, ResultType, SchemaVal>): Task<PayloadExplicit, ResultType, SchemaVal> {
    // The config object itself (config) is already of the correct generic type
    // TaskDefinition<PayloadExplicit, ResultType, SchemaVal>.
    // Its 'schema' property is of type 'SchemaVal | undefined'.

    const task = new Task<PayloadExplicit, ResultType, SchemaVal>(
      this as any, // Pass the TaskGroup instance
      config, // Pass the original config, Task constructor will handle it
      this.logger.child({ task: config.name })
    );

    if (config.name in this.tasks) {
      this.logger.warn({ taskName: config.name }, 'Task already defined in this group. Overwriting.');
    }

    // We need specific casts here because TS cannot automatically
    // verify that looping through 'definitions' and calling 'createTask'
    // perfectly populates 'this.tasks' according to the 'TTasks' mapped type structure.
    this.tasks[config.name as keyof TTasks] = task as any;
    this.logger.debug({ taskName: config.name }, 'Task defined');
    return task;
  }

  /**
   * Retrieves a defined Task by name.
   *
   * @param name The name of the task.
   * @returns The Task instance if found, otherwise undefined.
   */
  // Updated return type to reflect that tasks in the map can have any schema.
  getTask(name: string): Task<any, any, SchemaHandler> | undefined {
    return this.tasks[name];
  }

  /**
   * Gets all defined tasks in this group.
   *
   * @returns A map of task names to Task instances.
   */
  // Updated return type for consistency.
  getTasks(): TTasks {
    return this.tasks;
  }

  /**
   * Runs multiple task in the specified groups with the provided data.
   *
   */
  async runBulkTasks(runs: BulkTaskGroupRun[]): Promise<BulkTaskRunNode[]> {
    const processed: BulkTaskRun[] = runs.map((run) => {
      return {
        ...run,
        taskGroup: run.taskGroup || this.name,
      };
    });
    return await this.client.runBulkTasks(processed);
  }

  // --- Worker Orchestration ---

  private _getFilteredTasks(
    filter?: { tasks?: Array<keyof TTasks> },
    actionContext: 'starting' | 'stopping' | string = 'processing'
  ): Array<TTasks[keyof TTasks]> {
    let tasksToProcess: Array<TTasks[keyof TTasks]>;
    const notFoundKeys: Array<keyof TTasks> = [];

    if (filter?.tasks) {
      tasksToProcess = filter.tasks
        .map((name) => {
          const task = this.tasks[name];
          if (!task) {
            notFoundKeys.push(name);
          }
          return task;
        })
        .filter((task): task is TTasks[keyof TTasks] => Boolean(task)); // Type predicate filters undefined and asserts type

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
      // Get all tasks if no filter is provided
      tasksToProcess = Object.values(this.tasks);
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
  async startWorkers(filter?: { tasks?: Array<keyof TTasks> }, workerOptions?: WorkerOptions): Promise<void> {
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
    filter?: { tasks?: Array<keyof TTasks> }
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
    filter?: { tasks?: Array<keyof TTasks> }
  ): Promise<void> {
    const actionContext = 'closing';
    this.logger.info(
      { group: this.name, filter: filter?.tasks?.join(', ') ?? 'all' },
      `Attempting to ${actionContext} task(s)`
    );

    // Use the helper method to get tasks
    const tasksToClose = this._getFilteredTasks(filter, actionContext);

    if (tasksToClose.length === 0) {
      // _getFilteredTasks already logs if no tasks are found or if the filter was empty
      return;
    }

    this.logger.debug(
      { group: this.name, count: tasksToClose.length },
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
          group: this.name,
          success: tasksToClose.length - failedCloses,
          failed: failedCloses,
        },
        `Some tasks failed to close cleanly.`
      );
    } else {
      this.logger.info({ group: this.name, count: tasksToClose.length }, 'All targeted tasks closed successfully.');
    }
    this.logger.info({ group: this.name, count: tasksToClose.length }, `Finished ${actionContext} task(s)`);
  }

  // --- Potential future methods ---
  // - Methods to trigger tasks directly?
  // - Methods related to worker processing specific to this group?
}
