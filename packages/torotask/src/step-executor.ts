import { isArray, isPlainObject } from 'lodash-es';
import ms, { type StringValue } from 'ms';
import { Logger } from 'pino';
import { ToroTask } from './client.js';
import { TaskJob } from './job.js';
import { DelayedError, WaitingChildrenError } from './step-errors.js';
import { Task } from './task.js';
import type {
  SimplifiedJob,
  StepBulkJob,
  StepResult,
  StepTaskJobOptions,
  TaskGroupDefinitionRegistry,
  TaskGroupRegistry,
  TaskJobState,
} from './types/index.js';
import { getDateTime } from './utils/get-datetime.js';
import { isControlError } from './utils/is-control-error.js';
import { deserializeError, serializeError } from './utils/serialize-error.js';

export class StepExecutor<
  JobType extends TaskJob = TaskJob,
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry = TaskGroupDefinitionRegistry,
  TCurrentJobGroup extends keyof TAllTaskGroupsDefs = never,
  TGroups extends TaskGroupRegistry<TAllTaskGroupsDefs> = TaskGroupRegistry<TAllTaskGroupsDefs>,
  TJobPayload = JobType extends TaskJob<infer P, any, any> ? P : unknown,
  TJobResult = JobType extends TaskJob<any, infer R, any> ? R : unknown,
> {
  private logger: Logger;
  private stepCounts: Map<string, number> = new Map();
  private client: ToroTask;

  constructor(
    private job: JobType,
    private parentTask: Task<TJobPayload, TJobResult, any>
  ) {
    this.logger = job.logger || (console as unknown as Logger);
    this.client = parentTask.group.client;

    if (typeof this.job.state !== 'object' || this.job.state === null) {
      this.job.state = {} as TaskJobState;
    }

    this.job.state.stepState = this.job.state.stepState || {};
  }

  private async persistState(): Promise<void> {
    const stateToUpdate: Partial<TaskJobState> = {
      stepState: this.job.state.stepState,
    };
    await this.job.updateState(stateToUpdate);
  }

  /**
   * Process step result before storing it in the job state.
   * This method automatically prepares TaskJob instances ready for serialization.
   * Recursively processes arrays and objects to find and serialize any TaskJob instances.
   *
   * @param result The result from a step's core logic
   * @param stepKind The kind of step that produced this result
   * @returns A processed version of the result suitable for storage
   */
  protected async memoizeStepResult<T>(result: T, stepKind: string): Promise<any> {
    // Base case: null or undefined
    if (result === null || result === undefined) {
      return result;
    }

    // Handle TaskJob instances by simplifying them
    if (result instanceof TaskJob) {
      const complexJob: TaskJob = result;
      this.logger.debug({ jobId: result.id, stepKind }, `Automatically processing TaskJob instance for serialization`);

      const simpleJob: SimplifiedJob = {
        jobId: complexJob.id!,
        queue: complexJob.queueName,
        timestamp: complexJob.timestamp,
        _isMemoizedTaskJob: true,
      };

      return simpleJob;
    }

    // Handle arrays by recursively processing each element
    if (isArray(result)) {
      this.logger.debug({ stepKind, arrayLength: result.length }, `Processing array for potential TaskJob instances`);
      return Promise.all(result.map((item) => this.memoizeStepResult(item, stepKind)));
    }

    // Handle plain objects by recursively processing each property
    if (isPlainObject(result)) {
      this.logger.debug(
        { stepKind, objectKeys: Object.keys(result as object).length },
        `Processing object for potential TaskJob instances`
      );
      const processedObject: Record<string, any> = {};

      for (const [key, value] of Object.entries(result as object)) {
        processedObject[key] = await this.memoizeStepResult(value, stepKind);
      }

      return processedObject;
    }

    // For other types (primitives, functions, etc.), just return as is
    return result;
  }

  /**
   * Checks if the memoized data is a job that needs to be reconstructed.
   * Recursively processes arrays and objects to find and reconstruct any serialized jobs.
   *
   * @param memoizedData The data from the memoized result
   * @param userStepId The ID of the step for logging purposes
   * @returns The original data or a reconstructed job
   */
  protected async reconstructJobIfNeeded<T>(memoizedData: any, userStepId: string): Promise<T> {
    // Base case: null or undefined
    if (memoizedData === null || memoizedData === undefined) {
      return memoizedData as T;
    }

    // Check if this is a memoized job by looking for our marker
    if (memoizedData && memoizedData._isMemoizedTaskJob) {
      this.logger.debug(
        { jobId: memoizedData.jobId, userStepId },
        `Detected memoized job data for step '${userStepId}'`
      );

      const jobData: SimplifiedJob = memoizedData as SimplifiedJob;

      // Try to reconstruct the job from the queue if possible
      try {
        // If we have a parent task and queue info, we could try to get the job from the queue
        if (this.client && jobData.queue) {
          const job = await this.client.getJobById(jobData.queue, jobData.jobId);
          return job as T;
        } else {
          throw new Error(`Cannot reconstruct job: client or queue not available.`);
        }
      } catch (error: any) {
        this.logger.error(
          { error: error?.message, jobId: memoizedData.jobId, userStepId },
          `Error during job reconstruction attempt`
        );
        throw deserializeError(error);
      }
    }

    // Handle arrays by recursively processing each element
    if (isArray(memoizedData)) {
      this.logger.debug(
        { userStepId, arrayLength: memoizedData.length },
        `Processing array for potential serialized jobs`
      );
      const result = await Promise.all(memoizedData.map((item) => this.reconstructJobIfNeeded(item, userStepId)));
      return result as unknown as T;
    }

    // Handle plain objects by recursively processing each property
    if (isPlainObject(memoizedData)) {
      this.logger.debug(
        { userStepId, objectKeys: Object.keys(memoizedData).length },
        `Processing object for potential serialized jobs`
      );
      const result: Record<string, any> = {};

      for (const [key, value] of Object.entries(memoizedData)) {
        result[key] = await this.reconstructJobIfNeeded(value, userStepId);
      }

      return result as unknown as T;
    }

    // Not a job, return original data
    return memoizedData as T;
  }

  /**
   * Centralized method to execute a step, handling memoization, state persistence, and errors.
   * @param userStepId User-defined ID for the step.
   * @param stepKind A string identifier for the kind of step (e.g., 'do', 'sleep').
   * @param coreLogic The async function that performs the actual work of the step.
   *                  If it initiates a pending state (e.g., sleep, wait), it should:
   *                  1. Update \`this.job.state.stepState\` with the new status (e.g., 'sleeping').
   *                  2. Call \`await this.persistState()\`.
   *                  3. Throw a \`WorkflowPendingError\` (e.g., \`DelayedError\`).
   *                  If it completes successfully, it returns the result.
   *                  If it fails with an unexpected error, it throws that error.
   * @param handleMemoizedState Optional handler for memoized states that are not 'completed' or 'errored'.
   *                                     Used for re-evaluating pending states (e.g., checking if sleep duration has passed).
   *                                     If it handles the state, it should return \`{ processed: true, ... }\`.
   *                                     If the step completes, it must update state and persist.
   * @param memoizeStepResult Optional function to customize how the step result is serialized before storage.
   *                        If not provided, the default memoizeStepResult method will be used.
   */
  private async _executeStep<T>(
    userStepId: string,
    stepKind: string,
    coreLogic: (internalStepId: string) => Promise<T>,
    handleMemoizedState?: (
      memoizedResult: StepResult,
      internalStepId: string
    ) => Promise<{
      processed: boolean; // True if this handler processed the state
      result?: T; // Result if processed and completed
      errorToThrow?: any; // Error to throw if processed and still pending or errored
    }>,
    memoizeStepResult?: (result: T, stepKind: string) => Promise<any> // Optional custom memoizer
  ): Promise<T> {
    const currentCount = this.stepCounts.get(userStepId) || 0;
    const internalStepId = `${userStepId}_${currentCount}`;
    this.stepCounts.set(userStepId, currentCount + 1);

    const memoizedResult = this.job.state.stepState![internalStepId];

    if (memoizedResult) {
      if (memoizedResult.status === 'completed') {
        this.logger.debug(
          { internalStepId, data: memoizedResult.data, stepKind },
          `Step '${userStepId}' (id: ${internalStepId}) already completed, returning memoized data.`
        );

        // Check if the memoized result is a job that needs reconstruction
        const result = await this.reconstructJobIfNeeded(memoizedResult.data, userStepId);
        return result as T;
      } else if (memoizedResult.status === 'errored') {
        this.logger.warn(
          { internalStepId, error: memoizedResult.error, stepKind },
          `Step '${userStepId}' (id: ${internalStepId}) previously errored, re-throwing.`
        );
        throw deserializeError(memoizedResult.error);
      } else if (handleMemoizedState) {
        const intermediateOutcome = await handleMemoizedState(memoizedResult, internalStepId);
        if (intermediateOutcome.processed) {
          if (intermediateOutcome.errorToThrow) {
            throw intermediateOutcome.errorToThrow;
          }
          return intermediateOutcome.result as T;
        }
        this.logger.warn(
          { internalStepId, memoizedResult, stepKind },
          `Memoized step '${userStepId}' (id: ${internalStepId}) with status '${memoizedResult.status}' not fully handled by intermediate handler, proceeding to core logic.`
        );
      } else {
        this.logger.warn(
          { internalStepId, memoizedResult, stepKind },
          `Memoized step '${userStepId}' (id: ${internalStepId}) with unhandled status '${memoizedResult.status}', proceeding to core logic.`
        );
      }
    }

    try {
      const result = await coreLogic(internalStepId);

      // Process the result for storage in the state - use custom serializer if provided, otherwise use default
      const processedResult = memoizeStepResult
        ? await memoizeStepResult(result, stepKind)
        : await this.memoizeStepResult(result, stepKind);

      this.job.state.stepState![internalStepId] = {
        status: 'completed',
        data: processedResult,
      };
      await this.persistState();
      return result;
    } catch (error: any) {
      if (isControlError(error) && error.message.includes(internalStepId)) {
        throw error;
      }

      this.logger.debug(
        { internalStepId, stepKind, err: error },
        `Core logic for step '${userStepId}' (id: ${internalStepId}) threw an unexpected error.`
      );
      this.job.state.stepState![internalStepId] = {
        status: 'errored',
        error: serializeError(error),
      };
      await this.persistState();
      throw error;
    }
  }

  async do<T>(userStepId: string, handler: () => Promise<T>): Promise<T> {
    return this._executeStep<T>(userStepId, 'do', async (_internalStepId: string) => {
      return handler();
    });
  }

  async sleep(userStepId: string, duration: number | StringValue): Promise<void> {
    return this._executeStep<void>(
      userStepId,
      'sleep',
      async (internalStepId: string) => {
        const durationMs = typeof duration === 'number' ? duration : ms(duration);
        const newSleepUntil = Date.now() + durationMs;
        this.job.state.stepState![internalStepId] = {
          status: 'sleeping',
          sleepUntil: newSleepUntil,
        };
        await this.persistState();
        await this.job.moveToDelayed(newSleepUntil, this.job.token);
        throw new DelayedError(`Step "${internalStepId}" is sleeping.`);
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'sleeping') {
          const sleepUntil = memoizedResult.sleepUntil!;
          if (Date.now() >= sleepUntil) {
            this.job.state.stepState![internalStepId] = { status: 'completed' };
            await this.persistState();
            return { processed: true, result: undefined };
          } else {
            await this.job.moveToDelayed(sleepUntil, this.job.token);
            return {
              processed: true,
              errorToThrow: new DelayedError(`Step "${internalStepId}" is sleeping.`),
            };
          }
        }
        return { processed: false };
      }
    );
  }

  async sleepUntil(userStepId: string, datetime: Date | string | number): Promise<void> {
    return this._executeStep<void>(
      userStepId,
      'sleepUntil',
      async (internalStepId: string) => {
        this.logger.debug(
          { internalStepId, userStepId, datetime },
          `sleepUntil called for step '${userStepId}' (id: ${internalStepId}).`
        );

        const timestampMs = getDateTime(datetime);
        if (timestampMs <= Date.now()) {
          this.logger.debug(
            { internalStepId, userStepId, timestampMs },
            `Timestamp for sleepUntil step '${userStepId}' (id: ${internalStepId}) is in the past. Completing immediately.`
          );
          this.job.state.stepState![internalStepId] = { status: 'completed' };
          await this.persistState();
          return;
        }
        this.job.state.stepState![internalStepId] = { status: 'sleeping', sleepUntil: timestampMs };
        await this.persistState();
        await this.job.moveToDelayed(timestampMs, this.job.token);
        throw new DelayedError(`Step "${internalStepId}" is sleeping until specific time.`);
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'sleeping') {
          const sleepUntilTime = memoizedResult.sleepUntil!;
          if (Date.now() >= sleepUntilTime) {
            this.job.state.stepState![internalStepId] = { status: 'completed' };
            await this.persistState();
            return { processed: true, result: undefined };
          } else {
            await this.job.moveToDelayed(sleepUntilTime, this.job.token);
            return {
              processed: true,
              errorToThrow: new DelayedError(`Step "${internalStepId}" is sleeping until specific time.`),
            };
          }
        }
        return { processed: false };
      }
    );
  }

  async runGroupTask<
    TargetGroup extends TGroups[TCurrentJobGroup] = TGroups[TCurrentJobGroup],
    TaskName extends keyof TargetGroup['tasks'] = keyof TargetGroup['tasks'],
    ActualTask extends TargetGroup['tasks'][TaskName] = TargetGroup['tasks'][TaskName],
    Payload = ActualTask extends Task<any, any, any, infer P> ? P : unknown,
    Result = ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
    TJob extends TaskJob<ActualPayload, Result> = TaskJob<ActualPayload, Result>,
  >(userStepId: string, taskName: TaskName, payload: ActualPayload, options?: StepTaskJobOptions): Promise<TJob> {
    return this._executeStep<TJob>(userStepId, 'runGroupTask', async (_internalStepId: string) => {
      const taskKey = taskName.toString();
      const task = this.parentTask?.group.tasks[taskKey];
      if (!task) {
        throw new Error(`Task '${taskKey}' not found in this Task group.`);
      }
      return (await task.run(payload, { ...options, parent: this.job })) as TJob;
    });
  }

  async runGroupTaskAndWait<
    TargetGroup extends TGroups[TCurrentJobGroup] = TGroups[TCurrentJobGroup],
    TaskName extends keyof TargetGroup['tasks'] = keyof TargetGroup['tasks'],
    ActualTask extends TargetGroup['tasks'][TaskName] = TargetGroup['tasks'][TaskName],
    Payload = ActualTask extends Task<any, any, any, infer P> ? P : unknown,
    Result = ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
  >(userStepId: string, taskName: TaskName, payload: ActualPayload, options?: StepTaskJobOptions): Promise<Result> {
    return this._executeStep<Result>(userStepId, 'runGroupTaskAndWait', async (_internalStepId: string) => {
      const taskKey = taskName.toString();
      const task = this.parentTask?.group.tasks[taskKey];
      if (!task) {
        throw new Error(`Task '${taskKey}' not found in this Task group.`);
      }

      return await task.runAndWait(payload, { ...options, parent: this.job });
    });
  }

  async runTask<
    GroupName extends keyof TGroups,
    TargetGroup extends TGroups[GroupName] = TGroups[GroupName],
    TaskName extends keyof TargetGroup['tasks'] = keyof TargetGroup['tasks'],
    ActualTask extends TargetGroup['tasks'][TaskName] = TargetGroup['tasks'][TaskName],
    Payload = ActualTask extends Task<any, any, any, infer P> ? P : unknown,
    Result = ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
    TJob extends TaskJob<ActualPayload, Result> = TaskJob<ActualPayload, Result>,
  >(
    userStepId: string,
    groupName: GroupName,
    taskName: TaskName,
    payload: ActualPayload,
    options?: StepTaskJobOptions
  ): Promise<TJob> {
    return this._executeStep<TJob>(userStepId, 'runTask', async (_internalStepId: string) => {
      if (!this.parentTask) {
        throw new Error('Cannot start task: parentTask is not available.');
      }
      const client = this.parentTask.group.client;
      const groupKey = groupName.toString();
      const taskGroup = client.taskGroups[groupKey];
      if (!taskGroup) {
        throw new Error(`Task group '${groupKey}' not found.`);
      }
      const taskKey = taskName.toString();
      const task = taskGroup.tasks[taskKey];
      if (!task) {
        throw new Error(`Task '${taskKey}' not found in group '${groupKey}'.`);
      }
      const taskJob = (await task.run(payload, { ...options, parent: this.job })) as TJob;

      return taskJob;
    });
  }

  async runTaskAndWait<
    GroupName extends keyof TGroups,
    TargetGroup extends TGroups[GroupName] = TGroups[GroupName],
    TaskName extends keyof TargetGroup['tasks'] = keyof TargetGroup['tasks'],
    ActualTask extends TargetGroup['tasks'][TaskName] = TargetGroup['tasks'][TaskName],
    Payload = ActualTask extends Task<any, any, any, infer P> ? P : unknown,
    Result = ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
  >(
    userStepId: string,
    groupName: GroupName,
    taskName: TaskName,
    payload: ActualPayload,
    options?: StepTaskJobOptions
  ): Promise<Result> {
    return this._executeStep<Result>(userStepId, 'runTaskAndWait', async (_internalStepId: string) => {
      if (!this.parentTask) {
        throw new Error('Cannot run task: parentTask is not available.');
      }
      const client = this.parentTask.group.client;
      const groupKey = groupName.toString();
      const taskGroup = client.taskGroups[groupKey];
      if (!taskGroup) {
        throw new Error(`Task group '${groupKey}' not found.`);
      }
      const taskKey = taskName.toString();
      const task = taskGroup.tasks[taskKey];
      if (!task) {
        throw new Error(`Task '${taskKey}' not found in group '${groupKey}'.`);
      }
      return (await task.runAndWait(payload, { ...options, parent: this.job })) as Result;
    });
  }

  async runTasks<
    GroupName extends keyof TGroups,
    TargetGroup extends TGroups[GroupName] = TGroups[GroupName],
    TaskName extends keyof TargetGroup['tasks'] = keyof TargetGroup['tasks'],
    ActualTask extends TargetGroup['tasks'][TaskName] = TargetGroup['tasks'][TaskName],
    Payload = ActualTask extends Task<any, any, any, infer P> ? P : unknown,
    Result = ActualTask extends Task<any, infer R, any, any> ? R : unknown,
    ActualPayload extends Payload = Payload,
    TJob extends TaskJob<ActualPayload, Result> = TaskJob<ActualPayload, Result>,
  >(
    userStepId: string,
    groupName: GroupName,
    taskName: TaskName,
    tasks: StepBulkJob<ActualPayload>[],
    options?: StepTaskJobOptions
  ): Promise<TJob[]> {
    return this._executeStep<TJob[]>(userStepId, 'runTasks', async (_internalStepId: string) => {
      if (!this.parentTask) {
        throw new Error('Cannot start tasks: parentTask is not available.');
      }
      const client = this.parentTask.group.client;
      const groupKey = groupName.toString();
      const taskGroup = client.taskGroups[groupKey];
      if (!taskGroup) {
        throw new Error(`Task group '${groupKey}' not found.`);
      }
      const taskKey = taskName.toString();
      const task = taskGroup.tasks[taskKey];
      if (!task) {
        throw new Error(`Task '${taskKey}' not found in group '${groupKey}'.`);
      }
      const taskJobs = (await task.runMany(tasks, { ...options, parent: this.job })) as TJob[];

      return taskJobs;
    });
  }

  async waitForChildTasks(userStepId: string): Promise<any[]> {
    return this._executeStep<any[]>(
      userStepId,
      'waitForChildTasks',
      async (internalStepId: string) => {
        this.logger.debug(
          { internalStepId, userStepId },
          `waitForChildTasks called for step '${userStepId}' (id: ${internalStepId}).`
        );
        this.job.state.stepState![internalStepId] = { status: 'waiting_for_children' };
        await this.persistState();
        const token = this.job.token || '';
        const shouldWait = await this.job.moveToWaitingChildren(token);
        if (shouldWait) {
          this.logger.debug(
            { internalStepId, userStepId },
            `Step '${userStepId}' (id: ${internalStepId}) successfully moved to waiting for children, throwing WaitingChildrenError.`
          );

          // Create and throw the error - BullMQ will recognize it
          throw new WaitingChildrenError(`Step "${internalStepId}" is waiting for child tasks.`);
        } else {
          this.logger.debug(
            { internalStepId, userStepId },
            `Step '${userStepId}' (id: ${internalStepId}) does not need to wait for children. Completing step.`
          );
          return [];
        }
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'waiting_for_children') {
          this.logger.debug(
            { internalStepId, userStepId, tasks: memoizedResult.childTaskIds },
            `Handling intermediate 'waiting_for_children' state for step '${userStepId}' (id: ${internalStepId}). Re-checking.`
          );
          const token = this.job.token || '';
          const shouldStillWait = await this.job.moveToWaitingChildren(token);
          if (shouldStillWait) {
            this.logger.debug(
              { internalStepId, userStepId },
              `Still waiting for children for step '${userStepId}' (id: ${internalStepId}). Re-throwing WaitingChildrenError.`
            );
            return {
              processed: true,
              errorToThrow: new WaitingChildrenError(`Step "${internalStepId}" is waiting for child tasks.`),
            };
          } else {
            this.logger.debug(
              { internalStepId, userStepId },
              `Children for step '${userStepId}' (id: ${internalStepId}) are now complete. Marking step as completed.`
            );
            this.job.state.stepState![internalStepId] = { status: 'completed', data: [] };
            await this.persistState();
            return { processed: true, result: [] };
          }
        }
        return { processed: false };
      }
    );
  }

  async sendEvent(userStepId: string, eventName: string, eventData: any): Promise<void> {
    return this._executeStep<void>(userStepId, 'sendEvent', async () => {
      await this.job.taskClient?.sendEvent(eventName, eventData);
      return;
    });
  }
}
