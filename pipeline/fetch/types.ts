/**
 * Parse boundary for the source registry (plan §3.1/§3.2).
 *
 * The registry files are hand-edited YAML — i.e. untrusted input from the point
 * of view of the fetcher. They get a zod schema for the same reason an upstream
 * API does: a typo in a rate limit is indistinguishable from a missing one at
 * runtime unless something asserts the shape first.
 */
import { z } from 'zod';

export const RobotsVerdict = z.enum(['allow', 'disallow', 'absent', 'unreachable']);
export const TosVerdict = z.enum(['permissive', 'restrictive', 'prohibitive', 'unknown']);
export const LegalBasis = z.enum([
  'public-records-open-data',
  'public-notice-statutory',
  'government-published',
]);

const Sha256OrNull = z
  .string()
  .regex(/^(sha256:)?[0-9a-f]{64}$/i, 'must be 64 hex chars, optionally sha256:-prefixed')
  .nullable();

export const ControlQuerySchema = z.object({
  where: z.string().min(1),
  returnCountOnly: z.literal(true),
  expect_count: z.number().int().nonnegative(),
});

/**
 * RT-1 fix #3. The two controls must produce DIFFERENT bodies; a source whose
 * positive and negative controls are identical is measuring nothing. Asserted
 * here at parse time so a copy-paste error cannot reach a live batch.
 */
export const ControlBlockSchema = z
  .object({ positive: ControlQuerySchema, negative: ControlQuerySchema })
  .refine((c) => c.positive.where !== c.negative.where, {
    message: 'control_block positive and negative must differ — identical controls prove nothing',
  })
  .refine((c) => c.positive.expect_count > 0 && c.negative.expect_count === 0, {
    message: 'control_block positive must expect >0 rows and negative exactly 0',
  });

export const ExpectSchema = z.object({
  per_county_min_rows: z.record(z.string(), z.number().int().positive()),
  rolling_median_floor_pct: z.number().min(0).max(100),
  max_delta_pct: z.number().min(0).max(100),
  max_zero_parval_pct: z.number().min(0).max(100),
});

export const SourceSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  url: z.string().url(),
  legal_basis: LegalBasis,
  robots: z.object({
    verdict: RobotsVerdict,
    checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidence_url: z.string().url(),
    evidence_sha256: Sha256OrNull,
  }),
  tos: z.object({
    verdict: TosVerdict,
    checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    evidence_url: z.string().url(),
  }),
  rate: z.object({
    rps: z.number().positive(),
    concurrency: z.number().int().positive(),
    crawl_delay_s: z.number().nonnegative().nullable(),
    backoff: z.enum(['exponential', 'linear']),
  }),
  user_agent: z.string().min(1),
  control_block: ControlBlockSchema,
  expect: ExpectSchema,
  schema_fingerprint: Sha256OrNull,
  enabled: z.boolean(),
});

export const DenialSchema = z.object({
  host: z.string().min(1),
  paths: z.array(z.string().min(1)).optional(),
  claims: z.array(z.string()),
  reason: z.string().min(1),
});

export const SourcesFileSchema = z.array(SourceSchema);
export const DenylistFileSchema = z.array(DenialSchema);

export type Source = z.infer<typeof SourceSchema>;
export type Denial = z.infer<typeof DenialSchema>;
export type ControlBlock = z.infer<typeof ControlBlockSchema>;
export type Expect = z.infer<typeof ExpectSchema>;
