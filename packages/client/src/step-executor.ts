import ms, { type StringValue } from 'ms';
import { Logger } from 'pino';
import { TaskJob } from './job.js';
import type { StepResult, TaskJobState } from './types/index.js';
import {
  SleepError,
  WaitForChildError,
  WaitForChildrenError,
  WaitForEventError,
  WorkflowPendingError,
} from './step-errors.js';
import { getDateTime } from './utils/get-datetime.js';
import { serializeError, deserializeError } from './utils/serialize-error.js';

export class StepExecutor<JobType extends TaskJob = TaskJob> {
  private job: JobType;
  private logger: Logger;
  private stepCounts: Map<string, number> = new Map();

  constructor(job: JobType) {
    this.job = job;
    this.logger = job.logger || (console as unknown as Logger);

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
   * Centralized method to execute a step, handling memoization, state persistence, and errors.
   * @param userStepId User-defined ID for the step.
   * @param stepKind A string identifier for the kind of step (e.g., 'run', 'sleep').
   * @param coreLogic The async function that performs the actual work of the step.
   *                  If it initiates a pending state (e.g., sleep, wait), it should:
   *                  1. Update \`this.job.state.stepState\` with the new status (e.g., 'sleeping').
   *                  2. Call \`await this.persistState()\`.
   *                  3. Throw a \`WorkflowPendingError\` (e.g., \`SleepError\`).
   *                  If it completes successfully, it returns the result.
   *                  If it fails with an unexpected error, it throws that error.
   * @param handleMemoizedState Optional handler for memoized states that are not 'completed' or 'errored'.
   *                                     Used for re-evaluating pending states (e.g., checking if sleep duration has passed).
   *                                     If it handles the state, it should return \`{ processed: true, ... }\`.
   *                                     If the step completes, it must update state and persist.
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
    }>
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
        return memoizedResult.data as T;
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
      this.job.state.stepState![internalStepId] = {
        status: 'completed',
        data: result,
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

      this.logger.error(
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

  async run<T>(userStepId: string, handler: () => Promise<T>): Promise<T> {
    return this._executeStep<T>(userStepId, 'run', async (_internalStepId: string) => {
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
          `Step '${userStepId}' (id: ${internalStepId}) is now sleeping, throwing SleepError.`
        );
        throw new SleepError(internalStepId);
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
              `Step '${userStepId}' (id: ${internalStepId}) still sleeping, re-asserting delay and throwing SleepError.`
            );
            await this.job.moveToDelayed(sleepUntil, this.job.token);
            return {
              processed: true,
              errorToThrow: new SleepError(internalStepId),
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
          `Step '${userStepId}' (id: ${internalStepId}) is now sleeping until specific time, throwing SleepError.`
        );
        throw new SleepError(internalStepId);
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
              `Step '${userStepId}' (id: ${internalStepId}) still sleeping until specific time, re-asserting delay and throwing SleepError.`
            );
            await this.job.moveToDelayed(sleepUntilTime, this.job.token);
            return {
              processed: true,
              errorToThrow: new SleepError(internalStepId),
            };
          }
        }
        return { processed: false };
      }
    );
  }

  async invoke<T = any>(userStepId: string, childWorkflowName: string, input: any): Promise<T> {
    return this._executeStep<T>(
      userStepId,
      'invoke',
      async (internalStepId: string) => {
        this.logger.info(
          { internalStepId, userStepId, childWorkflowName, input },
          `invoke called for step '${userStepId}' (id: ${internalStepId}) - NOT IMPLEMENTED.`
        );
        this.job.state.stepState![internalStepId] = { status: 'waiting_for_child', childIdentifier: childWorkflowName };
        await this.persistState();
        throw new WaitForChildError(childWorkflowName, internalStepId);
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'waiting_for_child') {
          this.logger.info(
            { internalStepId, userStepId, child: memoizedResult.childIdentifier },
            `Handling intermediate 'waiting_for_child' state for 'invoke' - NOT IMPLEMENTED. Assuming child '${memoizedResult.childIdentifier}' is still running.`
          );
          throw new WaitForChildError(memoizedResult.childIdentifier!, internalStepId);
        }
        return { processed: false };
      }
    );
  }

  async waitForChildTasks(userStepId: string, childTaskIds: string[]): Promise<any[]> {
    return this._executeStep<any[]>(
      userStepId,
      'waitForChildTasks',
      async (internalStepId: string) => {
        this.logger.info(
          { internalStepId, userStepId, childTaskIds },
          `waitForChildTasks called for step '${userStepId}' (id: ${internalStepId}).`
        );
        this.job.state.stepState![internalStepId] = { status: 'waiting_for_children', childTaskIds: childTaskIds };
        await this.persistState();
        const token = this.job.token || '';
        const shouldWait = await this.job.moveToWaitingChildren(token);
        if (shouldWait) {
          this.logger.info(
            { internalStepId, userStepId, childTaskIds },
            `Step '${userStepId}' (id: ${internalStepId}) successfully moved to waiting for children, throwing WaitForChildrenError.`
          );
          throw new WaitForChildrenError(childTaskIds.length, internalStepId);
        } else {
          this.logger.info(
            { internalStepId, userStepId, childTaskIds },
            `Step '${userStepId}' (id: ${internalStepId}) does not need to wait for children. Completing step.`
          );
          return [];
        }
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'waiting_for_children') {
          this.logger.info(
            { internalStepId, userStepId, tasks: memoizedResult.childTaskIds },
            `Handling intermediate 'waiting_for_children' state for step '${userStepId}' (id: ${internalStepId}). Re-checking.`
          );
          const token = this.job.token || '';
          const shouldStillWait = await this.job.moveToWaitingChildren(token);
          if (shouldStillWait) {
            this.logger.info(
              { internalStepId, userStepId },
              `Still waiting for children for step '${userStepId}' (id: ${internalStepId}). Re-throwing WaitForChildrenError.`
            );
            return {
              processed: true,
              errorToThrow: new WaitForChildrenError(memoizedResult.childTaskIds?.length || 0, internalStepId),
            };
          } else {
            this.logger.info(
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

  async waitForEvent<T = any>(userStepId: string, eventName: string, timeoutMs?: number): Promise<T> {
    return this._executeStep<T>(
      userStepId,
      'waitForEvent',
      async (internalStepId: string) => {
        this.logger.info(
          { internalStepId, userStepId, eventName, timeoutMs },
          `waitForEvent called for step '${userStepId}' (id: ${internalStepId}) - NOT IMPLEMENTED.`
        );
        const timeoutAt = timeoutMs ? Date.now() + timeoutMs : undefined;
        this.job.state.stepState![internalStepId] = { status: 'waiting_for_event', eventName: eventName, timeoutAt };
        await this.persistState();
        throw new WaitForEventError(eventName, internalStepId, timeoutMs);
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'waiting_for_event') {
          this.logger.info(
            { internalStepId, userStepId, event: memoizedResult.eventName },
            `Handling intermediate 'waiting_for_event' state - NOT IMPLEMENTED. Assuming event '${memoizedResult.eventName}' not yet received.`
          );
          if (memoizedResult.timeoutAt && Date.now() >= memoizedResult.timeoutAt) {
            this.logger.warn(
              { internalStepId, userStepId, eventName: memoizedResult.eventName },
              `Event '${memoizedResult.eventName}' timed out for step '${userStepId}'.`
            );
            throw new Error(`Event '${memoizedResult.eventName}' timed out.`);
          }
          throw new WaitForEventError(
            memoizedResult.eventName!,
            internalStepId,
            memoizedResult.timeoutAt ? memoizedResult.timeoutAt - Date.now() : undefined
          );
        }
        return { processed: false };
      }
    );
  }

  async sendEvent(userStepId: string, eventName: string, eventData: any): Promise<void> {
    return this._executeStep<void>(userStepId, 'sendEvent', async (internalStepId: string) => {
      this.logger.info(
        { internalStepId, userStepId, eventName, eventData },
        `sendEvent called for step '${userStepId}' (id: ${internalStepId}) - NOT IMPLEMENTED (simulating success).`
      );
      return;
    });
  }
}
