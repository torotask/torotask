import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';
import type { ToroTask } from './client.js';
import { Task } from './task.js';
import type {
  BulkTaskGroupRun,
  BulkTaskRun,
  BulkTaskRunNode,
  TaskHandler,
  TaskOptions,
  TaskTrigger,
} from './types/index.js';

/**
 * Represents a logical group of related Tasks.
 */
export class TaskGroup {
  public readonly name: string;
  public readonly client: ToroTask;
  public readonly logger: Logger;
  private readonly tasks: Map<string, Task<any, any>> = new Map();

  constructor(client: ToroTask, name: string, parentLogger: Logger) {
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
  }

  /**
   * Defines a new Task within this group using a configuration object.
   *
   * @template T Data type for the task. Default is `unknown`.
   * @template R Return type for the task. Default is `unknown`.
   * @param config The configuration object for the task.
   * @param config.name The name of the task (must be unique within the group).
   * @param config.options Optional default job options for this task.
   * @param config.triggers Optional TaskTrigger or array of TaskTriggers to associate with this task.
   * @param config.handler The function to execute when the task runs.
   * @returns The created Task instance.
   */
  defineTask<PayloadType = any, ResultType = unknown>(config: {
    name: string;
    options?: TaskOptions | undefined;
    triggers?: TaskTrigger<PayloadType> | TaskTrigger<PayloadType>[] | undefined;
    handler: TaskHandler<PayloadType, ResultType>;
  }): Task<PayloadType, ResultType> {
    const { name, options, triggers, handler } = config;

    if (this.tasks.has(name)) {
      this.logger.warn({ taskName: name }, 'Task already defined in this group. Overwriting.');
    }

    // Pass all parameters to Task constructor
    const newTask = new Task<PayloadType, ResultType>(this, name, options, triggers, handler, this.logger);
    this.tasks.set(name, newTask);
    this.logger.debug({ taskName: name }, 'Task defined');
    return newTask;
  }

  /**
   * Retrieves a defined Task by name.
   *
   * @param name The name of the task.
   * @returns The Task instance if found, otherwise undefined.
   */
  getTask<PayloadType = any, ResultType = unknown>(name: string): Task<PayloadType, ResultType> | undefined {
    return this.tasks.get(name);
  }

  /**
   * Gets all defined tasks in this group.
   *
   * @returns A map of task names to Task instances.
   */
  getTasks(): Map<string, Task<any, any>> {
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
      ? filter.tasks.map((name) => this.tasks.get(name)).filter((task): task is Task<any, any> => !!task)
      : Array.from(this.tasks.values());

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
      ? filter.tasks.map((name) => this.tasks.get(name)).filter((task): task is Task<any, any> => !!task)
      : Array.from(this.tasks.values());

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
