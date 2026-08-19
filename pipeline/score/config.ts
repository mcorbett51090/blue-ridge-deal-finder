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

export const WeightsSchema = z.object({
  components: z.object({
    discount: z.number().nonnegative(),
    distress: z.number().nonnegative(),
    per_acre: z.number().nonnegative(),
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
}
