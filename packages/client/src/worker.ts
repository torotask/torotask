import type { Job, WorkerOptions } from 'bullmq';
import { Worker } from 'bullmq'; // Keep Worker import for extends
import type { Logger } from 'pino';
import type { ToroTaskClient } from './client.js';
import type { TaskWorkerOptions, TaskProcessor, TaskJobPayload, TaskJobData } from './types/index.js';
import { TaskJob } from './job.js';

const BatchMaxStalledCount = 5;
export class TaskWorker<
  PayloadType extends TaskJobPayload = TaskJobPayload,
  ResultType = unknown,
  NameType extends string = string,
  const DataType extends TaskJobData = TaskJobData<PayloadType>,
  const JobType extends TaskJob<PayloadType, ResultType, NameType> = TaskJob<PayloadType, ResultType, NameType>,
> extends Worker<TaskJobData<PayloadType>, ResultType, NameType> {
  public readonly logger: Logger;
  private readonly isBatchingEnabled: boolean;
  public readonly options: Partial<TaskWorkerOptions>;

  // --- Batching State ---
  private jobBatch: JobType[] = [];
  private jobBatchCreationTime: Date = new Date();
  private jobBatchProcessPromise: Promise<void> | null = null;
  private resolveJobBatchProcessPromise: (() => void) | null = null;
  private rejectJobBatchProcessPromise: ((error: Error) => void) | null = null;
  private batchProcessingRunning = false;
  private batchTimeoutTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly taskClient: ToroTaskClient,
    name: string,
    processor?: string | URL | null | TaskProcessor<DataType, ResultType, string>,
    options?: Partial<TaskWorkerOptions>
  ) {
    if (!taskClient) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue name is required.');
    }
    let isBatchingEnabled = false;
    let mergedOptions: Partial<TaskWorkerOptions> = {
      ...options,
      prefix: options?.prefix || taskClient.queuePrefix,
      connection: taskClient.connectionOptions,
    };

    const logger = mergedOptions.logger || taskClient.logger.child({ taskQueue: name });

    if (mergedOptions.batch) {
      isBatchingEnabled = true;
      mergedOptions = TaskWorker.validateBatchOptions(name, mergedOptions, logger);
    }

    super(name, processor as any, mergedOptions as WorkerOptions);
    this.options = mergedOptions;
    this.logger = logger;
    this.isBatchingEnabled = isBatchingEnabled;
    if (this.isBatchingEnabled) {
      this.initializeJobBatch(); // Set up the first batch promise
    }
  }

  static validateBatchOptions(
    name: string,
    options: Partial<TaskWorkerOptions>,
    logger?: Logger
  ): Partial<TaskWorkerOptions> {
    if (!options.batch) {
      return options;
    }
    if (typeof options.batch.size !== 'number' || options.batch.size <= 0) {
      throw new Error(`TaskWorker for "${name}" requires a positive integer batchSize option.`);
    }
    if (typeof options.batch.timeout !== 'number' || options.batch.timeout <= 0) {
      throw new Error(`TaskWorker for "${name}" requires a positive integer batchTimeout option.`);
    }
    if (options.batch.minSize !== undefined) {
      if (typeof options.batch.minSize !== 'number' || options.batch.minSize <= 0) {
        logger?.warn(`TaskWorker for "${name}" has invalid batchMinSize. Defaulting to 1.`);
        options.batch.minSize = 1;
      }
    } else {
      options.batch.minSize = 1;
    }

    options.maxStalledCount = BatchMaxStalledCount;

    // Make sure concurrency is at least batchSize
    if (!options.concurrency || options.concurrency < options.batch.size) {
      options.concurrency = options.batch.size;
    }

    if (!options.lockDuration || options.lockDuration < options.batch.timeout * 1.5) {
      options.lockDuration = options.batch.timeout * 1.5;
    }
    return options;
  }

  /**
   * If batching is enabled, this method is called to process a job.
   * Adds the job to the current batch, manages the timeout timer, triggers
   * processing if size limit is reached, and awaits batch completion.
   *
   * @override
   * @param job - The standard BullMQ job object.
   * @returns A promise that resolves/rejects when the batch containing this job completes/fails.
   */

  protected callProcessJob(job: TaskJob<any, ResultType, NameType>, token: string): Promise<ResultType> {
    const batchOptions = this.options.batch;
    if (!this.isBatchingEnabled || !batchOptions || job.isBatch) {
      return super.callProcessJob(job, token);
    }
    return this.batchJobCollector(job as any, token) as any;
  }

  /**
   * The processor function used by BullMQ Worker when batching is enabled.
   * Collects jobs into a batch and triggers processing.
   */
  private async batchJobCollector(job: JobType, _token?: string): Promise<void> {
    const jobLogger = this.logger.child({ jobId: job.id, jobName: job.name });
    jobLogger.info(`Received job ${job.id}. Adding to current batch.`);

    // Ensure batchOptions is defined before using it (satisfies non-null assertion rule)
    if (!this.options.batch) {
      jobLogger.error('Critical internal error: batchJobCollector called but batchOptions are missing.');
      throw new Error('Batch options not configured.');
    }

    this.jobBatch.push(job);
    try {
      await job.log(
        `Adding to batch queue for worker "${this.name}". Item ${this.jobBatch.length} of ${this.options.batch.size}`
      );
    } catch (logError) {
      jobLogger.error({ err: logError }, `Failed to add log to job ${job.id}`);
    }

    const currentBatchPromise = this.jobBatchProcessPromise;
    if (!currentBatchPromise) {
      jobLogger.error('Critical error: jobBatchProcessPromise is null when adding a job.');
      throw new Error('Internal error: Batch processing promise not initialized.');
    }

    if (this.jobBatch.length === 1) {
      this.startBatchTimeoutTimerIfNeeded();
    }

    if (this.jobBatch.length >= this.options.batch.size) {
      jobLogger.debug(
        `Batch size limit (${this.options.batch.size}) reached for worker "${this.name}". Triggering batch processing.`
      );
      this.clearBatchTimeoutTimer();
      void this.processBatchWrapper();
    }

    jobLogger.debug(`Job ${job.id} waiting for its batch (size ${this.jobBatch.length}) to complete...`);
    try {
      await currentBatchPromise;
      jobLogger.info(`Batch containing job ${job.id} completed successfully.`);
    } catch (batchError) {
      jobLogger.warn({ err: batchError }, `Batch containing job ${job.id} failed.`);
      throw batchError;
    }
  }

  // --- Batch Management Methods ---

  private initializeJobBatch(): void {
    this.jobBatchCreationTime = new Date();
    this.jobBatch = [];
    this.jobBatchProcessPromise = new Promise<void>((resolve, reject) => {
      this.resolveJobBatchProcessPromise = resolve;
      this.rejectJobBatchProcessPromise = reject;
    });
    this.clearBatchTimeoutTimer();
    this.logger.debug(
      `Initialized new batch buffer for worker "${this.name}" at ${this.jobBatchCreationTime.toISOString()}`
    );
  }

  private clearBatchTimeoutTimer(): void {
    if (this.batchTimeoutTimer) {
      clearTimeout(this.batchTimeoutTimer);
      this.batchTimeoutTimer = null;
      this.logger.trace(`Cleared batch timeout timer for worker "${this.name}".`);
    }
  }

  private startBatchTimeoutTimerIfNeeded(): void {
    if (!this.options.batch) return;

    const minSize = this.options.batch.minSize ?? 1;
    if (this.options.batch.timeout && minSize > 0 && !this.batchTimeoutTimer) {
      this.logger.debug(`Starting batch timeout timer (${this.options.batch.timeout}ms) for worker "${this.name}".`);
      this.batchTimeoutTimer = setTimeout(() => {
        this.logger.info(`Batch timeout reached for worker "${this.name}".`);
        this.batchTimeoutTimer = null;
        if (this.jobBatch.length > 0 && !this.batchProcessingRunning) {
          if (this.jobBatch.length >= minSize) {
            this.logger.debug(`Timeout triggered batch processing (met minSize ${minSize}) for worker "${this.name}".`);
            void this.processBatchWrapper();
          } else {
            this.logger.debug(
              `Timeout reached for worker "${this.name}", but minSize (${minSize}) not met. Batch size: ${this.jobBatch.length}. Resetting timer.`
            );
            this.startBatchTimeoutTimerIfNeeded();
          }
        } else if (this.batchProcessingRunning) {
          this.logger.warn(
            `Batch timeout reached for worker "${this.name}", but a batch is already processing. Ignoring timeout trigger.`
          );
        } else {
          this.logger.debug(`Batch timeout reached for worker "${this.name}", but batch is empty. Ignoring.`);
        }
      }, this.options.batch.timeout);
    }
  }

  private async processBatchWrapper(): Promise<void> {
    if (!this.isBatchingEnabled) {
      this.logger.error('processBatchWrapper called but batching is not enabled.');
      return;
    }
    if (this.batchProcessingRunning) {
      this.logger.warn(
        `Attempted to process batch for worker "${this.name}" while another batch was running. Skipping.`
      );
      return;
    }
    if (this.jobBatch.length === 0) {
      this.logger.warn(`processBatchWrapper called for worker "${this.name}" with empty batch. Skipping.`);
      if (this.resolveJobBatchProcessPromise) this.resolveJobBatchProcessPromise();
      return;
    }

    this.batchProcessingRunning = true;
    this.logger.info(`Starting batch processing for worker "${this.name}"...`);

    const batchToProcess = this.jobBatch;
    const batchCreationTime = this.jobBatchCreationTime;
    const batchPromiseResolver = this.resolveJobBatchProcessPromise;
    const batchPromiseRejector = this.rejectJobBatchProcessPromise;
    this.clearBatchTimeoutTimer();

    this.initializeJobBatch(); // Prepare for the *next* batch

    if (!batchPromiseResolver || !batchPromiseRejector) {
      this.logger.error(
        `Critical error: Batch promise resolver/rejector missing for batch created at ${batchCreationTime.toISOString()}. Cannot process.`
      );
      this.batchProcessingRunning = false;
      const error = new Error('Internal error: Batch promise state lost.');
      if (batchPromiseRejector) {
        try {
          batchPromiseRejector(error);
        } catch (rejectError) {
          this.logger.error({ err: rejectError }, 'Error rejecting lost batch promise');
        }
      }
      batchToProcess.forEach((job) => {
        job.moveToFailed(error, 'InternalErrorToken', false).catch((err) => {
          this.logger.error({ err, jobId: job.id }, 'Failed to move job to failed state during internal error.');
        });
      });
      return;
    }

    const batchInfo = `Batch created at ${batchCreationTime.toISOString()} with ${batchToProcess.length} jobs`;
    this.logger.info(`Processing ${batchInfo} for worker "${this.name}".`);
    const batchLogger = this.logger.child({ batchId: batchCreationTime.getTime() });

    this.logger.info(`Processing ${batchInfo} for task "${this.name}".`);

    try {
      const batchJob = new this.TaskJob(this, this.name as any, {} as any, {});
      batchJob.setBatch(batchToProcess);
      // --- Execute actual batch processing logic ---
      await this.callProcessJob(batchJob, batchJob.token ?? '');
      // --- Success ---
      batchLogger.info(`Successfully processed ${batchInfo} for task "${this.name}".`);
      batchPromiseResolver(); // Resolve promise for all waiting jobs in this batch.
    } catch (error) {
      // --- Failure (emulating default Pro behavior) ---
      const processingError = error instanceof Error ? error : new Error(String(error));
      batchLogger.error(
        { err: processingError },
        `Error processing ${batchInfo} for task "${this.name}". Failing entire batch.`
      );
      batchPromiseRejector(processingError); // Reject promise for all waiting jobs.
    } finally {
      // --- Cleanup ---
      this.batchProcessingRunning = false;
      batchLogger.debug(`Finished processing wrapper for ${batchInfo}.`);
    }
  }

  /**
   * Gracefully shuts down the worker.
   * Handles final batch processing if enabled.
   *
   * @override
   */
  async close(force = false): Promise<void> {
    this.logger.info(`Closing TaskWorker "${this.name}"...`);

    if (this.isBatchingEnabled) {
      this.clearBatchTimeoutTimer();

      if (!force && this.jobBatch.length > 0 && !this.batchProcessingRunning) {
        const minSize = this.options.batch?.minSize ?? 1;
        if (this.jobBatch.length >= minSize) {
          this.logger.info(
            `Processing final pending batch (${this.jobBatch.length} jobs, met minSize ${minSize}) during shutdown for worker "${this.name}"...`
          );
          try {
            await this.processBatchWrapper();
          } catch (err) {
            this.logger.error({ err }, 'Error processing final batch during shutdown.');
          }
        } else {
          this.logger.warn(
            `Skipping final batch (${this.jobBatch.length} jobs) during shutdown for worker "${this.name}" as it does not meet minimum size ${minSize}. These jobs may be processed on next startup.`
          );
          if (this.resolveJobBatchProcessPromise) {
            this.resolveJobBatchProcessPromise();
          }
        }
      } else if (!force && this.batchProcessingRunning) {
        this.logger.info(
          `Waiting for currently running batch to complete during shutdown for worker "${this.name}"...`
        );
        const promiseToWaitFor = this.jobBatchProcessPromise;
        if (promiseToWaitFor) {
          try {
            await promiseToWaitFor;
            this.logger.info(`Active batch likely finished during shutdown for worker "${this.name}".`);
          } catch (_error) {
            this.logger.warn(`Active batch likely failed during shutdown for worker "${this.name}".`);
          }
        }
      } else if (force) {
        this.logger.warn(
          `Force closing worker "${this.name}". Any pending or active batch processing will be interrupted.`
        );
        if (this.rejectJobBatchProcessPromise) {
          try {
            this.rejectJobBatchProcessPromise(new Error('Worker force closed'));
          } catch (e) {
            // Log the error caught during rejection
            this.logger.error({ err: e }, 'Error rejecting pending batch promise during force close.');
          }
        }
      }
    }

    this.logger.debug(`Calling base Worker close method for worker "${this.name}".`);
    await super.close(force);

    this.logger.info(`TaskWorker "${this.name}" closed successfully.`);
  }

  /**
   * Override the Job class to use TaskJob
   * @returns {typeof Job}
   */
  protected get Job(): typeof Job {
    return TaskJob as any;
  }

  protected get TaskJob(): typeof TaskJob<PayloadType, ResultType, NameType> {
    return TaskJob;
  }
}
