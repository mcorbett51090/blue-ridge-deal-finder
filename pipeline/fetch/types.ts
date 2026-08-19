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
  /**
   * `true` for a QUERY source, where the control is a row count.
   *
   * A DOCUMENT source (a county PDF) has no query interface, so its control is
   * a property of the document itself — "has a text layer" versus "is a scanned
   * image" — and there is no count to return. Forcing `true` here would have
   * meant writing a literal that is not true of the source, which is the kind
   * of small lie that makes a registry stop being evidence.
   *
   * The control is not weaker for being different: `parseJacksonReo` throws on
   * a scanned document, on a short extraction, and on any mismatch between the
   * PIN count and the parsed row count.
   */
  returnCountOnly: z.literal(true).optional(),
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
  /** What the source is FOR. Governs which layer geometry it may use:
   *  `coordinates` is the only role permitted to read the points layer, and it
   *  may not be used for attributes. Absent = attributes (the default and the
   *  historical behaviour). */
  role: z.enum(['attributes', 'coordinates']).optional(),
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
  /** For a query source: the digest of the layer's sorted field set. For a
   *  DOCUMENT source: the sha256 of the document bytes — a change there is
   *  exactly the drift signal that matters, since the layout IS the schema. */
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

/**
 * ⛔ THE ARCGIS CONTROL BLOCK DOES NOT FIT EVERY FEDERAL SERVICE, AND PRETENDING
 * IT DOES WOULD BE THE LIE THIS FILE EXISTS TO PREVENT.
 *
 * `ControlBlockSchema` above assumes `?where=…&returnCountOnly=true` — a query
 * shape only an ArcGIS layer has. USGS EPQS (the elevation source P7 needs for
 * slope) is a single POINT lookup: no `where`, no rows, no count. Filling in a
 * `where` clause for it so the schema parses would put a field in the registry
 * that nothing executes, which is exactly the "a gate that appears to run"
 * failure the rest of this codebase is built against.
 *
 * So a point service is a DIFFERENT KIND OF ENTRY with its own honest control:
 * a positive request that must come back parseable, and a negative request that
 * must NOT. Both are executed before the service is used (pipeline/enrich/epqs.ts).
 *
 * ⛔ MEASURED 2026-08-19, and this is why `expect` is an enum and not a boolean:
 *   x=-81.8135&y=36.1478 -> HTTP 200, application/json, {"value":"1188.127319336"}
 *                           …note the value is a STRING, not a number
 *   x=-999&y=-999        -> HTTP 200, Content-Type: application/json, body is
 *                           `The operation was attempted on an empty geometry.`
 *                           — PLAIN TEXT. The Content-Type header LIES.
 *   x=-40&y=30 (ocean)   -> HTTP 200, application/json, body is
 *                           `Call failed.  [Failed cloud operation: Open, …]`
 * A JSON.parse on either error body throws; an HTTP-status check passes both.
 */
export const ProbeExpectation = z.enum([
  /** Body parses as JSON and carries a finite numeric elevation. */
  'json-numeric-value',
  /** Body is NOT JSON — the measured shape of this service's error path. */
  'non-json-body',
]);

export const ControlProbeQuerySchema = z.object({
  params: z.record(z.string(), z.string()),
  expect: ProbeExpectation,
});

export const ControlProbeSchema = z
  .object({ positive: ControlProbeQuerySchema, negative: ControlProbeQuerySchema })
  .refine((c) => JSON.stringify(c.positive.params) !== JSON.stringify(c.negative.params), {
    message: 'control_probe positive and negative must send DIFFERENT params — identical probes prove nothing',
  })
  .refine((c) => c.positive.expect !== c.negative.expect, {
    message: 'control_probe positive and negative must expect DIFFERENT outcomes',
  });

/**
 * A keyless point-lookup service. Carries every field the guard reads on a
 * `Source` (denylist target, robots evidence, tos, rate, UA, enabled) and
 * `control_probe` in place of `control_block`.
 *
 * `schema_fingerprint` here is taken over the SORTED KEY SET of a known-good
 * response body, not over layer metadata — a point service publishes no schema
 * document, so the response shape is the only thing there is to fingerprint.
 */
export const PointServiceSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('point-lookup'),
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
  control_probe: ControlProbeSchema,
  schema_fingerprint: Sha256OrNull,
  enabled: z.boolean(),
});

/**
 * A source we MEASURED and are NOT permitted (or not able) to use.
 *
 * It is a first-class record rather than a comment because "we checked and the
 * answer was no" and "nobody looked" are indistinguishable once the evidence is
 * only in someone's head. Nothing loads these into a Registry, so the fetcher
 * cannot reach them even by id — a stronger refusal than `enabled: false`.
 */
export const RefusedSourceSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  refusal: z.enum(['robots-disallow', 'robots-unobtainable', 'tos-prohibitive']),
  checked_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  evidence_url: z.string().url(),
  evidence_file: z.string().min(1),
  evidence_sha256: Sha256OrNull,
  measured: z.string().min(20),
  consequence: z.string().min(20),
});

export const EnrichRegistryFileSchema = z.object({
  sources: z.array(SourceSchema).default([]),
  point_services: z.array(PointServiceSchema).default([]),
  refused: z.array(RefusedSourceSchema).default([]),
});

export type PointService = z.infer<typeof PointServiceSchema>;
export type ControlProbe = z.infer<typeof ControlProbeSchema>;
export type RefusedSource = z.infer<typeof RefusedSourceSchema>;
export type EnrichRegistryFile = z.infer<typeof EnrichRegistryFileSchema>;
