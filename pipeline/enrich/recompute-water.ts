/**
 * OFFLINE re-derivation of `water` for every already-enriched parcel.
 *
 * ⛔ Why this exists rather than "just re-run the enricher". The cache stores
 * RESULTS: `getEnrichment(geometryHash)` returns the stored payload verbatim and
 * issues no network call, which is exactly what makes re-runs cheap. It also
 * means a CORRECTED computation reaches nobody — every parcel already enriched
 * keeps serving the number the old maths produced. The 2026-08-19 fix (within-
 * cell and cross-cell duplicate counting, which inflated published frontage by
 * up to 4x) would have been invisible on precisely the rows that already shipped.
 *
 * This recomputes water from the CACHED cells and CACHED parcel geometry, so it
 * opens no socket, and rewrites both the sqlite payload and
 * `enrichment-latest.json` — the file `to-contract.ts` projects `water.json`
 * from. Run it after any change to computeWater's arithmetic, and bump
 * WATER_COMPUTATION_VERSION so the reason is recorded beside the code.
 *
 *   npx tsx pipeline/enrich/recompute-water.ts [--write]
 *
 * Without `--write` it only reports the diff. A frontage that goes UP is a
 * failure, not a curiosity: the fix removes double counts and can never invent
 * water, so an increase means the recomputation is wrong.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeWater, cellsCovering, SEARCH_RADIUS_M, WATER_COMPUTATION_VERSION, type NhdCell } from './nhd.ts';
import { ringsToMultiPolygon, bboxOf, expandBbox } from './geometry.ts';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const WRITE = process.argv.includes('--write');
const dbPath = join(ROOT, 'data/enrich/enrichment.sqlite');
if (!existsSync(dbPath)) {
  console.log('no enrichment cache — nothing to recompute');
  process.exit(0);
}

const db = new DatabaseSync(dbPath, { readOnly: !WRITE });
const enr = db.prepare('SELECT record_id, geometry_hash, payload FROM parcel_enrichment').all() as Record<string, unknown>[];
const geo = new Map<string, string>();
for (const g of db.prepare('SELECT geometry_hash, rings FROM parcel_geometry').all() as Record<string, unknown>[]) {
  geo.set(String(g['geometry_hash']), String(g['rings']));
}
const cellMemo = new Map<string, NhdCell | null>();
const getCell = (k: string): NhdCell | null => {
  if (!cellMemo.has(k)) {
    const r = db.prepare('SELECT payload FROM nhd_cell WHERE cell_key = ?').get(k) as Record<string, unknown> | undefined;
    cellMemo.set(k, r ? (JSON.parse(String(r['payload'])) as NhdCell) : null);
  }
  return cellMemo.get(k) ?? null;
};

let down = 0, up = 0, same = 0, skipped = 0, written = 0;
const updated = new Map<string, unknown>();
for (const e of enr) {
  const ringsJson = geo.get(String(e['geometry_hash']));
  if (!ringsJson) { skipped += 1; continue; }
  const parcel = ringsToMultiPolygon(JSON.parse(ringsJson) as never);
  if (!parcel) { skipped += 1; continue; }
  const payload = JSON.parse(String(e['payload'])) as Record<string, unknown>;
  const old = payload['water'] as Record<string, unknown> | undefined;
  const cells = cellsCovering(expandBbox(bboxOf(parcel), SEARCH_RADIUS_M)).map(getCell).filter(Boolean) as NhdCell[];
  if (!cells.length) { skipped += 1; continue; }

  const next = computeWater({
    parcel, parcelIsBboxOnly: false, budgetMs: 60_000, cells,
    sourceUrl: (old?.['source_url'] as string | null) ?? null,
  });
  const a = (old?.['water_frontage_m'] as number | null) ?? null;
  const b = next.water_frontage_m ?? null;
  if (a === b) { same += 1; } else if (a !== null && b !== null && b > a) {
    up += 1;
    console.error(`  ⛔ FRONTAGE ROSE for ${String(e['record_id'])}: ${a} -> ${b}. The fix removes double counts; it cannot invent water.`);
  } else { down += 1; }

  payload['water'] = next;
  payload['water_computation_version'] = WATER_COMPUTATION_VERSION;
  updated.set(String(e['record_id']), payload);
  if (WRITE) {
    db.prepare('UPDATE parcel_enrichment SET payload = ? WHERE geometry_hash = ?')
      .run(JSON.stringify(payload), String(e['geometry_hash']));
    written += 1;
  }
}

// Keep enrichment-latest.json in step — it is what to-contract.ts projects from,
// so leaving it stale would republish the old numbers from a corrected cache.
const latestPath = join(ROOT, 'data/enrich/enrichment-latest.json');
if (WRITE && existsSync(latestPath)) {
  const doc = JSON.parse(readFileSync(latestPath, 'utf8')) as Record<string, unknown>;
  const rows = (doc['results'] as Record<string, unknown>[] | undefined) ?? [];
  let patched = 0;
  for (const r of rows) {
    const u = updated.get(String(r['record_id']));
    if (u) { r['water'] = (u as Record<string, unknown>)['water']; patched += 1; }
  }
  writeFileSync(latestPath, `${JSON.stringify(doc, null, 1)}\n`);
  console.log(`  enrichment-latest.json: ${patched} row(s) patched`);
}

db.close();
console.log(
  `recompute-water v${WATER_COMPUTATION_VERSION}${WRITE ? ' (WRITTEN)' : ' (dry run — pass --write)'}: ` +
    `${enr.length} cached · unchanged ${same} · down ${down} · up ${up} · skipped ${skipped}` +
    (WRITE ? ` · ${written} payload(s) updated` : ''),
);
if (up > 0) process.exit(1);
