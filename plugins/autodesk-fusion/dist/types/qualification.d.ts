import { z } from 'zod/v4';
import type { Runtime } from './runtime.js';
declare const assertionSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"equals">;
    pointer: z.ZodString;
    expected: z.ZodUnknown;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"exists">;
    pointer: z.ZodString;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"approx">;
    pointer: z.ZodString;
    expected: z.ZodNumber;
    absolute_tolerance: z.ZodNumber;
    relative_tolerance: z.ZodDefault<z.ZodNumber>;
}, z.core.$strict>, z.ZodObject<{
    kind: z.ZodLiteral<"length_at_least">;
    pointer: z.ZodString;
    expected: z.ZodNumber;
}, z.core.$strict>], "kind">;
export declare function jsonPointer(value: unknown, pointer: string): unknown;
export declare function checkQualificationAssertions(value: unknown, assertions: z.infer<typeof assertionSchema>[]): void;
export declare function runQualification(runtime: Runtime, raw: unknown): Promise<Record<string, unknown>>;
export {};
