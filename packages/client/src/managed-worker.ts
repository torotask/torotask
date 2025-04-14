import { Worker, WorkerOptions, Job } from 'bullmq';
import type { ManagedQueue } from './managed-queue';
// import type { ManagedFunction } from './managed-function'; // Not directly needed here

/**
 * Wraps a BullMQ Worker instance.
 * Holds a reference back to its ManagedQueue and manages worker creation.
 * Uses a generic processor that executes handlers defined on the ManagedQueue.
 */
export class ManagedWorker {
  public readonly worker: Worker;
  public readonly managedQueue: ManagedQueue;

  constructor(managedQueue: ManagedQueue, opts?: WorkerOptions) {
    this.managedQueue = managedQueue;

    const processor = async (job: Job) => {
      console.log(`Processing job ${job.id} (${job.name}) on queue ${this.managedQueue.name}`);
      const managedFunction = this.managedQueue.getFunction(job.name);

      if (!managedFunction) {
        console.error(`No function definition found for job name "${job.name}" on queue "${this.managedQueue.name}".`);
        throw new Error(`Processor not found for job ${job.name}`);
      }

      try {
        // Execute the handler
        const result = await (managedFunction.handler as (job: Job) => Promise<unknown>)(job);
        console.log(`Completed job ${job.id} (${job.name}) on queue ${this.managedQueue.name}`);
        return result;
      } catch (error: unknown) {
        console.error(
          `Error processing job ${job.id} (${job.name}) on queue ${this.managedQueue.name}:`,
          error instanceof Error ? error.message : error
        );
        throw error;
      }
    };

    const workerOptions: WorkerOptions = {
      connection: this.managedQueue.client.connectionOptions,
      ...(opts ?? {}),
      concurrency: opts?.concurrency ?? 1,
    };

    this.worker = new Worker(this.managedQueue.name, processor, workerOptions);

    console.log(`Worker started for queue "${this.managedQueue.name}"`);
  }

  /**
   * Get the underlying BullMQ Worker instance.
   */
  get bullmqInstance(): Worker {
    return this.worker;
  }

  /**
   * Closes the underlying worker.
   * Example of a wrapped method.
   */
  async close(force?: boolean): Promise<void> {
    return this.worker.close(force);
  }

  // --- Add other custom methods related to this worker here ---
}
