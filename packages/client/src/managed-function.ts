import { JobsOptions, Job } from 'bullmq';
import type { ManagedQueue } from './managed-queue';

/**
 * Options for defining a ManagedFunction, extending BullMQ's JobsOptions.
 */
export interface ManagedFunctionOptions extends JobsOptions {
  // Add any function-specific default options here if needed
  // e.g., default attempts, backoff strategy?
}

/** Function handler type */
export type FunctionHandler<T = unknown, R = unknown> = (job: Job<T, R>) => Promise<R>;

/**
 * Represents a defined function or job type associated with a specific ManagedQueue.
 * Encapsulates the function name, default job options, and execution handler.
 *
 * @template T The expected type of the data payload for this function.
 * @template R The expected return type of the job associated with this function.
 */
export class ManagedFunction<T = unknown, R = unknown> {
  public readonly name: string;
  public readonly managedQueue: ManagedQueue;
  public readonly defaultJobOptions: ManagedFunctionOptions;
  public readonly handler: FunctionHandler<T, R>;

  constructor(
    managedQueue: ManagedQueue,
    name: string,
    handler: FunctionHandler<T, R>,
    options?: ManagedFunctionOptions
  ) {
    if (!managedQueue) {
      throw new Error('ManagedQueue instance is required.');
    }
    if (!name) {
      throw new Error('Function name is required.');
    }
    if (!handler || typeof handler !== 'function') {
      throw new Error('Function handler is required and must be a function.');
    }
    this.managedQueue = managedQueue;
    this.name = name;
    this.handler = handler;
    this.defaultJobOptions = options ?? {};
  }

  /**
   * Adds a job using this function's definition without waiting for completion.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the function's defaults for this specific job.
   * @returns A promise resolving to the enqueued BullMQ Job object.
   */
  async run(data: T, overrideOptions?: JobsOptions): Promise<Job<T, R>> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    // Use the managedQueue's underlying add method and return the Job
    const job = await this.managedQueue.queue.add(this.name, data, finalOptions);
    return job as Job<T, R>; // Type assertion might be needed depending on queue's generic type
  }

  /**
   * Adds a job to the associated queue using this function's definition
   * and waits for it to complete.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the function's defaults for this specific job.
   * @returns A promise resolving to the return value of the completed job.
   * @throws Throws an error if the job fails.
   */
  async runAndWait(data: T, overrideOptions?: JobsOptions): Promise<R> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };

    // Add the job to the queue
    const job = await this.managedQueue.queue.add(this.name, data, finalOptions);

    try {
      // Wait for the job to complete.
      // This requires a QueueEvents instance associated with the queue.
      // Assuming this.managedQueue provides access to it, e.g., this.managedQueue.queueEvents
      // Replace 'this.managedQueue.queueEvents' if your QueueEvents instance is accessed differently.
      if (!this.managedQueue.queueEvents) {
        throw new Error('QueueEvents instance is required on ManagedQueue to wait for job results.');
      }
      await job.waitUntilFinished(this.managedQueue.queueEvents);

      // Ensure job.id is defined before attempting to refetch
      if (!job.id) {
        throw new Error('Job ID is missing after adding to the queue. Cannot wait for result.');
      }

      // Refetch the job to ensure we have the latest data, including the return value
      const finishedJob = await Job.fromId(this.managedQueue.queue, job.id);

      if (!finishedJob) {
        // This should theoretically not happen if waitUntilFinished succeeded
        throw new Error(`Failed to refetch job ${job.id} after completion.`);
      }

      console.log('Refetched job return value:', finishedJob.returnvalue);

      // After completion, the return value is available on the job object.
      // Note: If the job fails, waitUntilFinished will throw an error.
      return finishedJob.returnvalue as R;
    } catch (error) {
      // Handle potential errors during job execution (e.g., job failed)
      console.error(`Job ${job.id} failed or could not be waited for:`, error);
      // Re-throw the error or handle it as appropriate for your application
      throw error;
    }
  }

  // --- Add other methods related to function definition or invocation ---
}
