/**
 * Pure scoring arithmetic (plan §5). No I/O, no dates, no randomness.
 *
 * ⛔ THE ONE RULE THIS FILE ENFORCES: `unknown` is EXCLUDED FROM THE
 * DENOMINATOR, never scored 0. Score 0 on an unmeasured component makes an
 * unmeasured parcel look like a bad one; excluding it and publishing a
 * CONFIDENCE beside the score makes it look like what it is. Without this,
 * every TN parcel (no assessed value at all, E3.3) scores ~40 and reads as a
 * mediocre deal rather than an unmeasured one.
 */
import type { ScoreComponent, ScoreResult } from './schema.ts';

export function rollUp(components: readonly ScoreComponent[]): ScoreResult {
  const scored = components.filter((c) => c.status === 'scored');

  const effectiveOverScored = scored.reduce((a, c) => a + c.effective_weight, 0);
  const nominalOverAll = components.reduce((a, c) => a + c.nominal_weight, 0);

  // Zero scored weight is not a zero score — it is "nothing was measurable".
  // Returning 0 here would put unmeasurable rows at the bottom of a ranking
  // with the same authority as a measured bad one.
  const total =
    effectiveOverScored === 0
      ? 0
      : scored.reduce((a, c) => a + (c.normalized ?? 0) * c.effective_weight, 0) / effectiveOverScored;

  const confidence = nominalOverAll === 0 ? 0 : effectiveOverScored / nominalOverAll;

  return {
    total: clamp(total, 0, 100),
    confidence: clamp(confidence, 0, 1),
    components: [...components],
    gates: [],
  };
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Percentile rank of `value` within `population`, where `population` ALREADY
 * excludes unknowns. Passing a population that still contains sentinel zeros
 * shifts every percentile — hence sentinel.partitionForScoring, which is the
 * only supported way to build the population.
 */
export function percentileRank(value: number, population: readonly number[]): number | null {
  if (population.length === 0) return null;
  const below = population.filter((p) => p < value).length;
  const equal = population.filter((p) => p === value).length;
  return clamp(((below + equal / 2) / population.length) * 100, 0, 100);
}

/** Cheaper is better: a low $/acre must map to a HIGH component score. */
export function invert(pct: number): number {
  return clamp(100 - pct, 0, 100);
}
