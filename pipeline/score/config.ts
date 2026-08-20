/**
 * The ONE reader of weights.yaml (plan §5, §5.8 item 3).
 *
 * Everything tunable about the score enters the process here and nowhere else,
 * so `git log -p pipeline/score/weights.yaml` is a complete history of every
 * ranking change that was not a code change.
 *
 * The parse is fail-closed through zod: a weights file with a typo'd key is a
 * throw, not a silent default. A default here would let a mis-edited weight
 * reshuffle the top 100 while every gate stayed green.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';

/** The distress `kind` vocabulary. Lives HERE, beside the increments that must
 *  cover it, so the two cannot drift into different files and disagree. */
export const DistressKindSchema = z.enum([
  'tax_sale_listed',
  'foreclosure_notice',
  'tax_delinquent',
  'upset_bid_window_open',
  'county_owned_reo',
]);
export type DistressKind = z.infer<typeof DistressKindSchema>;

export const WeightsSchema = z.object({
  components: z.object({
    discount: z.number().nonnegative(),
    distress: z.number().nonnegative(),
    water: z.number().nonnegative(),
    livability: z.number().nonnegative(),
  }),
  per_acre: z.object({
    min_cohort: z.number().int().positive(),
    acreage_bands: z.array(z.number().positive()).min(1),
  }),
  discount: z.object({
    min_cohort: z.number().int().positive(),
    thin_cohort_penalty: z.number().min(0).max(1),
    vintage_decay_per_year: z.number().min(0).max(1),
    max_vintage_years: z.number().int().positive(),
  }),
  water: z.object({
    frontage_score: z.number().min(0).max(100),
    near_m: z.number().positive(),
    near_score: z.number().min(0).max(100),
    mid_m: z.number().positive(),
    mid_score: z.number().min(0).max(100),
  }),
  distress: z.object({
    increments: z.object({
      tax_sale_listed: z.number().nonnegative(),
      foreclosure_notice: z.number().nonnegative(),
      tax_delinquent: z.number().nonnegative(),
      upset_bid_window_open: z.number().nonnegative(),
      county_owned_reo: z.number().nonnegative(),
    }),
  }),
  vetoes: z.object({
    use_class_patterns: z.array(z.string().min(1)).min(1),
    min_acres: z.number().nonnegative(),
  }),
});

export type ScoreConfig = z.infer<typeof WeightsSchema>;

export function parseWeights(text: string): ScoreConfig {
  return WeightsSchema.parse(yaml.load(text));
}

export function loadWeights(repoRoot: string): ScoreConfig {
  return parseWeights(readFileSync(join(repoRoot, 'pipeline', 'score', 'weights.yaml'), 'utf8'));
}

/**
 * Nominal weights are documented to sum to 100 and the roll-up's `confidence`
 * divides by that sum, so a file that quietly sums to 97 makes every confidence
 * on the site 3% optimistic. Asserted rather than assumed.
 */
export function assertWeightsSumTo100(cfg: ScoreConfig): void {
  const sum = Object.values(cfg.components).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 1e-9) {
    throw new Error(`weights.yaml: nominal component weights sum to ${sum}, not 100`);
  }
  assertDistressIncrementsComplete(cfg);
}

/**
 * EVERY declared distress `kind` must carry an increment.
 *
 * ⛔ This is a structural invariant, and it is checked here because the failure
 * it prevents is silent and shaped exactly like a correct result.
 * `scoreDistress()` does `cfg.distress.increments[kind]` and then `total += inc`.
 * For a kind with no increment that is `undefined`, so:
 *
 *     total += undefined   ->  NaN
 *     clamp(NaN, 0, 100)   ->  NaN        (Math.min(100, Math.max(0, NaN)))
 *     JSON.stringify(NaN)  ->  null
 *
 * The component would go out through `scoredComponent` — claiming status
 * `scored`, carrying its full nominal weight into the DENOMINATOR — with a value
 * that serialises to null. The row then reads "we could not measure this" while
 * dated, linked, priced evidence sits on disk, and the composite's numerator is
 * quietly poisoned by a NaN. Nothing downstream catches it: the payload is valid
 * JSON, the score derives consistently from a broken breakdown, and every gate
 * stays green.
 *
 * Adding an enum member without its weight is a one-line change that a reviewer
 * reads as complete, which is why this refuses at load time instead of trusting
 * anyone to remember. (FORGE tiebreak TB-2 addendum, 2026-08-19.)
 */
export function assertDistressIncrementsComplete(cfg: ScoreConfig): void {
  const declared = DistressKindSchema.options;
  const have = cfg.distress.increments as Record<string, number | undefined>;
  const missing = declared.filter((k) => typeof have[k] !== 'number');
  if (missing.length) {
    throw new Error(
      `weights.yaml: distress.increments is missing ${missing.join(', ')} — ` +
        'a declared kind with no increment scores NaN and publishes as null. ' +
        'Add the increment in the same commit as the enum member.',
    );
  }
}
