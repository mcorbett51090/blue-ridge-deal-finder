/**
 * Esri → GeoJSON, and the distance primitives the water signal is built on.
 *
 * Pure. No network, no clock, no fs. Everything here is exercised by fixtures
 * with hand-computable answers, because "the frontage number looks plausible"
 * is not a test.
 *
 * ⛔ ESRI RINGS ARE NOT GEOJSON RINGS, AND THE DIFFERENCE IS SILENT.
 * Esri encodes a polygon as a flat list of rings with orientation carrying the
 * meaning: CLOCKWISE is an outer ring, COUNTER-CLOCKWISE is a hole in the
 * preceding outer ring. GeoJSON wants `[[outer], [hole], [hole]]` per polygon
 * and uses the opposite winding convention for the outer ring. Handing Esri
 * rings straight to turf produces a polygon that is the right SHAPE and the
 * wrong TOPOLOGY: a parcel with a hole in it (very common — an inholding, a
 * right-of-way) silently gains the area of the hole, and any point-in-polygon
 * test inside the hole answers `true`. Nothing throws.
 */
import { createHash } from 'node:crypto';
import * as turf from '@turf/turf';

export type Ring = number[][];
export type BBox = [number, number, number, number];

/**
 * Minimal structural GeoJSON geometry types, declared HERE rather than imported
 * from `geojson`. turf v7 stopped re-exporting them, and adding a bare
 * `import type { Polygon } from 'geojson'` would put a module in the import
 * graph that scripts/verify-egress-allowlist.mjs does not permit — a
 * type-only import is invisible at runtime but not to a source scanner, and
 * arguing with the allowlist to save six lines is the wrong trade.
 */
export type PolygonGeom = { type: 'Polygon'; coordinates: number[][][] };
export type MultiPolygonGeom = { type: 'MultiPolygon'; coordinates: number[][][][] };
export type LineStringGeom = { type: 'LineString'; coordinates: number[][] };
export type MultiLineStringGeom = { type: 'MultiLineString'; coordinates: number[][][] };
export type AnyPolygon = PolygonGeom | MultiPolygonGeom;
export type AnyLine = LineStringGeom | MultiLineStringGeom;

/** Signed area (shoelace). Positive = clockwise in Esri's convention. */
export function signedArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    if (!a || !b || a.length < 2 || b.length < 2) continue;
    sum += (b[0] as number) * (a[1] as number) - (a[0] as number) * (b[1] as number);
  }
  return sum / 2;
}

function closeRing(ring: Ring): Ring {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (!first || !last) return ring;
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

/**
 * Esri rings → a GeoJSON MultiPolygon geometry, holes attached to the outer
 * ring they follow. Rings with fewer than 4 positions (after closing) are
 * dropped: a degenerate ring is not a polygon and turf throws on it.
 */
export function ringsToMultiPolygon(rings: readonly Ring[]): MultiPolygonGeom | null {
  const polygons: Ring[][] = [];
  for (const raw of rings) {
    const ring = closeRing(raw);
    if (ring.length < 4) continue;
    const clockwise = signedArea(ring) > 0;
    if (clockwise || polygons.length === 0) {
      // An outer ring — or a leading hole, which is malformed input; treating it
      // as an outer ring keeps the area rather than dropping it silently.
      polygons.push([ring]);
    } else {
      (polygons[polygons.length - 1] as Ring[]).push(ring);
    }
  }
  if (polygons.length === 0) return null;
  return { type: 'MultiPolygon', coordinates: polygons as number[][][][] };
}

/** Esri paths → a GeoJSON MultiLineString. Degenerate paths are dropped. */
export function pathsToMultiLineString(paths: readonly Ring[]): MultiLineStringGeom | null {
  const kept = paths.filter((p) => p.length >= 2);
  if (kept.length === 0) return null;
  return { type: 'MultiLineString', coordinates: kept as number[][][] };
}

export function bboxOf(geom: AnyPolygon): BBox {
  const b = turf.bbox({ type: 'Feature', properties: {}, geometry: geom });
  return [b[0] as number, b[1] as number, b[2] as number, b[3] as number];
}

/**
 * Expand a bbox by `metres` on all sides. Latitude degrees are ~constant;
 * longitude degrees shrink with cos(lat), which at 36°N is a 24% difference —
 * enough that ignoring it under-searches the east and west edges.
 */
export function expandBbox(bbox: BBox, metres: number): BBox {
  const [minX, minY, maxX, maxY] = bbox;
  const dLat = metres / 111_320;
  const midLat = (minY + maxY) / 2;
  const dLng = metres / (111_320 * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
  return [minX - dLng, minY - dLat, maxX + dLng, maxY + dLat];
}

/**
 * THE GEOMETRY CACHE KEY. Stable under re-serialisation, sensitive to any real
 * coordinate change. Truncated to 32 hex chars to match the warehouse's
 * content_hash convention (pipeline/store/warehouse.ts).
 */
export function geometryHash(rings: readonly Ring[]): string {
  return createHash('sha256').update(JSON.stringify(rings)).digest('hex').slice(0, 32);
}

/**
 * Minimum distance in metres between a polygon and a line, 0 when they touch.
 *
 * ⛔ THIS IS A DISCRETE APPROXIMATION AND THE RECEIPT SAYS SO. It takes the
 * minimum over (every polygon vertex → the line) AND (every line vertex → the
 * polygon boundary). Both directions are needed: checking only polygon vertices
 * misses a line that passes close to the middle of a long parcel edge, which is
 * the common case for a road-parallel creek. It is exact wherever either
 * geometry has a vertex at the closest approach, and it never UNDER-reports,
 * which is the safe direction for a "how far is the water" claim.
 */
export function polygonToLineDistanceM(
  polygon: AnyPolygon,
  line: AnyLine,
): number {
  const polyFeature = turf.feature(polygon);
  const lineFeature = turf.feature(line);
  if (turf.booleanIntersects(polyFeature, lineFeature)) return 0;

  let best = Number.POSITIVE_INFINITY;
  const lineStrings = line.type === 'LineString' ? [line.coordinates] : line.coordinates;

  for (const coords of lineStrings) {
    if (coords.length < 2) continue;
    const ls = turf.lineString(coords as number[][]);
    for (const c of turf.coordAll(polyFeature)) {
      best = Math.min(best, turf.pointToLineDistance(turf.point(c), ls, { units: 'meters' }));
    }
  }
  const boundary = turf.polygonToLine(polyFeature);
  const boundaries = boundary.type === 'FeatureCollection' ? boundary.features : [boundary];
  for (const b of boundaries) {
    const g = b.geometry;
    const segs = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const ls = turf.lineString(seg as number[][]);
      for (const coords of lineStrings) {
        for (const c of coords) {
          best = Math.min(best, turf.pointToLineDistance(turf.point(c as number[]), ls, { units: 'meters' }));
        }
      }
    }
  }
  return best;
}

/** Same idea, polygon to polygon. 0 when they overlap or touch. */
export function polygonToPolygonDistanceM(
  a: AnyPolygon,
  b: AnyPolygon,
): number {
  const fa = turf.feature(a);
  const fb = turf.feature(b);
  if (turf.booleanIntersects(fa, fb)) return 0;
  const lineB = turf.polygonToLine(fb);
  const lines = lineB.type === 'FeatureCollection' ? lineB.features : [lineB];
  let best = Number.POSITIVE_INFINITY;
  for (const l of lines) {
    const g = l.geometry;
    const segs = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
    for (const seg of segs) {
      if (seg.length < 2) continue;
      best = Math.min(best, polygonToLineDistanceM(a, turf.lineString(seg as number[][]).geometry));
    }
  }
  return best;
}

/**
 * Length in metres of the part of `line` that lies INSIDE `polygon`.
 *
 * ⛔ lineSplit alone is not the answer. It returns every segment either side of
 * the boundary, so summing them all gives the length of the whole flowline —
 * which for a creek running past a 7-acre parcel is a frontage claim off by an
 * order of magnitude. Each segment's MIDPOINT is tested for containment, and
 * only the contained ones are summed. A line entirely within the polygon is not
 * split at all, so that case is handled explicitly rather than falling through
 * to zero.
 */
export function lengthInsidePolygonM(
  polygon: AnyPolygon,
  line: AnyLine,
): number {
  const polyFeature = turf.feature(polygon);
  const lineStrings = line.type === 'LineString' ? [line.coordinates] : line.coordinates;
  let total = 0;

  for (const coords of lineStrings) {
    if (coords.length < 2) continue;
    const ls = turf.lineString(coords as number[][]);
    if (!turf.booleanIntersects(polyFeature, ls)) continue;

    let split;
    try {
      split = turf.lineSplit(ls, polyFeature);
    } catch {
      split = null;
    }
    const pieces = split && split.features.length > 0 ? split.features : [ls];
    for (const piece of pieces) {
      const lenKm = turf.length(piece, { units: 'kilometers' });
      if (lenKm === 0) continue;
      const mid = turf.along(piece, lenKm / 2, { units: 'kilometers' });
      if (turf.booleanPointInPolygon(mid, polyFeature)) total += lenKm * 1000;
    }
  }
  return total;
}

/** Area in m² of the overlap between two polygons. 0 when they do not overlap. */
export function overlapAreaM2(
  a: AnyPolygon,
  b: AnyPolygon,
): number {
  try {
    const inter = turf.intersect(turf.featureCollection([turf.feature(a), turf.feature(b)]));
    return inter ? turf.area(inter) : 0;
  } catch {
    return 0;
  }
}
