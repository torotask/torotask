import { Queue, QueueEvents, Worker, WorkerOptions, Job, ConnectionOptions, JobsOptions } from 'bullmq';
import type { ToroTaskClient } from './client.js';
import { Logger } from 'pino';
import { EventEmitter } from 'events';

/**
 * Base class for managing a dedicated BullMQ Queue, its events, and an optional Worker.
 * Handles resource creation, lifecycle (startWorker, close), and provides an abstract
 * method for job processing logic.
 * Also provides a static registry (`instances`) of all created queues.
 * Extends EventEmitter to forward worker events.
 */
export abstract class BaseQueue extends EventEmitter {
  // Static registry of all BaseQueue instances, keyed by queueName
  public static readonly instances: Map<string, BaseQueue> = new Map();

  public readonly client: ToroTaskClient;
  public readonly queueName: string;
  public readonly prefix: string;
  public readonly queue: Queue;
  public readonly queueEvents: QueueEvents;
  public readonly logger: Logger;
  protected worker?: Worker;
  // Store listeners to remove them later
  private workerEventHandlers: Record<string, (...args: any[]) => void> = {};

  constructor(client: ToroTaskClient, queueName: string, parentLogger: Logger, prefix?: string) {
    super();
    if (!client) {
      throw new Error('ToroTask instance is required.');
    }
    if (!queueName) {
      throw new Error('Queue name is required.');
    }
    if (BaseQueue.instances.has(queueName)) {
      throw new Error(`A queue with the name "${queueName}" already exists or is being managed.`);
    }

    this.client = client;
    this.queueName = queueName;
    this.prefix = prefix || client.queuePrefix;

    // Assign logger first
    this.logger = parentLogger.child({ queueName: this.queueName });

    // Register the instance in the static map
    BaseQueue.instances.set(this.queueName, this);

    try {
      // Initialize queue and events within try block
      this.logger.debug('Initializing BaseQueue resources (queue, events)');

      const connection: ConnectionOptions = this.client.connectionOptions;

      this.queue = new Queue(this.queueName, { prefix: this.prefix, connection });
      this.queueEvents = new QueueEvents(this.queueName, { prefix: this.prefix, connection });

      this.logger.debug('BaseQueue resources initialized');
    } catch (error) {
      // If initialization fails, remove from registry before throwing
      BaseQueue.instances.delete(this.queueName);
      // Logger is guaranteed to be assigned now
      this.logger.error({ err: error }, 'Failed to initialize BaseQueue resources after registration');
      throw error;
    }
  }

  /**
   * Get the Redis client instance used by the queue.
   * @returns The Redis client instance.
   */
  async getRedisClient() {
    return this.queue.client;
  }

  /**
   * Abstract method to process a job.
   * Subclasses must implement this method to define the job handling logic.
   *
   * @param job The BullMQ job object.
   * @returns A promise that resolves with the result of the job.
   */
  abstract process(job: Job): Promise<any>;

  getWorkerOptions(): Partial<WorkerOptions> {
    return {};
  }

  /**
   * Starts a dedicated BullMQ Worker for this queue, if one is not already running.
   * Forwards worker events to this BaseQueue instance.
   */
  async startWorker(options?: WorkerOptions): Promise<Worker> {
    if (this.worker) {
      this.logger.warn('Worker already started for this queue. Returning existing instance.');
      return this.worker;
    }
    // Clear any stale listeners if somehow start is called without stop
    this.removeAllWorkerListeners();

    const mergedOptions = {
      connection: this.client.connectionOptions,
      prefix: this.client.queuePrefix,
      ...this.getWorkerOptions(),
      ...(options ?? {}),
    };

    this.logger.info({ workerOptions: mergedOptions }, 'Starting worker');

    const newWorker = new Worker(this.queueName, async (job) => this.process(job), mergedOptions);

    // --- Event Forwarding ---
    // Define handlers that emit events from `this` (the BaseQueue instance)
    this.workerEventHandlers = {
      // TODO check bullmq types
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      active: (job: Job, prev: string) => {
        this.logger.debug({ jobId: job.id, prev }, 'Worker event: active');
        this.emit('active', job, prev);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cleaned: (jobs: Job[], type: string) => {
        this.logger.debug({ count: jobs.length, type }, 'Worker event: cleaned');
        this.emit('cleaned', jobs, type);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      completed: (job: Job, result: any) => {
        this.logger.debug({ jobId: job.id, result }, 'Worker event: completed');
        this.emit('completed', job, result);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      drained: () => {
        this.logger.debug('Worker event: drained');
        this.emit('drained');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (error: Error) => {
        // This is for errors *within the worker itself*, not job failures
        this.logger.error({ err: error }, 'Worker event: error');
        this.emit('error', error);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      failed: (job: Job | undefined, error: Error, prev: string) => {
        // Job might be undefined if failure happens before job is retrieved
        this.logger.warn({ jobId: job?.id, err: error, prev }, 'Worker event: failed');
        this.emit('failed', job, error, prev);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      paused: () => {
        this.logger.debug('Worker event: paused');
        this.emit('paused');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      progress: (job: Job, progress: number | object) => {
        // Progress can be number | object
        this.logger.debug({ jobId: job.id, progress }, 'Worker event: progress');
        this.emit('progress', job, progress);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ready: () => {
        this.logger.debug('Worker event: ready');
        this.emit('ready');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      resumed: () => {
        this.logger.debug('Worker event: resumed');
        this.emit('resumed');
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stalled: (jobId: string, prev: string) => {
        this.logger.warn({ jobId, prev }, 'Worker event: stalled');
        this.emit('stalled', jobId, prev);
      },
      // TODO: Add any other events if needed
    };

    // Attach the listeners using Object.keys for better type inference
    Object.keys(this.workerEventHandlers).forEach((eventName) => {
      // Cast eventName to the expected type for worker.on
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      newWorker.on(eventName as any, this.workerEventHandlers[eventName]);
    });
    // --- End Event Forwarding ---

    this.worker = newWorker;
    this.logger.info('Worker started successfully and event forwarding enabled');
    return this.worker;
  }

  /** Helper to remove all attached worker listeners */
  private removeAllWorkerListeners(): void {
    if (this.worker && Object.keys(this.workerEventHandlers).length > 0) {
      this.logger.debug('Removing worker event listeners');
      // Detach listeners using Object.keys
      Object.keys(this.workerEventHandlers).forEach((eventName) => {
        // Cast eventName to the expected type for worker.off
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.worker?.off(eventName as any, this.workerEventHandlers[eventName]);
      });
      this.workerEventHandlers = {}; // Clear stored handlers
    }
  }

  /**
   * Stops the worker instance associated with this queue, if it is running.
   * Removes event listeners before closing.
   */
  async stopWorker(): Promise<void> {
    if (this.worker) {
      this.logger.info('Stopping worker and removing listeners...');
      // Remove listeners before closing
      this.removeAllWorkerListeners();
      try {
        await this.worker.close();
        this.logger.info('Worker stopped successfully.');
      } catch (error) {
        this.logger.error({ err: error instanceof Error ? error : new Error(String(error)) }, 'Error stopping worker');
      } finally {
        this.worker = undefined;
      }
    }
  }

  /**
   * Closes the underlying BullMQ Worker (if started), Queue, and QueueEvents instances,
   * and removes the instance from the static registry.
   * Should be called during application shutdown.
   */
  async close(): Promise<void> {
    // Remove from static registry first
    BaseQueue.instances.delete(this.queueName);
    this.logger.debug('Removed queue from static registry.');

    this.logger.debug('Closing BaseQueue resources (worker, queue, events)');
    const closePromises: Promise<void>[] = [];

    // Stop the worker first using the new method
    // Use await here to ensure worker stops before queue closes if order matters
    await this.stopWorker();

    // Proceed with closing queue and events
    this.logger.debug('Closing queue events...');
    closePromises.push(this.queueEvents.close());
    this.logger.debug('Closing queue...');
    closePromises.push(this.queue.close());

    try {
      await Promise.all(closePromises);
      this.logger.debug('BaseQueue resources closed successfully');
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'Error closing BaseQueue resources'
      );
      // Note: Instance was already removed from registry
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
