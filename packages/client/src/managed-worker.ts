import { Worker, WorkerOptions, Job } from 'bullmq';
import type { ManagedQueue } from './managed-queue';
import { Logger } from 'pino';
import { HandlerOptions, HandlerContext } from './managed-function';

/**
 * Wraps a BullMQ Worker instance.
 * Holds a reference back to its ManagedQueue and manages worker creation.
 * Uses a generic processor that executes handlers defined on the ManagedQueue.
 */
export class ManagedWorker {
  public readonly worker: Worker;
  public readonly managedQueue: ManagedQueue;
  public readonly logger: Logger;

  constructor(managedQueue: ManagedQueue, opts: WorkerOptions | undefined, queueLogger: Logger) {
    this.managedQueue = managedQueue;
    // Create a child logger specific to this worker
    this.logger = queueLogger.child({ workerName: this.managedQueue.name });

    const processor = async (job: Job) => {
      // Add job details to logger context for this specific job processing
      const jobLogger = this.logger.child({ jobId: job.id, jobName: job.name });

      jobLogger.info(`Processing job`);
      const managedFunction = this.managedQueue.getFunction(job.name);

      if (!managedFunction) {
        jobLogger.error(`No function definition found.`);
        throw new Error(`Processor not found for job ${job.name}`);
      }

      // Prepare arguments for the new handler signature
      const handlerOptions: HandlerOptions = {
        id: job.id,
        name: job.name,
        data: job.data,
      };

      const handlerContext: HandlerContext = {
        logger: jobLogger,
        client: this.managedQueue.client,
        queue: this.managedQueue,
        job,
      };

      try {
        // Execute the handler with the new signature
        jobLogger.debug('Executing job handler');
        const result = await managedFunction.handler(handlerOptions, handlerContext);
        jobLogger.info({ result }, `Completed job`);
        return result;
      } catch (error: unknown) {
        jobLogger.error({ err: error instanceof Error ? error : new Error(String(error)) }, `Error processing job`);
        // Re-throw the original error to ensure BullMQ handles it correctly
        throw error;
      }
    };

    const workerOptions: WorkerOptions = {
      connection: this.managedQueue.client.connectionOptions,
      ...(opts ?? {}),
      concurrency: opts?.concurrency ?? 1,
    };

    this.worker = new Worker(this.managedQueue.name, processor, workerOptions);

    this.logger.info(`Worker started`);
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
    this.logger.info('Closing worker...');
    await this.worker.close(force);
    this.logger.info('Worker closed.');
  }

  // --- Add other custom methods related to this worker here ---
}
