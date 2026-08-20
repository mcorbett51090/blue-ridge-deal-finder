/**
 * WATER — USGS NHD, computed from GEOMETRY, never from text (plan §5.5).
 *
 * This is the owner's own added signal and the project's differentiator: every
 * listing site in these counties says "creek" in prose and none of them can
 * tell you whether the creek CROSSES the property or how many metres of it you
 * would own. That question is only answerable by intersecting the recorded
 * parcel polygon with the recorded hydrography, which is what this file does.
 *
 * ⛔ THE PARCEL POLYGON, NOT THE CENTROID. A centroid can answer "how far to
 * water" and can answer NOTHING ELSE. Frontage length and "does it cross" are
 * properties of the boundary. Where a polygon is genuinely unavailable this
 * module says so in `water_confidence: 'bbox-approximation'` and never launders
 * a weaker geometry into a stronger claim.
 *
 * ⛔ THREE OUTCOMES, NOT TWO — this is the acceptance criterion that matters:
 *     has_stream: true   we looked and a flowline crosses the parcel
 *     has_stream: false  we looked and none does
 *     water: unknown     we could not look (no NHD coverage here at all)
 * A system with only two outcomes reports the third as the second, and a parcel
 * nobody has mapped becomes a parcel with no creek.
 *
 * ⛔ REQUEST SHAPE, AND WHY IT IS PER-CELL AND NOT PER-PARCEL. NHD is queried
 * once per 0.1° grid cell (~11 x 9 km here) and the features are then
 * intersected against every candidate parcel in that cell locally with turf.
 * One Watauga cell holds 499 flowlines and 24 waterbodies — well inside the
 * layer's maxRecordCount of 2000 — so a thousand candidate parcels in that cell
 * cost THREE requests, not three thousand. This is the same "download once per
 * county, then per candidate with turf" shape plan §5.5 specifies, at a
 * granularity that keeps every response under the transfer limit.
 */
import * as turf from '@turf/turf';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { FetchClient } from '../fetch/client.ts';
import { assertNotInBandError } from '../fetch/arcgis.ts';
import {
  bboxOf,
  expandBbox,
  lengthInsidePolygonM,
  overlapAreaM2,
  pathsToMultiLineString,
  polygonToLineDistanceM,
  polygonToPolygonDistanceM,
  ringsToMultiPolygon,
  type AnyPolygon,
  type BBox,
  type MultiLineStringGeom,
  type MultiPolygonGeom,
} from './geometry.ts';
import { waterUnknown, type Regime, type WaterSignal } from './schema.ts';

/** How far out we look for water we do not own. Beyond this, the answer is
 *  "not within 500 m", which is a MEASUREMENT, not an unknown. The scoring
 *  bands in weights.yaml top out at 400 m, so 500 m covers them with margin. */
export const SEARCH_RADIUS_M = 500;

export const NHD_FLOWLINE_SOURCE = 'usgs-nhd-flowline';
export const NHD_WATERBODY_SOURCE = 'usgs-nhd-waterbody';
export const NHD_AREA_SOURCE = 'usgs-nhd-area';

/**
 * ⛔ ATTRIBUTE KEYS ARE NOT CONSISTENTLY CASED ACROSS NHD LAYERS.
 * Measured 2026-08-19, same service, same request, same day:
 *   layer  6 -> `fcode`, `ftype`, `gnis_name`   (lowercase)
 *   layer  9 -> `FCODE`, `FTYPE`, `GNIS_NAME`   (UPPERCASE)
 *   layer 12 -> `FCODE`, `FTYPE`, `GNIS_NAME`   (UPPERCASE)
 * `outFields` is case-insensitive so the REQUEST is identical either way; only
 * the response keys differ. A reader keying on `fcode` gets `undefined` for
 * layers 9 and 12, and `undefined === 46006` is `false` — i.e. every waterbody
 * in the corpus silently becomes "not perennial". Nothing throws, nothing logs.
 *
 * Hence: read case-insensitively, and THROW when the field is absent rather
 * than returning undefined. An absent FCode is a schema we do not understand,
 * and guessing is how the above becomes a shipped defect instead of a crash.
 */
export function attr(attributes: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(attributes)) {
    if (key.toLowerCase() === wanted) return attributes[key];
  }
  throw new Error(
    `NHD attribute '${name}' is absent (case-insensitively) from [${Object.keys(attributes).join(', ')}] — ` +
      'refusing to read it as undefined, which would compare false against every FCode',
  );
}

export function attrOrNull(attributes: Record<string, unknown>, name: string): unknown {
  try {
    return attr(attributes, name);
  } catch {
    return null;
  }
}

/**
 * FCode → hydrographic regime (NHDFCode domain, USGS).
 *
 * ⛔ 46000 IS NOT PERENNIAL. It is "Stream/River" with the hydrographic category
 * left UNSPECIFIED, and it is the MAJORITY of flowlines in this region: 342 of
 * 499 (69%) in the measured Watauga cell, against 90 perennial and 27
 * intermittent. Collapsing it into `perennial` would mean 69% of our water
 * claims were invented; collapsing it into `intermittent` would throw away
 * genuine creek frontage. It gets its own bucket and the UI says what USGS
 * actually recorded, which is: a stream, regime not stated.
 *
 * ⛔ A DRY DITCH IS NOT CREEK FRONTAGE, and neither is a line that is not a
 * watercourse at all. See isWatercourseFCode below.
 */
export function regimeOfFCode(fcode: number): Regime {
  switch (fcode) {
    case 46006: return 'perennial';
    case 46003: return 'intermittent';
    case 46007: return 'ephemeral';
    default: return 'unspecified';
  }
}

/**
 * Is this flowline a NATURAL WATERCOURSE whose length is real frontage?
 *
 * FType 460 (StreamRiver) only. Everything else on this layer is excluded, and
 * each exclusion is a thing that would otherwise be sold as creek frontage:
 *   558 ArtificialPath — a SYNTHETIC centreline drawn through a lake or pond so
 *       the network stays connected. It is not a stream; it is a topology
 *       device. 35 of 499 in the measured cell, and every one of them lies
 *       inside a waterbody, so counting them double-counts the pond.
 *   334 Connector     — also synthetic, drawn across a gap in the network.
 *   336 CanalDitch    — a real channel, but a dug one. Not creek frontage.
 *   428 Pipeline      — underground. Emphatically not frontage.
 *   566 Coastline     — not applicable inland, excluded for completeness.
 */
export function isWatercourseFType(ftype: number): boolean {
  return ftype === 460;
}

/** FCodes for a waterbody that holds water. 39001 is INTERMITTENT — a pond that
 *  is dry for part of the year is not a pond you can swim in, so it is kept
 *  separate rather than counted as one. */
export function isPerennialWaterbodyFCode(fcode: number): boolean {
  return (
    fcode === 39004 || fcode === 39009 || fcode === 39010 || fcode === 39011 ||
    fcode === 39012 || (fcode >= 43600 && fcode <= 43626) || fcode === 39000
  );
}

export const NhdFeatureSchema = z.object({
  attributes: z.record(z.string(), z.unknown()),
  geometry: z.unknown().optional(),
});

export const NhdQueryResponseSchema = z.object({
  features: z.array(NhdFeatureSchema),
  exceededTransferLimit: z.boolean().optional(),
});

export type NhdLine = {
  permanent_identifier: string;
  gnis_name: string | null;
  ftype: number;
  fcode: number;
  regime: Regime;
  geometry: MultiLineStringGeom;
};

export type NhdArea = {
  permanent_identifier: string;
  gnis_name: string | null;
  ftype: number;
  fcode: number;
  geometry: MultiPolygonGeom;
};

/** Parse a flowline query response. Throws on anything it does not understand. */
export function parseFlowlines(body: unknown): NhdLine[] {
  assertNotInBandError(body, NHD_FLOWLINE_SOURCE, 'flowline query');
  const parsed = NhdQueryResponseSchema.parse(body);
  const out: NhdLine[] = [];
  for (const f of parsed.features) {
    const geom = f.geometry as { paths?: number[][][] } | undefined;
    if (!geom || !Array.isArray(geom.paths)) continue;
    const mls = pathsToMultiLineString(geom.paths);
    if (!mls) continue;
    const fcode = Number(attr(f.attributes, 'fcode'));
    const ftype = Number(attr(f.attributes, 'ftype'));
    if (!Number.isFinite(fcode) || !Number.isFinite(ftype)) {
      throw new Error(`NHD flowline has non-numeric fcode/ftype: ${JSON.stringify(f.attributes)}`);
    }
    const name = attrOrNull(f.attributes, 'gnis_name');
    out.push({
      permanent_identifier: String(attrOrNull(f.attributes, 'permanent_identifier') ?? ''),
      gnis_name: typeof name === 'string' && name.trim() !== '' ? name : null,
      ftype,
      fcode,
      regime: regimeOfFCode(fcode),
      geometry: mls,
    });
  }
  return out;
}

/** Parse a waterbody / area query response (polygon layers). */
export function parseAreas(body: unknown, sourceId: string): NhdArea[] {
  assertNotInBandError(body, sourceId, 'area query');
  const parsed = NhdQueryResponseSchema.parse(body);
  const out: NhdArea[] = [];
  for (const f of parsed.features) {
    const geom = f.geometry as { rings?: number[][][] } | undefined;
    if (!geom || !Array.isArray(geom.rings)) continue;
    const mp = ringsToMultiPolygon(geom.rings);
    if (!mp) continue;
    const fcode = Number(attr(f.attributes, 'fcode'));
    const ftype = Number(attr(f.attributes, 'ftype'));
    if (!Number.isFinite(fcode) || !Number.isFinite(ftype)) {
      throw new Error(`NHD area has non-numeric FCODE/FTYPE: ${JSON.stringify(f.attributes)}`);
    }
    const name = attrOrNull(f.attributes, 'gnis_name');
    out.push({
      permanent_identifier: String(attrOrNull(f.attributes, 'permanent_identifier') ?? ''),
      gnis_name: typeof name === 'string' && name.trim() !== '' ? name : null,
      ftype,
      fcode,
      geometry: mp,
    });
  }
  return out;
}

export type NhdCell = {
  key: string;
  bbox: BBox;
  flowlines: NhdLine[];
  waterbodies: NhdArea[];
  areas: NhdArea[];
};

/** 0.1° grid cell key for a coordinate. The cache and the coverage probe share it. */
export function cellKeyOf(lng: number, lat: number): string {
  const x = Math.floor(lng * 10) / 10;
  const y = Math.floor(lat * 10) / 10;
  return `${x.toFixed(1)},${y.toFixed(1)}`;
}

export function cellBboxOf(key: string): BBox {
  const parts = key.split(',');
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  return [x, y, x + 0.1, y + 0.1];
}

/** Every 0.1° cell a bbox touches — a parcel near a cell edge needs both. */
export function cellsCovering(bbox: BBox): string[] {
  const [minX, minY, maxX, maxY] = bbox;
  const keys = new Set<string>();
  for (let x = Math.floor(minX * 10); x <= Math.floor(maxX * 10); x++) {
    for (let y = Math.floor(minY * 10); y <= Math.floor(maxY * 10); y++) {
      keys.add(`${(x / 10).toFixed(1)},${(y / 10).toFixed(1)}`);
    }
  }
  return [...keys].sort();
}

function envelopeParam(bbox: BBox): string {
  return JSON.stringify({
    xmin: bbox[0], ymin: bbox[1], xmax: bbox[2], ymax: bbox[3],
    spatialReference: { wkid: 4326 },
  });
}

/** The query params for one cell fetch. Exported so a test can assert the shape
 *  without a socket — in particular that outSR is always sent. */
export function cellQueryParams(bbox: BBox, outFields: string): Record<string, string> {
  return {
    geometry: envelopeParam(bbox),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields,
    returnGeometry: 'true',
    // ⛔ outSR on EVERY geometry request (§4.1/R8). Without it the service
    // answers in its own SR and the coordinates land in the wrong hemisphere
    // of the map with no error anywhere.
    outSR: '4326',
    // ~0.1 m at this latitude. Cuts the payload roughly in half against the
    // default 15 significant figures, which are noise below the accuracy of
    // the source data.
    geometryPrecision: '6',
    f: 'json',
  };
}

/** Deep link to the exact query behind a cell's numbers (verify-provenance). */
export function cellSourceUrl(baseUrl: string, bbox: BBox): string {
  const url = new URL(`${baseUrl}/query`);
  for (const [k, v] of Object.entries(cellQueryParams(bbox, 'permanent_identifier,gnis_name,ftype,fcode'))) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Fetch one grid cell's hydrography. THREE requests, cached by the caller.
 *
 * `exceededTransferLimit` is a hard failure rather than a shrug: a truncated
 * cell is a cell where some creeks are missing, and a missing creek reads
 * downstream as `has_stream: false` — a measured negative that is actually a
 * partial read. That is precisely the "silently truncated page is read as
 * merely smaller" failure recorded in assert-healthy.ts.
 */
export async function fetchCell(client: FetchClient, key: string): Promise<NhdCell> {
  return fetchCellBbox(client, key, cellBboxOf(key), 0);
}

/** Split a bbox into four. Used only when a cell is too dense to fetch whole. */
function quarters([xmin, ymin, xmax, ymax]: BBox): BBox[] {
  const mx = (xmin + xmax) / 2;
  const my = (ymin + ymax) / 2;
  return [
    [xmin, ymin, mx, my],
    [mx, ymin, xmax, my],
    [xmin, my, mx, ymax],
    [mx, my, xmax, ymax],
  ];
}

/**
 * ⛔ REFUSING A TRUNCATED CELL IS RIGHT; ABORTING THE RUN IS TOO BLUNT.
 *
 * `assertNotTruncated` correctly refuses a half-read cell, because a missing
 * creek reads downstream as `has_stream: false` — a measured negative that is
 * really a partial read. But the first enrichment over the full published set
 * died on its first dense cell (-82.9,35.8), and one crowded valley must not
 * cost 658 parcels their water signal.
 *
 * So a truncated cell is SUBDIVIDED and retried, up to a bounded depth. The
 * guarantee is unchanged: every cell that contributes data was read whole. What
 * changes is that "too much water here" becomes four smaller reads instead of a
 * dead run — and if it is still truncated at max depth, it still throws rather
 * than returning a partial answer.
 */
const MAX_SPLIT_DEPTH = 3;

async function fetchCellBbox(
  client: FetchClient,
  key: string,
  bbox: BBox,
  depth: number,
): Promise<NhdCell> {
  try {
    return await fetchCellOnce(client, key, bbox);
  } catch (err) {
    const truncated = err instanceof Error && err.message.includes('transfer limit');
    if (!truncated || depth >= MAX_SPLIT_DEPTH) throw err;
    const parts = await Promise.all(
      quarters(bbox).map((q) => fetchCellBbox(client, key, q, depth + 1)),
    );
    // ⛔ dedupeCell, not a bare flatMap. A feature straddling a quarter boundary
    // comes back from every quarter it touches; merging without dedupe both
    // multiplies the work and DOUBLE-COUNTS its frontage downstream.
    return dedupeCell({
      key,
      bbox,
      flowlines: parts.flatMap((p) => p.flowlines),
      waterbodies: parts.flatMap((p) => p.waterbodies),
      areas: parts.flatMap((p) => p.areas),
    });
  }
}

async function fetchCellOnce(client: FetchClient, key: string, bbox: BBox): Promise<NhdCell> {
  const flowBody = await client.fetchJson(NHD_FLOWLINE_SOURCE, {
    path: '/query',
    searchParams: cellQueryParams(bbox, 'permanent_identifier,gnis_name,ftype,fcode,lengthkm'),
  });
  assertNotTruncated(flowBody.body, NHD_FLOWLINE_SOURCE, key);
  const flowlines = parseFlowlines(flowBody.body);

  const wbBody = await client.fetchJson(NHD_WATERBODY_SOURCE, {
    path: '/query',
    searchParams: cellQueryParams(bbox, 'permanent_identifier,gnis_name,ftype,fcode'),
  });
  assertNotTruncated(wbBody.body, NHD_WATERBODY_SOURCE, key);
  const waterbodies = parseAreas(wbBody.body, NHD_WATERBODY_SOURCE);

  const areaBody = await client.fetchJson(NHD_AREA_SOURCE, {
    path: '/query',
    searchParams: cellQueryParams(bbox, 'permanent_identifier,gnis_name,ftype,fcode'),
  });
  assertNotTruncated(areaBody.body, NHD_AREA_SOURCE, key);
  const areas = parseAreas(areaBody.body, NHD_AREA_SOURCE);

  return { key, bbox, flowlines, waterbodies, areas };
}

export function assertNotTruncated(body: unknown, sourceId: string, key: string): void {
  if (body !== null && typeof body === 'object' && (body as Record<string, unknown>)['exceededTransferLimit'] === true) {
    throw new Error(
      `[${sourceId}] cell ${key} hit the transfer limit — a truncated cell reads downstream as ` +
        '"no creek here", so the cell is refused rather than half-used',
    );
  }
}

/**
 * ⛔ THE COVERAGE QUESTION, WHICH IS NOT THE SAME AS THE WATER QUESTION.
 *
 * A cell that comes back with zero features of any kind is not a cell with no
 * water; it is a cell NHD has not mapped, or a failed read that happened to
 * parse. In the Blue Ridge — the wettest terrain in the eastern United States —
 * a 0.1° cell (~100 km²) containing not one hydrographic feature is not
 * credible, and treating it as "no water anywhere in 100 km²" would put
 * `has_stream: false` on every parcel in it.
 *
 * So: an EMPTY cell yields `unknown` for every parcel in it. A cell with any
 * feature at all is positive evidence that NHD covers this locality, which is
 * what makes a parcel-level zero a real zero.
 */
export function cellHasCoverage(cell: NhdCell): boolean {
  return cell.flowlines.length + cell.waterbodies.length + cell.areas.length > 0;
}

/**
 * ⛔ DEDUPE — the single largest cost in the whole enricher, and a LIVE DATA BUG.
 *
 * `fetchCellBbox` splits a cell into quarters when the server reports a transfer
 * limit, then merges the parts with `flatMap` and NO dedupe. A feature that
 * straddles a quarter boundary is returned by every quarter it touches, so it
 * arrives 2, 4 — at MAX_SPLIT_DEPTH 3, up to 64 — times.
 *
 * Measured 2026-08-19 in the live cache: 11 of 60 cells carry duplicates, and
 * cell -82.7,35.2 holds FIVE area features of which FOUR are byte-identical
 * copies of one 181,882-vertex polygon (permanent_identifier
 * {C5294F09-594B-4875-BAB4-AD379E62BC1F}, same geometry hash). That cell alone
 * is 728,205 area vertices where 182,559 are real.
 *
 * TWO consequences, and the second is worse than the slowness:
 *   COST     — every duplicate is a full booleanDisjoint/intersection pass.
 *   CORRECTNESS — `computeWater` does `frontage += metres` and
 *                 `waterbodyOverlap +=`, so a duplicated feature is COUNTED
 *                 TWICE. Published frontage metres were inflated up to 4x,
 *                 worst in the densest hydrography — i.e. exactly the parcels a
 *                 buyer cares about most. `scoreWater` normalises any frontage
 *                 > 0 to the same 100, so the SCORE never moved and no gate
 *                 could see it; it only ever surfaced on the card.
 *
 * Applied on READ as well as on merge, deliberately: the duplicates are already
 * in the cached cells, and re-fetching 60 cells to fix them would cost egress
 * against a 0.5 rps host for data we already hold.
 */
export function dedupeCellFeatures<T extends { permanent_identifier: string; geometry: unknown }>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    // permanent_identifier is NHD's stable feature id and is the right key. Some
    // rows carry an empty one; those fall back to the geometry itself, so a
    // missing id degrades to "dedupe identical shapes" rather than to "keep
    // every copy".
    const id = item.permanent_identifier
      ? `id:${item.permanent_identifier}`
      : `geom:${createHash('sha256').update(JSON.stringify(item.geometry)).digest('hex')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** Dedupe every layer of a cell. Idempotent, pure, and safe to apply twice. */
export function dedupeCell(cell: NhdCell): NhdCell {
  return {
    ...cell,
    flowlines: dedupeCellFeatures(cell.flowlines),
    waterbodies: dedupeCellFeatures(cell.waterbodies),
    areas: dedupeCellFeatures(cell.areas),
  };
}

export type WaterInputs = {
  parcel: AnyPolygon;
  /** Per-parcel wall-clock budget in ms. Exceeded => `enrich_timeout`, which is
   *  UNKNOWN, never a measured absence. Omitted => no budget (tests, fixtures).
   *  Checked INSIDE the loops because the computation is synchronous: a timer
   *  cannot interrupt it, so the only way to bound it is to ask. */
  budgetMs?: number;
  /** True when `parcel` is the bbox rectangle rather than the recorded polygon. */
  parcelIsBboxOnly: boolean;
  cells: readonly NhdCell[];
  sourceUrl: string | null;
};

/**
 * ⛔ CLIP EACH CELL'S GEOMETRY TO ITS OWN CELL, ONCE — the only mitigation that
 * touches the residual cost, and the one neither plan proposed.
 *
 * Dedupe and the bbox prefilter both leave the giant NHDArea untouched, and by
 * construction they always will: `{C5294F09-…}` is a single legitimate feature
 * of 181,882 vertices whose envelope spans 0.83° x 0.89° — about 74 cells of
 * 0.1°. Every parcel in the region falls inside that envelope, so a feature-level
 * bbox test rejects nothing, and the full 182k-vertex polygon is fed to the
 * sweepline for every parcel in the cell.
 *
 * A cell only ever needs the part of a feature that lies within it. Clipping is
 * paid ONCE PER CELL rather than once per parcel, and the clipped geometry is
 * what every later parcel in that cell sees.
 *
 * ⛔ THE SKIRT IS SEARCH_RADIUS_M AND MUST NOT BE ZERO. Clipping to the bare
 * cell bbox would shorten any feature crossing a cell edge, so a parcel near the
 * boundary would report less frontage than it has, and a creek just outside the
 * cell would vanish from `min_dist_flowline_m` instead of being measured. That
 * is an unknown-rendered-as-absent — the same shape as the five prior
 * unknown-as-zero defects. With a 500 m skirt the bias is provably nil:
 * `computeWater` nulls any distance beyond SEARCH_RADIUS_M and `scoreWater`
 * discards anything past mid_m (400 m), so nothing the clip removes could have
 * changed an output.
 *
 * Applied on READ, memoised per cell key — the documented fallback for a cache
 * that is already populated. Re-fetching 60 cells to clip at write time would
 * spend egress against a 0.5 rps host to obtain data we already hold, and this
 * phase is required to open no socket at all.
 */
const NORMALISED_CELLS = new Map<string, NhdCell>();

/**
 * Does a clipped geometry still contain real coordinates?
 *
 * ⛔ `coordinates.length > 0` IS NOT ENOUGH, and assuming it was crashed a
 * corpus-wide re-derive. `turf.bboxClip` can return a MultiPolygon shaped like
 * `[[]]` or `[[[]]]` — non-empty at the top level, empty underneath — and
 * `booleanDisjoint` then dies on `feature1.coordinates[0] is not iterable`.
 * A single-parcel benchmark never hit it; running every cached parcel did, which
 * is the argument for the wider run.
 */
function hasRealCoordinates(coords: unknown): boolean {
  if (!Array.isArray(coords) || coords.length === 0) return false;
  if (typeof coords[0] === 'number') return coords.length >= 2;
  return coords.some(hasRealCoordinates);
}

function clipGeometry(geometry: unknown, box: BBox): unknown | null {
  try {
    const clipped = turf.bboxClip(turf.feature(geometry as never) as never, box as never);
    const g = (clipped as { geometry?: { coordinates?: unknown[] } }).geometry;
    if (!g || !hasRealCoordinates(g.coordinates)) return null;
    return g;
  } catch {
    // ⛔ A geometry turf cannot clip is KEPT UNCLIPPED, never dropped. Slower is
    // an acceptable outcome; silently losing a watercourse is not.
    return geometry;
  }
}

/** Dedupe + clip, memoised per cell key. Idempotent and pure. */
export function normaliseCell(cell: NhdCell): NhdCell {
  const memo = NORMALISED_CELLS.get(cell.key);
  if (memo) return memo;
  const box = expandBbox(cellBboxOf(cell.key), SEARCH_RADIUS_M);
  const deduped = dedupeCell(cell);
  const clip = <T extends { geometry: unknown }>(items: readonly T[]): T[] => {
    const out: T[] = [];
    for (const it of items) {
      const g = clipGeometry(it.geometry, box);
      if (g === null) continue; // provably outside the cell + 500 m skirt
      out.push({ ...it, geometry: g } as T);
    }
    return out;
  };
  const normalised: NhdCell = {
    ...deduped,
    flowlines: clip(deduped.flowlines),
    waterbodies: clip(deduped.waterbodies),
    areas: clip(deduped.areas),
  };
  NORMALISED_CELLS.set(cell.key, normalised);
  return normalised;
}

/** Bbox of ANY geojson geometry, by walking its coordinates. `bboxOf` in
 *  geometry.ts only handles polygons; flowlines are MultiLineString. */
export function geomBbox(geometry: unknown): BBox | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (x: unknown): void => {
    if (!Array.isArray(x)) return;
    if (typeof x[0] === 'number' && typeof x[1] === 'number') {
      const [lng, lat] = x as [number, number];
      if (lng < minX) minX = lng;
      if (lng > maxX) maxX = lng;
      if (lat < minY) minY = lat;
      if (lat > maxY) maxY = lat;
      return;
    }
    for (const y of x) walk(y);
  };
  walk((geometry as { coordinates?: unknown } | null)?.coordinates);
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

const bboxesOverlap = (a: BBox, b: BBox): boolean =>
  !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);

/**
 * ⛔ CHEAP REJECTION BEFORE THE EXACT PREDICATE.
 *
 * Every flowline, waterbody and area in a 0.1-degree cell was fed to
 * `booleanDisjoint` / distance maths against the parcel — a sweepline over the
 * full geometry pair — even when the two are kilometres apart. The parcel only
 * ever cares about features within SEARCH_RADIUS_M (500 m), which a bbox
 * comparison settles in four float compares.
 *
 * ⛔ THE SKIRT IS NOT OPTIONAL AND IS NOT COSMETIC. The search box is the
 * parcel's bbox expanded by SEARCH_RADIUS_M, so a feature that merely comes
 * NEAR the parcel still survives the filter. Rejecting on the bare parcel bbox
 * would silently null `min_dist_flowline_m` for every parcel whose creek is
 * outside the polygon but inside the radius — an unknown-rendered-as-absent,
 * which is the defect family this repo has now hit six times.
 *
 * Measured on the worst-case cell: 142 of 4,147 flowlines and 4 of 124
 * waterbodies survive — a 96.6% rejection rate that costs four compares each.
 */
export function prefilterCell(cell: NhdCell, searchBbox: BBox): NhdCell {
  const keep = <T extends { geometry: unknown }>(items: readonly T[]): T[] =>
    items.filter((it) => {
      const b = geomBbox(it.geometry);
      // A feature whose bbox cannot be computed is KEPT, never dropped. An
      // unparseable geometry is unknown, and unknown is not absent.
      return b === null ? true : bboxesOverlap(b, searchBbox);
    });
  return {
    ...cell,
    flowlines: keep(cell.flowlines),
    waterbodies: keep(cell.waterbodies),
    areas: keep(cell.areas),
  };
}

/**
 * THE COMPUTATION. Pure — no network, no clock — so every branch is reachable
 * from a fixture and the acceptance controls are real tests rather than a live
 * run someone has to trust.
 */
export function computeWater(inputs: WaterInputs): WaterSignal {
  const { parcel, sourceUrl } = inputs;

  // ⛔ COVERAGE IS DECIDED ON THE UNFILTERED CELLS, before any prefilter runs.
  // "this cell has no NHD coverage at all" and "no feature in this cell is near
  // this parcel" are different facts: the first is unknown, the second is a
  // measured absence of water. Filtering first would turn every parcel in a
  // covered-but-dry area into `nhd_no_coverage_in_cell`.
  if (inputs.cells.length === 0 || !inputs.cells.some(cellHasCoverage)) {
    return waterUnknown('nhd_no_coverage_in_cell', SEARCH_RADIUS_M, sourceUrl);
  }

  const searchBbox = expandBbox(bboxOf(parcel), SEARCH_RADIUS_M);

  // ⛔ MERGE ACROSS CELLS, THEN DEDUPE — not per cell. NHD returns a feature for
  // EVERY cell envelope it intersects, and `cellsCovering` loads every cell
  // within the search radius, so a creek near a cell boundary arrives two or
  // four times. `computeWater` does `frontage += metres`, so it was COUNTED
  // ONCE PER CELL. Measured 2026-08-19 on the cached corpus: 46 of 46 parcels
  // that load more than one cell share at least one flowline between them (12,
  // 17 features in the samples). That is a SECOND inflation bug, independent of
  // the quarter-split duplication inside a single cell, and per-cell deduping
  // cannot see it.
  //
  // Then clip to the PARCEL's search box rather than the cell's. It is a far
  // smaller box, so it removes far more geometry, and it is provably lossless:
  // frontage is measured INSIDE the parcel and every distance is nulled beyond
  // SEARCH_RADIUS_M, so nothing outside this box can change any output.
  const merged: NhdCell = prefilterCell(
    {
      key: 'merged',
      bbox: searchBbox,
      flowlines: dedupeCellFeatures(inputs.cells.flatMap((c) => c.flowlines)),
      waterbodies: dedupeCellFeatures(inputs.cells.flatMap((c) => c.waterbodies)),
      areas: dedupeCellFeatures(inputs.cells.flatMap((c) => c.areas)),
    },
    searchBbox,
  );
  const clipToSearch = <T extends { geometry: unknown }>(items: readonly T[]): T[] => {
    const out: T[] = [];
    for (const it of items) {
      const g = clipGeometry(it.geometry, searchBbox);
      if (g === null) continue;
      out.push({ ...it, geometry: g } as T);
    }
    return out;
  };
  const cells: NhdCell[] = [
    {
      ...merged,
      flowlines: clipToSearch(merged.flowlines),
      waterbodies: clipToSearch(merged.waterbodies),
      areas: clipToSearch(merged.areas),
    },
  ];
  const deadline =
    typeof inputs.budgetMs === 'number' ? Date.now() + inputs.budgetMs : Number.POSITIVE_INFINITY;
  let overBudget = false;

  const frontage: Record<Regime, number> = {
    perennial: 0, intermittent: 0, ephemeral: 0, unspecified: 0,
  };
  const named = new Set<string>();
  let minFlowlineDist = Number.POSITIVE_INFINITY;
  let minWaterbodyDist = Number.POSITIVE_INFINITY;
  let waterbodyOverlap = 0;
  let hasPond = false;
  let hasRiver = false;

  outer: for (const cell of cells) {
    for (const line of cell.flowlines) {
      // Checked per FEATURE, not per cell: one cell can hold thousands, and a
      // budget only observed between cells would overshoot by the whole cell.
      if (Date.now() > deadline) { overBudget = true; break outer; }
      // ⛔ Synthetic and dug channels are excluded BEFORE any measurement, not
      // subtracted afterwards — an artificial path through a pond would
      // otherwise add its own length to the frontage of the pond it crosses.
      if (!isWatercourseFType(line.ftype)) continue;

      const dist = polygonToLineDistanceM(parcel, line.geometry);
      if (dist < minFlowlineDist) minFlowlineDist = dist;
      if (dist > 0) continue;

      const metres = lengthInsidePolygonM(parcel, line.geometry);
      if (metres <= 0) continue;
      frontage[line.regime] += metres;
      if (line.gnis_name) named.add(line.gnis_name);
    }

    for (const wb of cell.waterbodies) {
      if (Date.now() > deadline) { overBudget = true; break outer; }
      const dist = polygonToPolygonDistanceM(parcel, wb.geometry);
      if (dist < minWaterbodyDist) minWaterbodyDist = dist;
      if (dist > 0) continue;
      const overlap = overlapAreaM2(parcel, wb.geometry);
      if (overlap <= 0) continue;
      waterbodyOverlap += overlap;
      if (isPerennialWaterbodyFCode(wb.fcode)) hasPond = true;
      if (wb.gnis_name) named.add(wb.gnis_name);
    }

    for (const area of cell.areas) {
      if (Date.now() > deadline) { overBudget = true; break outer; }
      // has_river from GEOMETRY: NHD maps a watercourse as an AREA only once it
      // is wide enough to have two drawn banks. A creek is a line and nothing
      // else; a river is a line AND an area. So this is a width measurement
      // made by USGS, not the word "River" in a label.
      if (!isWatercourseFType(area.ftype)) continue;
      const dist = polygonToPolygonDistanceM(parcel, area.geometry);
      // ⛔ AN OVERLAPPING RIVER AREA IS WATER **ON** THE PARCEL, and the
      // distance figures have to agree with that. The first live run produced
      // `has_river: true` beside `distance_to_water_m: 8.4` on 37199:071900645676000
      // — a river polygon clipping the parcel while its centreline ran 8.4 m
      // outside. Both numbers were individually right and together they read as
      // a contradiction. Area surface now counts toward the same distance and
      // overlap totals as a lake does; only `has_pond` stays specific to
      // layer 12, because a river is not a pond.
      if (dist < minWaterbodyDist) minWaterbodyDist = dist;
      if (dist > 0) continue;
      waterbodyOverlap += overlapAreaM2(parcel, area.geometry);
      hasRiver = true;
      if (area.gnis_name) named.add(area.gnis_name);
    }
  }

  // ⛔ ABANDON THE PARTIAL RESULT ENTIRELY. A half-finished pass has measured
  // some features and not others, so its frontage is a FLOOR and its distances
  // are upper bounds — publishing them would be a measurement-shaped guess. And
  // because the budget is exceeded precisely where hydrography is dense, the
  // partial would understate water exactly where there is most of it.
  if (overBudget) return waterUnknown('enrich_timeout', SEARCH_RADIUS_M, sourceUrl);

  const totalFrontage =
    frontage.perennial + frontage.intermittent + frontage.ephemeral + frontage.unspecified;

  // Out of range is a MEASUREMENT ("not within 500 m"), expressed as null with
  // search_radius_m beside it, never as a made-up large number.
  const flowDist = minFlowlineDist <= SEARCH_RADIUS_M ? round1(minFlowlineDist) : null;
  const wbDist = minWaterbodyDist <= SEARCH_RADIUS_M ? round1(minWaterbodyDist) : null;
  const nearest = [flowDist, wbDist].filter((d): d is number => d !== null);

  return {
    // ⛔ has_stream is about FRONTAGE, not proximity. A creek 6 m away is not on
    // the property and the buyer cannot fish in it.
    has_stream: totalFrontage > 0,
    has_river: hasRiver,
    has_pond: hasPond,
    water_frontage_m: round1(totalFrontage),
    frontage_by_regime_m: {
      perennial: round1(frontage.perennial),
      intermittent: round1(frontage.intermittent),
      ephemeral: round1(frontage.ephemeral),
      unspecified: round1(frontage.unspecified),
    },
    distance_to_water_m: nearest.length > 0 ? Math.min(...nearest) : null,
    min_dist_flowline_m: flowDist,
    min_dist_waterbody_m: wbDist,
    waterbody_overlap_m2: round1(waterbodyOverlap),
    named_waters: [...named].sort(),
    search_radius_m: SEARCH_RADIUS_M,
    water_confidence: inputs.parcelIsBboxOnly ? 'bbox-approximation' : 'polygon-intersection',
    water_unknown_reason: null,
    source_url: sourceUrl,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Rectangle polygon from a bbox — the degraded input for a parcel with no
 *  recorded rings. Only ever used with `parcelIsBboxOnly: true`. */
export function bboxPolygon(bbox: BBox): AnyPolygon {
  return turf.bboxPolygon(bbox).geometry as AnyPolygon;
}
