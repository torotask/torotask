import type { JobsOptions, MinimalQueue } from 'bullmq';
import type { Logger } from 'pino';
import type { ToroTask } from './client.js';
import type { TaskJobData, TaskJobOptions, TaskJobState } from './types/index.js';
import { Job } from 'bullmq';
import { TaskQueue } from './queue.js';
import { convertJobOptions } from './utils/convert-job-options.js';

export class TaskJob<
  PayloadType = any,
  ReturnType = any,
  NameType extends string = string,
  const DataType extends TaskJobData = TaskJobData<PayloadType>,
  const StateType = TaskJobState,
> extends Job<DataType, ReturnType, NameType> {
  public logger?: Logger;
  public taskClient?: ToroTask;
  public taskQueue?: TaskQueue;
  /**
   * The array of real TaskJob instances that constitute a batch.
   */
  private batch: (typeof this)[];
  public payload: PayloadType;
  public state: StateType;
  /*
   * @deprecated use options instead.
   */
  declare opts: JobsOptions;

  constructor(
    queue: MinimalQueue,
    name: NameType,
    data: DataType,
    public options: TaskJobOptions<DataType> = {},
    id?: string,
  ) {
    const opts = convertJobOptions(options);
    super(queue, name, data, opts, id);

    this.payload = this.data.payload as PayloadType;
    this.state = this.data.state as StateType;

    // Check if the queue is an instance of TaskQueue
    if (queue instanceof TaskQueue) {
      this.taskQueue = queue;
      this.logger = queue.logger.child({ taskRun: this.name, taskId: this.id });
      this.taskClient = queue.taskClient;
    }
    this.batch = [];
  }

  /**
   * Sets a job's payload
   *
   * @param payload - the payload that will replace the current jobs payload.
   */
  async setPayload(payload: PayloadType): Promise<void> {
    this.payload = payload;
    const data = {
      ...this.data,
      payload: this.payload,
    };
    return this.updateData(data);
  }

  /**
   * Partially updates a job's payload
   *
   * @param payload - the payload that will merge with the current jobs payload.
   */
  async updatePayload(payload: Partial<PayloadType>): Promise<void> {
    const newPayload = {
      ...this.payload,
      ...payload,
    };
    return this.setPayload(newPayload);
  }

  /**
   * Sets a job's state
   *
   * @param state - the state that will replace the current jobs state.
   */
  async setState(state: StateType): Promise<void> {
    this.state = state;
    const data = {
      ...this.data,
      state: this.state,
    };
    return this.updateData(data);
  }

  /**
   * Partially updates a job's state
   *
   * @param state - the state that will merge with the current jobs state.
   */
  async updateState(state: Partial<StateType>): Promise<void> {
    const newState = {
      ...this.state,
      ...state,
    };
    return this.setState(newState as StateType);
  }

  /**
   * Sets/replaces the internal list of Job instances managed by this container.
   * @param batch The array of Job instances representing the batch.
   */
  setBatch(batch: (typeof this)[]) {
    this.batch = batch;
  }

  /**
   * Adds a single job to the internal list for this batch container.
   * @param job The job to add.
   */
  addBatchJob(job: typeof this) {
    this.batch.push(job);
  }

  /**
   * Adds multiple jobs to the internal list for this batch container.
   * @param jobs The jobs to add.
   */
  addBatchJobs(jobs: (typeof this)[]) {
    this.batch.push(...jobs);
  }

  /**
   * Returns the array of actual TaskJob instances managed by this batch container.
   * @returns The array of jobs.
   */
  getBatch(): (typeof this)[] {
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
    if (!this.isBatch) {
      return;
    }

    this.logger?.debug(`Manually extending locks for ${this.batch.length} jobs in batch ${this.id} by ${duration}ms`);

    const promises = this.batch.map(job =>
      // Each job needs its token for lock extension
      job.token
        ? job.extendLock(job.token, duration).catch((err) => {
            // Log or handle individual extension errors
            this.logger?.error(`Failed to extend lock for job ${job.id} within batch ${this.id}:`, err);
          }) // Handle case where job token might be missing (shouldn't happen if fetched correctly)
        : Promise.reject(new Error(`Job ${job.id} missing token for lock extension.`)),
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
    const promises = this.batch.map(job =>
      job.updateProgress(progress).catch((err) => {
        this.logger?.error(`Failed to update progress for job ${job.id} within batch ${this.id}:`, err);
      }),
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
    const promises = this.batch.map(job =>
      job.log(logRow).catch((err) => {
        this.logger?.error(`Failed to add log entry for job ${job.id} within batch ${this.id}:`, err);
        return null; // Return null or another indicator for failed logs
      }),
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
    const promises = this.batch.map(job =>
      job.clearLogs(keepLogs).catch((err) => {
        this.logger?.error(`Failed to add log entry for job ${job.id} within batch ${this.id}:`, err);
      }),
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
      `Attempting to move ${this.batchLength} jobs in batch ${this.id} to failed state due to error: ${error.message}`,
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
