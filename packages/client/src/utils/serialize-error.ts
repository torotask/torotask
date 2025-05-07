import { StepResult } from '../types/step.js';

/**
 * Utility to serialize an error object into a plain object.
 */
export function serializeError(error: any): StepResult['error'] {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

/**
 * Utility to deserialize a stored error.
 * For simplicity, it just creates a generic Error.
 */
export function deserializeError(storedError: StepResult['error']): Error {
  const err = new Error(storedError?.message || 'Unknown step error');
  err.name = storedError?.name || 'StepExecutionError';
  // err.stack = storedError?.stack; // Stack might not be perfectly reconstructed
  return err;
}
