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
      this, // Pass the TaskGroup instance
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

  /**
   * Starts workers for tasks within this group, optionally filtered by task names.
   *
   * @param filter Optional filter object. If `filter.tasks` is provided, only starts workers for task names in the array.
   * @param workerOptions Optional default WorkerOptions to pass to each task's worker.
   */
  async startWorkers(filter?: { tasks?: string[] }, workerOptions?: WorkerOptions): Promise<void> {
    this.logger.debug({ filter }, 'Starting workers for task group');
    const tasksToStart = filter?.tasks
      ? filter.tasks.map((name) => this.tasks[name as keyof TTasks]).filter((task) => !!task)
      : Object.values(this.tasks);

    if (filter?.tasks) {
      const requested = filter.tasks.length;
      const found = tasksToStart.length;
      if (requested !== found) {
        this.logger.warn(
          { requested, found },
          'Some requested tasks for starting workers were not found in this group.'
        );
      }
    }

    tasksToStart.forEach(async (task) => {
      try {
        await task.queue.startWorker(workerOptions);
      } catch (error) {
        this.logger.error({ taskName: task.name, err: error }, 'Error starting worker for task');
        // Continue starting other workers
      }
    });
    this.logger.debug({ count: tasksToStart.length }, 'Finished attempting to start workers for task group');
  }

  /**
   * Stops workers for tasks within this group, optionally filtered by task names.
   *
   * @param filter Optional filter object. If `filter.tasks` is provided, only stops workers for task names in the array.
   * @returns A promise that resolves when all targeted workers have been requested to stop.
   */
  async stopWorkers(filter?: { tasks?: string[] }): Promise<void> {
    this.logger.info({ filter }, 'Stopping workers for task group');
    const tasksToStop = filter?.tasks
      ? filter.tasks.map((name) => this.tasks[name as keyof TTasks]).filter((task) => !!task)
      : Object.values(this.tasks);

    if (filter?.tasks) {
      const requested = filter.tasks.length;
      const found = tasksToStop.length;
      if (requested !== found) {
        this.logger.warn(
          { requested, found },
          'Some requested tasks for stopping workers were not found in this group.'
        );
      }
    }

    const stopPromises = tasksToStop.map((task) =>
      task.queue.stopWorker().catch((error) => {
        this.logger.error({ taskName: task.name, err: error }, 'Error stopping worker for task');
        // Continue stopping other workers, do not reject Promise.all
      })
    );

    await Promise.all(stopPromises);
    this.logger.info({ count: tasksToStop.length }, 'Finished attempting to stop workers for task group');
  }

  // --- Potential future methods ---
  // - Methods to trigger tasks directly?
  // - Methods related to worker processing specific to this group?
}
