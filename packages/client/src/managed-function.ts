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
   * Adds a job to the associated queue using this function's definition.
   *
   * @param data The data payload for the job.
   * @param overrideOptions Optional JobOptions to override the function's defaults for this specific job.
   * @returns A promise resolving to the added BullMQ Job.
   */
  async invoke(data: T, overrideOptions?: JobsOptions): Promise<R> {
    const finalOptions: JobsOptions = {
      ...this.defaultJobOptions,
      ...overrideOptions,
    };
    // Use the managedQueue's underlying add method
    // Type assertion needed as ManagedQueue uses unknown internally
    const result = await this.managedQueue.queue.add(this.name, data as unknown, finalOptions);

    return result.returnvalue as R;
  }

  // --- Add other methods related to function definition or invocation ---
}
