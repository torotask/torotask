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
 * If a schema is present, the payload type is inferred from it.
 * Otherwise, it falls back to `PayloadExplicit` or `unknown`.
 */
export type EffectivePayloadType<PayloadExplicit, SchemaTypeResolved extends ZodSchema | undefined> =
  SchemaTypeResolved extends ZodSchema // If SchemaTypeResolved is a ZodSchema
    ? z.infer<SchemaTypeResolved> // Then use inferred schema type
    : IsStrictlyUnknown<PayloadExplicit> extends true // Else (no schema), if PayloadExplicit is unknown
      ? unknown // Then use unknown
      : PayloadExplicit; // Else (no schema, PayloadExplicit is NOT unknown), use PayloadExplicit
