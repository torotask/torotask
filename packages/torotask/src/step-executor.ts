import ms, { type StringValue } from 'ms';
import { Logger } from 'pino';
import { TaskJob } from './job.js';
import type { SimplifiedJob, StepResult, TaskGroupDefinitionRegistry, TaskJobState } from './types/index.js';
import { DelayedError, WaitingChildrenError } from './step-errors.js';
import { getDateTime } from './utils/get-datetime.js';
import { serializeError, deserializeError } from './utils/serialize-error.js';
import { Task } from './task.js';
import { ToroTask } from './client.js';

export class StepExecutor<
  JobType extends TaskJob = TaskJob,
  TAllTaskGroupsDefs extends TaskGroupDefinitionRegistry = TaskGroupDefinitionRegistry,
  TCurrentTaskGroup extends keyof TAllTaskGroupsDefs = never,
  TPayload = JobType extends TaskJob<infer P, any, any> ? P : unknown,
  TResult = JobType extends TaskJob<any, infer R, any> ? R : unknown,
> {
  private logger: Logger;
  private stepCounts: Map<string, number> = new Map();
  private client: ToroTask;

  constructor(
    private job: JobType,
    private parentTask: Task<TPayload, TResult, any>
  ) {
    this.logger = job.logger || (console as unknown as Logger);
    this.client = parentTask.group.client;

    if (typeof this.job.state !== 'object' || this.job.state === null) {
      this.job.state = {} as TaskJobState;
    }

    this.job.state.stepState = this.job.state.stepState || {};

    this.logger.debug(
      {
        existingSteps: Object.keys(this.job.state.stepState || {}).length,
      },
      'StepExecutor initialized.'
    );
  }

  private async persistState(): Promise<void> {
    const stateToUpdate: Partial<TaskJobState> = {
      stepState: this.job.state.stepState,
    };
    this.logger.debug({ stateToUpdate }, 'Persisting step state');
    await this.job.updateState(stateToUpdate);
  }

  /**
   * Process step result before storing it in the job state.
   * This method automatically prpeares TaskJob instances ready for serialization.
   *
   * @param result The result from a step's core logic
   * @param stepKind The kind of step that produced this result
   * @returns A processed version of the result suitable for storage
   */
  protected async memoizeStepResult<T>(result: T, stepKind: string): Promise<any> {
    // Handle TaskJob instances by calling toJSON
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
    // For other types, just return as is
    return result;
  }

  /**
   * Checks if the memoized data is a job that needs to be reconstructed.
   *
   * @param memoizedData The data from the memoized result
   * @param userStepId The ID of the step for logging purposes
   * @returns The original data or a reconstructed job
   */
  protected async reconstructJobIfNeeded<T>(memoizedData: any, userStepId: string): Promise<T> {
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

    this.logger.debug({ userStepId, internalStepId, stepKind, currentCount }, `Attempting step: ${stepKind}`);

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

    this.logger.debug(
      { internalStepId, stepKind },
      `Executing core logic for step '${userStepId}' (id: ${internalStepId}).`
    );
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
      this.logger.info(
        { internalStepId, stepKind, result },
        `Step '${userStepId}' (id: ${internalStepId}) completed successfully by core logic.`
      );
      return result;
    } catch (error: any) {
      if (error?.isWorkflowPendingError === true && error.stepInternalId === internalStepId) {
        this.logger.info(
          { internalStepId, stepKind, errName: error.name, details: error },
          `Step '${userStepId}' (id: ${internalStepId}) initiated a pending state (${error.name}). State already persisted by step method.`
        );
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
        this.logger.info(
          { internalStepId, durationMs, sleepUntil: newSleepUntil },
          `Step '${userStepId}' (id: ${internalStepId}) is now sleeping, throwing DelayedError.`
        );
        throw new DelayedError(`Step "${internalStepId}" is sleeping.`);
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'sleeping') {
          const sleepUntil = memoizedResult.sleepUntil!;
          if (Date.now() >= sleepUntil) {
            this.logger.info(
              { internalStepId },
              `Sleep duration for step '${userStepId}' (id: ${internalStepId}) ended, marking as completed.`
            );
            this.job.state.stepState![internalStepId] = { status: 'completed' };
            await this.persistState();
            return { processed: true, result: undefined };
          } else {
            this.logger.info(
              { internalStepId, sleepUntil },
              `Step '${userStepId}' (id: ${internalStepId}) still sleeping, re-asserting delay and throwing DelayedError.`
            );
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
        this.logger.info(
          { internalStepId, userStepId, datetime },
          `sleepUntil called for step '${userStepId}' (id: ${internalStepId}).`
        );

        const timestampMs = getDateTime(datetime);
        if (timestampMs <= Date.now()) {
          this.logger.info(
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
        this.logger.info(
          { internalStepId, userStepId, timestampMs },
          `Step '${userStepId}' (id: ${internalStepId}) is now sleeping until specific time, throwing DelayedError.`
        );
        throw new DelayedError(`Step "${internalStepId}" is sleeping until specific time.`);
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'sleeping') {
          const sleepUntilTime = memoizedResult.sleepUntil!;
          if (Date.now() >= sleepUntilTime) {
            this.logger.info(
              { internalStepId, userStepId },
              `sleepUntil for step '${userStepId}' (id: ${internalStepId}) completed.`
            );
            this.job.state.stepState![internalStepId] = { status: 'completed' };
            await this.persistState();
            return { processed: true, result: undefined };
          } else {
            this.logger.info(
              { internalStepId, userStepId, sleepUntilTime },
              `Step '${userStepId}' (id: ${internalStepId}) still sleeping until specific time, re-asserting delay and throwing DelayedError.`
            );
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
    ChildTaskName extends keyof TAllTaskGroupsDefs[TCurrentTaskGroup]['tasks'],
    ChildTask extends TAllTaskGroupsDefs[TCurrentTaskGroup]['tasks'][ChildTaskName],
    Payload = ChildTask extends Task<infer P, any, any> ? P : unknown,
    Result = ChildTask extends Task<any, infer R, any> ? R : unknown,
  >(userStepId: string, childTaskName: ChildTaskName, payload: Payload): Promise<Result> {
    return this._executeStep<Result>(userStepId, 'runGroupTask', async (_internalStepId: string) => {
      const childTaskKey = childTaskName.toString();
      const childTask = this.parentTask?.group.tasks[childTaskKey];
      if (!childTask) {
        throw new Error(`Task '${childTaskKey}' not found in this Task group.`);
      }
      return await childTask.runAndWait(payload, { parent: this.job });
    });
  }

  async startGroupTask<
    ChildTaskName extends keyof TAllTaskGroupsDefs[TCurrentTaskGroup]['tasks'],
    ChildTask extends TAllTaskGroupsDefs[TCurrentTaskGroup]['tasks'][ChildTaskName],
    Payload = ChildTask extends Task<infer P, any, any> ? P : unknown,
    Result = ChildTask extends Task<any, infer R, any> ? R : unknown,
    TJob extends TaskJob<Payload, Result> = TaskJob<Payload, Result>,
  >(userStepId: string, childTaskName: ChildTaskName, payload: Payload): Promise<TJob> {
    return this._executeStep<TJob>(userStepId, 'startGroupTask', async (_internalStepId: string) => {
      const childTaskKey = childTaskName.toString();
      const childTask = this.parentTask?.group.tasks[childTaskKey];
      if (!childTask) {
        throw new Error(`Task '${childTaskKey}' not found in this Task group.`);
      }
      return (await childTask.run(payload, { parent: this.job })) as TJob;
    });
  }

  async runTask<
    GroupName extends keyof TAllTaskGroupsDefs,
    TargetGroup extends TAllTaskGroupsDefs[GroupName],
    TaskName extends keyof TargetGroup['tasks'],
    ChildTask extends TargetGroup['tasks'][TaskName],
    Payload = ChildTask extends Task<infer P, any, any> ? P : unknown,
    Result = ChildTask extends Task<any, infer R, any> ? R : unknown,
  >(userStepId: string, groupName: GroupName, taskName: TaskName, payload: Payload): Promise<Result> {
    return this._executeStep<Result>(userStepId, 'runTask', async (_internalStepId: string) => {
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
      return (await task.runAndWait(payload, { parent: this.job })) as any;
    });
  }

  async startTask<
    GroupName extends keyof TAllTaskGroupsDefs,
    TargetGroup extends TAllTaskGroupsDefs[GroupName],
    TaskName extends keyof TargetGroup['tasks'],
    ChildTask extends TargetGroup['tasks'][TaskName],
    Payload = ChildTask extends Task<infer P, any, any> ? P : unknown,
    Result = ChildTask extends Task<any, infer R, any> ? R : unknown,
    TJob extends TaskJob<Payload, Result> = TaskJob<Payload, Result>,
  >(userStepId: string, groupName: GroupName, taskName: TaskName, payload: Payload): Promise<TJob> {
    return this._executeStep<TJob>(userStepId, 'startTask', async (_internalStepId: string) => {
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
      const taskJob = (await task.run(payload, { parent: this.job })) as TJob;

      return taskJob;
    });
  }

  async waitForChildTasks(userStepId: string): Promise<any[]> {
    return this._executeStep<any[]>(
      userStepId,
      'waitForChildTasks',
      async (internalStepId: string) => {
        this.logger.info(
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
