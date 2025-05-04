import type { WorkerOptions } from 'bullmq';
import { Worker } from 'bullmq'; // Keep Worker import for extends
import type { Logger } from 'pino';
import type { ToroTaskClient } from './client.js';
import type { TaskWorkerOptions, TaskProcessor, BatchProcessor } from './types/index.js';
import { TaskJob } from './job.js';

export class TaskWorker<DataType = unknown, ResultType = unknown, NameType extends string = string> extends Worker<
  DataType,
  ResultType,
  NameType
> {
  public readonly logger: Logger;
  private readonly batchProcessor?: BatchProcessor<DataType, ResultType, NameType>;
  private readonly isBatchingEnabled: boolean;
  public readonly options: Partial<TaskWorkerOptions>;

  // --- Batching State ---
  private jobBatch: TaskJob<DataType, ResultType, NameType>[] = [];
  private jobBatchCreationTime: Date = new Date();
  private jobBatchProcessPromise: Promise<void> | null = null;
  private resolveJobBatchProcessPromise: (() => void) | null = null;
  private rejectJobBatchProcessPromise: ((error: Error) => void) | null = null;
  private batchProcessingRunning = false;
  private batchTimeoutTimer: NodeJS.Timeout | null = null;

  constructor(
    public readonly taskClient: ToroTaskClient,
    name: string,
    processorOrOptions?: string | URL | null | TaskProcessor<DataType, ResultType, string> | Partial<TaskWorkerOptions>,
    maybeOptions?: Partial<TaskWorkerOptions>
  ) {
    if (!taskClient) {
      throw new Error('ToroTask instance is required.');
    }
    if (!name) {
      throw new Error('Queue name is required.');
    }

    let processorArg: string | URL | null | TaskProcessor<DataType, ResultType, string> | undefined;
    let options: Partial<TaskWorkerOptions>;

    // Determine overload
    if (
      typeof processorOrOptions === 'function' ||
      typeof processorOrOptions === 'string' ||
      processorOrOptions instanceof URL ||
      processorOrOptions === null
    ) {
      processorArg = processorOrOptions;
      options = maybeOptions || {};
    } else {
      processorArg = undefined;
      options = processorOrOptions || {};
    }

    // --- Prepare arguments for super() ---
    const finalOptions: Partial<WorkerOptions> = {
      ...options,
      prefix: options.prefix || taskClient.queuePrefix,
      connection: options.connection || taskClient.connectionOptions,
    };
    const logger = options.logger || taskClient.logger.child({ taskQueue: name });

    let isBatchingEnabled = false;
    let batchProcessor: BatchProcessor<DataType, ResultType, NameType> | undefined;
    let finalProcessor: string | URL | null | TaskProcessor<DataType, ResultType, NameType> | undefined;

    // --- Batching Setup Logic (before super) ---
    if (options.batch) {
      if (!options.batchProcessor) {
        throw new Error('TaskWorker: batchProcessor is required when batch options are provided.');
      }
      if (processorArg) {
        logger.warn(
          'TaskWorker: A standard processor was provided but batching is enabled. The standard processor will be ignored.'
        );
      }

      isBatchingEnabled = true;
      const batchOptions = options.batch;
      batchProcessor = options.batchProcessor as BatchProcessor<DataType, ResultType, NameType>;

      // Validate batch options
      if (typeof batchOptions.size !== 'number' || batchOptions.size <= 0) {
        throw new Error(`TaskWorker for "${name}" requires a positive integer batchSize option.`);
      }
      if (typeof batchOptions.timeout !== 'number' || batchOptions.timeout <= 0) {
        throw new Error(`TaskWorker for "${name}" requires a positive integer batchTimeout option.`);
      }
      if (batchOptions.minSize !== undefined) {
        if (typeof batchOptions.minSize !== 'number' || batchOptions.minSize <= 0) {
          logger.warn(`TaskWorker for "${name}" has invalid batchMinSize. Defaulting to 1.`);
          batchOptions.minSize = 1;
        }
      } else {
        batchOptions.minSize = 1;
      }

      // Adjust concurrency and lockDuration in finalOptions
      if (!finalOptions.concurrency || finalOptions.concurrency < batchOptions.size) {
        logger.debug(`Adjusting worker concurrency to batchSize (${batchOptions.size}) for "${name}".`);
        finalOptions.concurrency = batchOptions.size;
      }
      const requiredLockDuration = batchOptions.timeout * 1.5;
      if (!finalOptions.lockDuration || finalOptions.lockDuration < requiredLockDuration) {
        logger.debug(`Adjusting worker lockDuration based on batchTimeout (${requiredLockDuration}ms) for "${name}".`);
        finalOptions.lockDuration = requiredLockDuration;
      }

      // Set the batch collector as the final processor - binding happens *after* super()
      finalProcessor = undefined; // Placeholder, will be set correctly after `this` is available
    } else {
      // Standard (non-batching) worker
      isBatchingEnabled = false;
      finalProcessor = processorArg as TaskProcessor<DataType, ResultType, NameType> | string | URL | null | undefined;

      // Validate standard processor if not sandboxed
      const isSandboxed = typeof finalProcessor === 'string' || finalProcessor instanceof URL;
      if (!finalProcessor && !isSandboxed) {
        throw new Error('TaskWorker: A processor function or path is required when batching is not enabled.');
      }
    }

    // --- Call super() ---
    // Pass the processor directly if not batching. If batching, pass undefined initially.
    super(name, isBatchingEnabled ? undefined : finalProcessor, finalOptions as WorkerOptions);

    // --- Assign properties after super() ---
    this.logger = logger;
    this.options = options;
    this.isBatchingEnabled = isBatchingEnabled;

    if (this.isBatchingEnabled) {
      this.batchProcessor = batchProcessor;

      // Now that `this` is available, bind and set the actual processor
      // for the running worker instance via the public `processor` setter if available,
      // or fallback to internal property access (use carefully).
      // NOTE: BullMQ Worker does not have a public `processor` setter.
      // We must rely on the internal property.
      (this as any).processor = this.batchJobCollector.bind(this);

      this.initializeJobBatch(); // Initialize batch state now
    } // No else needed for standard processor, it was passed to super()
  }

  /**
   * The processor function used by BullMQ Worker when batching is enabled.
   * Collects jobs into a batch and triggers processing.
   */
  private async batchJobCollector(job: TaskJob<DataType, ResultType, NameType>, _token?: string): Promise<void> {
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
    if (!this.isBatchingEnabled || !this.batchProcessor) {
      this.logger.error('processBatchWrapper called but batching is not enabled or processor is missing.');
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

    try {
      batchLogger.info(`Calling batchProcessor for ${batchToProcess.length} jobs.`);
      await this.batchProcessor(batchToProcess);
      batchLogger.info(`Successfully processed ${batchInfo}.`);
      batchPromiseResolver();
    } catch (error) {
      const processingError = error instanceof Error ? error : new Error(String(error));
      batchLogger.error({ err: processingError }, `Error processing ${batchInfo}. Failing entire batch.`);
      batchPromiseRejector(processingError);
    } finally {
      this.batchProcessingRunning = false;
      batchLogger.debug(`Finished processing wrapper for ${batchInfo}.`);
      if (this.jobBatch.length > 0) {
        this.startBatchTimeoutTimerIfNeeded();
      }
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
   * @returns {typeof TaskJob}
   */
  protected get Job(): typeof TaskJob {
    return TaskJob;
  }
}
