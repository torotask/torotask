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
import { serializeError, deserializeError } from './utils/serialize-error.js';

export class StepExecutor<JobType extends TaskJob = TaskJob> {
  private job: JobType;
  private currentStepIndex: number;
  private logger: Logger;

  constructor(job: JobType) {
    this.job = job;
    this.logger = job.logger || (console as unknown as Logger);

    if (typeof this.job.state !== 'object' || this.job.state === null) {
      this.job.state = {} as TaskJobState;
    }
    this.job.state.stepState = this.job.state.stepState || {};
    this.currentStepIndex = this.job.state._currentStepIndex || 0;

    this.logger.debug(
      {
        initialStepIndex: this.currentStepIndex,
        existingSteps: Object.keys(this.job.state.stepState || {}).length,
      },
      'StepExecutor initialized.'
    );
  }

  private async persistState(): Promise<void> {
    const stateToUpdate: Partial<TaskJobState> = {
      _currentStepIndex: this.currentStepIndex,
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
   *                  2. Call \`await this.persistState()\`. (currentStepIndex is NOT incremented yet).
   *                  3. Throw a \`WorkflowPendingError\` (e.g., \`SleepError\`).
   *                  If it completes successfully, it returns the result.
   *                  If it fails with an unexpected error, it throws that error.
   * @param handleMemoizedState Optional handler for memoized states that are not 'completed' or 'errored'.
   *                                     Used for re-evaluating pending states (e.g., checking if sleep duration has passed).
   *                                     If it handles the state, it should return \`{ processed: true, ... }\`.
   *                                     If the step completes, it must update state, increment \`currentStepIndex\`, and persist.
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
    const internalStepId = `${userStepId}_${this.currentStepIndex}`;
    this.logger.debug({ userStepId, internalStepId, stepKind }, `Attempting step: ${stepKind}`);

    const memoizedResult = this.job.state.stepState![internalStepId];

    if (memoizedResult) {
      if (memoizedResult.status === 'completed') {
        this.logger.debug(
          { internalStepId, data: memoizedResult.data, stepKind },
          `Step '${userStepId}' already completed, returning memoized data.`
        );
        this.currentStepIndex++;
        await this.persistState();
        return memoizedResult.data as T;
      } else if (memoizedResult.status === 'errored') {
        this.logger.warn(
          { internalStepId, error: memoizedResult.error, stepKind },
          `Step '${userStepId}' previously errored, re-throwing.`
        );
        this.currentStepIndex++;
        await this.persistState();
        throw deserializeError(memoizedResult.error);
      } else if (handleMemoizedState) {
        const intermediateOutcome = await handleMemoizedState(memoizedResult, internalStepId);
        if (intermediateOutcome.processed) {
          if (intermediateOutcome.errorToThrow) {
            throw intermediateOutcome.errorToThrow;
          }
          // If processed and completed, currentStepIndex and persistState should have been handled by it.
          return intermediateOutcome.result as T;
        }
        this.logger.warn(
          { internalStepId, memoizedResult, stepKind },
          `Memoized step '${userStepId}' with status '${memoizedResult.status}' not fully handled by intermediate handler, proceeding to core logic.`
        );
      } else {
        this.logger.warn(
          { internalStepId, memoizedResult, stepKind },
          `Memoized step '${userStepId}' with unhandled status '${memoizedResult.status}', proceeding to core logic.`
        );
      }
    }

    this.logger.debug({ internalStepId, stepKind }, `Executing core logic for step '${userStepId}'.`);
    try {
      const result = await coreLogic(internalStepId);
      // If coreLogic completes without throwing a WorkflowPendingError, it's a normal completion.
      this.job.state.stepState![internalStepId] = {
        status: 'completed',
        data: result,
      };
      this.currentStepIndex++;
      await this.persistState();
      this.logger.info(
        { internalStepId, stepKind, result },
        `Step '${userStepId}' completed successfully by core logic.`
      );
      return result;
    } catch (error: any) {
      if (error instanceof WorkflowPendingError && error.stepInternalId === internalStepId) {
        // coreLogic (or its caller) has set the pending state and persisted it.
        // currentStepIndex was NOT incremented for pending states.
        this.logger.info(
          { internalStepId, stepKind, errName: error.name, details: error },
          `Step '${userStepId}' initiated a pending state (${error.name}).`
        );
        throw error; // Re-throw for the worker to handle.
      }

      // Unexpected error from coreLogic.
      this.logger.error(
        { internalStepId, stepKind, err: error },
        `Core logic for step '${userStepId}' threw an unexpected error.`
      );
      this.job.state.stepState![internalStepId] = {
        status: 'errored',
        error: serializeError(error),
      };
      this.currentStepIndex++; // Increment to move past this faulty step definition on retry.
      await this.persistState();
      throw error; // Re-throw the original error.
    }
  }

  async run<T>(userStepId: string, handler: () => Promise<T>): Promise<T> {
    return this._executeStep<T>(
      userStepId,
      'run',
      async (_internalStepId: string) => {
        // Core logic for run is simply the handler
        return handler();
      }
      // No special intermediate state handling for 'run' beyond completed/errored
    );
  }

  async sleep(userStepId: string, durationMs: number): Promise<void> {
    return this._executeStep<void>(
      userStepId,
      'sleep',
      async (internalStepId: string) => {
        const newSleepUntil = Date.now() + durationMs;
        this.job.state.stepState![internalStepId] = {
          status: 'sleeping',
          sleepUntil: newSleepUntil,
        };
        await this.persistState(); // Persist state first
        // TaskJob.moveToDelayed is expected to handle BullMQ specific logic
        // and NOT throw an error that interrupts this flow unless the move itself fails critically.
        await this.job.moveToDelayed(newSleepUntil, this.job.token);
        this.logger.info(
          { internalStepId, durationMs, sleepUntil: newSleepUntil },
          `Step '${userStepId}' is now sleeping, throwing SleepError for StepExecutor.`
        );
        throw new SleepError(internalStepId); // Signal pending state to StepExecutor
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'sleeping') {
          const sleepUntil = memoizedResult.sleepUntil!;
          if (Date.now() >= sleepUntil) {
            this.logger.info(
              { internalStepId },
              `Sleep duration for step '${userStepId}' ended, marking as completed.`
            );
            this.job.state.stepState![internalStepId] = { status: 'completed' };
            this.currentStepIndex++;
            await this.persistState();
            return { processed: true, result: undefined };
          } else {
            this.logger.info(
              { internalStepId, sleepUntil },
              `Step '${userStepId}' still sleeping, re-asserting delay via moveToDelayed and throwing SleepError.`
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

  async sleepUntil(userStepId: string, timestampMs: number): Promise<void> {
    return this._executeStep<void>(
      userStepId,
      'sleepUntil',
      async (internalStepId: string) => {
        this.logger.info({ internalStepId, userStepId, timestampMs }, `sleepUntil called for step '${userStepId}'.`);
        if (timestampMs <= Date.now()) {
          this.logger.info(
            { internalStepId, userStepId, timestampMs },
            `Timestamp for sleepUntil step '${userStepId}' is in the past. Completing immediately.`
          );
          this.job.state.stepState![internalStepId] = { status: 'completed' };
          // persistState and currentStepIndex increment handled by _executeStep on normal return
          return;
        }
        this.job.state.stepState![internalStepId] = { status: 'sleeping', sleepUntil: timestampMs };
        await this.persistState();
        await this.job.moveToDelayed(timestampMs, this.job.token);
        this.logger.info(
          { internalStepId, userStepId, timestampMs },
          `Step '${userStepId}' is now sleeping until specific time, throwing SleepError for StepExecutor.`
        );
        throw new SleepError(internalStepId);
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'sleeping') {
          const sleepUntilTime = memoizedResult.sleepUntil!;
          if (Date.now() >= sleepUntilTime) {
            this.logger.info({ internalStepId, userStepId }, `sleepUntil for step '${userStepId}' completed.`);
            this.job.state.stepState![internalStepId] = { status: 'completed' };
            this.currentStepIndex++;
            await this.persistState();
            return { processed: true, result: undefined };
          } else {
            this.logger.info(
              { internalStepId, userStepId, sleepUntilTime },
              `Step '${userStepId}' still sleeping until specific time, re-asserting delay via moveToDelayed and throwing SleepError.`
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
          `invoke called for step '${userStepId}' - NOT IMPLEMENTED.`
        );
        // Real implementation:
        // 1. Trigger child workflow, get childJobId/identifier.
        // 2. this.job.state.stepState![internalStepId] = { status: 'waiting_for_child', childIdentifier: '...' };
        // 3. await this.persistState();
        // 4. throw new WaitForChildError('childJobId', internalStepId);
        this.job.state.stepState![internalStepId] = { status: 'waiting_for_child', childIdentifier: childWorkflowName }; // Placeholder
        await this.persistState();
        throw new WaitForChildError(childWorkflowName, internalStepId); // Placeholder
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'waiting_for_child') {
          this.logger.info(
            { internalStepId, userStepId, child: memoizedResult.childIdentifier },
            `Handling intermediate 'waiting_for_child' state for 'invoke' - NOT IMPLEMENTED. Assuming child '${memoizedResult.childIdentifier}' is still running.`
          );
          // Real implementation: Check child status. If done, complete/error this step. Else, re-throw WaitForChildError.
          // For now, we'll just re-throw to keep it pending.
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
          `waitForChildTasks called for step '${userStepId}'.`
        );
        this.job.state.stepState![internalStepId] = { status: 'waiting_for_children', childTaskIds: childTaskIds };
        await this.persistState();

        const shouldWait = await this.job.moveToWaitingChildren(this.job.token || '');

        if (shouldWait) {
          this.logger.info(
            { internalStepId, userStepId, childTaskIds },
            `Step '${userStepId}' successfully moved to waiting for children, throwing WaitForChildrenError for StepExecutor.`
          );
          throw new WaitForChildrenError(childTaskIds.length, internalStepId);
        } else {
          this.logger.info(
            { internalStepId, userStepId, childTaskIds },
            `Step '${userStepId}' does not need to wait for children (moveToWaitingChildren returned false). Completing step.`
          );
          // If moveToWaitingChildren returns false, it implies children are already processed or no waiting is needed.
          // The step completes now. _executeStep will mark it as 'completed' with this return value.
          return []; // Placeholder for actual children results if they were fetched.
        }
      },
      async (memoizedResult, internalStepId) => {
        if (memoizedResult.status === 'waiting_for_children') {
          this.logger.info(
            { internalStepId, userStepId, tasks: memoizedResult.childTaskIds },
            `Handling intermediate 'waiting_for_children' state for step '${userStepId}'. Re-checking with moveToWaitingChildren.`
          );

          // TODO: Implement actual check for child task completion results if needed before this.
          const shouldStillWait = await this.job.moveToWaitingChildren(this.job.token || '');

          if (shouldStillWait) {
            this.logger.info(
              { internalStepId, userStepId },
              `Still waiting for children for step '${userStepId}'. Re-throwing WaitForChildrenError.`
            );
            return {
              processed: true,
              errorToThrow: new WaitForChildrenError(memoizedResult.childTaskIds?.length || 0, internalStepId),
            };
          } else {
            this.logger.info(
              { internalStepId, userStepId },
              `Children for step '${userStepId}' are now complete (moveToWaitingChildren returned false). Marking step as completed.`
            );
            this.job.state.stepState![internalStepId] = { status: 'completed', data: [] }; // Placeholder for actual results
            this.currentStepIndex++;
            await this.persistState();
            return { processed: true, result: [] }; // Placeholder for actual results
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
          `waitForEvent called for step '${userStepId}' - NOT IMPLEMENTED.`
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
          // Real implementation: Check if event received or timeout.
          // For now, re-throw to keep it pending. Check for timeout.
          if (memoizedResult.timeoutAt && Date.now() >= memoizedResult.timeoutAt) {
            this.logger.warn(
              { internalStepId, userStepId, eventName: memoizedResult.eventName },
              `Event '${memoizedResult.eventName}' timed out for step '${userStepId}'.`
            );
            // This should be an actual error, not a pending state.
            // The _executeStep will catch this, mark as errored, and persist.
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
    return this._executeStep<void>(
      userStepId,
      'sendEvent',
      async (internalStepId: string) => {
        // This step type usually completes immediately or errors.
        this.logger.info(
          { internalStepId, userStepId, eventName, eventData },
          `sendEvent called for step '${userStepId}' - NOT IMPLEMENTED (simulating success).`
        );
        // Real implementation: Send the event.
        // For stub, we can let it "complete" immediately.
        return; // This will cause _executeStep to mark it as 'completed'.
      }
      // No special intermediate state handling typically needed for sendEvent
    );
  }
}
