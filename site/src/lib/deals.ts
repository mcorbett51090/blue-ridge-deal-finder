/**
 * THE derivation layer.
 *
 * Ported from SWC's src/lib/geo.ts (claims-D claim 29), which exists so the
 * server-rendered HTML list and the map's GeoJSON read from ONE place and can
 * never drift apart. Same job here, plus three things SWC did not need:
 *
 *   • lane partitioning (`for_sale_evidence != null`),
 *   • the coverage-tier join, so an uncovered county can be told apart from a
 *     covered-but-quiet one everywhere, keyed off `coverage.tier` and NEVER off
 *     a row count,
 *   • score re-derivation, so the number a card shows is provably the number the
 *     breakdown implies (the prebuild gate fails the build if they disagree).
 *
 * DATA SOURCE — read this before wiring the pipeline in:
 * Today this reads `src/data/fixtures/listings.json`. The pipeline is being
 * written in parallel and no real data exists yet. When it lands, swap ONE
 * import below for the published payload; nothing else in the site changes,
 * which is the entire point of having this file. At real scale (5k–25k rows)
 * plan §6.3 also swaps the map's inline JSON block for a fetch of
 * `public/data/deals-<contenthash>.json` — see the note in DealMap.astro.
 */
import rawListings from '../data/fixtures/listings.json';
import rawCoverage from '../data/coverage.json';
import rawStatus from '../../public/data/status.json';
import type {
  CoverageCounty,
  CoverageTier,
  Lane,
  Listing,
  ScoreBreakdown,
  StatusPayload,
} from './types';

/** TRUE while the site is served from fixtures. The shell renders a loud strip
 *  when this is set — a demo that looks like live data is the same lie as a dead
 *  pipeline serving stale data behind a healthy façade. */
export const IS_FIXTURE_DATA = true;

export const listings = rawListings as unknown as Listing[];
export const coverage = rawCoverage as unknown as CoverageCounty[];
export const status = rawStatus as unknown as StatusPayload;

// ---------------------------------------------------------------------------
// Scoring — the one function that turns a breakdown into a number.
// ---------------------------------------------------------------------------

/** Recompute the score from the breakdown. UNKNOWN signals (`value === null`)
 *  are excluded from the DENOMINATOR — they are never scored 0. That is the
 *  difference between "we don't know" and "it's bad", and conflating them is
 *  the single easiest way for this site to lie. */
export function deriveScore(bd: ScoreBreakdown): number {
  const scored = bd.signals.filter((s) => s.value !== null);
  const denom = scored.reduce((a, s) => a + s.weight, 0);
  if (denom === 0) return 0;
  const num = scored.reduce((a, s) => a + s.weight * (s.value as number), 0);
  return Math.round((num / denom) * 100);
}

/** A score built from very few signals is not a confident score, whatever its
 *  value. Cards and detail pages both surface this. */
export function isLowEvidence(bd: ScoreBreakdown): boolean {
  return bd.unknown_count >= 3;
}

export function laneOf(l: Listing): Lane {
  return l.for_sale_evidence === null ? 'prospect' : 'market';
}

export const LANE_LABEL: Record<Lane, string> = {
  market: 'On market / in distress',
  prospect: 'Prospecting — not known to be for sale',
};

export const LANE_BLURB: Record<Lane, string> = {
  market:
    'Each of these has a dated, linked piece of evidence that it is for sale or in distress.',
  prospect:
    'A parcel record says a property EXISTS. It does not say it is for sale, and nobody here has been asked whether they want to sell. Treat everything in this lane as research, not as a listing.',
};

export const TIER_LABEL: Record<CoverageTier, string> = {
  rich: 'Rich coverage',
  partial: 'Partial coverage',
  thin: 'Thin coverage',
  'notices-only': 'Notices only',
};

export const TIER_BLURB: Record<CoverageTier, string> = {
  rich: 'Parcel boundaries and assessed values are collected for this county.',
  partial: 'Parcel boundaries are collected, but assessed values are not published by this county.',
  thin: 'Only a partial or untested source exists here; most parcel attributes are unknown.',
  'notices-only':
    'No parcel data source exists for this county. Anything shown is a published notice, not a parcel record — and a quiet county here means we cannot see it, not that nothing is happening.',
};

// ---------------------------------------------------------------------------
// Coverage join — the honesty layer.
// ---------------------------------------------------------------------------

const coverageByFips = new Map(coverage.map((c) => [c.fips, c]));

export function countyOf(fips: string): CoverageCounty | undefined {
  return coverageByFips.get(fips);
}

/** Tier for a fips. An unknown fips is NOT quietly downgraded to a tier — the
 *  caller gets `undefined` and must say "not in the covered set", because
 *  guessing here is exactly the failure this whole layer exists to prevent. */
export function tierOf(fips: string): CoverageTier | undefined {
  return coverageByFips.get(fips)?.tier;
}

export interface CoverageSummary {
  rich: number;
  partial: number;
  thin: number;
  'notices-only': number;
  total: number;
}

/** Drives the persistent coverage strip. Counts come from coverage.json, so a
 *  county promoted from thin to rich updates the strip with zero UI edits. */
export function coverageSummary(): CoverageSummary {
  const s: CoverageSummary = { rich: 0, partial: 0, thin: 0, 'notices-only': 0, total: coverage.length };
  for (const c of coverage) s[c.tier] += 1;
  return s;
}

// ---------------------------------------------------------------------------
// Facets — everything the rail needs, derived once.
// ---------------------------------------------------------------------------

export interface CountyFacet extends CoverageCounty {
  /** Rows CURRENTLY published for this county. Never used to infer coverage. */
  rows: number;
  marketRows: number;
  prospectRows: number;
}

export function countyFacets(): CountyFacet[] {
  const counts = new Map<string, { rows: number; market: number; prospect: number }>();
  for (const l of listings) {
    const c = counts.get(l.fips) ?? { rows: 0, market: 0, prospect: 0 };
    c.rows += 1;
    if (laneOf(l) === 'market') c.market += 1;
    else c.prospect += 1;
    counts.set(l.fips, c);
  }
  // EVERY covered county appears, including the ones with zero rows. A county
  // that is missing from the list is indistinguishable from a county with
  // nothing in it, and those are not the same fact.
  return coverage
    .map((c) => {
      const n = counts.get(c.fips) ?? { rows: 0, market: 0, prospect: 0 };
      return { ...c, rows: n.rows, marketRows: n.market, prospectRows: n.prospect };
    })
    .sort((a, b) => a.state.localeCompare(b.state) || a.county.localeCompare(b.county));
}

export function states(): string[] {
  return [...new Set(coverage.map((c) => c.state))].sort();
}

export function parcelUses(): string[] {
  return [...new Set(listings.map((l) => l.parcel_use))].sort();
}

export function hasWater(l: Listing): boolean {
  return l.water.has_stream || l.water.has_river || l.water.has_pond;
}

/** Water is UNKNOWN, not absent, when no water layer was joined. Three false
 *  booleans plus a null distance is what "we never looked" looks like. */
export function waterIsUnknown(l: Listing): boolean {
  return !hasWater(l) && l.water.distance_m === null;
}

export function waterLabel(l: Listing): string {
  const parts: string[] = [];
  if (l.water.has_river) parts.push('River');
  if (l.water.has_stream) parts.push('Stream');
  if (l.water.has_pond) parts.push('Pond');
  if (parts.length) return parts.join(' + ');
  return waterIsUnknown(l) ? 'Water unknown' : 'No water';
}

/** In the 1% annual-chance floodplain? null = unknown, and unknown is NOT "no". */
export function inFloodplain(l: Listing): boolean | null {
  if (l.flood_zone === null) return null;
  return !/^(X|C|B)$/i.test(l.flood_zone);
}

export const sorted = [...listings].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

export function byLane(lane: Lane): Listing[] {
  return sorted.filter((l) => laneOf(l) === lane);
}

export function byId(id: string): Listing | undefined {
  return listings.find((l) => l.id === id);
}

export function byCounty(fips: string): Listing[] {
  return sorted.filter((l) => l.fips === fips);
}

// ---------------------------------------------------------------------------
// GeoJSON — the map's half of the one-source-of-truth pair.
// ---------------------------------------------------------------------------

export interface DealFeatureProps {
  id: string;
  county: string;
  state: string;
  fips: string;
  lane: Lane;
  tier: CoverageTier | 'uncovered';
  score: number;
  water: 0 | 1;
  waterUnknown: 0 | 1;
  acres: number | null;
  value: number | null;
  use: string;
  flood: 0 | 1;
  floodUnknown: 0 | 1;
  lowEvidence: 0 | 1;
  label: string;
}

export function featureCollection(rows: Listing[] = sorted) {
  return {
    type: 'FeatureCollection' as const,
    features: rows.map((l) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [l.lng, l.lat] as [number, number] },
      properties: {
        id: l.id,
        county: l.county,
        state: l.state,
        fips: l.fips,
        lane: laneOf(l),
        tier: tierOf(l.fips) ?? 'uncovered',
        score: l.score,
        water: hasWater(l) ? 1 : 0,
        waterUnknown: waterIsUnknown(l) ? 1 : 0,
        acres: l.acres,
        value: l.assessed_value,
        use: l.parcel_use,
        flood: inFloodplain(l) === true ? 1 : 0,
        floodUnknown: inFloodplain(l) === null ? 1 : 0,
        lowEvidence: isLowEvidence(l.score_breakdown) ? 1 : 0,
        label: `${l.county} Co, ${l.state}`,
      } satisfies DealFeatureProps,
    })),
  };
}

export function bounds(rows: Listing[] = sorted): [[number, number], [number, number]] {
  if (rows.length === 0) {
    // Never Math.min([]) → Infinity. Fall back to the Blue Ridge envelope.
    return [
      [-84.5, 34.6],
      [-78.3, 38.4],
    ];
  }
  const lngs = rows.map((r) => r.lng);
  const lats = rows.map((r) => r.lat);
  return [
    [Math.min(...lngs), Math.min(...lats)],
    [Math.max(...lngs), Math.max(...lats)],
  ];
}
