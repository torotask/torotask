import type { StepResult } from '../types/step.js';
import { UnrecoverableError } from 'bullmq';

// Maximum size for serialized errors, in bytes (default: 1MB)
const MAX_ERROR_SIZE_BYTES = 1 * 1024 * 1024;

/**
 * Calculate the approximate size of a JSON-serializable object in bytes
 */
function getApproximateSize(obj: any): number {
  try {
    const jsonString = JSON.stringify(obj);
    // In JavaScript, each character is 2 bytes (UTF-16)
    return jsonString.length * 2;
  }
  catch {
    // If we can't stringify, we can't estimate size accurately,
    // so we'll return a large number to trigger the size check
    return Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Utility to serialize an error object into a plain object.
 * Throws UnrecoverableError if:
 * 1. Serialization fails, as this represents a fundamental state management issue
 * 2. The serialized error exceeds the maximum allowed size
 * These are issues that retries won't solve.
 *
 * @param error The error to serialize
 * @param maxSizeBytes Maximum size of serialized error in bytes (defaults to MAX_ERROR_SIZE_BYTES)
 */
export function serializeError(error: any, maxSizeBytes: number = MAX_ERROR_SIZE_BYTES): StepResult['error'] {
  try {
    let serialized: StepResult['error'];

    // Check if error contains a job instance that might cause circular references
    if (error && typeof error === 'object' && (error.queueQualifiedName || error.queueName)) {
      // Create a safe version of the error without job references
      if (error instanceof Error) {
        serialized = {
          message: `[Job Reference Removed] ${error.message}`,
          name: error.name,
          stack: error.stack,
          containedJobReference: true,
        };
      }
      else {
        serialized = {
          message: `[Job Reference Removed] ${String(error)}`,
          containedJobReference: true,
        };
      }
    }
    else if (error instanceof Error) {
      serialized = {
        message: error.message,
        name: error.name,
        stack: error.stack,
      };
    }
    else {
      serialized = {
        message: String(error),
      };
    }

    // Check the size of the serialized error
    const approximateSizeBytes = getApproximateSize(serialized);
    if (approximateSizeBytes > maxSizeBytes) {
      // Instead of throwing, truncate the error to fit within size limits
      const truncatedError = {
        message: `Error too large to serialize fully (${(approximateSizeBytes / 1024 / 1024).toFixed(2)}MB). Original error: ${
          serialized.message?.substring(0, 1000) || 'Unknown error'
        }...`,
        name: serialized.name || 'TruncatedError',
        stack: serialized.stack?.substring(0, 2000) || undefined,
        truncated: true,
      };

      return truncatedError;
    }

    return serialized;
  }
  catch (serializationError) {
    throw new UnrecoverableError(
      `Failed to serialize error state: ${serializationError instanceof Error ? serializationError.message : String(serializationError)}`,
    );
  }
}

/**
 * Utility to deserialize a stored error.
 * For simplicity, it just creates a generic Error.
 * Throws UnrecoverableError if deserialization fails, as this represents
 * a fundamental state management issue that retries won't solve.
 */
export function deserializeError(storedError: StepResult['error']): Error {
  try {
    const err = new Error(storedError?.message || 'Unknown step error');
    err.name = storedError?.name || 'StepExecutionError';
    // err.stack = storedError?.stack; // Stack might not be perfectly reconstructed
    return err;
  }
  catch (deserializationError) {
    throw new UnrecoverableError(
      `Failed to deserialize error state: ${deserializationError instanceof Error ? deserializationError.message : String(deserializationError)}`,
    );
  }
}
