/**
 * FLOOD — FEMA NFHL (plan §5.6, C30, E6.6).
 *
 * ⛔ READ THIS BEFORE WIRING ANYTHING IN THIS FILE TO A SOCKET.
 * hazards.fema.gov/robots.txt DISALLOWS US. Measured 2026-08-19, HTTP 200,
 * 806 bytes, a real robots.txt whose first two directives under `User-agent: *`
 * are `Disallow: /*?*` and `Disallow: /arcgis`. Our target path starts /arcgis
 * and every ArcGIS query carries a query string, so it is disallowed twice.
 * The record and the evidence digest live in sources/sources.enrich.yaml under
 * refused[]; nothing loads FEMA into a Registry, so client.ts cannot reach it
 * even by id.
 *
 * P0 recorded NFHL as "live and keyless" and marked the enrichment gate PASS.
 * That was true. Live is not the same question as permitted, and only the first
 * one had been asked.
 *
 * SO WHY DOES THIS FILE EXIST? Because the derivation is the part that is easy
 * to get wrong, and getting it right offline means the day FEMA's robots.txt
 * changes the lane is a registry edit rather than a rewrite. Everything below
 * is PURE and fixture-tested. ⛔ NOTHING CALLS IT OVER THE NETWORK TODAY — the
 * orchestrator emits `flood_unknown_reason: 'nfhl_robots_disallow'` for every
 * parcel, and that is the honest state of the flood signal.
 *
 * ⛔ AND THE DERIVATION'S OWN TRAP, WHICH OUTLIVES THE ROBOTS QUESTION:
 * LAYER 0 IS "NFHL AVAILABILITY", NOT FLOOD ZONES. Large parts of rural
 * Appalachia are simply not mapped. A zone query over an unmapped parcel
 * returns ZERO FEATURES — the identical response to a mapped parcel that sits
 * outside every flood polygon. One means "FEMA has not looked"; the other means
 * "FEMA looked and it is dry". Reading the first as the second puts a
 * reassuring "not in a floodplain" on land nobody has assessed, which is the
 * single most expensive wrong answer this tool could give.
 *
 * Availability is therefore checked FIRST and its absence short-circuits: no
 * zone query is even issued, because there is no answer it could give.
 */
import { z } from 'zod';
import { floodUnknown, type FloodSignal } from './schema.ts';
import {
  overlapAreaM2,
  ringsToMultiPolygon,
  type AnyPolygon,
} from './geometry.ts';
import * as turf from '@turf/turf';

export const NFHL_AVAILABILITY_LAYER = 0;
export const NFHL_FLOOD_HAZARD_ZONE_LAYER = 28;

/**
 * Special Flood Hazard Area zones — the 1%-annual-chance floodplain, the ones
 * that carry a federal insurance mandate. X, X500, D and AREA NOT INCLUDED are
 * NOT SFHA, and `D` in particular means "undetermined", which is its own kind
 * of unknown and must never be reported as safe.
 */
export const SFHA_ZONES = new Set([
  'A', 'AE', 'AH', 'AO', 'AR', 'A99', 'V', 'VE', 'A1-A30', 'V1-V30',
]);

export function isSfhaZone(zone: string): boolean {
  return SFHA_ZONES.has(zone.trim().toUpperCase());
}

/** ⛔ Zone D is "undetermined risk", not "no risk". It is neither SFHA nor safe. */
export function isUndeterminedZone(zone: string): boolean {
  return zone.trim().toUpperCase() === 'D';
}

export const NfhlFeatureSchema = z.object({
  attributes: z.record(z.string(), z.unknown()),
  geometry: z.unknown().optional(),
});
export const NfhlQueryResponseSchema = z.object({
  features: z.array(NfhlFeatureSchema),
  exceededTransferLimit: z.boolean().optional(),
});

export type NfhlCoverage = 'present' | 'absent' | 'unknown';

/**
 * Coverage from a layer-0 query response.
 *
 * ⛔ `unknown` AND `absent` ARE DIFFERENT AND BOTH ARE NON-EMPTY OUTCOMES.
 * A response we could not read is `unknown`; a response we read that contained
 * no availability polygon is `absent`. Only a response containing one is
 * `present`. The function refuses to guess: a body that is not a well-formed
 * query response returns `unknown`, never `absent`.
 */
export function coverageFrom(body: unknown): NfhlCoverage {
  if (body === null || typeof body !== 'object') return 'unknown';
  if ('error' in (body as Record<string, unknown>)) return 'unknown';
  const parsed = NfhlQueryResponseSchema.safeParse(body);
  if (!parsed.success) return 'unknown';
  return parsed.data.features.length > 0 ? 'present' : 'absent';
}

export type FloodZonePolygon = { zone: string; geometry: AnyPolygon };

export function parseFloodZones(body: unknown): FloodZonePolygon[] {
  const parsed = NfhlQueryResponseSchema.parse(body);
  const out: FloodZonePolygon[] = [];
  for (const f of parsed.features) {
    const geom = f.geometry as { rings?: number[][][] } | undefined;
    if (!geom || !Array.isArray(geom.rings)) continue;
    const mp = ringsToMultiPolygon(geom.rings);
    if (!mp) continue;
    // Case-insensitive read for the same reason as NHD: FLD_ZONE / fld_zone.
    let zone: string | null = null;
    for (const k of Object.keys(f.attributes)) {
      if (k.toLowerCase() === 'fld_zone') {
        const v = f.attributes[k];
        if (typeof v === 'string') zone = v;
      }
    }
    if (zone === null) continue;
    out.push({ zone, geometry: mp });
  }
  return out;
}

export type FloodInputs = {
  parcel: AnyPolygon;
  coverage: NfhlCoverage;
  zones: readonly FloodZonePolygon[];
  sourceUrl: string | null;
};

/**
 * THE DERIVATION. Pure. The first branch is the one the whole file is about.
 */
export function computeFlood(inputs: FloodInputs): FloodSignal {
  if (inputs.coverage === 'unknown') {
    return floodUnknown('nfhl_unhealthy_response', 'unknown');
  }
  if (inputs.coverage === 'absent') {
    // ⛔ NOT `in_sfha: false`. FEMA has not mapped this parcel. The schema's
    // superRefine enforces this at the parse boundary too, so a future edit
    // that returns a boolean here fails the fixture AND the schema.
    return floodUnknown('nfhl_no_coverage', 'absent');
  }

  const parcelArea = turf.area(turf.feature(inputs.parcel));
  let sfhaArea = 0;
  let dominantZone: string | null = null;
  let dominantArea = 0;

  for (const z of inputs.zones) {
    const overlap = overlapAreaM2(inputs.parcel, z.geometry);
    if (overlap <= 0) continue;
    if (isSfhaZone(z.zone)) sfhaArea += overlap;
    if (overlap > dominantArea) {
      dominantArea = overlap;
      dominantZone = z.zone;
    }
  }

  const pct = parcelArea > 0 ? Math.min(100, (sfhaArea / parcelArea) * 100) : 0;
  return {
    // A mapped parcel with no overlapping zone polygon is genuinely outside the
    // mapped floodplain — that is a MEASURED 'X', and it is only sayable
    // because coverage came back `present`.
    flood_zone: dominantZone ?? 'X',
    in_sfha: sfhaArea > 0,
    pct_parcel_in_floodplain: Math.round(pct * 10) / 10,
    nfhl_coverage: 'present',
    flood_unknown_reason: null,
    source_url: inputs.sourceUrl,
  };
}
