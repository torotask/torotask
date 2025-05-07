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
 * Extends WorkflowPendingError.
 */
export class SleepError extends WorkflowPendingError {
  public readonly isSleepError = true;
  constructor(
    public readonly durationMs: number,
    stepInternalId: string
  ) {
    super(`Step "${stepInternalId}" is sleeping for ${durationMs}ms.`, stepInternalId);
    this.name = 'SleepError';
    Object.setPrototypeOf(this, SleepError.prototype);
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
 */
export class WaitForChildrenError extends WorkflowPendingError {
  public readonly isWaitForChildrenError = true;
  constructor(
    public readonly childTaskCount: number,
    stepInternalId: string
  ) {
    super(`Step "${stepInternalId}" is waiting for ${childTaskCount} child tasks.`, stepInternalId);
    this.name = 'WaitForChildrenError';
    Object.setPrototypeOf(this, WaitForChildrenError.prototype);
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
