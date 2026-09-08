import type { JobsOptions, MinimalQueue, QueueEvents } from 'bullmq';
import type { Logger } from 'pino';
import type { ToroTask } from './client.js';
import type { TaskJobData, TaskJobOptions, TaskJobState } from './types/index.js';
import type { StepResult } from './types/step.js';
import { Job, UnrecoverableError } from 'bullmq';
import { TaskQueue } from './queue.js';
import { convertJobOptions } from './utils/convert-job-options.js';
import {
  clearJobArtifacts,
  readJobRecordState,
  scheduleOrphanedArtifactCleanup,
} from './utils/job-artifact-cleanup.js';

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
  /**
   * Whether this job has already been completed early within a batch.
   * When true, the moveToCompleted override will no-op to prevent double-completion.
   */
  private _batchCompleted = false;
  private _stepStateHydrated = false;
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

    // Handle cases where the job data is nested, which can happen when
    // re-creating jobs from systems like bull-board.
    let finalData = data;
    const jobData = data as any;
    if (
      jobData.payload
      && typeof jobData.payload === 'object'
      && 'payload' in jobData.payload
    ) {
      finalData = {
        ...(jobData as object),
        payload: jobData.payload.payload,
        state: jobData.payload.state || jobData.state,
      } as DataType;
    }

    super(queue, name, finalData, opts, id);

    this.payload = this.data.payload as PayloadType;
    this.state = this.data.state as StateType;

    if (queue instanceof TaskQueue) {
      this.taskQueue = queue;
      this.logger = queue.logger.child({ taskRun: this.name, taskId: this.id });
      this.taskClient = queue.taskClient;
    }
    else {
      // BullMQ workers pass the Worker instance as the queue when hydrating jobs.
      const workerLike = queue as { taskClient?: ToroTask; logger?: Logger };
      if (workerLike.taskClient) {
        this.taskClient = workerLike.taskClient;
        this.logger = workerLike.logger?.child({ taskRun: this.name, taskId: this.id });
      }
    }
    this.batch = [];
  }

  /**
   * State fields persisted inside BullMQ job.data (stepState is kept in Redis separately).
   */
  private getStateAsTaskJobState(): TaskJobState {
    return this.state as TaskJobState;
  }

  private stateForPersistence(): Omit<StateType, 'stepState'> {
    const { stepState: _stepState, ...persisted } = this.getStateAsTaskJobState();
    return persisted as Omit<StateType, 'stepState'>;
  }

  /**
   * Loads step state from Redis (or migrates legacy inline stepState from job.data).
   * Call before StepExecutor runs so memoized steps are available on resume/retry.
   */
  async hydrateStepState(): Promise<void> {
    if (this._stepStateHydrated) {
      return;
    }
    this._stepStateHydrated = true;

    if (typeof this.state !== 'object' || this.state === null) {
      this.state = {} as StateType;
    }

    const legacyStepState = (this.data.state as TaskJobState | undefined)?.stepState;
    const hasLegacy = legacyStepState && Object.keys(legacyStepState).length > 0;

    if (hasLegacy) {
      this.state = {
        ...this.state,
        stepState: { ...legacyStepState },
      } as StateType;

      if (this.taskClient && this.id) {
        const store = this.taskClient.getStepStateStore();
        for (const [stepId, stepResult] of Object.entries(legacyStepState)) {
          await store.saveStep(this.queueName, this.id, stepId, stepResult);
        }
        await this.stripLegacyStepStateFromJobData();
      }
      return;
    }

    if (!this.taskClient || !this.id) {
      const currentState = this.getStateAsTaskJobState();
      this.state = {
        ...this.state,
        stepState: currentState.stepState ?? {},
      } as StateType;
      return;
    }

    const store = this.taskClient.getStepStateStore();
    const keyExists = await store.exists(this.queueName, this.id);
    if (!keyExists) {
      this.state = {
        ...this.state,
        stepState: {},
      } as StateType;
      return;
    }

    const loaded = await store.loadSteps(this.queueName, this.id);
    const dataStore = this.taskClient.getDataStore();
    if (dataStore) {
      for (const [stepId, result] of Object.entries(loaded)) {
        if (result.data !== undefined) {
          result.data = await dataStore.resolveDeep(result.data);
        }
        loaded[stepId] = result;
      }
    }
    this.state = {
      ...this.state,
      stepState: loaded,
    } as StateType;
  }

  /**
   * Persists a single step's state to the per-step Redis hash.
   * Falls back to inline job.data when no ToroTask client is available (e.g. bull-board).
   */
  async saveStepState(stepId: string, stepResult: StepResult): Promise<void> {
    if (typeof this.state !== 'object' || this.state === null) {
      this.state = {} as StateType;
    }

    const stepState = this.getStateAsTaskJobState().stepState ?? {};
    stepState[stepId] = stepResult;
    this.state = {
      ...this.state,
      stepState,
    } as StateType;

    if (this.taskClient && this.id) {
      await this.taskClient.getStepStateStore().saveStep(
        this.queueName,
        this.id,
        stepId,
        stepResult,
      );
      return;
    }

    await this.updateState({ stepState } as unknown as Partial<StateType>);
  }

  /**
   * Removes the per-step Redis hash for this job.
   */
  async clearStepState(): Promise<void> {
    if (this.taskClient && this.id) {
      await this.taskClient.getStepStateStore().clear(this.queueName, this.id);
    }

    if (typeof this.state === 'object' && this.state !== null) {
      this.state = {
        ...this.state,
        stepState: {},
      };
    }
  }

  /**
   * Resolves external data refs in payload and return value (when present).
   * Called automatically before job processing and when fetching jobs via the client.
   */
  async hydrateStoredData(): Promise<void> {
    const store = this.taskClient?.getDataStore();
    if (!store) {
      return;
    }

    this.payload = await store.resolveDeep(this.payload) as PayloadType;
    if (this.returnvalue !== undefined) {
      this.returnvalue = await store.resolveDeep(this.returnvalue) as ReturnType;
    }
  }

  /**
   * Removes the job from BullMQ and clears external step state.
   */
  async remove(opts?: { removeChildren?: boolean }): Promise<void> {
    await this.clearStepState();
    if (this.taskClient && this.id) {
      await this.taskClient.getDataStore()?.clearJob(this.queueName, this.id);
    }
    await super.remove(opts);
  }

  private async stripLegacyStepStateFromJobData(): Promise<void> {
    const dataState = this.data.state as TaskJobState | undefined;
    if (!dataState?.stepState) {
      return;
    }

    const { stepState: _removed, ...stateWithoutSteps } = dataState;
    await this.updateData({
      ...this.data,
      state: stateWithoutSteps,
    });
  }

  /**
   * Sets a job's payload
   *
   * @param payload - the payload that will replace the current jobs payload.
   */
  async setPayload(payload: PayloadType): Promise<void> {
    let storedPayload: PayloadType = payload;
    const store = this.taskClient?.getDataStore();
    if (store && this.id) {
      storedPayload = await store.externalize(
        { queueName: this.queueName, jobId: this.id, kind: 'payload' },
        payload,
      ) as PayloadType;
    }

    this.payload = storedPayload;
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
      state: this.stateForPersistence(),
    };
    return this.updateData(data);
  }

  /**
   * Partially updates a job's state
   *
   * @param state - the state that will merge with the current jobs state.
   */
  async updateState(state: Partial<StateType>): Promise<void> {
    const { stepState, ...rest } = state as Partial<TaskJobState>;
    const newState = {
      ...this.state,
      ...rest,
    } as StateType;

    if (stepState !== undefined) {
      (newState as TaskJobState).stepState = stepState;
    }

    return this.setState(newState);
  }

  /**
   * Throws an UnrecoverableError to permanently fail this job.
   * The job will not be retried and will immediately move to the failed state.
   *
   * @param message - Error message describing why the job failed
   * @param logMessage - If true, logs the message to the job's log before throwing (default: true)
   * @throws UnrecoverableError - Always throws to fail the job
   *
   * @example
   * ```ts
   * if (!payload.userId) {
   *   await job.failUnrecoverable('Missing required userId');
   * }
   * ```
   */
  async failUnrecoverable(message: string, logMessage: boolean = true): Promise<never> {
    if (logMessage) {
      await this.log(`[UNRECOVERABLE] ${message}`);
    }
    throw new UnrecoverableError(message);
  }

  /**
   * Sets the return value for this job in memory.
   * When used inside a batch handler, this value will be persisted to Redis
   * when the batch completes and BullMQ's normal completion flow runs.
   *
   * For immediate persistence, use {@link complete} instead.
   *
   * @param value - The return value to set.
   */
  setResult(value: ReturnType): void {
    this.returnvalue = value;
  }

  /**
   * Completes this individual job immediately, persisting the return value to Redis.
   * The job will be skipped during the batch's final completion step to avoid double-completion.
   *
   * Use this when you want to complete a job early within a batch loop,
   * for example when a job can be resolved without waiting for the entire batch to finish.
   *
   * @param value - The return value to persist.
   * @throws Error if the job is missing its lock token.
   *
   * @example
   * ```ts
   * for (const item of job.getBatch()) {
   *   const result = await processItem(item.payload);
   *   await item.complete(result); // Persisted to Redis immediately
   * }
   * ```
   */
  async complete(value: ReturnType): Promise<void> {
    if (!this.token) {
      throw new Error(`Job ${this.id} missing token for completion.`);
    }
    this._batchCompleted = true;
    await super.moveToCompleted(value, this.token, false);
    await this.cleanupAfterSuccessfulCompletion();
  }

  /**
   * Whether this job has already been completed early within a batch.
   */
  get isBatchCompleted(): boolean {
    return this._batchCompleted;
  }

  /**
   * Override moveToCompleted to prevent double-completion of batch jobs.
   * When a job has been completed early via {@link complete}, this returns
   * an empty array (no-op) instead of calling the parent implementation.
   *
   * BullMQ's Worker calls this after the processor returns. Returning `[]`
   * tells the Worker there is no next job to fetch from this call.
   */
  async moveToCompleted(
    returnValue: ReturnType,
    token: string,
    fetchNext?: boolean,
  ): Promise<any> {
    if (this._batchCompleted) {
      return [];
    }

    let storedReturnValue = returnValue;
    const store = this.taskClient?.getDataStore();
    if (store && this.id) {
      storedReturnValue = await store.externalize(
        { queueName: this.queueName, jobId: this.id, kind: 'returnValue' },
        returnValue,
      ) as ReturnType;
    }

    const result = await super.moveToCompleted(storedReturnValue, token, fetchNext);
    await this.cleanupAfterSuccessfulCompletion();
    return result;
  }

  /**
   * Step state is execution scratch, so it is dropped once the job succeeds.
   * External data is only dropped when BullMQ also dropped the job record, since
   * a retained job's return value may still hold refs into the data store.
   */
  private async cleanupAfterSuccessfulCompletion(): Promise<void> {
    await this.cleanupFinishedJobArtifacts('completion');
  }

  /**
   * When removeOnFail drops the job record, clear leftover external artifacts.
   * Retained failed jobs keep step state so a failure can still be inspected.
   */
  private async cleanupAfterFailedCompletion(): Promise<void> {
    await this.cleanupFinishedJobArtifacts('failure');
  }

  private async cleanupFinishedJobArtifacts(reason: 'completion' | 'failure'): Promise<void> {
    const taskClient = this.taskClient;
    if (!taskClient || !this.id) {
      return;
    }

    try {
      const jobState = await readJobRecordState(taskClient, this.queueName, this.id);

      // A `restarted` record means another run already reused this job id, so its
      // artifacts belong to that run and must not be deleted here.
      if (jobState === 'missing') {
        await clearJobArtifacts(taskClient, this.queueName, this.id);
      }
      else if (
        jobState === 'finished'
        && reason === 'completion'
        && taskClient.getStepStateStore().clearOnComplete
      ) {
        await this.clearStepState();
      }

      scheduleOrphanedArtifactCleanup(taskClient, this.logger);
    }
    catch (err) {
      this.logger?.warn({ err, jobId: this.id, reason }, 'Failed to clean job artifacts after job finished');
    }
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
      const result = await super.moveToFailed(error, token, fetchNext);
      await this.cleanupAfterFailedCompletion();
      return result;
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

  /**
   * Waits for this job to complete and returns its typed result.
   * This is useful when you have started a child task with `step.runTask()` and want
   * to later retrieve its result after `step.waitForChildTasks()`.
   *
   * @param queueEvents - Optional QueueEvents instance. If not provided, uses the one from taskQueue.
   * @returns The typed return value of the job.
   * @throws Error if the job fails or no QueueEvents is available.
   *
   * @example
   * ```ts
   * const childJob = await step.runTask('step-id', 'groupName', 'taskName', payload);
   * await step.waitForChildTasks('wait-for-children');
   * const result = await childJob.waitForResult(); // Typed result
   * ```
   */
  async waitForResult(queueEvents?: QueueEvents): Promise<ReturnType> {
    // Try to find QueueEvents
    const events = queueEvents ?? (this.taskQueue as any)?.queueEvents;

    if (!events) {
      throw new Error(
        'QueueEvents instance not available. Pass it explicitly or ensure taskQueue has queueEvents.',
      );
    }

    if (!this.id) {
      throw new Error('Job ID is missing. Cannot wait for result.');
    }

    this.logger?.debug({ jobId: this.id }, 'Waiting for job to finish...');

    // Wait for the job to finish
    await this.waitUntilFinished(events);

    // Refetch the job to get the updated return value
    const finishedJob = await TaskJob.fromId<DataType, ReturnType>(
      this.queue as any,
      this.id,
    );

    if (!finishedJob) {
      throw new Error(`Failed to refetch job ${this.id} after completion.`);
    }

    await (finishedJob as unknown as TaskJob<PayloadType, ReturnType>).hydrateStoredData();

    this.logger?.debug(
      { jobId: this.id, returnValue: finishedJob.returnvalue },
      'Job completed, returning result',
    );

    return finishedJob.returnvalue;
  }

  /**
   * Gets the result of a completed job without waiting.
   * Returns undefined if the job hasn't completed yet.
   *
   * @returns The return value if completed, undefined otherwise.
   */
  async getResult(): Promise<ReturnType | undefined> {
    if (!this.id) {
      return undefined;
    }

    const state = await this.getState();
    if (state !== 'completed') {
      return undefined;
    }

    // Refetch to ensure we have the latest return value
    const job = await TaskJob.fromId<DataType, ReturnType>(
      this.queue as any,
      this.id,
    );

    if (job) {
      await (job as unknown as TaskJob<PayloadType, ReturnType>).hydrateStoredData();
    }

    return job?.returnvalue;
  }
}
