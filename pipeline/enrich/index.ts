/**
 * P7 — CANDIDATE ENRICHMENT ORCHESTRATOR (plan §5.5, §5.6, §5.7).
 *
 * ⛔ CANDIDATES ONLY, NEVER THE CORPUS (§5.7). Candidacy is decided from
 * WAREHOUSE-LOCAL data — use class, acreage, government ownership — before a
 * single external request is made. Enriching 503,674 parcels unconditionally is
 * an unbounded-egress design aimed straight at C36 clause 2; enriching the few
 * thousand that could plausibly be a deal is proportionate and is what makes
 * the water signal affordable at all.
 *
 * ⛔ THE WAREHOUSE HOLDS NO PARCEL GEOMETRY TODAY, AND THIS FILE DOES NOT
 * PRETEND OTHERWISE. Measured 2026-08-19 against the file named by
 * data/warehouse/warehouse-pointer.json (warehouse-2026-08-19T15-28-22.sqlite,
 * 81,092 rows):
 *     SELECT COUNT(*) FROM parcels WHERE bbox           IS NOT NULL  ->  0
 *     SELECT COUNT(*) FROM parcels WHERE lat            IS NOT NULL  ->  0
 *     SELECT COUNT(*) FROM parcels WHERE geometry_hash  IS NOT NULL  ->  0
 * The P2 attribute pass runs with returnGeometry=false and stage.ts writes
 * `bbox: null` unconditionally, so every geometry column is null for every row.
 *
 * The options were: (a) fall back to a centroid — impossible, there is not even
 * a centroid; (b) skip water entirely; (c) fetch the POLYGON for the candidate
 * set only, from the layer already in the registry. (c) is what happens here.
 * It is one extra request per ~40 candidates (`parno IN (…)`), the polygons are
 * cached by record_id, and — this is the point — the water numbers are then
 * derived from the REAL RECORDED BOUNDARY, so `water_confidence` is honestly
 * 'polygon-intersection' rather than a bbox rectangle wearing that label.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FetchClient } from '../fetch/client.ts';
import { Db } from '../store/sqlite.ts';
import { EnrichCache } from './cache.ts';
import { geometryHash, ringsToMultiPolygon, bboxOf, expandBbox, type AnyPolygon, type BBox } from './geometry.ts';
import {
  SEARCH_RADIUS_M, cellSourceUrl, cellsCovering, computeWater, fetchCell,
  NHD_FLOWLINE_SOURCE, type NhdCell,
} from './nhd.ts';
import {
  EPQS_SERVICE, SAMPLES_PER_PARCEL, epqsParams, epqsSourceUrl, parseElevation,
  pointKey, runControlProbe, samplePoints, slopeFromSamples, EpqsBodyError,
  type ElevationSample,
} from './epqs.ts';
import { floodUnknown, roadUnknown, slopeUnknown, waterUnknown, ParcelEnrichmentSchema, type ParcelEnrichment } from './schema.ts';
import { getPointService, loadEnrichRegistry, type EnrichRegistry } from './sources.ts';

export const PARCEL_SOURCE = 'nc-onemap-parcels';
/** Parcels per `parno IN (…)` geometry request. Keeps the URL well under any
 *  gateway limit while collapsing 40 parcels into one round trip. */
export const GEOMETRY_BATCH = 40;

export type Candidate = {
  record_id: string;
  county: string;
  parno: string;
  acreage: number | null;
  value: number | null;
  parusedesc: string;
};

/** The warehouse named by the POINTER — never the newest by mtime. A
 *  half-written `warehouse-building-*.sqlite` is newer than the live one and
 *  reading it would enrich a corpus that does not exist yet. */
export function warehousePath(repoRoot: string): string {
  const dir = join(repoRoot, 'data', 'warehouse');
  const pointerPath = join(dir, 'warehouse-pointer.json');
  if (!existsSync(pointerPath)) throw new Error(`no warehouse pointer at ${pointerPath}`);
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as { current?: string };
  if (!pointer.current) throw new Error(`${pointerPath} has no 'current' key`);
  const path = join(dir, pointer.current);
  if (!existsSync(path)) throw new Error(`pointer names ${pointer.current}, which is not on disk`);
  return path;
}

/**
 * Candidacy — warehouse-local only (§5.7). No network, no enrichment, nothing
 * that costs a request. The vetoes come first because a government-owned parcel
 * is not for sale at any price and enriching it is pure waste.
 */
export function selectCandidates(
  dbPath: string,
  options: { limit: number; counties?: readonly string[]; minAcres?: number; maxAcres?: number },
): Candidate[] {
  const db = new Db(dbPath, { readOnly: true });
  try {
    const minAcres = options.minAcres ?? 2;
    const maxAcres = options.maxAcres ?? 200;
    const where = [
      "status = 'active'",
      'owner_is_government = 0',
      'acreage IS NOT NULL',
      `acreage >= ${minAcres}`,
      `acreage <= ${maxAcres}`,
      "parno <> ''",
    ];
    if (options.counties && options.counties.length > 0) {
      const list = options.counties.map((c) => `'${c.replace(/'/g, "''")}'`).join(',');
      where.push(`county IN (${list})`);
    }
    const rows = db
      .prepare(
        `SELECT record_id, county, parno, acreage, value, parusedesc FROM parcels ` +
          `WHERE ${where.join(' AND ')} ORDER BY acreage DESC LIMIT ${Math.max(0, options.limit)}`,
      )
      .all();
    return rows.map((r) => ({
      record_id: String(r['record_id']),
      county: String(r['county']),
      parno: String(r['parno']),
      acreage: typeof r['acreage'] === 'number' ? r['acreage'] : null,
      value: typeof r['value'] === 'number' ? r['value'] : null,
      parusedesc: String(r['parusedesc'] ?? ''),
    }));
  } finally {
    db.close();
  }
}

export type Counters = { nhdRequests: number; parcelGeometryRequests: number; epqsRequests: number };

/**
 * Fetch parcel polygons for a batch, caching by record_id. Returns the rings in
 * WGS84. `outSR=4326` is not optional — see §4.1/R8.
 */
export async function fetchParcelGeometry(
  client: FetchClient,
  cache: EnrichCache,
  batch: readonly Candidate[],
  counters: Counters,
  now: string,
): Promise<Map<string, number[][][]>> {
  const out = new Map<string, number[][][]>();
  const missing: Candidate[] = [];
  for (const c of batch) {
    const cached = cache.getGeometry(c.record_id);
    if (cached) out.set(c.record_id, cached.rings);
    else missing.push(c);
  }
  if (missing.length === 0) return out;

  const byCounty = new Map<string, Candidate[]>();
  for (const c of missing) {
    const list = byCounty.get(c.county) ?? [];
    list.push(c);
    byCounty.set(c.county, list);
  }

  for (const [county, group] of byCounty) {
    const parnos = group.map((c) => `'${c.parno.replace(/'/g, "''")}'`).join(',');
    const res = await client.fetchJson(PARCEL_SOURCE, {
      path: '/query',
      searchParams: {
        where: `cntyname='${county.replace(/'/g, "''")}' AND parno IN (${parnos})`,
        outFields: 'parno',
        returnGeometry: 'true',
        outSR: '4326',
        f: 'json',
      },
    });
    counters.parcelGeometryRequests++;
    const body = res.body as { features?: { attributes?: Record<string, unknown>; geometry?: { rings?: number[][][] } }[]; error?: unknown };
    if (body === null || typeof body !== 'object' || 'error' in body || !Array.isArray(body.features)) {
      throw new Error(`[${PARCEL_SOURCE}] parcel geometry query returned no features array — ${JSON.stringify(body).slice(0, 200)}`);
    }
    const byParno = new Map<string, number[][][]>();
    for (const f of body.features) {
      const rings = f.geometry?.rings;
      if (!Array.isArray(rings)) continue;
      let parno: string | null = null;
      for (const k of Object.keys(f.attributes ?? {})) {
        if (k.toLowerCase() === 'parno') parno = String((f.attributes as Record<string, unknown>)[k]);
      }
      if (parno === null) continue;
      // A multi-part parcel returns several features under one parno. Their
      // rings are CONCATENATED, never overwritten — dropping a part would drop
      // whatever creek runs through it (§4.3, "never overwrite parts").
      byParno.set(parno, [...(byParno.get(parno) ?? []), ...rings]);
    }
    for (const c of group) {
      const rings = byParno.get(c.parno);
      if (!rings) continue;
      cache.putGeometry(c.record_id, geometryHash(rings), rings, now);
      out.set(c.record_id, rings);
    }
  }
  return out;
}

/** Cells, from cache where possible. This is the request-count lever. */
export async function loadCells(
  client: FetchClient,
  cache: EnrichCache,
  keys: readonly string[],
  counters: Counters,
  now: string,
): Promise<Map<string, NhdCell>> {
  const cells = new Map<string, NhdCell>();
  for (const key of keys) {
    const cached = cache.getCell(key);
    if (cached) {
      cells.set(key, cached);
      continue;
    }
    const cell = await fetchCell(client, key);
    counters.nhdRequests += 3; // flowline + waterbody + area
    cache.putCell(cell, now);
    cells.set(key, cell);
  }
  return cells;
}

async function elevationAt(
  client: FetchClient,
  cache: EnrichCache,
  reg: EnrichRegistry,
  lng: number,
  lat: number,
  counters: Counters,
  now: string,
): Promise<number | null> {
  const key = pointKey(lng, lat);
  const cached = cache.getElevation(key);
  if (cached) return cached.elevation_m;

  const service = getPointService(reg, EPQS_SERVICE);
  const res = await client.fetchPointService(service, epqsParams(lng, lat));
  counters.epqsRequests++;
  try {
    const m = parseElevation(res.text);
    cache.putElevation(key, m, now);
    return m;
  } catch (err) {
    if (err instanceof EpqsBodyError) {
      // Cached as a null so a point EPQS has no data for is not re-asked every
      // run — the absence is as stable as the elevation would have been.
      cache.putElevation(key, null, now);
      return null;
    }
    throw err;
  }
}

export type EnrichOptions = {
  repoRoot: string;
  limit: number;
  counties?: readonly string[];
  /** Slope costs 5 requests per parcel; water costs 3 per CELL. */
  withSlope?: boolean;
  cachePath?: string;
};

export type EnrichReport = {
  run_at: string;
  warehouse: string;
  candidates: number;
  enriched: number;
  from_cache: number;
  counters: Counters;
  refusals: { id: string; refusal: string; consequence: string }[];
  results: ParcelEnrichment[];
};

export async function enrichCandidates(options: EnrichOptions): Promise<EnrichReport> {
  const now = new Date().toISOString();
  const reg = loadEnrichRegistry(options.repoRoot);
  const client = new FetchClient(reg.registry);
  const cachePath = options.cachePath ?? join(options.repoRoot, 'data', 'enrich', 'enrichment.sqlite');
  const cache = new EnrichCache(cachePath);
  const counters: Counters = { nhdRequests: 0, parcelGeometryRequests: 0, epqsRequests: 0 };

  const dbPath = warehousePath(options.repoRoot);
  const candidates = selectCandidates(dbPath, {
    limit: options.limit,
    ...(options.counties ? { counties: options.counties } : {}),
  });

  // ⛔ The EPQS control probe runs ONCE, before any sample, and a failure aborts
  // the slope lane rather than degrading it silently.
  let slopeEnabled = options.withSlope === true;
  if (slopeEnabled) {
    try {
      await runControlProbe(client, getPointService(reg, EPQS_SERVICE));
      counters.epqsRequests += 2;
    } catch (err) {
      slopeEnabled = false;
      console.error(`  ! EPQS control probe failed, slope lane OFF: ${String(err).slice(0, 200)}`);
    }
  }

  const results: ParcelEnrichment[] = [];
  let fromCache = 0;

  for (let i = 0; i < candidates.length; i += GEOMETRY_BATCH) {
    const batch = candidates.slice(i, i + GEOMETRY_BATCH);
    const geometries = await fetchParcelGeometry(client, cache, batch, counters, now);

    for (const c of batch) {
      const rings = geometries.get(c.record_id);
      if (!rings) {
        results.push(
          ParcelEnrichmentSchema.parse({
            record_id: c.record_id,
            geometry_hash: `nogeom:${c.record_id}`,
            enriched_at: now,
            water: waterUnknown('parcel_geometry_absent', SEARCH_RADIUS_M),
            flood: floodUnknown('parcel_geometry_absent'),
            slope: slopeUnknown('parcel_geometry_absent'),
            road: roadUnknown('parcel_geometry_absent'),
          }),
        );
        continue;
      }

      const hash = geometryHash(rings);
      // ⛔ THE CACHE CHECK. Unchanged geometry issues ZERO network calls.
      const cached = cache.getEnrichment(hash);
      if (cached) {
        results.push(cached);
        fromCache++;
        continue;
      }

      const mp = ringsToMultiPolygon(rings);
      if (!mp) {
        results.push(
          ParcelEnrichmentSchema.parse({
            record_id: c.record_id, geometry_hash: hash, enriched_at: now,
            water: waterUnknown('parcel_geometry_absent', SEARCH_RADIUS_M),
            flood: floodUnknown('parcel_geometry_absent'),
            slope: slopeUnknown('parcel_geometry_absent'),
            road: roadUnknown('parcel_geometry_absent'),
          }),
        );
        continue;
      }
      const parcel: AnyPolygon = mp;
      const bbox = bboxOf(parcel);
      const searchBbox: BBox = expandBbox(bbox, SEARCH_RADIUS_M);

      const cellKeys = cellsCovering(searchBbox);
      const cells = await loadCells(client, cache, cellKeys, counters, now);
      const water = computeWater({
        parcel,
        parcelIsBboxOnly: false,
        cells: [...cells.values()],
        sourceUrl: cellSourceUrl(
          reg.registry.sources.find((s) => s.id === NHD_FLOWLINE_SOURCE)?.url ?? '',
          searchBbox,
        ),
      });

      let slope = slopeUnknown('epqs_sample_incomplete', SAMPLES_PER_PARCEL, 0);
      if (slopeEnabled) {
        const pts = samplePoints(bbox, parcel);
        const samples: ElevationSample[] = [];
        for (const [lng, lat] of pts) {
          const m = await elevationAt(client, cache, reg, lng, lat, counters, now);
          if (m !== null) samples.push({ lng, lat, elevation_m: m });
        }
        slope = slopeFromSamples(samples);
        if (slope.slope_unknown_reason === null) {
          const centre = pts[0];
          slope = {
            ...slope,
            source_url: centre
              ? epqsSourceUrl(getPointService(reg, EPQS_SERVICE), centre[0], centre[1])
              : null,
          };
        }
      }

      // ⛔ FLOOD AND ROAD ARE UNKNOWN BY REFUSAL, NOT BY OVERSIGHT. Both hosts
      // are in sources.enrich.yaml under refused[] with measured evidence, and
      // no code path here can reach them. See nfhl.ts and tiger.ts.
      const enrichment = ParcelEnrichmentSchema.parse({
        record_id: c.record_id,
        geometry_hash: hash,
        enriched_at: now,
        water,
        flood: floodUnknown('nfhl_robots_disallow'),
        slope,
        road: roadUnknown('tiger_robots_unobtainable'),
      });
      cache.putEnrichment(enrichment);
      results.push(enrichment);
    }
  }

  cache.close();
  return {
    run_at: now,
    warehouse: dbPath,
    candidates: candidates.length,
    enriched: results.length,
    from_cache: fromCache,
    counters,
    refusals: reg.refused.map((r) => ({ id: r.id, refusal: r.refusal, consequence: r.consequence })),
    results,
  };
}

/** CLI: `npm run enrich -- --limit 12 --counties Watauga,Mitchell --slope` */
export async function main(argv: readonly string[]): Promise<void> {
  const repoRoot = process.cwd();
  const arg = (name: string): string | null => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const limit = Number(arg('limit') ?? '12');
  const countiesRaw = arg('counties');
  const report = await enrichCandidates({
    repoRoot,
    limit,
    ...(countiesRaw ? { counties: countiesRaw.split(',').map((s) => s.trim()) } : {}),
    withSlope: argv.includes('--slope'),
  });

  const outDir = join(repoRoot, 'data', 'enrich');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'enrichment-latest.json'), `${JSON.stringify(report, null, 2)}\n`);

  const withStream = report.results.filter((r) => r.water.has_stream === true).length;
  const withRiver = report.results.filter((r) => r.water.has_river === true).length;
  const withPond = report.results.filter((r) => r.water.has_pond === true).length;
  const unknownWater = report.results.filter((r) => r.water.water_unknown_reason !== null).length;
  console.log(
    `enriched ${report.enriched} (${report.from_cache} from cache) · ` +
      `stream ${withStream} · river ${withRiver} · pond ${withPond} · water unknown ${unknownWater} · ` +
      `requests: nhd ${report.counters.nhdRequests}, parcel-geom ${report.counters.parcelGeometryRequests}, ` +
      `epqs ${report.counters.epqsRequests}`,
  );
}
