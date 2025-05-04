import { Job, MinimalQueue } from 'bullmq';
import { Logger } from 'pino';
import { BaseTask } from './base-task.js';
import type { TaskJobOptions } from './types/index.js';
import { TaskQueue } from './queue.js';

export class TaskJob<DataType = any, ReturnType = any, NameType extends string = string> extends Job<
  DataType,
  ReturnType,
  NameType
> {
  public logger?: Logger;
  public task?: BaseTask<DataType, ReturnType>;
  public taskQueue?: TaskQueue;
  /**
   * The array of real TaskJob instances that constitute a batch.
   */
  private batch: TaskJob<DataType, ReturnType, NameType>[];

  constructor(queue: MinimalQueue, name: NameType, data: DataType, opts: TaskJobOptions = {}, id?: string) {
    super(queue, name, data, opts, id);

    // Check if the queue is an instance of TaskQueue
    if (queue instanceof TaskQueue) {
      this.taskQueue = queue;
      this.logger = queue.logger.child({ taskRun: this.name, taskId: this.id });
    }
    this.batch = [];
  }

  /**
   * Sets/replaces the internal list of Job instances managed by this container.
   * @param jobs The array of Job instances representing the batch.
   */
  setBatch(batch: TaskJob<DataType, ReturnType, NameType>[]) {
    this.batch = batch;
  }

  /**
   * Adds a single job to the internal list for this batch container.
   * @param job The job to add.
   */
  addBatchJob(job: TaskJob<DataType, ReturnType, NameType>) {
    this.batch.push(job);
  }

  /**
   * Adds multiple jobs to the internal list for this batch container.
   * @param jobs The jobs to add.
   */
  addBatchJobs(jobs: TaskJob<DataType, ReturnType, NameType>[]) {
    this.batch.push(...jobs);
  }

  /**
   * Returns the array of actual TaskJob instances managed by this batch container.
   * @returns The array of jobs.
   */
  getBatch(): TaskJob<DataType, ReturnType, NameType>[] {
    return this.batch;
  }

  /**
   * Returns the array of actual TaskJob instances managed by this batch container.
   * @returns The array of jobs.
   */
  get isBatch(): boolean {
    return this.batch.length > 0;
  }

  /**
   * Returns the number of jobs currently in the batch.
   * @returns The number of jobs.
   */
  get batchLength(): number {
    return this.batch.length;
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
    if (!this.isBatch) return;

    this.logger?.debug(`Manually extending locks for ${this.batch.length} jobs in batch ${this.id} by ${duration}ms`);

    const promises = this.batch.map((job) =>
      // Each job needs its token for lock extension
      job.token
        ? job.extendLock(job.token, duration).catch((err) => {
            // Log or handle individual extension errors
            this.logger?.error(`Failed to extend lock for job ${job.id} within batch ${this.id}:`, err);
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
    if (!this.isBatch) {
      return super.updateProgress(progress);
    }
    const promises = this.batch.map((job) =>
      job.updateProgress(progress).catch((err) => {
        this.logger?.error(`Failed to update progress for job ${job.id} within batch ${this.id}:`, err);
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
  async log(logRow: string): Promise<number> {
    if (!this.isBatch) {
      return super.log(logRow);
    }
    let firstLogCount: number = 0; // S
    const promises = this.batch.map((job) =>
      job.log(logRow).catch((err) => {
        this.logger?.error(`Failed to add log entry for job ${job.id} within batch ${this.id}:`, err);
        return null; // Return null or another indicator for failed logs
      })
    );

    const results = await Promise.allSettled(promises);

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        firstLogCount = result.value;
        break;
      }
    }

    return firstLogCount;
  }

  /**
   * Clears all batched job's logs
   *
   * @param keepLogs - the amount of log entries to preserve
   */
  async clearLogs(keepLogs?: number): Promise<void> {
    if (!this.isBatch) {
      return super.clearLogs(keepLogs);
    }
    const promises = this.batch.map((job) =>
      job.clearLogs(keepLogs).catch((err) => {
        this.logger?.error(`Failed to add log entry for job ${job.id} within batch ${this.id}:`, err);
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

  async moveToFailed(error: Error, token: string, fetchNext = false) {
    if (!this.isBatch) {
      return super.moveToFailed(error, token, fetchNext);
    }
    this.logger?.warn(
      `Attempting to move ${this.batchLength} jobs in batch ${this.id} to failed state due to error: ${error.message}`
    );
    const promises = this.batch.map(async (job) => {
      if (!job.token) {
        this.logger?.error(`Job ${job.id} inside batch ${this.id} is missing its lock token. Cannot move to failed.`);
        return Promise.resolve(); // Skip this job
      }
      return job.moveToFailed(error, job.token).catch((moveError) => {
        this.logger?.error(`Failed to move job ${job.id} to 'failed' state within batch ${this.id}:`, moveError);
      });
    });

    await Promise.allSettled(promises);
  }
}
