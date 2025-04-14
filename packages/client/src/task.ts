import { JobsOptions, Job, Queue, QueueEvents, Worker, WorkerOptions } from 'bullmq';
import { BaseQueue } from './base-queue.js';
import { SubTask, SubTaskHandler, SubTaskHandlerContext, SubTaskHandlerOptions } from './sub-task.js'; // Import SubTask related types
import type { TaskGroup } from './task-group.js';
import type { ToroTaskClient } from './client.js';
import { Logger } from 'pino';

/**
 * Options for defining a Task, extending BullMQ's JobsOptions.
 * Similar to ManagedFunctionOptions.
 */
export interface TaskOptions extends JobsOptions {
  // Task-specific default options if needed
}

/** Handler details passed to the task handler */
export interface TaskHandlerOptions<T = unknown> {
  id?: string; // Job ID
  name: string; // Task name
  data: T;
}

/** Context passed to the task handler */
export interface TaskHandlerContext {
  logger: Logger;
  client: ToroTaskClient;
  group: TaskGroup;
  task: Task<any, any>; // Reference to the Task instance
  job: Job;
  queue: Queue; // The queue instance (from BaseQueue)
}

/** Task handler function type */
export type TaskHandler<T = unknown, R = unknown> = (
  options: TaskHandlerOptions<T>,
  context: TaskHandlerContext
) => Promise<R>;

/**
 * Represents a defined task associated with a TaskGroup.
 * Extends BaseQueue to manage its own underlying BullMQ queue and worker.
 * Implements the `process` method by calling the specific task `handler` or a registered subtask handler.
 * Can define and manage SubTasks.
 *
 * @template T The expected type of the data payload for this task's main handler.
 * @template R The expected return type of the job associated with this task's main handler.
 */
export class Task<T = unknown, R = unknown> extends BaseQueue {
  public readonly name: string;
  public readonly group: TaskGroup;
  public readonly defaultJobOptions: TaskOptions;
  public readonly handler: TaskHandler<T, R>;
  private readonly subTasks: Map<string, SubTask<any, any>>;

  constructor(
    taskGroup: TaskGroup,
    name: string,
    handler: TaskHandler<T, R>,
    options: TaskOptions | undefined,
    groupLogger: Logger
  ) {
    if (!taskGroup) {
      throw new Error('TaskGroup instance is required.');
    }
    if (!name) {
      throw new Error('Task name is required.');
    }
    if (!handler || typeof handler !== 'function') {
      throw new Error('Task handler is required and must be a function.');
    }

    const client = taskGroup.client;
    const queueName = `${taskGroup.name}.${name}`;
    const taskLogger = groupLogger.child({ taskName: name });

    super(client, queueName, taskLogger);

    this.group = taskGroup;
    this.name = name;
    this.handler = handler;
    this.defaultJobOptions = options ?? {};
    this.subTasks = new Map();

    this.logger.info('Task initialized (extending BaseQueue)');
  }

  defineSubTask<ST = T, SR = R>(subTaskName: string, subTaskHandler: SubTaskHandler<ST, SR>): SubTask<ST, SR> {
    if (this.subTasks.has(subTaskName)) {
      this.logger.warn({ subTaskName }, 'SubTask already defined. Overwriting.');
    }
    if (subTaskName === this.name) {
      this.logger.error({ subTaskName }, 'SubTask name cannot be the same as the parent Task name.');
      throw new Error(`SubTask name "${subTaskName}" cannot be the same as the parent Task name "${this.name}".`);
    }

    const newSubTask = new SubTask<ST, SR>(this, subTaskName, subTaskHandler);
    this.subTasks.set(subTaskName, newSubTask);
    this.logger.info({ subTaskName }, 'SubTask defined');
    return newSubTask;
  }

  getSubTask(subTaskName: string): SubTask<any, any> | undefined {
    return this.subTasks.get(subTaskName);
  }

  async run(data: T, overrideOptions?: JobsOptions): Promise<Job<T, R>> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    return this._runJob<T, R>(this.name, data, finalOptions);
  }

  async runAndWait(data: T, overrideOptions?: JobsOptions): Promise<R> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    return this._runJobAndWait<T, R>(this.name, data, finalOptions);
  }

  /**
   * Routes the job to the appropriate handler (main task or subtask) based on job name.
   */
  async process(job: Job): Promise<any> {
    const { id, name: jobName } = job;
    const jobLogger = this.logger.child({ jobId: id, jobName });

    const subTask = this.subTasks.get(jobName);

    try {
      // --- Route to SubTask Handler ---
      if (subTask) {
        jobLogger.info(`Routing job to SubTask handler: ${jobName}`);
        const typedJob = job as Job<unknown, unknown>;
        const handlerOptions: SubTaskHandlerOptions<unknown> = { id, name: jobName, data: typedJob.data };
        const handlerContext: SubTaskHandlerContext = {
          logger: jobLogger,
          client: this.client,
          group: this.group,
          parentTask: this,
          subTaskName: subTask.name,
          job: typedJob,
          queue: this.queue,
        };
        const result = await subTask.handler(handlerOptions, handlerContext);
        jobLogger.info(`SubTask job completed successfully`);
        return result;
      }
      // --- Route to Main Task Handler ---
      else if (jobName === this.name) {
        jobLogger.info(`Routing job to main Task handler: ${jobName}`);
        const typedJob = job as Job<T, R>;
        const handlerOptions: TaskHandlerOptions<T> = { id, name: this.name, data: typedJob.data };
        const handlerContext: TaskHandlerContext = {
          logger: jobLogger,
          client: this.client,
          group: this.group,
          task: this,
          job: typedJob,
          queue: this.queue,
        };
        const result = await this.handler(handlerOptions, handlerContext);
        jobLogger.info(`Main task job completed successfully`);
        return result;
      }
      // --- Job Name Not Recognized ---
      else {
        jobLogger.error(`Job name "${jobName}" does not match the main task or any defined subtasks.`);
        throw new Error(`Job name "${jobName}" on queue "${this.queueName}" not recognized by task "${this.name}".`);
      }
    } catch (error) {
      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job processing failed for job name "${jobName}"`
      );
      throw error;
    }
  }
}
