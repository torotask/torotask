import { DelayedError, WaitingChildrenError } from '../step-errors.js';

/**
 * Checks if the provided error is a control error.
 * Control errors are specific to BullMQ and indicate that the job is in a pending state
 * due to flow control issues, such as missing awaits in the job processing.
 */

export function isControlError(error: any): boolean {
  if (
    error instanceof DelayedError ||
    error instanceof WaitingChildrenError ||
    error?.name === 'DelayedError' ||
    error?.name === 'WaitingChildrenError'
  ) {
    return true;
  }
  return false;
}
