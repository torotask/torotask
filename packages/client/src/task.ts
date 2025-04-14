import { JobsOptions, Job, Queue, QueueEvents, Worker, WorkerOptions } from 'bullmq';
import { BaseQueue } from './base-queue';
import type { TaskGroup } from './task-group';
import type { ToroTaskClient } from './index';
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
 * Implements the `process` method by calling the specific task `handler`.
 *
 * @template T The expected type of the data payload for this task.
 * @template R The expected return type of the job associated with this task.
 */
export class Task<T = unknown, R = unknown> extends BaseQueue {
  public readonly name: string;
  public readonly group: TaskGroup;
  public readonly defaultJobOptions: TaskOptions;
  public readonly handler: TaskHandler<T, R>;

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

    this.logger.info('Task initialized (extending BaseQueue)');
  }

  /**
   * Adds a job for this task to its dedicated queue.
   * Note: This method might be simplified or removed if job adding is handled differently.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the task's defaults.
   * @returns A promise resolving to the enqueued BullMQ Job object.
   */
  async run(data: T, overrideOptions?: JobsOptions): Promise<Job<T, R>> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    const jobName = this.name;
    this.logger.info({ data, options: finalOptions, jobName }, `Adding job to queue [${this.queueName}]`);

    const job = await this.queue.add(jobName, data, finalOptions);
    this.logger.info({ jobId: job.id, jobName }, `Job added to queue [${this.queueName}]`);
    return job as Job<T, R>;
  }

  /**
   * Adds a job for this task to its dedicated queue and waits for it to complete.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the task's defaults.
   * @returns A promise resolving to the return value of the completed job.
   * @throws Throws an error if the job fails or cannot be awaited.
   */
  async runAndWait(data: T, overrideOptions?: JobsOptions): Promise<R> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    const jobName = this.name;
    this.logger.info({ data, options: finalOptions, jobName }, `Adding job to queue [${this.queueName}] and waiting`);

    const job = await this.queue.add(jobName, data, finalOptions);
    const jobLogger = this.logger.child({ jobId: job.id, jobName });

    try {
      jobLogger.info('Waiting for job completion...');
      await job.waitUntilFinished(this.queueEvents);

      if (!job.id) {
        jobLogger.error('Job ID is missing after adding to the queue. Cannot wait for result.');
        throw new Error('Job ID is missing after adding to the queue. Cannot wait for result.');
      }

      jobLogger.debug('Refetching job after completion');
      const finishedJob = await Job.fromId(this.queue, job.id);

      if (!finishedJob) {
        jobLogger.error(`Failed to refetch job after completion.`);
        throw new Error(`Failed to refetch job ${job.id} after completion.`);
      }

      jobLogger.info({ returnValue: finishedJob.returnvalue }, 'Job completed successfully');
      return finishedJob.returnvalue as R;
    } catch (error) {
      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job failed or could not be waited for`
      );
      throw error;
    }
  }

  /**
   * Implements the abstract process method from BaseQueue.
   * Calls the registered task handler with the appropriate context.
   *
   * @param job The BullMQ job object.
   * @returns A promise that resolves with the result of the task handler.
   */
  async process(job: Job): Promise<any> {
    const typedJob = job as Job<T, R>;
    const { id, name: jobNameReceived, data } = typedJob;
    const jobLogger = this.logger.child({ jobId: id, jobName: jobNameReceived });

    if (jobNameReceived !== this.name) {
      jobLogger.warn(
        { expectedJobName: this.name },
        'Worker received job with unexpected name for this task processor. Processing anyway.'
      );
    }

    const handlerOptions: TaskHandlerOptions<T> = { id, name: this.name, data };
    const handlerContext: TaskHandlerContext = {
      logger: jobLogger,
      client: this.client,
      group: this.group,
      task: this,
      job: typedJob,
      queue: this.queue,
    };

    jobLogger.info(`Processing job`);
    try {
      const result: R = await this.handler(handlerOptions, handlerContext);
      jobLogger.info(`Job completed successfully`);
      return result;
    } catch (error) {
      jobLogger.error({ err: error instanceof Error ? error : new Error(String(error)) }, `Job processing failed`);
      throw error;
    }
  }
}
