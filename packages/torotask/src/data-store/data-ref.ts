import type { ToroTaskDataRef } from '../types/data-store.js';
import { TOROTASK_DATA_REF } from '../types/data-store.js';

export function isToroTaskDataRef(value: unknown): value is ToroTaskDataRef {
  return (
    value !== null
    && typeof value === 'object'
    && (value as ToroTaskDataRef)[TOROTASK_DATA_REF] === true
    && typeof (value as ToroTaskDataRef).key === 'string'
  );
}

export function createToroTaskDataRef(
  key: string,
  compressed: boolean,
  byteLength: number,
): ToroTaskDataRef {
  return {
    [TOROTASK_DATA_REF]: true,
    key,
    compressed,
    byteLength,
  };
}
