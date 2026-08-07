import { Buffer } from 'node:buffer';
import { isToroTaskDataRef } from 'torotask';

export interface ToroTaskTruncateOptions {
  /**
   * When false, large values are passed through unchanged.
   * @default true when `truncate` is provided to the adapter
   */
  enabled?: boolean;

  /**
   * Max primitive string length before replacing with a truncation label.
   * @default 1000
   */
  maxStringLength?: number;

  /**
   * Max array length before replacing with a truncation label.
   * @default 100
   */
  maxArrayLength?: number;

  /**
   * Max JSON byte size per object property before replacing with a truncation label.
   * @default 204800 (200 KiB)
   */
  maxPropertyBytes?: number;

  /**
   * When true, skip truncation (e.g. job detail API requests).
   * Use a function for per-request control from Express middleware.
   */
  showFullData?: boolean | (() => boolean);
}

export interface ResolvedToroTaskTruncateOptions {
  enabled: boolean;
  maxStringLength: number;
  maxArrayLength: number;
  maxPropertyBytes: number;
  showFullData: () => boolean;
}

export const DEFAULT_TRUNCATE_MAX_STRING_LENGTH = 1000;
export const DEFAULT_TRUNCATE_MAX_ARRAY_LENGTH = 100;
export const DEFAULT_TRUNCATE_MAX_PROPERTY_BYTES = 200 * 1024;

export function resolveTruncateOptions(
  options?: ToroTaskTruncateOptions,
): ResolvedToroTaskTruncateOptions {
  const showFullData = options?.showFullData;
  return {
    enabled: options?.enabled ?? true,
    maxStringLength: options?.maxStringLength ?? DEFAULT_TRUNCATE_MAX_STRING_LENGTH,
    maxArrayLength: options?.maxArrayLength ?? DEFAULT_TRUNCATE_MAX_ARRAY_LENGTH,
    maxPropertyBytes: options?.maxPropertyBytes ?? DEFAULT_TRUNCATE_MAX_PROPERTY_BYTES,
    showFullData: typeof showFullData === 'function'
      ? showFullData
      : () => showFullData ?? false,
  };
}

function jsonByteLength(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  }
  catch {
    return undefined;
  }
}

function shouldSkipTruncation(value: unknown): boolean {
  if (isToroTaskDataRef(value)) {
    return true;
  }

  if (typeof value === 'string' && value.startsWith('[ToroTask external data]')) {
    return true;
  }

  return false;
}

/**
 * Recursively truncates large job payloads for Bull Board list views.
 */
export function createTruncateFormatter(
  options?: ToroTaskTruncateOptions,
): (value: unknown) => unknown {
  const resolved = resolveTruncateOptions(options);

  function truncateValue(value: unknown): unknown {
    if (!resolved.enabled || resolved.showFullData()) {
      return value;
    }

    if (value === null || value === undefined || shouldSkipTruncation(value)) {
      return value;
    }

    if (typeof value !== 'object') {
      const str = String(value);
      if (str.length > resolved.maxStringLength) {
        return `[String truncated - ${str.length} chars]`;
      }
      return value;
    }

    if (Array.isArray(value)) {
      if (value.length > resolved.maxArrayLength) {
        return `[Array truncated - ${value.length} items]`;
      }
      return value.map(item => truncateValue(item));
    }

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const byteLength = jsonByteLength(item);
      if (byteLength !== undefined && byteLength > resolved.maxPropertyBytes) {
        result[key] = `[Value truncated - ${(byteLength / 1024).toFixed(2)} KiB]`;
      }
      else {
        result[key] = truncateValue(item);
      }
    }

    return result;
  }

  return truncateValue;
}
