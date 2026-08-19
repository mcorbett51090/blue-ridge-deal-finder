/**
 * COORDINATE PASS — give every ingested parcel a mappable point.
 *
 * ⛔ Why this exists. The attribute ingest stores no geometry (the plan makes
 * the geometry pass quarterly, to keep the weekly run proportionate under
 * GitHub's terms). The consequence went unnoticed until the site was pointed at
 * real data: **lat/lng were null on 100% of published rows**, so the map — the
 * primary interface — had nothing to draw, and a detail page crashed on
 * `null.toFixed(5)` because no fixture had ever exercised that path.
 *
 * The cheap fix uses a layer this project already mis-stepped on. `MapServer/1`
 * is polygons and is the correct anchor for attributes and for the geometry
 * work that water frontage needs. `FeatureServer/0` is "Parcels (pts)" — the
 * layer originally anchored on by mistake, because a metadata probe printed
 * `Parcels (pts)` and nobody registered what it meant.
 *
 * For a MAP, points are exactly right: one x/y per parcel, keyed by `parno`,
 * a fraction of the bytes of a polygon pull. So the wrong layer for one job is
 * the right layer for another, and both are now used deliberately.
 *
 * `returnCentroid=true` was tried first on the polygon layer and returns `null`
 * on this server — measured, not assumed.
 *
 * ⛔ EVERY point is checked against the Blue Ridge envelope before it is stored.
 * A source that passes a name match can still describe another state entirely —
 * a "Fannin County Parcels" layer found during this build is Fannin County,
 * TEXAS. Coordinates are the one field where that error becomes visible, so
 * this is where the check belongs.
 */
import { loadRegistry } from '../fetch/registry.ts';
import { FetchClient } from '../fetch/client.ts';
import { assertNotInBandError } from '../fetch/arcgis.ts';
import { assertGeoIdentity, type LonLat } from '../fetch/geo-identity.ts';
import { openWarehouse } from '../store/warehouse.ts';

const SOURCE_ID = 'nc-onemap-points';
const PAGE = 2000;

type PointRow = { parno: string; lon: number; lat: number };

export async function fetchCountyPoints(
  client: FetchClient,
  county: string,
  onPage?: (n: number) => void,
): Promise<PointRow[]> {
  const out: PointRow[] = [];
  let offset = 0;

  for (;;) {
    const res = await client.fetchJson(SOURCE_ID, {
      path: '/query',
      searchParams: {
        where: `cntyname='${county.replace(/'/g, "''")}'`,
        outFields: 'parno',
        returnGeometry: 'true',
        // WGS84 explicitly. The declared extent of an ArcGIS layer is often in a
        // projected CRS, and reading that as lon/lat yields nonsense rather than
        // a clean failure — which is precisely how a wrong-state source hides.
        outSR: '4326',
        resultOffset: String(offset),
        resultRecordCount: String(PAGE),
        f: 'json',
      },
    });

    const body = res.body as Record<string, unknown>;
    assertNotInBandError(body, SOURCE_ID, `points(${county} @${offset})`);

    const features = body['features'];
    if (!Array.isArray(features)) {
      throw new Error(`[${SOURCE_ID}] ${county}@${offset}: no features array — keys ${JSON.stringify(Object.keys(body))}`);
    }
    if (features.length === 0) break;

    for (const f of features as Array<Record<string, unknown>>) {
      const a = (f['attributes'] ?? {}) as Record<string, unknown>;
      const g = (f['geometry'] ?? {}) as Record<string, unknown>;
      const parno = typeof a['parno'] === 'string' ? a['parno'].trim() : '';
      const lon = typeof g['x'] === 'number' ? g['x'] : null;
      const lat = typeof g['y'] === 'number' ? g['y'] : null;
      // A point with no parno cannot be joined, and a parcel with no point is
      // simply not mappable. Both are dropped rather than guessed at.
      if (parno === '' || lon === null || lat === null) continue;
      out.push({ parno, lon, lat });
    }

    onPage?.(out.length);
    if (features.length < PAGE) break;
    offset += PAGE;
  }

  // Sample rather than check all: the failure being guarded is a whole layer
  // describing the wrong place, which a sample catches just as well as a full
  // scan. An EMPTY sample throws — a check that inspected nothing is not a pass.
  const step = Math.max(1, Math.floor(out.length / 50));
  const sample: LonLat[] = out.filter((_, i) => i % step === 0).slice(0, 50);
  assertGeoIdentity(`${SOURCE_ID}:${county}`, sample);

  return out;
}

export function applyPoints(dbPath: string, fips: string, points: readonly PointRow[]): number {
  const db = openWarehouse(dbPath);
  let updated = 0;
  // This wrapper's run() returns void, so the count comes from asking the
  // table what actually changed rather than trusting a driver return value.
  const before = db.prepare('SELECT COUNT(*) AS n FROM parcels WHERE fips = ? AND lat IS NOT NULL').get([fips]) as { n: number };
  const stmt = db.prepare('UPDATE parcels SET lat = ?, lng = ? WHERE fips = ? AND parno = ?');
  for (const p of points) stmt.run([p.lat, p.lon, fips, p.parno]);
  const after = db.prepare('SELECT COUNT(*) AS n FROM parcels WHERE fips = ? AND lat IS NOT NULL').get([fips]) as { n: number };
  updated = Number(after.n) - Number(before.n);
  db.close();
  return updated;
}
