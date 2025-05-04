import { MinimalQueue } from 'bullmq';
import type { Logger } from 'pino'; // Assuming a logger interface
import { v4 as uuidv4 } from 'uuid'; // For generating IDs
import { TaskJob } from './job.js';

/**
 * Represents an in-memory container for managing a batch of actual BullMQ Job instances
 * during processing within a custom BatchTask.
 *
 * This class provides utility methods to perform actions (like logging, updating progress)
 * on all contained jobs simultaneously. It does not represent a single job persisted
 * in Redis itself and does not inherit from BullMQ's Job class.
 *
 * @template DataType The expected type of the data payload for the contained jobs.
 * @template ReturnType The expected return type from processing the contained jobs.
 * @template NameType The queue name type.
 */
export class BatchContainer<DataType = any, ReturnType = any, NameType extends string = string> {
  /**
   * The array of actual BullMQ Job instances that constitute this batch.
   */
  private jobs: TaskJob<DataType, ReturnType, NameType>[] = [];

  /**
   * A unique identifier for this specific batch instance (useful for logging).
   */
  public readonly id: string;

  /**
   * The name associated with the batch operation (e.g., the task name).
   */
  public readonly name: NameType;

  /**
   * The queue instance associated with these jobs.
   */
  private readonly queue: MinimalQueue;

  public readonly data: DataType | undefined;
  public readonly logger: Logger;
  /**
   * Creates an instance of BatchContainer.
   *
   * @param queue The BullMQ queue instance the jobs belong to.
   * @param name A descriptive name for the batch operation (e.g., the task name).
   * @param id Optional unique identifier for this batch instance. Defaults to a generated UUID.
   */
  constructor(queue: MinimalQueue, name: NameType, logger: Logger, id?: string, data?: DataType) {
    this.queue = queue;
    this.name = name;
    this.id = id ?? `batch-${uuidv4()}`; // Generate UUID if no ID provided
    this.data = data;
    this.logger = logger.child({ batchId: this.id, batchName: this.name });
    this.jobs = [];
  }

  /**
   * @returns the queue name this job belongs to.
   */
  get queueName(): string {
    return this.queue.name;
  }

  /**
   * Sets/replaces the internal list of Job instances managed by this container.
   * @param jobs The array of Job instances representing the batch.
   */
  setJobs(jobs: TaskJob<DataType, ReturnType, NameType>[]) {
    this.jobs = jobs;
  }

  /**
   * Adds a single job to the internal list for this batch container.
   * @param job The job to add.
   */
  addJob(job: TaskJob<DataType, ReturnType, NameType>) {
    this.jobs.push(job);
  }

  /**
   * Adds multiple jobs to the internal list for this batch container.
   * @param jobs The jobs to add.
   */
  addJobs(jobs: TaskJob<DataType, ReturnType, NameType>[]) {
    this.jobs.push(...jobs);
  }

  /**
   * Returns the array of actual BullMQ Job instances managed by this batch container.
   * @returns The array of jobs.
   */
  getJobs(): TaskJob<DataType, ReturnType, NameType>[] {
    return this.jobs;
  }

  /**
   * Returns the number of jobs currently in the batch container.
   * @returns The number of jobs.
   */
  get length(): number {
    return this.jobs.length;
  }

  /**
   * **Manual Lock Extension:** Extends the lock for all individual jobs currently held within this batch container.
   *
   * **Usage Note:** Generally **not required**. Rely on the Worker's automatic lock renewal
   * by configuring `lockDuration` appropriately. Use this only for explicit manual control
   * during very long-running steps within your handler.
   *
   * @param duration - Duration (in milliseconds) to extend the lock by. Uses the job's configured lock duration if omitted.
   * @returns A promise that resolves when all lock extensions have been attempted.
   */
  async extendLocks(duration: number): Promise<void> {
    if (this.jobs.length === 0) return;
    this.logger.debug(`Manually extending locks for ${this.jobs.length} jobs in batch ${this.id} by ${duration}ms`);

    const promises = this.jobs.map((job) =>
      // Each job needs its token for lock extension
      job.token
        ? job.extendLock(job.token, duration).catch((err) => {
            // Log or handle individual extension errors
            this.logger.error(`Failed to extend lock for job ${job.id} within batch ${this.id}:`, err);
          })
        : // Handle case where job token might be missing (shouldn't happen if fetched correctly)
          Promise.reject(new Error(`Job ${job.id} missing token for lock extension.`))
    );
    // Use Promise.allSettled to wait for all attempts and see individual results/errors
    await Promise.allSettled(promises);
  }

  /**
   * Updates the progress for all individual jobs currently held within this batch container.
   *
   * @param progress The progress value (number or object).
   * @returns A promise that resolves when all progress updates have been attempted.
   */
  async updateProgress(progress: number | object): Promise<void> {
    if (this.jobs.length === 0) return;
    const promises = this.jobs.map((job) =>
      job.updateProgress(progress).catch((err) => {
        this.logger.error(`Failed to update progress for job ${job.id} within batch ${this.id}:`, err);
      })
    );
    await Promise.allSettled(promises);
  }

  /**
   * Sends the same log entry to all individual jobs currently held within this batch container
   * using the underlying `job.log()` method.
   *
   * @param logRow The string log entry to add to each job's log in Redis.
   * @returns A promise that resolves when all log additions have been attempted.
   */
  async log(logRow: string): Promise<void> {
    if (this.jobs.length === 0) return;
    const promises = this.jobs.map((job) =>
      job.log(logRow).catch((err) => {
        this.logger.error(`Failed to add log entry for job ${job.id} within batch ${this.id}:`, err);
      })
    );
    // Returns an array of numbers (log counts) or errors
    await Promise.allSettled(promises);
  }

  /**
   * Clears all batched job's logs
   *
   * @param keepLogs - the amount of log entries to preserve
   */
  async clearLogs(keepLogs?: number): Promise<void> {
    if (this.jobs.length === 0) return;
    const promises = this.jobs.map((job) =>
      job.clearLogs(keepLogs).catch((err) => {
        this.logger.error(`Failed to add log entry for job ${job.id} within batch ${this.id}:`, err);
      })
    );
    await Promise.allSettled(promises);
  }
  /**
   * Attempts to move all individual jobs currently held within this batch container to the 'failed' state in BullMQ.
   *
   * **Use Case:** Useful if you detect a non-recoverable error *within* your batch handler
   * and want to explicitly mark all jobs as failed *before* throwing an error to signal the overall batch failure.
   * Often, just throwing an error from the handler is sufficient.
   *
   * **Requires Job Tokens:** This operation requires the lock `token` for each individual job.
   *
   * @param error The Error object representing the reason for failure.
   * @returns A promise that resolves when all `moveToFailed` operations have been attempted.
   */
  async moveToFailed(error: Error): Promise<void> {
    if (this.jobs.length === 0) return;
    this.logger.warn(
      `Attempting to move ${this.jobs.length} jobs in batch ${this.id} to failed state due to error: ${error.message}`
    );
    const promises = this.jobs.map(async (job) => {
      if (!job.token) {
        this.logger.error(`Job ${job.id} inside batch ${this.id} is missing its lock token. Cannot move to failed.`);
        return Promise.resolve(); // Skip this job
      }
      return job.moveToFailed(error, job.token).catch((moveError) => {
        this.logger.error(`Failed to move job ${job.id} to 'failed' state within batch ${this.id}:`, moveError);
      });
    });
    await Promise.allSettled(promises);
  }
}
