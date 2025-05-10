import { type ZodSchema, z } from 'zod';
import { IsStrictlyUnknown } from './utils.js';

// ZodNamespace is no longer needed as we are not using a schema builder function.

/**
 * Defines the type for a schema. It can be a ZodSchema instance or undefined.
 */
export type SchemaHandler = ZodSchema | undefined;

/**
 * Resolves the actual ZodSchema type.
 * If SH is a ZodSchema, that schema type is returned.
 * Otherwise (e.g., SH is undefined), it resolves to undefined.
 */
export type ResolvedSchemaType<SH extends SchemaHandler> = SH extends ZodSchema ? SH : undefined;

/**
 * Determines the effective payload type for a task.
 * If an `ExplicitPayload` type is provided (and is not strictly `unknown`), that type is used.
 * Otherwise, if a `ResolvedSch` (a ZodSchema) is available, the payload type is inferred from it.
 * If neither an explicit payload nor a resolvable schema is present, the payload type defaults to `any`.
 */
export type EffectivePayloadType<
  ExplicitPayload,
  ResolvedSch extends ZodSchema | undefined,
> = IsStrictlyUnknown<ExplicitPayload> extends true
  ? ResolvedSch extends ZodSchema<infer S>
    ? S
    : any
  : ExplicitPayload;
