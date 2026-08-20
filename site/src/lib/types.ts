/**
 * The published-record contract, as the SITE consumes it.
 *
 * Mirrors the pipeline's parcel record (publish/allowlist.json is the fail-closed
 * boundary on the producing side). Two disciplines are load-bearing and are
 * enforced by `scripts/verify-data.mjs` as a PREBUILD gate that exits non-zero:
 *
 *  1. `null` means UNKNOWN, and unknown is not zero. `acres: null` renders
 *     "unknown", never "0 ac"; `assessed_value: null` renders "unknown", never
 *     "$0". An unknown signal is excluded from the score DENOMINATOR — it is
 *     never scored 0. (Ported discipline: SWC's "absent by default, populated
 *     only when independently verified" — claims-D claim 28, which its own reuse
 *     map calls the single most valuable pattern to bring over.)
 *
 *  2. NO OWNER NAMES. Owner PII is stripped upstream and must never reach this
 *     type, this repo, or a rendered page. The only owner-derived facts allowed
 *     are booleans and a tenure integer. `scripts/verify-no-pii.mjs` re-asserts
 *     this independently against the BUILT dist/, because a type cannot stop a
 *     JSON file from carrying a key the type never mentions.
 */

/** A parcel record says a property EXISTS. It does not say you can buy it.
 *  Lane 1 = there is evidence it is for sale or in distress.
 *  Lane 2 = prospecting only. The UI must never blur these. */
export type Lane = 'market' | 'prospect';

export type CoverageTier = 'rich' | 'partial' | 'thin' | 'notices-only';

/** One signal's contribution to the score. `value: null` means UNKNOWN —
 *  excluded from the denominator, NEVER scored 0. */
export interface ScoreSignal {
  key: string;
  label: string;
  /** Relative weight. Only weights of scored (non-null) signals enter the denominator. */
  weight: number;
  /** Normalised 0..1, or null for unknown. */
  value: number | null;
  /** Why it scored what it did / why it is unknown. Always shown to the reader. */
  note: string;
}

export interface ScoreBreakdown {
  signals: ScoreSignal[];
  /** Sum of weights actually used — i.e. the denominator, excluding unknowns. */
  denominator: number;
  /** How many signals were unknown and therefore excluded. */
  unknown_count: number;
}

export interface WaterSignal {
  has_stream: boolean;
  has_river: boolean;
  has_pond: boolean;
  /** Metres to the nearest mapped water feature, or null if unknown. */
  distance_m: number | null;
  /** NHD gnis_name of the intersecting features — "Baker Creek", not "a creek". */
  named_waters?: string[];
  frontage_m?: number | null;
  /** A dry ditch is not creek frontage: perennial vs intermittent vs ephemeral. */
  frontage_by_regime_m?: {
    perennial: number; intermittent: number; ephemeral: number; unspecified: number;
  } | null;
}

/** Evidence that the parcel is on market or in distress. Absent (null) => Lane 2.
 *  A source URL is REQUIRED at the type level once evidence is asserted — an
 *  unsourced "this is for sale" claim literally will not typecheck. */
export interface ForSaleEvidence {
  /** ⛔ `county_owned_reo` is snake_case here because that is what the INGEST
   *  emits and what this payload actually carries — the type describes the data,
   *  it does not wish for it. (The scoring contract spells the same mechanism
   *  `county-owned-reo`; they are different vocabularies for different
   *  consumers, and `to-contract.ts` is the one place that maps between them.)
   *
   *  It is its own member and must never be folded into `tax-foreclosure`: the
   *  county already OWNS these outright and sells them directly — no auction, no
   *  redemption window, no competing bids — where every other member describes a
   *  process unfolding toward a future sale. These 8 rows are the only
   *  properties on the site a reader can actually buy, so the distinction is the
   *  most load-bearing label here. */
  kind:
    | 'listing'
    | 'tax-foreclosure'
    | 'county_owned_reo'
    | 'sheriff-sale'
    | 'master-in-equity'
    | 'estate-notice'
    | 'auction';
  /** Human label rendered on the card. */
  label: string;
  /** The primary source, always linked. Owner requirement: every row links to its source. */
  source_url: string;
  /** ISO-8601. When the evidence was OBSERVED — not when we last ran. */
  observed_at: string;
  sale_date: string | null;
  opening_bid: number | null;
}

export interface Listing {
  id: string;
  fips: string;
  county: string;
  state: string;
  lat: number;
  lng: number;
  /** null = unknown. Never 0 as a stand-in. */
  acres: number | null;
  /** null = unknown. Never 0 as a stand-in. */
  assessed_value: number | null;
  /** Asking / opening price where one exists. null = unknown or not for sale. */
  price: number | null;
  /** 0..100, recomputed and cross-checked against score_breakdown by the gate.
   *  `null` when NOTHING was measurable — every signal unknown, denominator 0.
   *  This is REAL and common: all 150 East Tennessee rows and all 8 Lane-1
   *  rows are null today. Typing it `number` is what let `String(l.score)`
   *  emit the string "null" into data-score, where Number() turned it into
   *  NaN and every filter comparison silently went false. */
  score: number | null;
  score_breakdown: ScoreBreakdown;
  /** THE SELECTION AXIS, 0..100, cheaper = higher. `publish` ORDERS by this, and
   *  it is deliberately NOT part of `score`: a signal that picks the shortlist
   *  cannot also grade it, or every published row sits at that signal's maximum
   *  (measured 2026-08-19 — 500 rows tied at exactly 100).
   *
   *  ⛔ Do not render this NUMBER. The published set is the cheapest ~0.25% of
   *  the corpus, so every value lands in 99.7–100 and the differences are
   *  invisible to a reader. Render `cheapness_basis`, which carries the $/acre
   *  and the cohort range — the facts a person can actually act on.
   *  `null` = not measurable, which is not "expensive". */
  cheapness: number | null;
  /** Why cheapness is what it is, verbatim — present even when cheapness is null. */
  cheapness_basis: string;
  for_sale_evidence: ForSaleEvidence | null;
  /** `null` = NOT MEASURED (the parcel was never enriched). It NEVER means
   *  "no water" — publishing false for an unmeasured parcel would render "No
   *  water" over exactly the creek parcel this tool exists to find. */
  water: WaterSignal | null;
  /** FEMA zone string, or null if unknown. 'X' = outside the 1% annual chance floodplain. */
  flood_zone: string | null;
  parcel_use: string;
  /** The primary source for the PARCEL record itself. Always present, always linked. */
  source_url: string;
  first_seen: string;
  last_seen: string;

  // --- Optional, absent-by-default, source-required-when-asserted ------------
  // Every field below renders ONLY when present (the graceful-absence pattern,
  // claims-D claim 15). None of them may be inferred or defaulted.
  /** Confidence in the score, 0..1. Rendered beside the score, never instead of it. */
  confidence?: number;
  /** How acreage was obtained. Drives the "GIS-derived — confirm against deed/survey" badge. */
  acreage_basis?: 'gis' | 'deed' | 'assessor';
  /** Tax year the assessed value belongs to. Drives the vintage string. */
  assessment_year?: number;
  /** Next scheduled county reappraisal year, when the county publishes one. */
  reappraisal_year?: number;
  /** Owner-derived BOOLEANS only. No names, ever. */
  owner_out_of_state?: boolean;
  owner_is_entity?: boolean;
  /** Years since the last recorded transfer. An integer, not a date, not a name. */
  tenure_years?: number;
  /** Short human note. Never an unsourced claim about a specific property. */
  note?: string;
}

export interface CoverageCounty {
  fips: string;
  state: string;
  county: string;
  region: string;
  tier: CoverageTier;
  /** The parcel source id, or null where none exists yet. */
  parcel_source: string | null;
  /** Why the tier is what it is — rendered verbatim on /status/ and the county page. */
  note: string;
}

export interface SourceStatus {
  source_id: string;
  label: string;
  /** ISO-8601 of the last SUCCESSFUL fetch, or null if it has never succeeded. */
  last_success: string | null;
  /** ISO-8601 of the last attempt, successful or not. */
  last_attempt: string | null;
  rows: number | null;
  state: 'ok' | 'degraded' | 'failed' | 'never-run';
  note: string;
}

export interface StatusPayload {
  /** max(observed_at) across published Lane-1 rows. THE freshness number.
   *  Deliberately NOT last_run_at: "we fetched recently" is not "the data
   *  changed recently" — a source serving a frozen snapshot for six months
   *  reports perfectly fresh under the other measure. */
  data_observed_at: string | null;
  /** When the pipeline last ran. Shown beside, never instead of, the above. */
  last_run_at: string | null;
  /** ISO-8601 of the build that produced this dist/. */
  built_at: string;
  lane1_rows: number;
  lane2_rows: number;
  sources: SourceStatus[];
}
