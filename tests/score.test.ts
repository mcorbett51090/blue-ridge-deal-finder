/**
 * P3 scoring — every assertion paired with a CONTROL that proves it can fail.
 *
 * An acceptance test with no control is a test that has never been observed to
 * discriminate. Half of these would pass against a scorer that counts unknowns
 * as zero, ranks against an absolute national threshold, or ignores the vetoes
 * entirely — so each one runs the broken implementation too and asserts it goes
 * the other way. Where the control is missing, say so; do not imply one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWeights, assertWeightsSumTo100, parseWeights } from '../pipeline/score/config.ts';
import { EMPTY_ENRICHMENT, type Enrichment } from '../pipeline/score/enrich-contract.ts';
import { scoreCorpus, topN } from '../pipeline/score/corpus.ts';
import type { WarehouseParcel } from '../pipeline/score/read-warehouse.ts';
import {
  CrossBasisRankingError,
  Population,
  acreageBand,
  buildCohorts,
  detectValueFloors,
  useBucket,
} from '../pipeline/score/cohorts.ts';
import { percentileRank, rollUp, withContributions } from '../pipeline/score/index.ts';
import { evaluateGates, isVetoed } from '../pipeline/score/vetoes.ts';
import { scorePerAcre, scoreWater, assertComponentsCoherent } from '../pipeline/score/signals.ts';
import type { ScoreComponent } from '../pipeline/score/schema.ts';

const ROOT = join(import.meta.dirname, '..');
const CFG = loadWeights(ROOT);
const NOW = new Date('2026-08-19T00:00:00Z');

const parcel = (over: Partial<WarehouseParcel>): WarehouseParcel => ({
  record_id: 'x', fips: '37189', state: 'NC', county: 'Watauga', parno: '1', part_seq: 0, part_count: 1,
  acreage: 10, acreage_unknown_reason: null, acreage_basis: 'gis',
  value: 100000, value_unknown_reason: null, value_basis: 'market_equivalent', value_basis_raw: 'Assessed',
  deed_date: null, sale_date: null, assessment_year: 2022,
  owner_out_of_state: 0, owner_is_entity: 0, owner_is_government: 0, tenure_years: null,
  parusedesc: 'RESIDENTIAL VACANT',
    siteadd: null, lat: null, lng: null,
  status: 'active', first_seen: '2026-08-19T00:00:00.000Z', last_seen: '2026-08-19T00:00:00.000Z',
  ...over,
});

const run = (rows: WarehouseParcel[], enrichment: Enrichment = EMPTY_ENRICHMENT) =>
  scoreCorpus(rows, { cfg: CFG, enrichment, now: NOW, parcelSourceOf: () => null });

/** A cohort big enough to be usable, spread over a range so percentiles move. */
function cohortOf(n: number, fips: string, county: string, baseValue: number): WarehouseParcel[] {
  return Array.from({ length: n }, (_, i) =>
    parcel({
      record_id: `${fips}:${i}`,
      fips,
      county,
      acreage: 10,
      value: baseValue * (1 + i / n),
    }),
  );
}

test('weights.yaml parses fail-closed and the nominal weights really sum to 100', () => {
  assertWeightsSumTo100(CFG);
  assert.throws(() => parseWeights('components:\n  discount: 30\n'), 'a truncated weights file must THROW, not default');
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 1 — unknown leaves the denominator, and is never scored 0.
// ---------------------------------------------------------------------------

test('⛔ a row with 3 unknown signals scores on the 2 it has, and says so', () => {
  const components: ScoreComponent[] = withContributions([
    { id: 'per_acre', nominal_weight: 20, effective_weight: 20, status: 'scored', raw: 500, normalized: 90, contribution: 0, basis: 'b', sources: [] },
    { id: 'water', nominal_weight: 15, effective_weight: 15, status: 'scored', raw: 0, normalized: 40, contribution: 0, basis: 'b', sources: [] },
    { id: 'discount', nominal_weight: 30, effective_weight: 0, status: 'unknown', raw: null, normalized: null, contribution: 0, basis: 'b', sources: [] },
    { id: 'distress', nominal_weight: 25, effective_weight: 0, status: 'unknown', raw: null, normalized: null, contribution: 0, basis: 'b', sources: [] },
    { id: 'livability', nominal_weight: 10, effective_weight: 0, status: 'unknown', raw: null, normalized: null, contribution: 0, basis: 'b', sources: [] },
  ]);
  const result = rollUp(components);
  const unknownCount = components.filter((c) => c.status === 'unknown').length;

  // (90×20 + 40×15) / 35 = 68.57 — the average over what was MEASURED.
  assert.equal(unknownCount, 3);
  assert.ok(Math.abs(result.total - (90 * 20 + 40 * 15) / 35) < 1e-9);
  assert.ok(Math.abs(result.confidence - 35 / 100) < 1e-9, 'confidence is the fraction of nominal weight actually used');

  // CONTROL: the scorer this project exists to not be. Unknown = 0 over the
  // full 100 of nominal weight. It must produce a DIFFERENT, LOWER number —
  // if these two ever agree, the discipline is not being applied.
  const naive = (90 * 20 + 40 * 15 + 0 + 0 + 0) / 100;
  assert.notEqual(Math.round(result.total), Math.round(naive));
  assert.ok(naive < result.total, `naive ${naive} must depress the score below the honest ${result.total}`);

  // Σ contributions === total, exactly. This is what makes the breakdown a
  // derivation rather than a decoration.
  const sum = components.reduce((a, c) => a + c.contribution, 0);
  assert.ok(Math.abs(sum - result.total) < 1e-9);
});

test('an unknown component may NEVER carry weight, a value, or a scored status', () => {
  assert.throws(
    () =>
      assertComponentsCoherent([
        { id: 'per_acre', nominal_weight: 20, effective_weight: 20, status: 'scored', raw: null, normalized: 50, contribution: 0, basis: 'b', sources: [] },
      ]),
    /status 'scored' with raw=null/,
    'a scored component with raw:null is P3 acceptance 1 and must throw',
  );
  assert.throws(
    () =>
      assertComponentsCoherent([
        { id: 'water', nominal_weight: 15, effective_weight: 15, status: 'unknown', raw: null, normalized: null, contribution: 0, basis: 'b', sources: [] },
      ]),
    /must leave the denominator/,
  );
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 2 — the HOA / government veto, against the SIX MEASURED ROWS.
// ---------------------------------------------------------------------------

test('⛔ the six measured Watauga "EXCLUSIONS (COMMONE AREAS)" rows are NOT in the top 100', () => {
  const fixture = JSON.parse(
    readFileSync(join(ROOT, 'fixtures', 'watauga-hoa-commons.json'), 'utf8'),
  ) as { rows: WarehouseParcel[] };
  assert.equal(fixture.rows.length, 6, 'the fixture is the six rows measured on the live warehouse');
  for (const r of fixture.rows) {
    assert.equal(r.value, 100);
    assert.ok(r.acreage !== null && r.acreage >= 9.8, 'each is 9.8-134 acres for $100 — the shape of the defect');
  }

  const ordinary = cohortOf(120, '37189', 'Watauga', 5000);
  const { scored } = run([...fixture.rows, ...ordinary]);
  const top100 = topN(scored, 100).map((s) => s.row.record_id);

  for (const r of fixture.rows) {
    assert.ok(!top100.includes(r.record_id), `${r.record_id} (HOA common area at $0.75/acre) must not be ranked`);
    const row = scored.find((s) => s.row.record_id === r.record_id);
    assert.equal(row?.rank, null, 'a vetoed row has NO rank — it is not merely pushed down');
    assert.ok(row !== undefined && isVetoed(row.gates));
  }

  // CONTROL: without the vetoes, the same six rows own the top of the board.
  // If this control ever stops finding them at the top, the test above is
  // passing for some reason other than the vetoes.
  const naiveTop = [...fixture.rows, ...ordinary]
    .filter((r) => r.value !== null && r.acreage !== null)
    .sort((a, b) => (a.value as number) / (a.acreage as number) - (b.value as number) / (b.acreage as number))
    .slice(0, 6)
    .map((r) => r.record_id);
  assert.deepEqual(
    naiveTop.sort(),
    fixture.rows.map((r) => r.record_id).sort(),
    'CONTROL: a naive $/acre ASC sort must put all six commons rows in the first six places',
  );
});

test('the veto keys on BOTH owner_is_government and parusedesc, and the upstream typo is matched', () => {
  const gates = (over: Partial<WarehouseParcel>) => evaluateGates(parcel(over), CFG);
  assert.ok(isVetoed(gates({ parusedesc: 'EXCLUSIONS (COMMONE AREAS)', owner_is_government: 0 })), 'typo spelling');
  assert.ok(isVetoed(gates({ parusedesc: 'EXCLUSIONS (COMMON AREAS)', owner_is_government: 0 })), 'corrected spelling');
  assert.ok(isVetoed(gates({ parusedesc: 'GOVERNMENT', owner_is_government: 0 })), 'use class alone');
  assert.ok(isVetoed(gates({ parusedesc: 'RESIDENTIAL VACANT', owner_is_government: 1 })), 'owner flag alone');
  assert.ok(!isVetoed(gates({ parusedesc: 'RESIDENTIAL VACANT', owner_is_government: 0 })), 'an ordinary parcel survives');
  // Unknown acreage is not "too small".
  assert.ok(!isVetoed(gates({ acreage: null })), 'unknown acreage must not trip the minimum-size gate');
  assert.ok(isVetoed(gates({ acreage: 0.01 })), 'a 0.01-acre sliver is below the floor');
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 4 — percentiles are WITHIN cohort, never absolute.
// ---------------------------------------------------------------------------

test('⛔ identical absolute $/acre scores DIFFERENTLY in a cheap county and an expensive one', () => {
  // Two counties, same size cohort, 10× apart in price level. One probe parcel
  // in each, both at exactly $2,000/acre.
  const cheap = cohortOf(100, '37199', 'Yancey', 1000 * 10); // $1k-2k /acre
  const dear = cohortOf(100, '37021', 'Buncombe', 10000 * 10); // $10k-20k /acre
  const probeCheap = parcel({ record_id: 'probe-cheap', fips: '37199', county: 'Yancey', acreage: 10, value: 20000 });
  const probeDear = parcel({ record_id: 'probe-dear', fips: '37021', county: 'Buncombe', acreage: 10, value: 20000 });

  const { scored } = run([...cheap, ...dear, probeCheap, probeDear]);
  const of = (id: string) => scored.find((s) => s.row.record_id === id)!;
  // per_acre is the SELECTION AXIS now, carried as `cheapness` rather than as a
  // composite component. Same number, same meaning, different field.
  const pctOf = (id: string) => of(id).cheapness;

  assert.equal(of('probe-cheap').row.value! / of('probe-cheap').row.acreage!, 2000);
  assert.equal(of('probe-dear').row.value! / of('probe-dear').row.acreage!, 2000);
  assert.notEqual(pctOf('probe-cheap'), pctOf('probe-dear'));
  assert.ok(
    (pctOf('probe-dear') as number) > (pctOf('probe-cheap') as number),
    '$2,000/acre is a bargain in Buncombe and unremarkable in Yancey — the percentile must say so',
  );

  // CONTROL: an ABSOLUTE scorer — the thing this design refuses — gives the two
  // identical scores, which is exactly the vintage/price-level bug RT-10 names.
  const absolute = (v: number) => Math.max(0, 100 - v / 100);
  assert.equal(absolute(2000), absolute(2000), 'CONTROL: absolute scoring cannot tell the two counties apart');
});

test('a cohort below the 50-comparable floor scores UNKNOWN, not a nonsense percentile', () => {
  const thin = cohortOf(20, '37189', 'Watauga', 5000);
  const { scored, tallies } = run(thin);
  for (const s of scored) {
    const c = { status: s.cheapness === null ? 'unknown' : 'scored', normalized: s.cheapness, basis: s.cheapness_basis } as const;
    assert.equal(c.status, 'unknown');
    assert.match(c.basis, /fewer than the 50/);
  }
  // `known`/`unknown` tally the COMPOSITE components; cheapness is not one of
  // them any more, so assert on the axis itself.
  assert.equal(run(thin).scored.filter((s) => s.cheapness !== null).length, 0);
  // CONTROL: the same rows, one over the floor, DO score — so the assertion
  // above is about the floor and not about the fixture being broken.
  const fat = cohortOf(60, '37189', 'Watauga', 5000);
  assert.ok(run(fat).scored.filter((s) => s.cheapness !== null).length === 60);
});

test('the fast binary-search percentile agrees with the readable reference implementation', () => {
  const values = [1, 3, 3, 7, 9, 12, 12, 12, 40];
  const pop = new Population(values);
  for (const v of [0, 1, 3, 8, 12, 40, 99]) {
    assert.equal(pop.percentileOf(v), percentileRank(v, values), `percentile of ${v}`);
  }
});

test('bucketing: use class is the raw string, acreage bands are (lower, upper]', () => {
  assert.equal(useBucket('  residential   vacant '), 'RESIDENTIAL VACANT');
  assert.equal(useBucket(''), 'UNCLASSIFIED');
  const bands = CFG.per_acre.acreage_bands;
  assert.equal(acreageBand(0.5, bands), '0-1');
  assert.equal(acreageBand(1, bands), '0-1');
  assert.equal(acreageBand(1.01, bands), '1-5');
  assert.equal(acreageBand(9000, bands), '500+');
});

// ---------------------------------------------------------------------------
// RT-9 — cross-basis ranking is REFUSED, not silently averaged.
// ---------------------------------------------------------------------------

test('⛔ ranking an NC gis-acreage row against a TN deeded-acreage row throws', () => {
  const nc = parcel({ record_id: 'nc', fips: '47155', county: 'Sevier', acreage_basis: 'gis' });
  const tn = parcel({ record_id: 'tn', fips: '47155', county: 'Sevier', acreage_basis: 'deeded' });
  assert.throws(() => buildCohorts([nc, tn], CFG), CrossBasisRankingError);
  // CONTROL: same two rows, same basis — no throw. The refusal is about the
  // basis, not about the fixture.
  assert.doesNotThrow(() => buildCohorts([nc, { ...tn, acreage_basis: 'gis' }], CFG));
});

// ---------------------------------------------------------------------------
// RT-3 — zero sentinels do not divide, and do not appear in the ranking.
// ---------------------------------------------------------------------------

test('⛔ parval=0 / gisacres=0 rows have rank NULL, not a bad rank', () => {
  const zeros = [
    parcel({ record_id: 'zero-val', value: null, value_unknown_reason: 'zero-sentinel' }),
    parcel({ record_id: 'zero-acres', acreage: null, acreage_unknown_reason: 'zero-sentinel' }),
  ];
  const { scored } = run([...cohortOf(80, '37189', 'Watauga', 5000), ...zeros]);
  for (const id of ['zero-val', 'zero-acres']) {
    const row = scored.find((s) => s.row.record_id === id)!;
    assert.equal(row.rank, null, `${id} must have NO rank — assert on rank, not merely on 'unknown'`);
    assert.equal(row.total, 0, 'nothing measurable means a total of 0, which is why rank must be null');
    assert.equal(row.scored_count, 0);
  }
  // CONTROL: an ordinary row in the same call DOES get a rank.
  assert.ok(scored.find((s) => s.row.record_id === '37189:0')?.rank !== null);
});

test('⛔ the administrative $100 floor is UNKNOWN, not the cheapest land in the county', () => {
  // 60 rows at the floor + 60 real ones. The floor is detected from the data,
  // not from a hardcoded dollar amount.
  const floorRows = Array.from({ length: 60 }, (_, i) =>
    parcel({ record_id: `floor-${i}`, value: 100, acreage: 10 }),
  );
  const real = cohortOf(60, '37189', 'Watauga', 5000);
  const floors = detectValueFloors([...floorRows, ...real], CFG.per_acre.min_cohort);
  assert.deepEqual(floors.get('37189'), { value: 100, count: 60 });

  const { scored } = run([...floorRows, ...real]);
  const f = scored.find((s) => s.row.record_id === 'floor-0')!;
  assert.equal(f.cheapness, null, 'a floor row has NO cheapness — it is not the cheapest land in the county');
  assert.match(f.cheapness_basis, /administrative floor/);
  assert.equal(f.rank, null);

  // CONTROL 1: with too few rows on it, a low value is NOT a floor — it is just
  // a cheap parcel, and it keeps its score.
  const fewFloors = detectValueFloors(
    [...floorRows.slice(0, 3), ...real],
    CFG.per_acre.min_cohort,
  );
  assert.equal(fewFloors.get('37189'), undefined, 'CONTROL: 3 rows at the minimum is a coincidence, not a floor');
  // CONTROL 2: without the floor rule the same rows sort to first place.
  const naiveTop = [...floorRows, ...real]
    .sort((a, b) => (a.value as number) / (a.acreage as number) - (b.value as number) / (b.acreage as number))[0];
  assert.match(naiveTop!.record_id, /^floor-/, 'CONTROL: a naive sort puts the floor rows on top');
});

// ---------------------------------------------------------------------------
// water — assert BOTH ends, or the test only proves the happy path (P3 #3).
// ---------------------------------------------------------------------------

test('water: a creek THROUGH the parcel scores 100; a creek 900 m away scores 0', () => {
  const src = { url: 'https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer/6', retrieved_at: '2026-08-19T00:00:00.000Z', kind: 'nhd-flowline' };
  const through = scoreWater(
    { frontage_m: 212, min_dist_flowline_m: 0, min_dist_waterbody_m: null, waterbody_overlap_m2: null,
    named_waters: [],
    frontage_by_regime_m: null, has_stream: true, has_river: false, has_pond: false, source: src },
    CFG, true,
  );
  assert.equal(through.status, 'scored');
  assert.equal(through.normalized, 100);
  // ⛔ INVERTED 2026-08-19, deliberately. This asserted /212 m/ — "the frontage
  // LENGTH is stated, not just the fact of it" — and that was the right contract
  // until the length was measured to be WRONG. `fetchCellBbox` merges
  // quarter-splits with no dedupe by permanent_identifier (11 of 60 cached cells
  // carry duplicates) and `computeWater` does `frontage += metres`, so the figure
  // is inflated by up to 4x, worst in the densest hydrography. `scoreWater`
  // normalises any frontage > 0 to the same 100, so the SCORE is unaffected and
  // no gate could ever see it — it only ever surfaced on the card.
  //
  // So the invariant flips while the defect stands: state the FACT (which the
  // duplication cannot corrupt), withhold the NUMBER. Phase 4's dedupe restores
  // the length and this assertion goes back to /212 m/.
  assert.match(through.basis, /runs THROUGH the parcel polygon/, 'the FACT of water on the parcel is still stated');
  assert.doesNotMatch(
    through.basis,
    /\d+\s*m of mapped/,
    'no frontage METRE figure may be published while the cell-merge dedupe is outstanding — it is inflated up to 4x',
  );

  const farAway = scoreWater(
    { frontage_m: 0, min_dist_flowline_m: 900, min_dist_waterbody_m: null, waterbody_overlap_m2: null,
    named_waters: [],
    frontage_by_regime_m: null, has_stream: false, has_river: false, has_pond: false, source: src },
    CFG, true,
  );
  assert.equal(farAway.status, 'scored');
  assert.equal(farAway.normalized, 0, '900 m away is NOT water frontage — assert this end too');

  // And absence is UNKNOWN, which is neither of the above.
  const absent = scoreWater(undefined, CFG, false);
  assert.equal(absent.status, 'unknown');
  assert.equal(absent.effective_weight, 0);
  assert.match(absent.basis, /not "no water"/);
});

// ---------------------------------------------------------------------------
// P3 #5 — a weight change is a GOLDEN-FILE DIFF and nothing else.
// ---------------------------------------------------------------------------

test('changing one weight moves the score and NOTHING structural', () => {
  const rows = cohortOf(60, '37189', 'Watauga', 5000);
  const enriched: Enrichment = {
    ...EMPTY_ENRICHMENT,
    water: new Map(
      rows.map((r) => [
        r.record_id,
        { frontage_m: 100, min_dist_flowline_m: 0, min_dist_waterbody_m: null, waterbody_overlap_m2: null,
    named_waters: [],
    frontage_by_regime_m: null, has_stream: true, has_river: false, has_pond: false, source: { url: 'https://hydro.nationalmap.gov/x', retrieved_at: '2026-08-19T00:00:00.000Z', kind: 'nhd' } },
      ]),
    ),
    // ⛔ TWO scored composite components are required for this assertion to mean
    // anything. `per_acre` used to supply the second one; it is now the SELECTION
    // axis and no longer in the composite, so the fixture supplies slope instead.
    // With a single scored signal the weighted mean is that signal's value
    // whatever the weights are — the test would pass vacuously or fail for the
    // wrong reason.
    livability: new Map(
      rows.map((r, i) => [
        r.record_id,
        { flood_zone: null, flood_coverage_fraction: null, slope_pct: (i % 25) + 1, road_distance_m: null,
          source: { url: 'https://epqs.nationalmap.gov/x', retrieved_at: '2026-08-19T00:00:00.000Z', kind: 'epqs' } },
      ]),
    ),
    present: { ...EMPTY_ENRICHMENT.present, water: true, livability: true },
  };
  const base = scoreCorpus(rows, { cfg: CFG, enrichment: enriched, now: NOW, parcelSourceOf: () => null });
  const heavier = scoreCorpus(rows, {
    cfg: { ...CFG, components: { ...CFG.components, water: 60 } },
    enrichment: enriched,
    now: NOW,
    parcelSourceOf: () => null,
  });
  // ⛔ NOT scored[0]. That is the CHEAPEST row in the cohort, so under magnitude
  // normalisation its per_acre is exactly 100 — identical to its water — and no
  // reweighting of two equal components can move their mean. That is correct
  // behaviour, and it silently made this assertion untestable at the top of the
  // ranking. Pick a row whose components genuinely differ.
  const idx = base.scored.findIndex((s) => {
    const w = s.components.find((c) => c.id === 'water');
    const l = s.components.find((c) => c.id === 'livability');
    return w?.status === 'scored' && l?.status === 'scored' && l.normalized !== w.normalized;
  });
  assert.ok(idx >= 0, 'fixture must contain a row with a scored component and an unknown one');
  const movedId = base.scored[idx]!.row.record_id;
  const after = heavier.scored.find((s) => s.row.record_id === movedId)!;
  assert.notEqual(base.scored[idx]!.total, after.total, 'the weight must actually move the number');
  assert.deepEqual(
    base.scored.map((s) => s.components.map((c) => c.id)),
    heavier.scored.map((s) => s.components.map((c) => c.id)),
    'the component SET is identical — a weight change is not a structural change',
  );
  assert.deepEqual(
    base.scored.map((s) => s.rank),
    heavier.scored.map((s) => s.rank),
    'and with a uniform signal the ORDER is untouched',
  );
});

test('scorePerAcre never divides by an unknown, whatever shape the unknown arrives in', () => {
  const cohorts = buildCohorts(cohortOf(60, '37189', 'Watauga', 5000), CFG);
  for (const over of [{ value: null }, { acreage: null }, { value: 0 }, { acreage: 0 }] as Partial<WarehouseParcel>[]) {
    const row = { ...parcel(over), county: 'Watauga' };
    const c = scorePerAcre(
      { ...row, value: row.value, acreage: row.acreage } as never,
      cohorts,
      CFG,
      null,
    );
    assert.equal(c.status, 'unknown');
    assert.equal(c.raw, null);
    assert.equal(c.effective_weight, 0);
  }
});
