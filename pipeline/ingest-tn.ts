/**
 * East Tennessee parcel ingest. Same guards as NC, a thinner upstream.
 * See pipeline/ingest/tn-stage.ts for what TN does and does not publish.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry } from './fetch/registry.ts';
import { FetchClient } from './fetch/client.ts';
import { assertNotInBandError } from './fetch/arcgis.ts';
import { assertGeoIdentity, type LonLat } from './fetch/geo-identity.ts';
import { stageTnRow } from './ingest/tn-stage.ts';
import { openWarehouse } from './store/warehouse.ts';
import type { StagedParcel } from './ingest/stage.ts';

const SOURCE_ID = 'tn-property-boundaries';
const PAGE = 2000; // the TN layer's maxRecordCount is 2000, NOT NC's 5000
const ROOT = process.cwd();

const arg = process.argv.find((a) => a.startsWith('--counties='));
const wanted = arg ? arg.split('=')[1]!.split(',').map((s) => s.trim()).filter(Boolean) : [];

const seeds = readFileSync(join(ROOT, 'seeds/counties.csv'), 'utf8').trim().split('\n').slice(1);
const fipsOf = new Map<string, string>();
for (const line of seeds) {
  const [fips, state, county] = line.split(',');
  if (state === 'TN' && fips && county) fipsOf.set(county, fips);
}

const pointerPath = join(ROOT, 'data/warehouse/warehouse-pointer.json');
if (!existsSync(pointerPath)) throw new Error('no warehouse pointer — run the NC ingest first');
const dbPath = join(ROOT, 'data/warehouse', JSON.parse(readFileSync(pointerPath, 'utf8')).current);

const registry = loadRegistry(ROOT);
const client = new FetchClient(registry);
const now = new Date();

/** Control block FIRST — a batch whose positive control misses is a FAILED run,
 *  and identical positive/negative answers mean the endpoint is a constant. */
async function count(where: string): Promise<number> {
  const res = await client.fetchJson(SOURCE_ID, {
    path: '/query',
    searchParams: { where, returnCountOnly: 'true', f: 'json' },
  });
  assertNotInBandError(res.body, SOURCE_ID, `count(${where})`);
  const n = (res.body as { count?: unknown }).count;
  if (typeof n !== 'number') throw new Error(`[${SOURCE_ID}] count(${where}): no numeric count`);
  return n;
}

const pos = await count("COUNTY_NAME='Sevier'");
const neg = await count("COUNTY_NAME='Zzzznotacounty'");
if (pos !== 70606) throw new Error(`control FAILED: Sevier expected 70606, got ${pos}`);
if (neg !== 0) throw new Error(`control FAILED: bogus county expected 0, got ${neg}`);
if (pos === neg) throw new Error('control FAILED: positive and negative agree — endpoint is answering a constant');
console.log(`✓ control block: positive=${pos} negative=${neg}`);

let grand = 0;
for (const county of wanted) {
  const fips = fipsOf.get(county);
  if (!fips) { console.error(`  ! ${county}: not a TN county in seeds/counties.csv`); continue; }

  const staged: StagedParcel[] = [];
  const samples: LonLat[] = [];
  const seen = new Map<string, number>();
  let offset = 0;
  let fetched = 0;

  try {
    process.stdout.write(`  ${county}: `);
    for (;;) {
      const res = await client.fetchJson(SOURCE_ID, {
        path: '/query',
        searchParams: {
          where: `COUNTY_NAME='${county.replace(/'/g, "''")}'`,
          outFields: 'PARCELID,ADDRESS,DEEDAC,OWNER,OWNER2,PARCEL_TYPE,COUNTY_NAME,LINK_TPAD',
          returnGeometry: 'true',
          outSR: '4326',
          resultOffset: String(offset),
          resultRecordCount: String(PAGE),
          f: 'json',
        },
      });
      assertNotInBandError(res.body, SOURCE_ID, `${county}@${offset}`);
      const features = (res.body as { features?: unknown }).features;
      if (!Array.isArray(features)) {
        throw new Error(`${county}@${offset}: no features array`);
      }
      if (features.length === 0) break;

      for (const f of features as Array<Record<string, unknown>>) {
        const a = (f['attributes'] ?? {}) as Record<string, unknown>;
        const pid = String(a['PARCELID'] ?? '').trim();
        fetched += 1;
        if (pid === '') continue; // unkeyed — quarantined, never guessed at

        const seq = (seen.get(pid) ?? 0) + 1;
        seen.set(pid, seq);
        const recordId = `${fips}:${pid}:${seq - 1}`;
        const row = stageTnRow(a, recordId, pid, seq - 1, 1, { state: 'TN', county, fips, now });

        // The geometry is already in hand — we asked for it in WGS84 to run the
        // geo-identity check. Discarding it and fetching coordinates again later
        // would be a second full pass over the same 152k parcels for data we
        // already downloaded, which is exactly the disproportionate burden the
        // cadence discipline exists to avoid.
        const g = (f['geometry'] ?? {}) as Record<string, unknown>;
        const rings = g['rings'] as number[][][] | undefined;
        const ring = rings?.[0];
        if (ring && ring.length > 0) {
          // Ring average, not a true polygon centroid. It is a MAP PIN, and for
          // a pin the difference is metres; a true centroid is a turf dependency
          // and a second pass for precision nothing here needs. Where it would
          // matter — does a creek cross this parcel — the polygon itself is used,
          // never this point.
          let sx = 0, sy = 0, n = 0;
          for (const pt of ring) {
            if (typeof pt[0] === 'number' && typeof pt[1] === 'number') { sx += pt[0]; sy += pt[1]; n += 1; }
          }
          if (n > 0) {
            row.lng = sx / n;
            row.lat = sy / n;
            if (samples.length < 50 && staged.length % 200 === 1) {
              samples.push({ lon: row.lng, lat: row.lat });
            }
          }
        }
        staged.push(row);
      }
      process.stdout.write(`${staged.length}… `);
      if (features.length < PAGE) break;
      offset += PAGE;
    }

    assertGeoIdentity(`${SOURCE_ID}:${county}`, samples);

    const db = openWarehouse(dbPath);
    const ins = db.prepare(`
      INSERT OR REPLACE INTO parcels
        (record_id, fips, state, county, parno, part_seq, part_count,
         acreage, acreage_unknown_reason, acreage_basis,
         value, value_unknown_reason, value_basis, value_basis_raw,
         deed_date, deed_date_unknown_reason, sale_date, sale_date_unknown_reason,
         assessment_year, owner_out_of_state, owner_is_entity, owner_is_government,
         tenure_years, parusedesc, siteadd, lat, lng, bbox, geometry_hash,
         status, first_seen, last_seen, content_hash)
      VALUES (?,?,?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?, ?,?,?,?,?,?,?, ?,?,?,?)`);
    const iso = now.toISOString();
    for (const p of staged) {
      ins.run([
        p.record_id, p.fips, p.state, p.county, p.parno, p.part_seq, p.part_count,
        p.acreage, p.acreage_unknown_reason, p.acreage_basis,
        p.value, p.value_unknown_reason, p.value_basis, p.value_basis_raw,
        p.deed_date, p.deed_date_unknown_reason, p.sale_date, p.sale_date_unknown_reason,
        p.assessment_year, p.owner_out_of_state, p.owner_is_entity, p.owner_is_government,
        p.tenure_years, p.parusedesc, p.siteadd, p.lat, p.lng, null, null,
        'active', iso, iso, `${p.record_id}:${p.acreage}:${p.siteadd}`,
      ]);
    }
    db.prepare(`INSERT OR REPLACE INTO county_runs
        (fips, county, run_id, ingest_status, rows_fetched, distinct_keys, rows_warehoused,
         unkeyed, collapsed_dupes, multipart_parcels, deed_date_nulled, zero_parval, ingested_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run([fips, county, `tn-${iso}`, 'complete', fetched, seen.size, staged.length,
            fetched - staged.length, 0, 0, 0, staged.length, iso]);
    db.close();

    grand += staged.length;
    console.log(`${fetched} fetched -> ${staged.length} warehoused (${fetched - staged.length} unkeyed, ${seen.size} distinct)`);
  } catch (e) {
    console.error(`\n  ✗ ${county} FAILED: ${(e as Error).message}`);
  }
}
console.log(`\n✓ TN ingest — ${grand} parcels warehoused`);
