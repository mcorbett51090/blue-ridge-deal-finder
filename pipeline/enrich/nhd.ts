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
import type { FetchClient } from '../fetch/client.ts';
import { assertNotInBandError } from '../fetch/arcgis.ts';
import {
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
  const bbox = cellBboxOf(key);
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

export type WaterInputs = {
  parcel: AnyPolygon;
  /** True when `parcel` is the bbox rectangle rather than the recorded polygon. */
  parcelIsBboxOnly: boolean;
  cells: readonly NhdCell[];
  sourceUrl: string | null;
};

/**
 * THE COMPUTATION. Pure — no network, no clock — so every branch is reachable
 * from a fixture and the acceptance controls are real tests rather than a live
 * run someone has to trust.
 */
export function computeWater(inputs: WaterInputs): WaterSignal {
  const { parcel, cells, sourceUrl } = inputs;

  if (cells.length === 0 || !cells.some(cellHasCoverage)) {
    return waterUnknown('nhd_no_coverage_in_cell', SEARCH_RADIUS_M, sourceUrl);
  }

  const frontage: Record<Regime, number> = {
    perennial: 0, intermittent: 0, ephemeral: 0, unspecified: 0,
  };
  const named = new Set<string>();
  let minFlowlineDist = Number.POSITIVE_INFINITY;
  let minWaterbodyDist = Number.POSITIVE_INFINITY;
  let waterbodyOverlap = 0;
  let hasPond = false;
  let hasRiver = false;

  for (const cell of cells) {
    for (const line of cell.flowlines) {
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
      // has_river from GEOMETRY: NHD maps a watercourse as an AREA only once it
      // is wide enough to have two drawn banks. A creek is a line and nothing
      // else; a river is a line AND an area. So this is a width measurement
      // made by USGS, not the word "River" in a label.
      if (!isWatercourseFType(area.ftype)) continue;
      const dist = polygonToPolygonDistanceM(parcel, area.geometry);
      if (dist > 0) continue;
      hasRiver = true;
      if (area.gnis_name) named.add(area.gnis_name);
    }
  }

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
