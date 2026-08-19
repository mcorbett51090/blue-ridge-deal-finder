/**
 * Comparison cohorts (plan §5.4, §5.2, RT-9, RT-10).
 *
 * ⛔ NOTHING IS EVER COMPARED AGAINST AN ABSOLUTE NATIONAL THRESHOLD.
 * `parval` is frozen county-wide between reappraisals (G.S. 105-287), and the
 * 11 NC counties reappraise on staggered 4-8 year cycles, so an absolute
 * $/acre comparison across counties measures ASSESSMENT AGE, not value. Every
 * percentile in this file is computed inside a cohort that contains `fips`,
 * which makes it vintage-neutral BY CONSTRUCTION rather than by arithmetic
 * applied afterwards.
 *
 * ⛔ THE BUCKET IS THE RAW USE CLASS, NOT A SEMANTIC MAPPING.
 * Upstream spells the use class three different ways in one corpus — free text
 * ('RESIDENTIAL VACANT'), bare numeric codes ('511'), and the empty string
 * (Yancey publishes no use code at all, on all 17,332 of its rows). Inventing a
 * residential/agricultural/commercial mapping across those would be guessing,
 * and a wrong guess silently compares a house to a hayfield. The raw class is
 * used verbatim; a class that is too thin to rank in falls to `unknown`, which
 * is the honest outcome and is what `min_cohort` is for.
 */
import type { ScoreConfig } from './config.ts';

/** The rows a cohort index is built from. Deliberately narrow — the index must
 *  not be able to see anything it could accidentally rank on. */
export type CohortRow = {
  record_id: string;
  fips: string;
  parusedesc: string;
  acreage: number | null;
  acreage_basis: string;
};

export const UNCLASSIFIED_BUCKET = 'UNCLASSIFIED';

/** Whitespace and casing are upstream noise, not distinctions. */
export function useBucket(parusedesc: string): string {
  const v = parusedesc.replace(/\s+/g, ' ').trim().toUpperCase();
  return v === '' ? UNCLASSIFIED_BUCKET : v;
}

/**
 * Band label for an acreage, as `(lower, upper]`. A 0.2-acre town lot and a
 * 300-acre tract do not share a market, and a percentile that mixes them is a
 * number about nothing.
 */
export function acreageBand(acres: number, bands: readonly number[]): string {
  let lower = 0;
  for (const edge of bands) {
    if (acres <= edge) return `${lower}-${edge}`;
    lower = edge;
  }
  return `${lower}+`;
}

export function cohortKey(row: CohortRow, cfg: ScoreConfig): string | null {
  if (row.acreage === null || !(row.acreage > 0)) return null;
  return `${row.fips}|${useBucket(row.parusedesc)}|${acreageBand(row.acreage, cfg.per_acre.acreage_bands)}`;
}

/**
 * RT-9. Acreage from a GIS polygon and acreage from a deed are different
 * measurements of different things, and NC (`gis`) and TN (`deeded`) would
 * otherwise be silently ranked against each other the day TN lands.
 */
export class CrossBasisRankingError extends Error {
  readonly cohort: string;
  readonly bases: string[];
  constructor(cohort: string, bases: string[]) {
    super(
      `cross-basis ranking refused: cohort '${cohort}' mixes acreage bases [${bases.join(', ')}]. ` +
        'A GIS-derived acreage and a deeded acreage are not comparable quantities (RT-9).',
    );
    this.name = 'CrossBasisRankingError';
    this.cohort = cohort;
    this.bases = bases;
  }
}

/**
 * A sorted population with binary-search percentile lookup.
 *
 * The naive filter-and-count percentile is O(n) per row, i.e. O(n²) per cohort;
 * on the measured Watauga corpus one cohort holds >8,000 rows and the run does
 * not finish. `percentileRank` in index.ts stays as the readable reference and
 * tests assert the two agree on the same population — the fast path is proven
 * against the slow one rather than trusted.
 */
export class Population {
  readonly values: readonly number[];

  constructor(values: readonly number[]) {
    this.values = [...values].sort((a, b) => a - b);
  }

  get size(): number {
    return this.values.length;
  }

  /** Index of the first element >= x. */
  #lowerBound(x: number): number {
    let lo = 0;
    let hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.values[mid] as number) < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Index of the first element > x. */
  #upperBound(x: number): number {
    let lo = 0;
    let hi = this.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.values[mid] as number) <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Mid-rank percentile, 0..100. Identical definition to percentileRank(). */
  percentileOf(x: number): number | null {
    if (this.values.length === 0) return null;
    const below = this.#lowerBound(x);
    const equal = this.#upperBound(x) - below;
    const pct = ((below + equal / 2) / this.values.length) * 100;
    return Math.min(100, Math.max(0, pct));
  }
}

export type CohortIndex = {
  /** cohort key -> the population of assessed $/acre values in it */
  byKey: Map<string, Population>;
  /** cohort key -> the one acreage basis every row in it carries */
  basisByKey: Map<string, string>;
  /** How many rows contributed a value at all. Not the row count. */
  scoredRows: number;
  /** The administrative floor per county, when one was detected. */
  floors: ReadonlyMap<string, ValueFloor>;
};

export type ValuedRow = CohortRow & { value: number | null };

export type ValueFloor = { value: number; count: number };

/**
 * ⛔ THE ADMINISTRATIVE FLOOR — RT-3, ONE LAYER OUT FROM THE ZERO SENTINEL.
 *
 * sentinel.ts catches `parval = 0`. It does not catch `parval = 100`, and the
 * measured corpus is full of the latter: 764 rows carry EXACTLY $100, and only
 * ONE row in 214,588 carries less than $100 anywhere in the corpus. $100 is the
 * minimum assessed value in 5 of the 7 ingested counties (Watauga 359 rows,
 * Ashe 269, Mitchell 109). That is a PILE-UP AT A FLOOR, which is the same
 * shape the 1753-01-01 SQL Server date floor has and is read the same way: an
 * administrative placeholder, not a valuation. G.S. 105-283 requires assessment
 * at "true value in money", and $100 on 134 acres is not an assessment anyone
 * performed.
 *
 * Left in, these rows are the cheapest $/acre in every cohort they touch and
 * own the entire top of the ranking — the HOA-commons defect wearing a
 * different use class, and the reason the first real publish produced 500
 * listings that were all placeholder assessments.
 *
 * ⛔ THE RULE IS MEASURED, NOT A HARDCODED DOLLAR AMOUNT. A county's floor is
 * whatever value that county piles rows up on at its minimum; a county with no
 * pile-up has no floor and loses nothing. `min_pileup` reuses the cohort
 * minimum, because the argument is identical: below that count it is a
 * coincidence, not a distribution.
 *
 * The rows become `unknown` — NOT vetoed, NOT zero. "The county did not price
 * this parcel" is exactly true, and it leaves the denominator.
 */
export function detectValueFloors(
  rows: readonly ValuedRow[],
  minPileup: number,
): Map<string, ValueFloor> {
  const perCounty = new Map<string, Map<number, number>>();
  for (const r of rows) {
    if (r.value === null || !(r.value > 0)) continue;
    const counts = perCounty.get(r.fips) ?? new Map<number, number>();
    counts.set(r.value, (counts.get(r.value) ?? 0) + 1);
    perCounty.set(r.fips, counts);
  }
  const floors = new Map<string, ValueFloor>();
  for (const [fips, counts] of perCounty) {
    let min = Infinity;
    for (const v of counts.keys()) if (v < min) min = v;
    const count = counts.get(min) ?? 0;
    if (count >= minPileup) floors.set(fips, { value: min, count });
  }
  return floors;
}

/** True when this row sits ON its county's administrative floor. */
export function isAtValueFloor(
  row: { fips: string; value: number | null },
  floors: ReadonlyMap<string, ValueFloor>,
): boolean {
  const floor = floors.get(row.fips);
  return floor !== undefined && row.value !== null && row.value === floor.value;
}

/**
 * Build the per-cohort populations of assessed $/acre.
 *
 * ⛔ Rows whose value or acreage is UNKNOWN do not enter the population at all.
 * A sentinel 0 admitted here shifts every percentile in the cohort downward and
 * makes the whole bucket look expensive by comparison — the failure
 * sentinel.partitionForScoring exists to prevent, one layer up.
 */
export function buildCohorts(
  rows: readonly ValuedRow[],
  cfg: ScoreConfig,
  floors: ReadonlyMap<string, ValueFloor> = new Map(),
): CohortIndex {
  const collect = new Map<string, number[]>();
  const basisByKey = new Map<string, string>();
  let scoredRows = 0;

  for (const row of rows) {
    const key = cohortKey(row, cfg);
    if (key === null) continue;

    const seenBasis = basisByKey.get(key);
    if (seenBasis === undefined) basisByKey.set(key, row.acreage_basis);
    else if (seenBasis !== row.acreage_basis) {
      throw new CrossBasisRankingError(key, [seenBasis, row.acreage_basis]);
    }

    if (row.value === null || !(row.value > 0)) continue;
    // A floor row in the POPULATION drags every percentile in its cohort down
    // and makes the whole bucket read as expensive by comparison.
    if (isAtValueFloor(row, floors)) continue;
    const perAcre = row.value / (row.acreage as number);
    if (!Number.isFinite(perAcre)) continue;
    const list = collect.get(key);
    if (list) list.push(perAcre);
    else collect.set(key, [perAcre]);
    scoredRows++;
  }

  const byKey = new Map<string, Population>();
  for (const [key, values] of collect) byKey.set(key, new Population(values));
  return { byKey, basisByKey, scoredRows, floors };
}

/** The per-county cohort `discount` ranks in (plan §5.2). `cntyfips` IS the
 *  vintage partition, so this key needs nothing else in it. */
export function discountCohortKey(fips: string): string {
  return fips;
}
