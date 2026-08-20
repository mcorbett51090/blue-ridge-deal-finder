/**
 * The five signals (plan §5.2-§5.6). Pure functions: a row in, a
 * `ScoreComponent` out. No I/O, no `Date.now()`, no randomness — `now` is an
 * argument so a vintage-sensitive score is reproducible in a test.
 *
 * ⛔ EVERY FUNCTION HERE RETURNS A COMPONENT, INCLUDING WHEN IT CANNOT SCORE.
 * There is no path that returns `null` or throws for missing data, because a
 * caller that has to remember to synthesise the unknown component is a caller
 * that will one day forget and produce a listing whose breakdown is missing a
 * row — which the site would render as a confident score built on four signals
 * when it was really built on one.
 */
import type { ScoreConfig } from './config.ts';
import type { ComponentId, ScoreComponent } from './schema.ts';
import type { CohortIndex, ValuedRow } from './cohorts.ts';
import { cohortKey, isAtValueFloor, useBucket } from './cohorts.ts';
import { clamp, invert } from './index.ts';
import type {
  DistressObservation,
  ForSaleEvidence,
  LivabilityFacts,
  SourceRef,
  WaterFacts,
} from './enrich-contract.ts';

export type SignalRow = ValuedRow & {
  county: string;
  assessment_year: number | null;
  value_basis: string;
  value_basis_raw: string;
  value_unknown_reason: string | null;
  acreage_unknown_reason: string | null;
};

function unknownComponent(
  id: ComponentId,
  nominal: number,
  basis: string,
  sources: SourceRef[] = [],
): ScoreComponent {
  return {
    id,
    nominal_weight: nominal,
    // ⛔ An unknown contributes NO effective weight — that is what "excluded
    // from the denominator" means arithmetically. It is not weight 0 on a
    // score of 0; the component simply is not in the average.
    effective_weight: 0,
    status: 'unknown',
    raw: null,
    normalized: null,
    contribution: 0,
    basis,
    sources,
  };
}

function scoredComponent(
  id: ComponentId,
  nominal: number,
  effective: number,
  raw: number,
  normalized: number,
  basis: string,
  sources: SourceRef[] = [],
): ScoreComponent {
  return {
    id,
    nominal_weight: nominal,
    effective_weight: effective,
    status: 'scored',
    raw,
    normalized: clamp(normalized, 0, 100),
    contribution: 0, // set by withContributions() once the denominator is known
    basis,
    sources,
  };
}

const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;

// ---------------------------------------------------------------------------
// per_acre — §5.4. The only signal computable from the ingested corpus alone.
// ---------------------------------------------------------------------------

export function scorePerAcre(
  row: SignalRow,
  cohorts: CohortIndex,
  cfg: ScoreConfig,
  parcelSource: SourceRef | null,
): ScoreComponent {
  // ⛔ 100, not a weight from `components`. `per_acre` is no longer IN the
  // composite — it is the declared SELECTION axis, published as `cheapness`.
  // A signal cannot both choose the shortlist and grade it; see weights.yaml.
  const nominal = 100;
  const sources = parcelSource ? [parcelSource] : [];

  if (row.value === null || !(row.value > 0)) {
    return unknownComponent(
      'per_acre',
      nominal,
      row.value_unknown_reason === null
        ? `${row.county} County publishes no assessed value for this parcel.`
        : `Assessed value unknown (${row.value_unknown_reason}) — a zero is a sentinel here, not a cheap parcel.`,
      sources,
    );
  }
  if (row.acreage === null || !(row.acreage > 0)) {
    return unknownComponent(
      'per_acre',
      nominal,
      `Acreage unknown (${row.acreage_unknown_reason ?? 'not published'}) — $/acre is not computed against a zero.`,
      sources,
    );
  }
  // ⛔ The administrative floor. See detectValueFloors() for the measurement.
  const floor = cohorts.floors.get(row.fips);
  if (floor !== undefined && isAtValueFloor(row, cohorts.floors)) {
    return unknownComponent(
      'per_acre',
      nominal,
      `Assessed value is exactly ${money(floor.value)}, which is the lowest value ${row.county} County ` +
        `publishes and is shared by ${floor.count} parcels there — an administrative floor, not a ` +
        'valuation of this parcel. Treated as unknown rather than as the cheapest land in the county.',
      sources,
    );
  }

  const key = cohortKey(row, cfg);
  const population = key === null ? undefined : cohorts.byKey.get(key);
  const bucket = useBucket(row.parusedesc);
  const band = key === null ? '' : (key.split('|')[2] ?? '');

  if (!population || population.size < cfg.per_acre.min_cohort) {
    return unknownComponent(
      'per_acre',
      nominal,
      `Only ${population?.size ?? 0} comparable parcels in ${row.county} County for use class ` +
        `'${bucket}' at ${band} acres — fewer than the ${cfg.per_acre.min_cohort} needed for a percentile ` +
        'that means anything.',
      sources,
    );
  }

  const perAcre = row.value / row.acreage;
  const pct = population.percentileOf(perAcre);
  if (pct === null) {
    return unknownComponent('per_acre', nominal, 'Empty comparison cohort.', sources);
  }
  // Cheaper is better: a low $/acre must map to a HIGH component score.
  const normalized = invert(pct);
  return scoredComponent(
    'per_acre',
    nominal,
    nominal,
    perAcre,
    normalized,
    `Assessed ${money(perAcre)}/acre — cheaper than ${normalized.toFixed(0)}% of the ${population.size} ` +
      `comparable ${bucket.toLowerCase()} parcels of ${band} acres in ${row.county} County. ` +
      'Ranked inside its own county, never against a national threshold.',
    sources,
  );
}

// ---------------------------------------------------------------------------
// discount — §5.2. Vintage-safe by cohort, decayed in CONFIDENCE only.
// ---------------------------------------------------------------------------

export type DiscountCohorts = {
  /** fips -> the population of `1 - price/parval` ratios priced in that county */
  byFips: Map<string, { percentileOf(x: number): number | null; size: number }>;
};

/** The thin-cohort fallback (§5.2). A raw discount of 0.5 means "half the
 *  assessed value"; the band is deliberately coarse because an absolute
 *  comparison is a worse instrument and should not pretend otherwise. */
export function absoluteDiscountBand(raw: number): number {
  if (raw <= 0) return 0;
  return clamp(raw * 100, 0, 100);
}

export function vintageYears(assessmentYear: number | null, now: Date): number | null {
  if (assessmentYear === null) return null;
  return now.getUTCFullYear() - assessmentYear;
}

export function scoreDiscount(
  row: SignalRow,
  evidence: ForSaleEvidence | undefined,
  cohorts: DiscountCohorts,
  cfg: ScoreConfig,
  now: Date,
  parcelSource: SourceRef | null,
): ScoreComponent {
  const nominal = cfg.components.discount;
  const sources: SourceRef[] = [];
  if (parcelSource) sources.push(parcelSource);
  if (evidence) {
    sources.push({ url: evidence.source_url, retrieved_at: evidence.observed_at, kind: evidence.kind });
  }

  const price = evidence?.price ?? null;
  if (price === null) {
    return unknownComponent(
      'discount',
      nominal,
      'No listing or bid price exists for this parcel. A parcel record carries an ASSESSED VALUE and ' +
        'never an asking price — only the for-sale-evidence lane can supply one, so this signal is ' +
        'unknown for every prospecting row by construction, not by omission.',
      sources,
    );
  }
  if (row.value === null || !(row.value > 0)) {
    return unknownComponent('discount', nominal, 'No assessed value to compare the price against.', sources);
  }
  if (row.value_basis !== 'market_equivalent') {
    return unknownComponent(
      'discount',
      nominal,
      `Assessed value is published on the '${row.value_basis_raw}' basis, which is not comparable to a market price.`,
      sources,
    );
  }
  if (row.assessment_year === null) {
    return unknownComponent('discount', nominal, 'County is not in the NCDOR reappraisal schedule.', sources);
  }
  const age = vintageYears(row.assessment_year, now);
  if (age === null || age < 0 || age > cfg.discount.max_vintage_years) {
    // G.S. 105-286 caps the cycle at 8 years, so this is a bad join, not old data.
    return unknownComponent(
      'discount',
      nominal,
      `Assessment vintage ${age ?? 'unknown'} years is outside the statutory 0-${cfg.discount.max_vintage_years} ` +
        'year range — that is a bad join, not old data.',
      sources,
    );
  }

  const raw = 1 - price / row.value;
  const cohort = cohorts.byFips.get(row.fips);
  let normalized: number;
  let cohortPenalty: number;
  let how: string;

  if (cohort && cohort.size >= cfg.discount.min_cohort) {
    const pct = cohort.percentileOf(raw);
    normalized = pct ?? 0;
    cohortPenalty = 1;
    how =
      `a bigger discount than ${normalized.toFixed(0)}% of the ${cohort.size} priced parcels in ` +
      `${row.county} County. Ranked inside the county, because assessed values are frozen county-wide ` +
      'between reappraisals and a cross-county comparison would measure assessment age, not value.';
  } else {
    normalized = absoluteDiscountBand(raw);
    cohortPenalty = cfg.discount.thin_cohort_penalty;
    how =
      `only ${cohort?.size ?? 0} priced parcels in ${row.county} County to rank against, so this is an ` +
      `absolute band rather than a percentile — weighted at ${cohortPenalty * 100}% for that reason.`;
  }

  // ⛔ VINTAGE DECAYS THE WEIGHT, NEVER THE SCORE. A five-year-old denominator
  // is a LESS TRUSTWORTHY MEASUREMENT, not a WORSE DEAL, and decaying the score
  // would corrupt the sort order while the card claimed to be honest about it.
  const vintageConfidence = clamp(1 - cfg.discount.vintage_decay_per_year * age, 0, 1);
  const effective = nominal * vintageConfidence * cohortPenalty;

  return scoredComponent(
    'discount',
    nominal,
    effective,
    raw,
    normalized,
    `${money(price)} against an assessed ${money(row.value)} (${(raw * 100).toFixed(0)}% below assessment) — ${how} ` +
      `Assessed ${row.assessment_year} (${age}y old), which is why this signal carries ` +
      `${effective.toFixed(1)} of its ${nominal} nominal weight.`,
    sources,
  );
}

// ---------------------------------------------------------------------------
// water — §5.5. GEOMETRY ONLY.
// ---------------------------------------------------------------------------

export function scoreWater(
  facts: WaterFacts | undefined,
  cfg: ScoreConfig,
  enrichmentRan: boolean,
): ScoreComponent {
  const nominal = cfg.components.water;
  if (!facts) {
    return unknownComponent(
      'water',
      nominal,
      enrichmentRan
        ? 'This parcel is outside the enriched candidate set — no water layer has been joined to it yet.'
        : 'No NHD water layer has been joined yet (pipeline/enrich is not in this run). Unknown, not "no water".',
    );
  }
  const sources = [facts.source];
  const frontage = facts.frontage_m;
  const dists = [facts.min_dist_flowline_m, facts.min_dist_waterbody_m].filter(
    (d): d is number => d !== null,
  );

  if (frontage !== null && frontage > 0) {
    return scoredComponent(
      'water',
      nominal,
      nominal,
      frontage,
      cfg.water.frontage_score,
      // ⛔ THE METRE FIGURE IS SUPPRESSED, not deleted, until the Phase 4 dedupe lands.
      // `fetchCellBbox` merges quarter-splits with no dedupe by permanent_identifier
      // (11 of 60 cached cells carry duplicates), and computeWater does
      // `frontage += metres`, so this number is inflated by up to 4x — worst in the
      // densest hydrography, i.e. exactly the parcels a buyer would care about most.
      // The score cannot see it (scoreWater normalises frontage>0 to a constant), so
      // no gate and no test catches it. Printing a number we know is wrong on the
      // site's one differentiating claim is the same defect class as a source link
      // that looks like verification and is not. The BOOLEAN fact — water crosses the
      // polygon — is unaffected by the duplication and is still true, so it stays.
      'A mapped stream or river runs THROUGH the parcel polygon (USGS NHD). ' +
        'Measured against the boundary geometry, not read off a listing adjective. ' +
        'Frontage length is withheld pending a correction to the cell-merge dedupe.',
      sources,
    );
  }
  if (dists.length === 0) {
    return unknownComponent(
      'water',
      nominal,
      'Water layer joined but no distance was computable for this parcel.',
      sources,
    );
  }
  const nearest = Math.min(...dists);
  const normalized =
    nearest < cfg.water.near_m
      ? cfg.water.near_score
      : nearest < cfg.water.mid_m
        ? cfg.water.mid_score
        : 0;
  return scoredComponent(
    'water',
    nominal,
    nominal,
    nearest,
    normalized,
    `No mapped water crosses the parcel; the nearest NHD feature is ${nearest.toFixed(0)} m away.`,
    sources,
  );
}

// ---------------------------------------------------------------------------
// livability — §5.6. Flood + slope + road access, each optional.
// ---------------------------------------------------------------------------

const FLOOD_OUT_RE = /^(X|B|C)/i;

export function scoreLivability(
  facts: LivabilityFacts | undefined,
  cfg: ScoreConfig,
  enrichmentRan: boolean,
): ScoreComponent {
  const nominal = cfg.components.livability;
  if (!facts) {
    return unknownComponent(
      'livability',
      nominal,
      enrichmentRan
        ? 'This parcel is outside the enriched candidate set — flood, slope and road access are not joined to it yet.'
        : 'FEMA flood zone, slope and road access have not been joined yet (pipeline/enrich is not in this run).',
    );
  }
  const parts: { label: string; value: number }[] = [];
  if (facts.flood_zone !== null) {
    const outside = FLOOD_OUT_RE.test(facts.flood_zone);
    parts.push({ label: `FEMA zone ${facts.flood_zone}`, value: outside ? 100 : 0 });
  }
  if (facts.slope_pct !== null) {
    // 0% is flat and buildable; 30%+ is a cliff. Linear in between.
    parts.push({ label: `${facts.slope_pct.toFixed(0)}% slope`, value: clamp(100 - (facts.slope_pct / 30) * 100, 0, 100) });
  }
  if (facts.road_distance_m !== null) {
    parts.push({
      label: `${facts.road_distance_m.toFixed(0)} m to a mapped road`,
      value: clamp(100 - (facts.road_distance_m / 1000) * 100, 0, 100),
    });
  }
  if (parts.length === 0) {
    return unknownComponent(
      'livability',
      nominal,
      'Flood, slope and road-access layers all returned unknown for this parcel.',
      [facts.source],
    );
  }
  const normalized = parts.reduce((a, p) => a + p.value, 0) / parts.length;
  return scoredComponent(
    'livability',
    nominal,
    nominal,
    normalized,
    normalized,
    `${parts.map((p) => p.label).join(' · ')} — averaged over the ${parts.length} of 3 layers that returned a value.`,
    [facts.source],
  );
}

// ---------------------------------------------------------------------------
// distress — §5.3. Additive, clamped, EVERY increment cited.
// ---------------------------------------------------------------------------

export function scoreDistress(
  observations: readonly DistressObservation[] | undefined,
  cfg: ScoreConfig,
  noticesRan: boolean,
): ScoreComponent {
  const nominal = cfg.components.distress;
  if (!observations || observations.length === 0) {
    return unknownComponent(
      'distress',
      nominal,
      noticesRan
        ? 'No tax-sale, foreclosure or delinquency notice mentions this parcel in the observed window.'
        : 'No notice source has been ingested yet (the evidence lane is P4). Unknown, not "not distressed".',
    );
  }
  // Deduplicate by kind: two newspapers printing the same foreclosure is one
  // fact about the parcel, not two.
  const kinds = new Map<string, DistressObservation>();
  for (const o of observations) if (!kinds.has(o.kind)) kinds.set(o.kind, o);

  let total = 0;
  const parts: string[] = [];
  for (const [kind, obs] of kinds) {
    const inc = cfg.distress.increments[kind as keyof typeof cfg.distress.increments];
    total += inc;
    parts.push(`${kind.replace(/_/g, ' ')} (+${inc}, observed ${obs.observed_at.slice(0, 10)})`);
  }
  const normalized = clamp(total, 0, 100);
  return scoredComponent(
    'distress',
    nominal,
    nominal,
    total,
    normalized,
    `${parts.join(' · ')}. Every increment comes from a dated, linked public notice; nothing here is inferred.`,
    [...kinds.values()].map((o) => ({ url: o.source_url, retrieved_at: o.observed_at, kind: o.kind })),
  );
}

/**
 * Acceptance 1 of P3: no component may report `status: 'scored'` with
 * `raw: null`. Asserted centrally rather than trusted per call site, because
 * the failure is silent — the site renders a scored row with a blank number.
 */
export function assertComponentsCoherent(components: readonly ScoreComponent[]): void {
  for (const c of components) {
    if (c.status === 'scored' && (c.raw === null || c.normalized === null)) {
      throw new Error(`component '${c.id}' reports status 'scored' with raw=${c.raw} normalized=${c.normalized}`);
    }
    if (c.status === 'unknown' && (c.raw !== null || c.normalized !== null || c.effective_weight !== 0)) {
      throw new Error(
        `component '${c.id}' reports status 'unknown' but carries raw=${c.raw} normalized=${c.normalized} ` +
          `effective_weight=${c.effective_weight} — an unknown must leave the denominator entirely`,
      );
    }
  }
}
