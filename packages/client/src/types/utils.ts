import type { Job } from 'bullmq';
import type { Task } from '../task.js';

export type ExtractDataType<DataTypeOrJob, Default> = DataTypeOrJob extends Job<infer D, any, any> ? D : Default;
export type ExtractResultType<DataTypeOrJob, Default> = DataTypeOrJob extends Job<any, infer R, any> ? R : Default;
export type ExtractNameType<DataTypeOrJob, Default extends string> = DataTypeOrJob extends Job<any, any, infer N>
  ? N
  : Default;

/**
 * Returns generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];

/**
 * With type `T`, return it as an array even if not already an array.
 */
export type AsArray<T> = T extends any[] ? T : [T];

/**
 * Reduces a complex object type to make it readable in IDEs.
 */
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & unknown;
