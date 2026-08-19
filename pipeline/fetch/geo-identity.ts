/**
 * GEOGRAPHIC IDENTITY — a source must prove it describes the place it claims.
 *
 * ⛔ Measured 2026-08-19, and this one nearly landed.
 *
 * Searching for a North Georgia parcel source returned "Fannin County Parcels",
 * an ArcGIS Feature Layer with 49 fields including `land_val`, `imprv_val`,
 * `market` and `legal_acreage` — richer than the NC anchor, and exactly the
 * data this project has been unable to obtain for Georgia.
 *
 * It is Fannin County, TEXAS. `situs_state: "TX"`, published by
 * `CityofBonhamTX`, projected in WKID 2276 (Texas North Central).
 *
 * A second candidate, "Union Parcels", is Union County FLORIDA — its own
 * attributes carry `union.floridapa.com` links, and a vertex sampled in WGS84
 * lands 0.14° from Union County FL against 5.15° from Union County GA.
 *
 * County names repeat across states: Fannin exists in GA and TX; Union exists
 * in at least GA, FL, NJ, NC, SC. A name match is not identity, and the failure
 * is silent and total — every row would have been correct data about the wrong
 * place, filed under a Blue Ridge county, scored, and ranked.
 *
 * THE RULE: before any source is ingested, sample real geometry in WGS84 and
 * assert it falls inside the county's expected envelope. Do not trust the
 * layer's declared extent alone — it is often in a projected CRS, and reading
 * a projected extent as lon/lat is how you conclude "somewhere in the ocean"
 * or, worse, nothing at all.
 */

export type LonLat = { lon: number; lat: number };
export type Envelope = { minLon: number; minLat: number; maxLon: number; maxLat: number };

/** The whole Blue Ridge study area, generously padded. Nothing we ingest may
 *  fall outside it — that is the cheapest possible catch for a wrong-state
 *  source, and it would have caught both false positives above. */
export const BLUE_RIDGE_ENVELOPE: Envelope = {
  minLon: -85.8, minLat: 33.9,
  maxLon: -77.9, maxLat: 39.6,
};

export function contains(env: Envelope, p: LonLat): boolean {
  return p.lon >= env.minLon && p.lon <= env.maxLon && p.lat >= env.minLat && p.lat <= env.maxLat;
}

export class GeoIdentityError extends Error {
  constructor(sourceId: string, detail: string) {
    super(`[${sourceId}] geographic identity check failed: ${detail}`);
    this.name = 'GeoIdentityError';
  }
}

/**
 * Assert sampled points sit inside `env`.
 *
 * ⛔ An EMPTY sample is a FAILURE, not a pass. "We checked nothing and found
 * nothing wrong" is the exact shape of every silent-green defect this project
 * has hit; a check that cannot fail must never report clean.
 */
export function assertGeoIdentity(
  sourceId: string,
  samples: readonly LonLat[],
  env: Envelope = BLUE_RIDGE_ENVELOPE,
): void {
  if (samples.length === 0) {
    throw new GeoIdentityError(sourceId, 'no geometry sampled — cannot confirm the source describes this region');
  }
  const outside = samples.filter((p) => !contains(env, p));
  if (outside.length > 0) {
    const p = outside[0]!;
    throw new GeoIdentityError(
      sourceId,
      `${outside.length}/${samples.length} sampled point(s) fall outside the study area — ` +
        `first at lon ${p.lon.toFixed(4)}, lat ${p.lat.toFixed(4)}. ` +
        `A county-name match is not county identity: Fannin exists in GA and TX, Union in GA, FL, NJ, NC and SC.`,
    );
  }
}
