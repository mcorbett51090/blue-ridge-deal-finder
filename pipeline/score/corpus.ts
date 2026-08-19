/**
 * Scoring a whole corpus, and RANKING it (plan §5, §5.7).
 *
 * Two rules decide what may appear in a ranking, and both are refusals:
 *
 *  1. A VETOED row is not ranked. Government land, HOA common area, cemeteries
 *     and rights-of-way are not purchasable at any price, and on measured data
 *     they own the top of a $/acre sort outright (see vetoes.ts).
 *
 *  2. A row with ZERO scored components is not ranked either — its `rank` is
 *     `null`, not a large number. `rollUp` returns total 0 for such a row
 *     because there is nothing to average, and a 0 sorted among real scores
 *     would read as "measured, and terrible" instead of "not measured". This is
 *     RT-3 acceptance 4: the parval=0 / gisacres=0 rows must be absent from the
 *     top 100, and the assertion is on `rank === null`, not on the score.
 */
import type { ScoreComponent } from './schema.ts';
import type { ScoreConfig } from './config.ts';
import type { Enrichment } from './enrich-contract.ts';
import type { SourceRef } from './enrich-contract.ts';
import type { WarehouseParcel } from './read-warehouse.ts';
import {
  Population,
  buildCohorts,
  detectValueFloors,
  type CohortIndex,
  type ValuedRow,
} from './cohorts.ts';
import { rollUp, withContributions } from './index.ts';
import {
  assertComponentsCoherent,
  scoreDiscount,
  scoreDistress,
  scoreLivability,
  scorePerAcre,
  scoreWater,
  type SignalRow,
} from './signals.ts';
import { evaluateGates, isVetoed, useClassPatterns, vetoReasons, type Gate } from './vetoes.ts';

export type ScoredParcel = {
  row: WarehouseParcel;
  components: ScoreComponent[];
  total: number;
  confidence: number;
  gates: Gate[];
  vetoed: boolean;
  veto_reasons: string[];
  scored_count: number;
  unknown_count: number;
  /** null = not in the ranking at all. Never a sentinel integer. */
  rank: number | null;
};

export type ScoreTallies = {
  rows: number;
  vetoed: number;
  ranked: number;
  unranked_no_signal: number;
  known: Record<string, number>;
  unknown: Record<string, number>;
  veto_by_reason: Record<string, number>;
  cohorts: { total: number; usable: number; min_cohort: number };
  /** Per-county administrative floors detected in the corpus, and how many rows
   *  sit on each. Published in the manifest — a rule this consequential must be
   *  legible in the output, not only in the code that applied it. */
  value_floors: Record<string, { value: number; rows_at_floor: number }>;
};

export type ScoreCorpusOptions = {
  cfg: ScoreConfig;
  enrichment: Enrichment;
  now: Date;
  parcelSourceOf: (row: WarehouseParcel) => SourceRef | null;
};

const toSignalRow = (p: WarehouseParcel): SignalRow & ValuedRow => ({
  record_id: p.record_id,
  fips: p.fips,
  county: p.county,
  parusedesc: p.parusedesc,
  acreage: p.acreage,
  acreage_basis: p.acreage_basis,
  acreage_unknown_reason: p.acreage_unknown_reason,
  value: p.value,
  value_unknown_reason: p.value_unknown_reason,
  value_basis: p.value_basis,
  value_basis_raw: p.value_basis_raw,
  assessment_year: p.assessment_year,
});

/** The per-county populations `discount` ranks inside (§5.2). Built only from
 *  rows that actually have a price — an unpriced row is not a 0% discount. */
export function buildDiscountCohorts(
  rows: readonly WarehouseParcel[],
  enrichment: Enrichment,
): { byFips: Map<string, Population> } {
  const collect = new Map<string, number[]>();
  for (const p of rows) {
    const ev = enrichment.forSale.get(p.record_id);
    if (!ev || ev.price === null || p.value === null || !(p.value > 0)) continue;
    const list = collect.get(p.fips);
    const raw = 1 - ev.price / p.value;
    if (list) list.push(raw);
    else collect.set(p.fips, [raw]);
  }
  const byFips = new Map<string, Population>();
  for (const [fips, values] of collect) byFips.set(fips, new Population(values));
  return { byFips };
}

export function scoreCorpus(
  rows: readonly WarehouseParcel[],
  opts: ScoreCorpusOptions,
): { scored: ScoredParcel[]; cohorts: CohortIndex; tallies: ScoreTallies } {
  const { cfg, enrichment, now } = opts;
  const signalRows = rows.map(toSignalRow);
  const floors = detectValueFloors(signalRows, cfg.per_acre.min_cohort);
  const cohorts = buildCohorts(signalRows, cfg, floors);
  const discountCohorts = buildDiscountCohorts(rows, enrichment);
  const patterns = useClassPatterns(cfg);

  const known: Record<string, number> = {};
  const unknown: Record<string, number> = {};
  const vetoByReason: Record<string, number> = {};
  const scored: ScoredParcel[] = [];

  for (const row of rows) {
    const sig = toSignalRow(row);
    const source = opts.parcelSourceOf(row);

    // Order is weights.yaml order and is stable — the published breakdown is a
    // table a human reads, and a table whose rows move between runs is unreadable.
    const components = withContributions([
      scoreDiscount(sig, enrichment.forSale.get(row.record_id), discountCohorts, cfg, now, source),
      scoreDistress(enrichment.distress.get(row.record_id), cfg, enrichment.present.distress),
      scorePerAcre(sig, cohorts, cfg, source),
      scoreWater(enrichment.water.get(row.record_id), cfg, enrichment.present.water),
      scoreLivability(enrichment.livability.get(row.record_id), cfg, enrichment.present.livability),
    ]);
    assertComponentsCoherent(components);

    for (const c of components) {
      if (c.status === 'scored') known[c.id] = (known[c.id] ?? 0) + 1;
      else unknown[c.id] = (unknown[c.id] ?? 0) + 1;
    }

    const result = rollUp(components);
    const gates = evaluateGates(row, cfg, patterns);
    const vetoed = isVetoed(gates);
    const reasons = vetoReasons(gates);
    for (const r of reasons) vetoByReason[r] = (vetoByReason[r] ?? 0) + 1;
    const scoredCount = components.filter((c) => c.status === 'scored').length;

    scored.push({
      row,
      components,
      total: result.total,
      confidence: result.confidence,
      gates,
      vetoed,
      veto_reasons: reasons,
      scored_count: scoredCount,
      unknown_count: components.length - scoredCount,
      rank: null,
    });
  }

  const rankable = scored
    .filter((s) => !s.vetoed && s.scored_count > 0)
    .sort((a, b) => b.total - a.total || a.row.record_id.localeCompare(b.row.record_id));
  rankable.forEach((s, i) => {
    s.rank = i + 1;
  });

  let usableCohorts = 0;
  for (const pop of cohorts.byKey.values()) if (pop.size >= cfg.per_acre.min_cohort) usableCohorts++;

  return {
    scored,
    cohorts,
    tallies: {
      rows: scored.length,
      vetoed: scored.filter((s) => s.vetoed).length,
      ranked: rankable.length,
      unranked_no_signal: scored.filter((s) => !s.vetoed && s.scored_count === 0).length,
      known,
      unknown,
      veto_by_reason: vetoByReason,
      cohorts: { total: cohorts.byKey.size, usable: usableCohorts, min_cohort: cfg.per_acre.min_cohort },
      value_floors: Object.fromEntries(
        [...cohorts.floors].map(([fips, f]) => [fips, { value: f.value, rows_at_floor: f.count }]),
      ),
    },
  };
}

/** The top N of the RANKING. Vetoed and unrankable rows cannot appear here by
 *  construction, because they never got a rank. */
export function topN(scored: readonly ScoredParcel[], n: number): RankedParcel[] {
  return scored
    .filter((s): s is RankedParcel => s.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, n);
}

/** A parcel that survived the vetoes AND scored at least one signal. The type
 *  is what stops an unrankable row from reaching the publish path at all. */
export type RankedParcel = ScoredParcel & { rank: number };
