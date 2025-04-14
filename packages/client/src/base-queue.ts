import { Queue, QueueEvents, Worker, WorkerOptions, Job, ConnectionOptions, JobsOptions } from 'bullmq';
import type { ToroTaskClient } from './index';
import { Logger } from 'pino';

/**
 * Base class for managing a dedicated BullMQ Queue, its events, and an optional Worker.
 * Handles resource creation, lifecycle (startWorker, close), and provides an abstract
 * method for job processing logic.
 */
export abstract class BaseQueue {
  public readonly client: ToroTaskClient;
  public readonly queueName: string;
  public readonly queue: Queue;
  public readonly queueEvents: QueueEvents;
  public readonly logger: Logger;
  protected worker?: Worker;

  constructor(client: ToroTaskClient, queueName: string, parentLogger: Logger) {
    if (!client) {
      throw new Error('ToroTaskClient instance is required.');
    }
    if (!queueName) {
      throw new Error('Queue name is required.');
    }
    this.client = client;
    this.queueName = queueName;

    // Create a logger specific to this queue instance
    this.logger = parentLogger.child({ queueName: this.queueName });

    this.logger.info('Initializing BaseQueue resources (queue, events)');

    const connection: ConnectionOptions = this.client.connectionOptions;

    this.queue = new Queue(this.queueName, { connection });
    this.queueEvents = new QueueEvents(this.queueName, { connection });

    this.logger.info('BaseQueue resources initialized');
  }

  /**
   * Abstract method to process a job.
   * Subclasses must implement this method to define the job handling logic.
   *
   * @param job The BullMQ job object.
   * @returns A promise that resolves with the result of the job.
   */
  abstract process(job: Job): Promise<any>;

  /**
   * Starts a dedicated BullMQ Worker for this queue, if one is not already running.
   * The worker will listen to this queue and use the `process` method defined by the subclass.
   *
   * @param options Optional BullMQ WorkerOptions to configure the worker.
   * @returns The BullMQ Worker instance.
   */
  startWorker(options?: WorkerOptions): Worker {
    if (this.worker) {
      this.logger.warn('Worker already started for this queue. Returning existing instance.');
      return this.worker;
    }

    this.logger.info({ workerOptions: options }, 'Starting worker');

    const workerOptions: WorkerOptions = {
      connection: this.client.connectionOptions,
      ...(options ?? {}),
      concurrency: options?.concurrency ?? 1,
    };

    const newWorker = new Worker(this.queueName, async (job) => this.process(job), workerOptions);

    // Basic event listeners
    newWorker.on('error', (error) => {
      this.logger.error({ err: error }, 'Worker encountered an error');
    });
    newWorker.on('failed', (job, error) => {
      // Error is thrown from the process method
      this.logger.warn({ jobId: job?.id, err: error }, 'Worker reported job failed');
    });
    newWorker.on('completed', (job) => {
      this.logger.debug({ jobId: job.id }, 'Worker reported job completed');
    });

    this.worker = newWorker;
    this.logger.info('Worker started successfully');
    return this.worker;
  }

  /**
   * Closes the underlying BullMQ Worker (if started), Queue, and QueueEvents instances.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    this.logger.info('Closing BaseQueue resources (worker, queue, events)');
    const closePromises: Promise<void>[] = [];

    if (this.worker) {
      this.logger.debug('Closing worker...');
      closePromises.push(this.worker.close());
    }

    this.logger.debug('Closing queue events...');
    closePromises.push(this.queueEvents.close());
    this.logger.debug('Closing queue...');
    closePromises.push(this.queue.close());

    try {
      await Promise.all(closePromises);
      this.logger.info('BaseQueue resources closed successfully');
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'Error closing BaseQueue resources'
      );
    }
  }

  // --- Public Job Execution Helper Methods ---

  /**
   * Core logic to add a job to the queue.
   * Public method intended for use by subclasses or related classes (e.g., SubTask).
   */
  public async _runJob<JobData, JobReturn>(
    jobName: string,
    data: JobData,
    options: JobsOptions
  ): Promise<Job<JobData, JobReturn>> {
    this.logger.info({ data, options, jobName }, `Adding job "${jobName}" to queue [${this.queueName}]`);
    const job = await this.queue.add(jobName, data, options);
    this.logger.info({ jobId: job.id, jobName }, `Job "${jobName}" added to queue [${this.queueName}]`);
    return job as Job<JobData, JobReturn>;
  }

  /**
   * Core logic to add a job and wait for its completion.
   * Public method intended for use by subclasses or related classes.
   */
  public async _runJobAndWait<JobData, JobReturn>(
    jobName: string,
    data: JobData,
    options: JobsOptions
  ): Promise<JobReturn> {
    const waitLogger = this.logger.child({ jobName, action: 'runAndWait' });
    waitLogger.info({ data, options }, `Adding job and waiting for completion`);

    const job = await this._runJob<JobData, JobReturn>(jobName, data, options);
    const jobLogger = this.logger.child({ jobId: job.id, jobName });

    try {
      jobLogger.info('Waiting for job completion...');
      await job.waitUntilFinished(this.queueEvents);

      if (!job.id) {
        jobLogger.error('Job ID is missing after waiting. Cannot get result.');
        throw new Error('Job ID is missing after waiting. Cannot get result.');
      }

      jobLogger.debug('Refetching job after completion');
      const finishedJob = await Job.fromId<JobData, JobReturn>(this.queue, job.id);

      if (!finishedJob) {
        jobLogger.error(`Failed to refetch job after completion.`);
        throw new Error(`Failed to refetch job ${job.id} after completion.`);
      }

      jobLogger.info({ returnValue: finishedJob.returnvalue }, 'Job completed successfully');
      return finishedJob.returnvalue;
    } catch (error) {
      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job failed or could not be waited for`
      );
      throw error;
    }
  }
}
