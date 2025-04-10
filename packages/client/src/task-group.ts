import type { ToroTaskClient } from './client.js';
import { Task } from './task.js';
import type { TaskHandler, TaskOptions, TaskTrigger } from './types.js';
import type { WorkerOptions } from 'bullmq';
import { Logger } from 'pino';

/**
 * Represents a logical group of related Tasks.
 */
export class TaskGroup {
  public readonly name: string;
  public readonly client: ToroTaskClient;
  public readonly logger: Logger;
  private readonly tasks: Map<string, Task<any, any>> = new Map();

  constructor(client: ToroTaskClient, name: string, parentLogger: Logger) {
    if (!client) {
      throw new Error('ToroTaskClient instance is required.');
    }
    if (!name) {
      throw new Error('TaskGroup name is required.');
    }
    this.client = client;
    this.name = name;
    // Create a child logger for this task group
    this.logger = parentLogger.child({ taskGroupName: this.name });

    this.logger.info('TaskGroup initialized');
  }

  /**
   * Defines a new Task within this group.
   *
   * @template T Data type for the task.
   * @template R Return type for the task.
   * @param name The name of the task (unique within the group).
   * @param options Optional default job options for this task.
   * @param triggerOrTriggers Optional TaskTrigger or array of TaskTriggers.
   * @param handler The function to execute when the task runs.
   * @returns The created Task instance.
   */
  defineTask<T = unknown, R = unknown>(
    name: string,
    options: TaskOptions | undefined,
    triggerOrTriggers: TaskTrigger<T> | TaskTrigger<T>[] | undefined,
    handler: TaskHandler<T, R>
  ): Task<T, R> {
    if (this.tasks.has(name)) {
      this.logger.warn({ taskName: name }, 'Task already defined in this group. Overwriting.');
    }

    // Pass all parameters to Task constructor
    const newTask = new Task<T, R>(this, name, options, triggerOrTriggers, handler, this.logger);
    this.tasks.set(name, newTask);
    this.logger.info({ taskName: name }, 'Task defined');
    return newTask;
  }

  /**
   * Retrieves a defined Task by name.
   *
   * @param name The name of the task.
   * @returns The Task instance if found, otherwise undefined.
   */
  getTask(name: string): Task<any, any> | undefined {
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

  // --- Worker Orchestration ---

  /**
   * Starts workers for tasks within this group, optionally filtered by task names.
   *
   * @param filter Optional filter object. If `filter.tasks` is provided, only starts workers for task names in the array.
   * @param workerOptions Optional default WorkerOptions to pass to each task's worker.
   */
  startWorkers(filter?: { tasks?: string[] }, workerOptions?: WorkerOptions): void {
    this.logger.info({ filter }, 'Starting workers for task group');
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

    tasksToStart.forEach((task) => {
      try {
        task.startWorker(workerOptions);
      } catch (error) {
        this.logger.error({ taskName: task.name, err: error }, 'Error starting worker for task');
        // Continue starting other workers
      }
    });
    this.logger.info({ count: tasksToStart.length }, 'Finished attempting to start workers for task group');
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
      task.stopWorker().catch((error) => {
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
