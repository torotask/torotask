import { JobsOptions, Job, Queue, QueueEvents } from 'bullmq';
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
  task: Task<any, any>;
  job: Job;
  queue: Queue;
}

/** Task handler function type */
export type TaskHandler<T = unknown, R = unknown> = (
  options: TaskHandlerOptions<T>,
  context: TaskHandlerContext
) => Promise<R>;

/**
 * Represents a defined task associated with a TaskGroup.
 * Each Task manages its own underlying BullMQ Queue instance.
 * Encapsulates the task name, default job options, and execution handler.
 * Provides a `process` method that orchestrates job execution, calling the handler by default.
 *
 * @template T The expected type of the data payload for this task.
 * @template R The expected return type of the job associated with this task.
 */
export class Task<T = unknown, R = unknown> {
  public readonly name: string;
  public readonly group: TaskGroup;
  public readonly client: ToroTaskClient;
  public readonly queue: Queue;
  public readonly queueEvents: QueueEvents;
  public readonly queueName: string;
  public readonly defaultJobOptions: TaskOptions;
  public readonly handler: TaskHandler<T, R>;
  public readonly logger: Logger;

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
    this.group = taskGroup;
    this.client = taskGroup.client;
    this.name = name;
    this.handler = handler;
    this.defaultJobOptions = options ?? {};

    this.queueName = `${this.group.name}.${this.name}`;
    this.logger = groupLogger.child({ taskName: this.name, queueName: this.queueName });

    this.logger.info('Initializing Task queue and events');

    this.queue = new Queue(this.queueName, {
      connection: this.client.connectionOptions,
    });

    this.queueEvents = new QueueEvents(this.queueName, {
      connection: this.client.connectionOptions,
    });

    this.logger.info('Task initialized');
  }

  /**
   * Adds a job for this task to its dedicated queue without waiting for completion.
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
   * Processes a job received by a BullMQ Worker.
   * This is the entry point for worker execution for this task.
   * The default implementation calls the registered `handler`.
   * Subclasses can override this method for custom processing logic (e.g., batching).
   *
   * @param job The BullMQ job object.
   * @returns A promise that resolves with the result of the job handler.
   */
  async process(job: Job<T, R>): Promise<R> {
    const { id, name: jobNameReceived, data } = job;
    const jobLogger = this.logger.child({ jobId: id, jobName: jobNameReceived });

    // Check if the received job name matches the task name (as an optional safeguard)
    if (jobNameReceived !== this.name) {
      jobLogger.warn(
        { expectedJobName: this.name },
        'Worker received job with unexpected name for this task processor. Processing anyway.'
      );
      // Decide whether to throw an error or proceed
    }

    const handlerOptions: TaskHandlerOptions<T> = { id, name: this.name, data };
    const handlerContext: TaskHandlerContext = {
      logger: jobLogger,
      client: this.client,
      group: this.group,
      task: this, // Provide the task instance itself
      job: job,
      queue: this.queue,
    };

    jobLogger.info(`Processing job`);
    try {
      // Execute the actual handler defined for the Task
      const result = await this.handler(handlerOptions, handlerContext);
      jobLogger.info(`Job completed successfully`);
      return result;
    } catch (error) {
      jobLogger.error({ err: error instanceof Error ? error : new Error(String(error)) }, `Job processing failed`);
      // Re-throw error for BullMQ to handle job failure
      throw error;
    }
  }

  /**
   * Closes the underlying BullMQ Queue and QueueEvents instances.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    this.logger.info('Closing task queue and events');
    try {
      await this.queueEvents.close();
      await this.queue.close();
      this.logger.info('Task queue and events closed successfully');
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'Error closing task queue or events'
      );
    }
  }
}
