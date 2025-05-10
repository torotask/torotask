import type { Job } from 'bullmq';
import { ZodSchema } from 'zod';

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

// Helper to determine the effective payload type based on new precedence:
// 1. ExplicitPayload (if not strictly unknown)
// 2. Inferred from Schema (if ExplicitPayload is strictly unknown and Schema is provided)
// 3. any (if ExplicitPayload is strictly unknown and no Schema is provided)
export type EffectivePayloadType<
  ExplicitPayload,
  Schema extends ZodSchema | undefined,
> = IsStrictlyUnknown<ExplicitPayload> extends true
  ? Schema extends ZodSchema<infer S>
    ? S
    : any // ExplicitPayload is unknown, try schema, then any
  : ExplicitPayload; // ExplicitPayload is not unknown (could be specific type or any), so use it

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
