import { Job, WorkerOptions } from 'bullmq';
import type { Logger } from 'pino';
import { BaseTask } from './base-task.js'; // Assuming standard BullMQ worker setup
import { BatchContainer } from './batch-container.js';
import type { TaskGroup } from './task-group.js';
import type {
  BatchHandlerOptions,
  BatchTaskHandler,
  BatchTaskHandlerContext,
  BatchTaskOptions,
  SingleOrArray,
  TaskHandlerOptions,
  TaskTrigger,
} from './types/index.js';

/**
 * Extends BaseTask to emulate BullMQ Pro's batch processing behavior
 * using standard BullMQ. It collects incoming jobs and processes them
 * together based on batchSize, batchMinSize, and batchTimeout options.
 *
 * @template T The expected type of the data payload for jobs in this batch task.
 * @template R The expected return type of the job processing handler.
 */
export class BatchTask<T = unknown, R = unknown> extends BaseTask<T, R, BatchTaskOptions> {
  // --- Batching State (Reinstated) ---
  private jobBatch: Job<T, R>[] = [];
  private jobBatchCreationTime: Date = new Date();
  private jobBatchProcessPromise: Promise<void> | null = null;
  private resolveJobBatchProcessPromise: (() => void) | null = null;
  private rejectJobBatchProcessPromise: ((error: Error) => void) | null = null;
  private batchProcessingRunning: boolean = false;
  private batchTimeoutTimer: NodeJS.Timeout | null = null; // For batchTimeout

  constructor(
    taskGroup: TaskGroup,
    name: string,
    options: BatchTaskOptions, // Expect batchSize, batchMinSize?, batchTimeout?
    trigger: SingleOrArray<TaskTrigger<T>> | undefined,
    protected handler: BatchTaskHandler<T, R>, // Processes *individual* jobs
    groupLogger: Logger
  ) {
    // Pass standard options to BaseTask, batch options are handled here
    super(taskGroup, name, options, trigger, groupLogger);

    const { batchSize, batchMinSize, batchTimeout } = options;

    // --- Batching Initialization ---
    if (typeof batchSize !== 'number' || batchSize <= 0) {
      throw new Error(`BatchTask "${name}" requires a positive integer batchSize option.`);
    }

    if (typeof batchTimeout !== 'number' || batchTimeout <= 0) {
      throw new Error(`BatchTask "${name}" requires a positive integer batchTimeout option.`);
    }

    // Validate dependent options
    if (batchMinSize == undefined || typeof batchMinSize !== 'number' || batchMinSize <= 0) {
      if (batchMinSize !== undefined) {
        this.logger.warn(`BatchTask "${name}" has invalid batchMinSize. It will be ignored.`);
      }
      this.taskOptions.batchMinSize = 1; // Default to 1 if not specified or invalid
    }

    this.initializeJobBatch(); // Set up the first batch promise
  }

  getWorkerOptions(): Partial<WorkerOptions> {
    const options: Partial<WorkerOptions> = {
      maxStalledCount: 5,

      ...super.getWorkerOptions(),
    };

    // Make sure concurrency is at least batchSize
    if (!options.concurrency || options.concurrency < this.taskOptions.batchSize) {
      options.concurrency = this.taskOptions.batchSize;
    }

    if (!options.lockDuration || options.lockDuration < this.taskOptions.batchTimeout * 1.5) {
      options.lockDuration = this.taskOptions.batchTimeout * 1.5;
    }
    return options;
  }
  /**
   * Initializes or resets the state for a new batch.
   * Creates promise, stores resolve/reject functions.
   * Clears any existing batch timeout timer.
   */
  private initializeJobBatch(): void {
    this.jobBatchCreationTime = new Date();
    this.jobBatch = [];

    this.jobBatchProcessPromise = new Promise<void>((resolve, reject) => {
      this.resolveJobBatchProcessPromise = resolve;
      this.rejectJobBatchProcessPromise = reject;
    });

    // Clear any lingering timeout from the previous batch
    this.clearBatchTimeoutTimer();

    this.logger.debug(
      `Initialized new batch buffer for task "${this.name}" at ${this.jobBatchCreationTime.toISOString()}`
    );
  }

  /** Clears the batch timeout timer if it's active. */
  private clearBatchTimeoutTimer(): void {
    if (this.batchTimeoutTimer) {
      clearTimeout(this.batchTimeoutTimer);
      this.batchTimeoutTimer = null;
      this.logger.trace(`Cleared batch timeout timer for task "${this.name}".`);
    }
  }

  /** Starts the batch timeout timer if conditions are met. */
  private startBatchTimeoutTimerIfNeeded(): void {
    // Start timer only if:
    // 1. Timeout is configured.
    // 2. A minimum size is relevant (batchMinSize > 0).
    // 3. The timer isn't already running.
    // 4. The batch isn't empty (implicitly handled by calling this when jobBatch.length === 1).
    if (this.taskOptions.batchTimeout && (this.taskOptions.batchMinSize ?? 0) > 0 && !this.batchTimeoutTimer) {
      this.logger.debug(`Starting batch timeout timer (${this.taskOptions.batchTimeout}ms) for task "${this.name}".`);
      this.batchTimeoutTimer = setTimeout(() => {
        this.logger.info(`Batch timeout reached for task "${this.name}".`);
        this.batchTimeoutTimer = null; // Mark timer as inactive
        // Process whatever is available, but only if not already processing
        if (this.jobBatch.length > 0 && !this.batchProcessingRunning) {
          this.logger.debug(`Timeout triggered batch processing for task "${this.name}".`);
          void this.processBatchWrapper(); // Use void, promise handled internally
        } else if (this.batchProcessingRunning) {
          this.logger.warn(
            `Batch timeout reached for task "${this.name}", but a batch is already processing. Ignoring timeout trigger.`
          );
        } else {
          this.logger.debug(`Batch timeout reached for task "${this.name}", but batch is empty. Ignoring.`);
        }
      }, this.taskOptions.batchTimeout);
    }
  }

  /**
   * The main processing function called by the standard BullMQ worker for each job.
   * Adds the job to the current batch, manages the timeout timer, triggers
   * processing if size limit is reached, and awaits batch completion.
   *
   * @override
   * @param job - The standard BullMQ job object.
   * @returns A promise that resolves/rejects when the batch containing this job completes/fails.
   */
  async process(job: Job): Promise<void> {
    const typedJob = job as Job<T, R>;
    const jobLogger = this.getJobLogger(typedJob);

    jobLogger.info(`Received job ${typedJob.id}. Adding to current batch.`);

    // Add job to the current batch
    this.jobBatch.push(typedJob);
    typedJob.log(
      `Adding to batch queue for task "${this.name}". Item ${this.jobBatch.length} of ${this.taskOptions.batchSize}`
    );

    // Capture the promise for the *current* batch
    const currentBatchPromise = this.jobBatchProcessPromise;
    if (!currentBatchPromise) {
      jobLogger.error('Critical error: jobBatchProcessPromise is null when adding a job.');
      throw new Error('Batch processing promise not initialized.');
    }

    // --- Trigger Logic ---
    // 1. Start Timeout Timer (if applicable and not started)
    if (this.jobBatch.length === 1) {
      this.startBatchTimeoutTimerIfNeeded();
    }

    // 2. Check Max Batch Size Reached
    if (this.jobBatch.length >= this.taskOptions.batchSize) {
      jobLogger.debug(
        `Batch size limit (${this.taskOptions.batchSize}) reached for task "${this.name}". Triggering batch processing.`
      );
      // Clear timeout timer *before* starting wrapper, as size limit takes precedence
      this.clearBatchTimeoutTimer();
      // Process immediately
      void this.processBatchWrapper(); // Non-blocking call here
    }
    // NOTE: We don't explicitly trigger on batchMinSize here. The timeout or batchSize limit handles it.

    // Wait for the batch this job belongs to, to complete.
    jobLogger.debug(`Job ${typedJob.id} waiting for its batch (size ${this.jobBatch.length}) to complete...`);
    await currentBatchPromise;
    jobLogger.info(`Batch containing job ${typedJob.id} completed (or failed).`);
    // BullMQ marks job completed/failed based on promise settlement.
  }

  /**
   * Wrapper function to safely initiate batch processing.
   * Prevents concurrent runs, captures state, initializes next batch,
   * calls processBatch, handles results/errors, and cleans up.
   */
  private async processBatchWrapper(): Promise<void> {
    if (this.batchProcessingRunning) {
      this.logger.warn(`Attempted to process batch for task "${this.name}" while another batch was running. Skipping.`);
      return;
    }
    if (this.jobBatch.length === 0) {
      // This might happen if triggered inappropriately, ensure robustness
      this.logger.warn(`processBatchWrapper called for task "${this.name}" with empty batch. Skipping.`);
      // Ensure any waiting promises are resolved if somehow created for an empty batch
      if (this.resolveJobBatchProcessPromise) this.resolveJobBatchProcessPromise();
      // No need to set running=true/false if we bail early
      return;
    }

    this.batchProcessingRunning = true;
    this.logger.info(`Starting batch processing for task "${this.name}"...`);

    // --- Capture state & Clear Timer ---
    const batchToProcess = this.jobBatch;
    const batchCreationTime = this.jobBatchCreationTime;
    const batchPromiseResolver = this.resolveJobBatchProcessPromise;
    const batchPromiseRejector = this.rejectJobBatchProcessPromise;
    // Ensure the timeout timer for the batch *being processed* is cleared
    this.clearBatchTimeoutTimer();

    // --- Prepare for the *next* batch ---
    this.initializeJobBatch();

    // --- Validate captured state ---
    if (!batchPromiseResolver || !batchPromiseRejector) {
      this.logger.error(
        `Critical error: Batch promise resolver/rejector missing for batch created at ${batchCreationTime.toISOString()}. Cannot process.`
      );
      this.batchProcessingRunning = false;
      // Explicitly fail jobs? This is complex without Pro's API.
      // For now, the jobs might hang or eventually timeout via BullMQ's own mechanisms.
      return;
    }

    const batchInfo = `Batch created at ${batchCreationTime.toISOString()} with ${batchToProcess.length} jobs`;
    this.logger.info(`Processing ${batchInfo} for task "${this.name}".`);

    try {
      const batch = new BatchContainer<T, R>(this.queue, this.name, this.logger);
      batch.setJobs(batchToProcess); // Set the jobs to process
      // --- Execute actual batch processing logic ---
      await this.processBatch(batch);

      // --- Success ---
      this.logger.info(`Successfully processed ${batchInfo} for task "${this.name}".`);
      batchPromiseResolver(); // Resolve promise for all waiting jobs in this batch.
    } catch (error) {
      // --- Failure (emulating default Pro behavior) ---
      const processingError = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        { err: processingError },
        `Error processing ${batchInfo} for task "${this.name}". Failing entire batch.`
      );
      batchPromiseRejector(processingError); // Reject promise for all waiting jobs.
    } finally {
      // --- Cleanup ---
      this.batchProcessingRunning = false;
      this.logger.debug(`Finished processing wrapper for ${batchInfo}.`);
    }
  }

  protected getBatchLogger(batch: BatchContainer): Logger {
    return this.logger.child({ batchId: batch.id });
  }

  /**
   * Processes a single job using the configured handler.
   * Called internally by `processBatch`.
   *
   * @param job - The BullMQ job object.
   * @param jobLogger - The logger instance specific to this job.
   * @returns The result returned by the task handler.
   * @throws Throws an error if the handler fails.
   */
  async processBatch(batch: BatchContainer<T, R>): Promise<any> {
    batch.log(`Processing ${batch.id} with ${batch.length} jobs...`);
    const handlerOptions: BatchHandlerOptions<T> = { id: batch.id, name: this.name, data: batch.data };
    const handlerContext: BatchTaskHandlerContext<T, R> = {
      logger: batch.logger,
      client: this.client,
      group: this.group,
      task: this,
      container: batch,
      queue: this.queue,
    };
    try {
      const result = await this.handler(handlerOptions, handlerContext);
      batch.log(`Finished processing ${batch.id} with ${batch.length} jobs...`);
      return result;
    } catch (error) {
      batch.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        `Job processing failed for batch job id "${batch.id}"`
      );
      throw error;
    }
  }

  /**
   * Gracefully shuts down the batch processing task.
   * Clears any pending timeout timer and processes final batch if needed.
   *
   * @override
   */
  async close(): Promise<void> {
    this.logger.info(`Closing BatchTask "${this.name}"...`);

    // Stop any pending batch timeout timer
    this.clearBatchTimeoutTimer();

    // Handle final pending batch (similar to previous custom implementation)
    // Process any remaining jobs if not already processing and not skipping.
    if (this.jobBatch.length > 0 && !this.batchProcessingRunning) {
      this.logger.info(
        `Processing final pending batch (${this.jobBatch.length} jobs) during shutdown for task "${this.name}"...`
      );
      await this.processBatchWrapper(); // Wait for the final batch
    } else if (this.batchProcessingRunning) {
      this.logger.info(`Waiting for currently running batch to complete during shutdown for task "${this.name}"...`);
      // Wait for the current batch promise to settle
      if (this.jobBatchProcessPromise) {
        // This promise is for the *next* batch now... Need the *active* one.
        // This highlights a limitation: cleanly waiting for the *active* batch is tricky.
        // The best effort is waiting for the promise associated with the *next* batch setup,
        // which might be resolved/rejected by the active 'finally' block.
        // A more robust solution would store the active batch promise separately.
        try {
          await this.jobBatchProcessPromise; // Wait on the promise object (might be the *next* one)
          this.logger.info(`Active batch likely finished during shutdown for task "${this.name}".`);
        } catch (_error) {
          this.logger.warn(`Active batch likely failed during shutdown for task "${this.name}".`);
        }
      }
    }

    // 3. Call base class close (stops the worker, etc.)
    this.logger.debug(`Calling BaseTask close method for task "${this.name}".`);
    await super.close();

    this.logger.info(`BatchTask "${this.name}" closed successfully.`);
  }
}
