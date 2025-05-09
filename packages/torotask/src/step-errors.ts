import { DelayedError, WaitingChildrenError } from 'bullmq'; // Assuming 'bullmq' is the correct import path

/**
 * Base error to indicate that a step is in a pending state and not yet completed or errored.
 * The BullMQ worker should catch this type of error and handle the job accordingly
 * (e.g., re-queue with delay, move to a waiting list).
 */
export class WorkflowPendingError extends Error {
  public readonly isWorkflowPendingError = true;
  constructor(
    message: string,
    public readonly stepInternalId: string
  ) {
    super(message);
    this.name = 'WorkflowPendingError';
    // Ensure correct prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Custom error to indicate that a step needs to sleep.
 * Extends BullMQ's DelayedError.
 * This error is thrown by StepExecutor AFTER the job has been successfully moved to the delayed set in BullMQ.
 * The BullMQ worker should catch DelayedError and allow the job to remain delayed.
 */
export class SleepError extends DelayedError {
  public readonly isWorkflowPendingError = true; // Keep for StepExecutor's internal logic
  public readonly isSleepError = true;
  constructor(public readonly stepInternalId: string) {
    super(`Step "${stepInternalId}" is sleeping.`); // Pass message to DelayedError
    this.name = 'SleepError'; // Override BullMQ's error name if desired, or keep as DelayedError
    // Object.setPrototypeOf(this, new.target.prototype); // Handled by DelayedError
    Object.setPrototypeOf(this, SleepError.prototype); // Re-assert for this specific class
  }
}

/**
 * Error to indicate that a step is waiting for a child workflow/task to complete.
 */
export class WaitForChildError extends WorkflowPendingError {
  public readonly isWaitForChildError = true;
  constructor(
    public readonly childIdentifier: string, // e.g., child workflow name or job ID
    stepInternalId: string
  ) {
    super(`Step "${stepInternalId}" is waiting for child "${childIdentifier}".`, stepInternalId);
    this.name = 'WaitForChildError';
    Object.setPrototypeOf(this, WaitForChildError.prototype);
  }
}

/**
 * Error to indicate that a step is waiting for multiple child tasks to complete.
 * Extends BullMQ's WaitingChildrenError.
 * This error is thrown by StepExecutor AFTER the job has been successfully moved to waiting-children in BullMQ.
 * The BullMQ worker should catch WaitingChildrenError and allow the job to remain in that state.
 */
export class WaitForChildrenError extends WaitingChildrenError {
  public readonly isWorkflowPendingError = true; // Keep for StepExecutor's internal logic
  public readonly isWaitForChildrenError = true;
  constructor(
    public readonly childTaskCount: number,
    public readonly stepInternalId: string
  ) {
    super(`Step "${stepInternalId}" is waiting for ${childTaskCount} child tasks.`); // Pass message to WaitingChildrenError
    this.name = 'WaitForChildrenError'; // Override BullMQ's error name if desired, or keep as WaitingChildrenError
    // Object.setPrototypeOf(this, new.target.prototype); // Handled by WaitingChildrenError
    Object.setPrototypeOf(this, WaitForChildrenError.prototype); // Re-assert for this specific class
  }
}

/**
 * Error to indicate that a step is waiting for an external event.
 */
export class WaitForEventError extends WorkflowPendingError {
  public readonly isWaitForEventError = true;
  constructor(
    public readonly eventName: string,
    stepInternalId: string,
    public readonly timeoutMs?: number
  ) {
    super(
      `Step "${stepInternalId}" is waiting for event "${eventName}"` +
        (timeoutMs ? ` with timeout ${timeoutMs}ms.` : '.'),
      stepInternalId
    );
    this.name = 'WaitForEventError';
    Object.setPrototypeOf(this, WaitForEventError.prototype);
  }
}
