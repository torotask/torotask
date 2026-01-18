import type { Job } from 'bullmq';

export type ExtractDataType<DataTypeOrJob, Default> = DataTypeOrJob extends Job<infer D, any, any> ? D : Default;
export type ExtractResultType<DataTypeOrJob, Default> = DataTypeOrJob extends Job<any, infer R, any> ? R : Default;
export type ExtractNameType<DataTypeOrJob, Default extends string> = DataTypeOrJob extends Job<any, any, infer N>
  ? N
  : Default;

// Helper to check if a type is strictly `unknown`
// This distinguishes `unknown` from `any` and other specific types.
export type IsStrictlyUnknown<T> = [T] extends [unknown]
  ? unknown extends T
    ? keyof T extends never
      ? true
      : false // `keyof unknown` is `never`, `keyof any` is `string | number | symbol`
    : false
  : false;

/**
 * Returns generic as either itself or an array of itself.
 */
export type SingleOrArray<T> = T | T[];
export type UnpackList<Item> = Item extends any[] ? Item[number] : Item;
/**
 * With type `T`, return it as an array even if not already an array.
 */
export type AsArray<T> = T extends any[] ? T : [T];

/**
 * Tests and fallbacks
 */
export type NeverToUnknown<T> = IfNever<T, unknown>;
export type IfNever<T, Y, N = T> = [T] extends [never] ? Y : N;

export type IfAny<T, Y, N> = 0 extends 1 & T ? Y : N;
export type IsAny<T> = IfAny<T, true, never>;
export type IsDefault<T, D> = T extends D ? (D extends T ? true : false) : false;
export type IsUnknown<T> = unknown extends T ? (T extends unknown ? true : false) : false;

export type IsNullable<T, Y = true, N = never> = T | null extends T ? Y : N;
export type IsDateTime<T, Y, N> = T extends 'datetime' ? Y : N;
export type IsNumber<T, Y, N> = T extends number ? Y : N;
export type IsString<T, Y, N> = T extends string ? Y : N;

/**
 * Reduces a complex object type to make it readable in IDEs.
 */
export type Prettify<T> = {
  [K in keyof T]: T[K];
} & unknown;

/**
 * Enforces that T has no properties beyond those in Expected.
 * Use this in generic constraints to get compile-time errors for excess properties.
 *
 * Usage: `<T extends NoExcessProperties<T, Expected>>`
 */
export type NoExcessProperties<T, Expected> = T & {
  [K in Exclude<keyof T, keyof Expected>]: never;
};
