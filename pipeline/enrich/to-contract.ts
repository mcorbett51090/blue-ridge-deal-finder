/**
 * ADAPTER — enrichment output -> the shape scoring expects.
 *
 * ⛔ Why this file exists. `pipeline/enrich/` and `pipeline/score/` were built
 * in parallel against DIFFERENT contracts, each internally correct:
 *   enrich writes  data/enrich/enrichment-latest.json  { results: [ {record_id, water, flood, slope, road} ] }
 *   score reads    data/enrich/water.json              { "<record_id>": WaterFacts }
 *                  data/enrich/livability.json         { "<record_id>": LivabilityFacts }
 *
 * Neither side was wrong; the seam was never specified. Rather than rewrite
 * either, translate — the enrichment file stays the record of what was measured
 * (with its refusals and counters intact), and this produces the projection
 * scoring consumes.
 *
 * ⛔ Absence stays absence. A parcel not enriched is simply not in the output;
 * it is never emitted with zeros. Flood is currently UNKNOWN for every parcel
 * because FEMA's robots.txt carries `Disallow: /arcgis` — the exact path of the
 * NFHL service — and `Disallow: /*?*`, which blocks any query. That is a refusal
 * we honour, not a measurement of "no flood risk".
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;

export function buildContractFiles(root: string): { water: number; livability: number } {
  const src = join(root, 'data/enrich/enrichment-latest.json');
  if (!existsSync(src)) return { water: 0, livability: 0 };
  const doc = JSON.parse(readFileSync(src, 'utf8')) as Json;
  const rows = (doc['results'] as Json[] | undefined) ?? [];

  const water: Record<string, Json> = {};
  const livability: Record<string, Json> = {};

  for (const r of rows) {
    const id = String(r['record_id'] ?? '');
    if (id === '') continue;
    const at = String(r['enriched_at'] ?? new Date(0).toISOString());

    const w = r['water'] as Json | undefined;
    if (w && typeof w['has_stream'] === 'boolean') {
      water[id] = {
        frontage_m: (w['water_frontage_m'] as number | null) ?? null,
        min_dist_flowline_m: (w['min_dist_flowline_m'] as number | null) ?? null,
        min_dist_waterbody_m: (w['min_dist_waterbody_m'] as number | null) ?? null,
        waterbody_overlap_m2: (w['waterbody_overlap_m2'] as number | null) ?? null,
        has_stream: w['has_stream'] as boolean,
        has_river: w['has_river'] as boolean,
        has_pond: w['has_pond'] as boolean,
        named_waters: (w['named_waters'] as string[] | undefined) ?? [],
        frontage_by_regime_m: (w['frontage_by_regime_m'] as Json | null) ?? null,
        source: { url: String(w['source_url'] ?? ''), retrieved_at: at, kind: 'usgs-nhd' },
      };
    }

    const f = (r['flood'] as Json | undefined) ?? {};
    const sl = (r['slope'] as Json | undefined) ?? {};
    const rd = (r['road'] as Json | undefined) ?? {};
    const anyKnown =
      f['flood_zone'] != null || sl['mean_slope_pct'] != null || rd['distance_to_road_m'] != null;
    if (anyKnown) {
      livability[id] = {
        flood_zone: (f['flood_zone'] as string | null) ?? null,
        flood_coverage_fraction: (f['pct_parcel_in_floodplain'] as number | null) ?? null,
        slope_pct: (sl['mean_slope_pct'] as number | null) ?? null,
        road_distance_m: (rd['distance_to_road_m'] as number | null) ?? null,
        source: {
          url: String(sl['source_url'] ?? f['source_url'] ?? rd['source_url'] ?? ''),
          retrieved_at: at,
          kind: 'usgs-epqs+census-tiger',
        },
      };
    }
  }

  writeFileSync(join(root, 'data/enrich/water.json'), JSON.stringify(water, null, 1));
  writeFileSync(join(root, 'data/enrich/livability.json'), JSON.stringify(livability, null, 1));
  return { water: Object.keys(water).length, livability: Object.keys(livability).length };
}
