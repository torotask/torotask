import type { Job, QueueOptions } from 'bullmq';
import type { Logger } from 'pino';
import type { ToroTask } from './client.js';
import type { BulkJob, TaskJobData, TaskJobOptions, TaskJobState, TaskQueueOptions } from './types/index.js';
import { Queue } from 'bullmq'; // Import JobsOptions
import { TaskJob } from './job.js';
import { convertJobOptions } from './utils/convert-job-options.js';

export class TaskQueue<
  PayloadType = any,
  ResultType = any,
  NameType extends string = string,
  const DataType extends TaskJobData = TaskJobData<PayloadType>,
> extends Queue<any, ResultType, NameType> {
  public readonly logger: Logger;

  constructor(
    public readonly taskClient: ToroTask,
    name: string,
    options?: Partial<TaskQueueOptions>,
  ) {
    if (!taskClient) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue name is required.');
    }
    options = options || {};
    options.prefix = options.prefix || taskClient.queuePrefix;
    options.connection = options.connection = taskClient.getQueueConnectionOptions();

    // Use shared Redis instance for queue connection reusing if enabled
    const sharedQueueRedisInstance = taskClient.getSharedQueueRedisInstance();
    if (sharedQueueRedisInstance) {
      options.connection = sharedQueueRedisInstance;
    }

    super(name, options as QueueOptions);
    this.logger = options.logger || taskClient.logger.child({ taskQueue: name });
  }

  /**
   * Overrides the default BullMQ `Job` class with the custom `TaskJob` class.
   * This ensures that jobs created and retrieved from this queue are instances of `TaskJob`,
   * providing access to custom properties and methods.
   *
   * @returns The `TaskJob` class constructor.
   */
  protected get Job(): typeof Job {
    return TaskJob as any;
  }

  protected get TaskJob(): typeof TaskJob<PayloadType, ResultType, NameType> {
    return TaskJob;
  }

  /**
   * Get the Redis client instance used by the queue.
   * @returns The Redis client instance.
   */
  async getRedisClient() {
    return this.client;
  }

  /**
   * Core logic to add a job to the queue.
   * Public method intended for use by subclasses or related classes (e.g., SubTask).
   */
  public override async add(
    name: NameType,
    payload: PayloadType,
    options?: TaskJobOptions,
    state?: TaskJobState,
  ): Promise<TaskJob<PayloadType, ResultType, NameType>> {
    // Return specific TaskJob
    const data = {
      payload,
      state,
    };
    // Convert options with payload to resolve idFromPayload callbacks
    const convertedOptions = convertJobOptions(options, payload);
    const job = await super.add(name, data, convertedOptions);
    // Cast the result from the base Job to the specific TaskJob
    return job as TaskJob<PayloadType, ResultType, NameType>;
  }

  /**
   * Core logic to add multiple jobs to the queue.
   * Public method intended for use by subclasses or related classes (e.g., SubTask).
   */
  // Assuming BulkJob's options are compatible with BullMQ's BulkJobOptions
  public override async addBulk(jobs: BulkJob<DataType>[]): Promise<TaskJob<PayloadType, ResultType>[]> {
    this.logger.debug(`Bulk adding jobs ${jobs.length} to queue [${this.name}]`);

    const bulkJobs = jobs.map((job) => {
      const data = {
        ...job.data,
      };
      if (job.payload) {
        data.payload = job.payload;
      }
      if (job.state) {
        data.state = job.state;
      }
      // Convert options with payload to resolve idFromPayload callbacks
      const convertedOptions = convertJobOptions(job.options, data.payload);
      return {
        name: job.name,
        opts: convertedOptions,
        data,
      };
    });

    const result = await super.addBulk(bulkJobs as any);
    this.logger.debug(`${result.length} Jobs bulk added added to queue [${this.name}]`);
    return result as TaskJob<PayloadType, ResultType, NameType>[];
  }

  /**
   * Core logic to add a job and wait for its completion.
   * Public method intended for use by subclasses or related classes.
   */
  public async _runJobAndWait(
    name: NameType,
    payload: PayloadType,
    options: TaskJobOptions,
    state?: TaskJobState,
  ): Promise<ResultType> {
    // Use specific JobReturn generic
    const waitLogger = this.logger.child({ jobName: name, action: 'runAndWait' });
    waitLogger.debug({ payload, options }, 'Adding job and waiting for completion');

    // Call the corrected _runJob
    const job = await this.add(name, payload, options, state); // Cast data if needed
    const jobLogger = this.logger.child({ jobId: job.id, jobName: name });

    try {
      jobLogger.debug('Waiting for job completion...');
      // Make sure queueEvents is accessible (might need to be passed or stored)
      // Assuming this.queueEvents exists similar to BaseQueue/WorkerQueue
      if (!this.queueEvents) {
        throw new Error('QueueEvents instance not available for waiting.');
      }
      await job.waitUntilFinished(this.queueEvents);

      if (!job.id) {
        jobLogger.error('Job ID is missing after waiting. Cannot get result.');
        throw new Error('Job ID is missing after waiting. Cannot get result.');
      }

      jobLogger.debug('Refetching job after completion');
      // Use the overridden this.Job getter which returns TaskJob
      const finishedJob = await this.Job.fromId<DataType, ResultType>(this as any, job.id);

      if (!finishedJob) {
        jobLogger.error('Failed to refetch job after completion.');
        throw new Error(`Failed to refetch job ${job.id} after completion.`);
      }

      jobLogger.debug({ returnValue: finishedJob.returnvalue }, 'Job completed successfully');
      return finishedJob.returnvalue;
    }
    catch (error) {
      jobLogger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'Job failed or could not be waited for',
      );
      throw error;
    }
  }

  // Add queueEvents property if it's needed by _runJobAndWait and not already present
  // You might need to initialize this in the constructor similar to WorkerQueue
  protected queueEvents?: any; // Replace 'any' with the actual type, e.g., TaskQueueEvents
}
