import type { ToroTaskClient } from './index';
import { Task, type TaskHandler, type TaskOptions } from './task';
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
    this.logger = parentLogger.child({ taskGroup: this.name });

    this.logger.info('TaskGroup initialized');
  }

  /**
   * Defines a new Task within this group.
   *
   * @template T Data type for the task.
   * @template R Return type for the task.
   * @param name The name of the task (unique within the group).
   * @param handler The function to execute when the task runs.
   * @param options Default job options for this task.
   * @returns The created Task instance.
   */
  defineTask<T = unknown, R = unknown>(name: string, handler: TaskHandler<T, R>, options?: TaskOptions): Task<T, R> {
    if (this.tasks.has(name)) {
      this.logger.warn({ taskName: name }, 'Task already defined in this group. Overwriting.');
      // Or throw an error? Depending on desired behavior.
      // throw new Error(`Task "${name}" already defined in TaskGroup "${this.name}"`);
    }

    const newTask = new Task<T, R>(this, name, handler, options, this.logger);
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

  // --- Potential future methods ---
  // - Methods to trigger tasks directly?
  // - Methods related to worker processing specific to this group?
}
