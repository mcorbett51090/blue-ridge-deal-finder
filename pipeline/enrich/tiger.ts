/**
 * ROAD ACCESS — Census TIGERweb (plan §5.6).
 *
 * ⛔ WE CANNOT OBTAIN THIS HOST'S robots.txt, SO WE DO NOT QUERY IT.
 * Measured 2026-08-19: GET https://tigerweb.geo.census.gov/robots.txt returns
 * HTTP **200** with `<html><head><title>Request Rejected</title>…Your support
 * ID is: 13427891559852892367` — an F5 WAF answering for the origin. Reproduced
 * 5/5 with the honest UA and 1/1 with curl's default UA, and the support ID
 * changes every time, so the body has no stable digest either.
 *
 * Three things would have gone wrong had that body been treated as robots.txt:
 *   1. robots-parser finds zero directives in HTML and returns ALLOWED — a WAF
 *      refusal read as a grant of permission;
 *   2. the rotating ID moves the source to ingest_paused on every single run;
 *   3. the status is 200, so nothing status-shaped notices.
 * guard.ts looksLikeRobotsTxt() now refuses a non-empty body carrying no
 * recognisable directive, which closes (1) for every host and not just this one.
 *
 * Plan §5.6 pre-authorised exactly this outcome: "if it fails, road access
 * renders `unknown` permanently". So it does — `tiger_robots_unobtainable` on
 * every parcel. The derivation below is pure and fixture-tested so that the
 * day the Census WAF stops eating /robots.txt, turning this lane on is a
 * registry edit. ⛔ NOTHING CALLS IT OVER THE NETWORK TODAY.
 */
import { z } from 'zod';
import { roadUnknown, type RoadSignal } from './schema.ts';
import { pathsToMultiLineString, polygonToLineDistanceM, type AnyPolygon, type MultiLineStringGeom } from './geometry.ts';

/** MTFCC road classes, coarsest first. S1100 primary … S1500 4WD track. */
export const ROAD_CLASS_LABELS: Record<string, string> = {
  S1100: 'primary',
  S1200: 'secondary',
  S1400: 'local',
  S1500: 'vehicular-trail-4wd',
  S1630: 'ramp',
  S1640: 'service-drive',
  S1740: 'private-service',
};

/**
 * ⛔ A LANDLOCKED PARCEL IS A VETO, NOT A DEDUCTION (plan §5.6). Mountain land
 * with no legal access is the classic trap in these counties and it is not a
 * "minor" anything — it cannot be built on, financed or insured. 400 m is the
 * threshold: beyond it there is no plausible driveway from a public road, and
 * the parcel needs an easement nobody has verified.
 */
export const LANDLOCKED_THRESHOLD_M = 400;

export const TigerFeatureSchema = z.object({
  attributes: z.record(z.string(), z.unknown()),
  geometry: z.unknown().optional(),
});
export const TigerQueryResponseSchema = z.object({ features: z.array(TigerFeatureSchema) });

export type TigerRoad = { mtfcc: string; name: string | null; geometry: MultiLineStringGeom };

export function parseRoads(body: unknown): TigerRoad[] {
  const parsed = TigerQueryResponseSchema.parse(body);
  const out: TigerRoad[] = [];
  for (const f of parsed.features) {
    const geom = f.geometry as { paths?: number[][][] } | undefined;
    if (!geom || !Array.isArray(geom.paths)) continue;
    const mls = pathsToMultiLineString(geom.paths);
    if (!mls) continue;
    let mtfcc: string | null = null;
    let name: string | null = null;
    for (const k of Object.keys(f.attributes)) {
      const v = f.attributes[k];
      if (k.toLowerCase() === 'mtfcc' && typeof v === 'string') mtfcc = v;
      if (k.toLowerCase() === 'name' && typeof v === 'string' && v.trim() !== '') name = v;
    }
    if (mtfcc === null) continue;
    out.push({ mtfcc, name, geometry: mls });
  }
  return out;
}

export type RoadInputs = {
  parcel: AnyPolygon;
  roads: readonly TigerRoad[];
  /** True when the road query itself succeeded. Zero roads from a FAILED query
   *  is not a landlocked parcel; it is an unknown. */
  queryHealthy: boolean;
  searchRadiusM: number;
  sourceUrl: string | null;
};

export function computeRoad(inputs: RoadInputs): RoadSignal {
  if (!inputs.queryHealthy) return roadUnknown('tiger_unhealthy_response');
  if (inputs.roads.length === 0) {
    // ⛔ Zero roads within the search radius from a HEALTHY query is a real
    // measurement — but only if the radius is at least the landlocked
    // threshold, otherwise "none within 100 m" is being read as "none at all".
    if (inputs.searchRadiusM < LANDLOCKED_THRESHOLD_M) return roadUnknown('tiger_no_coverage');
    return {
      distance_to_road_m: null,
      road_class: null,
      landlocked: true,
      road_unknown_reason: null,
      source_url: inputs.sourceUrl,
    };
  }

  let best = Number.POSITIVE_INFINITY;
  let bestClass: string | null = null;
  for (const r of inputs.roads) {
    const d = polygonToLineDistanceM(inputs.parcel, r.geometry);
    if (d < best) {
      best = d;
      bestClass = ROAD_CLASS_LABELS[r.mtfcc] ?? r.mtfcc;
    }
  }
  return {
    distance_to_road_m: Math.round(best * 10) / 10,
    road_class: bestClass,
    landlocked: best > LANDLOCKED_THRESHOLD_M,
    road_unknown_reason: null,
    source_url: inputs.sourceUrl,
  };
}
