import type { BatchTask } from '../batch-task.js';
import type { Task } from '../task.js';

/**
 * Returns generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];

/**
 * With type `T`, return it as an array even if not already an array.
 */
export type AsArray<T> = T extends any[] ? T : [T];

export type AnyTask<T, R> = Task<T, R> | BatchTask<T, R>;

/**
 * Reduces a complex object type to make it readable in IDEs.
 */
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & unknown;
