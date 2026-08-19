/**
 * Score shapes (plan §5). Schema + pure functions only at P1 — the components
 * themselves land in P3, and this file exists now so they cannot land with a
 * different contract.
 */
import { z } from 'zod';

export const ComponentIdSchema = z.enum(['discount', 'distress', 'per_acre', 'water', 'livability']);

export const SourceRefSchema = z.object({
  url: z.string().url(),
  retrieved_at: z.string().datetime(),
  kind: z.string().min(1),
});

export const ScoreComponentSchema = z.object({
  id: ComponentIdSchema,
  nominal_weight: z.number().nonnegative(),
  /** nominal × vintage_confidence × cohort_penalty */
  effective_weight: z.number().nonnegative(),
  /** ⛔ `unknown` is NEVER silently 0. It leaves the denominator entirely. */
  status: z.enum(['scored', 'unknown']),
  raw: z.number().nullable(),
  normalized: z.number().min(0).max(100).nullable(),
  contribution: z.number(),
  /** A human sentence, rendered verbatim on the card. Mechanisms, not promises. */
  basis: z.string().min(1),
  sources: z.array(SourceRefSchema),
});

export const ScoreResultSchema = z.object({
  total: z.number().min(0).max(100),
  /** Σ(effective over SCORED) / Σ(nominal over ALL). Rendered beside the score. */
  confidence: z.number().min(0).max(1),
  components: z.array(ScoreComponentSchema),
  gates: z.array(z.object({ id: z.string(), passed: z.boolean(), basis: z.string() })),
});

export type ComponentId = z.infer<typeof ComponentIdSchema>;
export type ScoreComponent = z.infer<typeof ScoreComponentSchema>;
export type ScoreResult = z.infer<typeof ScoreResultSchema>;
