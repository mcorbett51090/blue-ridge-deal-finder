/**
 * Scored parcel -> the record the SITE consumes (site/src/lib/types.ts).
 *
 * ⛔ THE SCORE IS DERIVED WITH THE SITE'S OWN ARITHMETIC, NOT COPIED BESIDE IT.
 * site/scripts/verify-data.mjs check 6 recomputes the score from the published
 * breakdown and FAILS THE BUILD if the two disagree. `deriveScore` below is the
 * site's formula, reduce-order and rounding included, applied to the same array
 * that ships — so the published number cannot be an artefact of some other
 * order of operations upstream. Publishing `Math.round(rollUp.total)` instead
 * would be a second implementation of the same sum, which is a coin-flip on the
 * last ULP and a red build nobody can reproduce.
 *
 * ⛔ UNKNOWN SIGNALS SHIP THEIR NOMINAL WEIGHT, NOT 0.
 * A `value: null` signal is excluded from the denominator by the consumer, so
 * its weight never enters the average — but the site's gate refuses a signal
 * that is unknown AND weight 0, because that pair is indistinguishable from an
 * unknown scored as zero. The weight published on an unknown is the weight it
 * WOULD have carried, which is also the number that makes `confidence` legible.
 */
import type { ScoredParcel } from '../pipeline/score/corpus.ts';
import type { ScoreComponent } from '../pipeline/score/schema.ts';
import type { Provenance } from './provenance.ts';

export type PublishedSignal = {
  key: string;
  label: string;
  weight: number;
  /** 0..1, or null for UNKNOWN. Never 0 as a stand-in for unknown. */
  value: number | null;
  note: string;
  /** Points of the final score this signal is responsible for. Sums to `score`. */
  contribution: number;
  unknown_reason: string | null;
};

export type PublishedListing = {
  id: string;
  fips: string;
  county: string;
  state: string;
  lat: number | null;
  lng: number | null;
  geometry_unknown_reason: string | null;
  acres: number | null;
  assessed_value: number | null;
  price: number | null;
  /** `null` when ZERO signals were measurable. Not 0 — a 0 sits at the bottom
   *  of a sort with the same authority as a measured bad deal, and this project
   *  has fixed that same confusion in value, acreage, water and flood already.
   *  A 6,208-acre Unicoi County parcel scoring 0 because Tennessee publishes no
   *  assessed value is the clearest case of it. */
  score: number | null;
  score_breakdown: { signals: PublishedSignal[]; denominator: number; unknown_count: number };
  confidence: number;
  /** THE SELECTION AXIS, 0..100, cheaper = higher — published as its own number
   *  rather than folded into `score`.
   *
   *  ⛔ This separation is load-bearing, not cosmetic. `publish` chooses which
   *  parcels ship by ranking on cheapness; if cheapness were also IN the score,
   *  every published row would sit at the top of the axis it was selected by and
   *  the score would be pinned at its maximum. Measured 2026-08-19: it was —
   *  500 published rows tied at exactly 100. Swapping the transform does not fix
   *  it (rank, log min–max and log median/IQR all saturate in their own top
   *  slice); separating the two jobs does.
   *
   *  `null` = not measurable (thin cohort, unknown value or acreage, or an
   *  administrative value floor). It is NOT "expensive", and it must never sort
   *  as if it were. */
  cheapness: number | null;
  /** Why cheapness is what it is, rendered verbatim — including when it is null. */
  cheapness_basis: string;
  /** Non-null moves the row into LANE 1. Null is Lane 2 (prospecting). This is
   *  the single field that separates "a property exists" from "you can buy it". */
  for_sale_evidence: {
    kind: string;
    label: string;
    price_usd: number | null;
    observed_at: string;
    since: string | null;
    record_url: string | null;
    generic_url: string | null;
    generic_label: string | null;
    how_to_verify: string;
  } | null;
  /** `null` means NOT MEASURED. It never means "no water" — see publish/run.ts. */
  water: {
    has_stream: boolean; has_river: boolean; has_pond: boolean; distance_m: number | null;
    named_waters?: string[]; frontage_m?: number | null;
    frontage_by_regime_m?: { perennial: number; intermittent: number; ephemeral: number; unspecified: number } | null;
  } | null;
  flood_zone: string | null;
  parcel_use: string;
  /** SITUS address — the property's own location. Never the owner's mailing
   *  address, which is destroyed at the redaction boundary. `null` (never '')
   *  on the 26% of parcels the county publishes no address for. */
  site_address: string | null;
  site_address_unknown_reason: string | null;
  lane: 'market' | 'prospect';
  source_url: string | null;
  provenance: Provenance;
  first_seen: string;
  last_seen: string;
  acreage_basis: string;
  assessment_year: number | null;
  reappraisal_year: number | null;
  owner_out_of_state: boolean | null;
  owner_is_entity: boolean | null;
  tenure_years: number | null;
  /** `null` for a row that is VISIBLE but not RANKED — the East Tennessee
   *  slice, ordered by acreage because no scoreable signal exists there. A
   *  number here is a position in the ranking; null means "shown, not ranked",
   *  and the two must never be conflated. */
  rank: number | null;
};

const LABELS: Record<string, string> = {
  discount: 'Discount to assessed value',
  distress: 'Distress signals',
  per_acre: 'Assessed price per acre',
  water: 'Water',
  livability: 'Livability',
};

/** The site's formula, verbatim (site/src/lib/deals.ts + verify-data.mjs #6). */
export function deriveScore(signals: readonly PublishedSignal[]): number | null {
  const scored = signals.filter((s) => s.value !== null);
  const denom = scored.reduce((a, s) => a + s.weight, 0);
  // ⛔ null, NOT 0. Zero measurable signals means "we could not score this",
  // and a 0 sorts among real scores reading as "measured, and terrible".
  // Measured case: every East Tennessee parcel, because the state publishes no
  // assessed value — a 6,208-acre Unicoi tract came out at 0.
  if (denom === 0) return null;
  const num = scored.reduce((a, s) => a + s.weight * (s.value as number), 0);
  return Math.round((num / denom) * 100);
}

export function denominatorOf(signals: readonly PublishedSignal[]): number {
  return signals.filter((s) => s.value !== null).reduce((a, s) => a + s.weight, 0);
}

function toSignal(c: ScoreComponent): PublishedSignal {
  const scored = c.status === 'scored';
  return {
    key: c.id,
    label: LABELS[c.id] ?? c.id,
    // Effective weight when it was actually weighed; nominal when it was not,
    // so the reader can see what the absence cost.
    weight: scored ? c.effective_weight : c.nominal_weight,
    value: scored ? (c.normalized as number) / 100 : null,
    note: c.basis,
    contribution: c.contribution,
    unknown_reason: scored ? null : c.basis,
  };
}

export type ToListingContext = {
  /** From data/distress/evidence.json, keyed by record_id. */
  forSaleEvidence?: PublishedListing['for_sale_evidence'];
  provenance: Provenance;
  reappraisalYear: number | null;
  /** `null` means NOT MEASURED. It never means "no water" — see publish/run.ts. */
  water: {
    has_stream: boolean; has_river: boolean; has_pond: boolean; distance_m: number | null;
    named_waters?: string[]; frontage_m?: number | null;
    frontage_by_regime_m?: { perennial: number; intermittent: number; ephemeral: number; unspecified: number } | null;
  } | null;
  floodZone: string | null;
};

export function toListing(s: ScoredParcel & { rank: number | null }, ctx: ToListingContext): PublishedListing {
  const signals = s.components.map(toSignal);
  const score = deriveScore(signals);
  const p = s.row;
  return {
    id: p.record_id,
    fips: p.fips,
    county: p.county,
    state: p.state,
    // ⛔ null, not 0,0. The ingested corpus carries NO geometry at all
    // (measured: lat IS NULL on 100% of rows), and 0,0 is the Gulf of Guinea.
    lat: p.lat,
    lng: p.lng,
    geometry_unknown_reason:
      p.lat === null || p.lng === null
        ? 'The parcel ingest fetched attributes only — no polygon or centroid has been stored for this row yet, so it cannot be mapped.'
        : null,
    acres: p.acreage,
    assessed_value: p.value,
    price: null,
    score,
    // 4dp, not the raw float. The ordering needs the precision (428 distinct
    // values across 500 rows survive at 4dp); 14 significant digits of IEEE
    // noise in a published payload is not a measurement, it is an artefact.
    // ⛔ The NUMBER is deliberately not what the card shows. The published set
    // IS the cheapest ~0.25% of the corpus, so every percentile lands in
    // 99.7–100 and 'cheaper than 99.997%' reads identically to 'cheaper than
    // 99.72%'. The reader gets $/acre and the cohort range, from
    // `cheapness_basis`; this field exists to ORDER the set, not to be read.
    cheapness: s.cheapness === null ? null : Math.round(s.cheapness * 1e4) / 1e4,
    cheapness_basis: s.cheapness_basis,
    score_breakdown: {
      signals,
      denominator: denominatorOf(signals),
      unknown_count: signals.filter((x) => x.value === null).length,
    },
    confidence: s.confidence,
    for_sale_evidence: ctx.forSaleEvidence ?? null,
    water: ctx.water,
    flood_zone: ctx.floodZone,
    parcel_use: p.parusedesc.trim() === '' ? 'Unclassified — county publishes no use code' : p.parusedesc.trim(),
    // SITUS address: the property's own location — the asset being sold. This is
    // NOT the owner's mailing address (`mailadd`), which is where a named person
    // lives and is destroyed at the redaction boundary. Publishing the address of
    // a parcel without publishing who owns it is what every listing does.
    // Absent on 26% of the corpus, 52% of VACANT parcels, and 100% of Avery
    // County — so `null` is a normal answer here, never an empty string.
    site_address: p.siteadd !== null && p.siteadd.trim() !== '' ? p.siteadd.trim() : null,
    site_address_unknown_reason:
      p.siteadd === null || p.siteadd.trim() === ''
        ? 'The county publishes no situs address for this parcel. Common on vacant land, which often has no assigned address at all.'
        : null,
    lane: 'prospect',
    source_url: ctx.provenance.record_url,
    provenance: ctx.provenance,
    first_seen: p.first_seen,
    last_seen: p.last_seen,
    acreage_basis: p.acreage_basis,
    assessment_year: p.assessment_year,
    reappraisal_year: ctx.reappraisalYear,
    owner_out_of_state: p.owner_out_of_state === null ? null : p.owner_out_of_state === 1,
    owner_is_entity: p.owner_is_entity === null ? null : p.owner_is_entity === 1,
    tenure_years: p.tenure_years,
    rank: s.rank,
  };
}

/**
 * The arithmetic gate, run on the producing side as well as the consuming one.
 * The site fails its build on a mismatch; discovering that in the site build is
 * discovering it two systems away from the cause.
 */
export function assertScoreDerivable(listing: PublishedListing): void {
  const derived = deriveScore(listing.score_breakdown.signals);
  if (derived !== listing.score) {
    throw new Error(`listing ${listing.id}: score ${listing.score} but breakdown derives ${derived}`);
  }
  const denom = denominatorOf(listing.score_breakdown.signals);
  if (denom !== listing.score_breakdown.denominator) {
    throw new Error(`listing ${listing.id}: denominator ${listing.score_breakdown.denominator} != ${denom}`);
  }
  const unknowns = listing.score_breakdown.signals.filter((s) => s.value === null).length;
  if (unknowns !== listing.score_breakdown.unknown_count) {
    throw new Error(`listing ${listing.id}: unknown_count ${listing.score_breakdown.unknown_count} != ${unknowns}`);
  }
  for (const s of listing.score_breakdown.signals) {
    if (s.value === null && s.weight === 0) {
      throw new Error(`listing ${listing.id}: signal ${s.key} is unknown AND weight 0 — that is an unknown scored as zero`);
    }
    if (s.note.trim() === '') throw new Error(`listing ${listing.id}: signal ${s.key} has no note`);
  }
}
