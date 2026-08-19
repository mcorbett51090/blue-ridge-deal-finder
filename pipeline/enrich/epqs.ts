/**
 * SLOPE — USGS EPQS point elevation (plan §5.6, C31).
 *
 * ⛔ THIS SERVICE ANSWERS ERRORS WITH PLAIN TEXT AT HTTP 200, AND LABELS THEM
 * application/json. Measured 2026-08-19, honest UA, three requests:
 *
 *   x=-81.8135 y=36.1478  -> 200, 207 B, {"value":"1188.127319336", …}
 *   x=-999     y=-999     -> 200,  49 B, `The operation was attempted on an
 *                                         empty geometry.`
 *   x=-40      y=30       -> 200,  77 B, `Call failed.  [Failed cloud
 *                                         operation: Open, Path: /vsimem/…]`
 *
 * Every one of those is `Content-Type: application/json`. So:
 *   - a status check passes all three;
 *   - a content-type check passes all three;
 *   - JSON.parse throws on two of them, and inside client.ts's retry loop that
 *     throw becomes five requests and a message that names neither the body nor
 *     the coordinate.
 * Hence fetchPointService returns raw text and the parsing lives here.
 *
 * ⛔ AND `value` IS A STRING. `{"value":"1188.127319336"}` — not a number. A
 * schema that says z.number() rejects a healthy response; a reader that does
 * arithmetic on it concatenates. Both halves are asserted below.
 */
import { createHash } from 'node:crypto';
import * as turf from '@turf/turf';
import { z } from 'zod';
import type { FetchClient } from '../fetch/client.ts';
import type { PointService } from '../fetch/types.ts';
import { slopeUnknown, type SlopeSignal } from './schema.ts';
import type { AnyPolygon, BBox } from './geometry.ts';

export const EPQS_SERVICE = 'usgs-epqs';

/** Samples per parcel: centroid + 4 bbox-inset points (plan §5.6). */
export const SAMPLES_PER_PARCEL = 5;

/** The sentinel EPQS returns for "no elevation data at this point". */
export const EPQS_NO_DATA = -1000000;

export const EpqsResponseSchema = z.object({
  location: z.object({ x: z.number(), y: z.number() }),
  /** ⛔ STRING on the wire. Coerced here, at the boundary, exactly once. */
  value: z.union([z.string(), z.number()]),
  rasterId: z.number().optional(),
  resolution: z.number().optional(),
});

export class EpqsBodyError extends Error {
  readonly kind: 'non-json' | 'shape' | 'no-data';
  readonly bodyHead: string;
  constructor(kind: 'non-json' | 'shape' | 'no-data', body: string) {
    super(`EPQS body rejected (${kind}): ${JSON.stringify(body.slice(0, 120))}`);
    this.name = 'EpqsBodyError';
    this.kind = kind;
    this.bodyHead = body.slice(0, 120);
  }
}

/**
 * Text → elevation in metres. Throws EpqsBodyError on every shape that is not a
 * measurement — it NEVER returns NaN, null-as-zero, or a partially-parsed
 * object, because each of those flows downstream as a number.
 */
export function parseElevation(text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The measured error path. Named as its own kind so the caller can record
    // `epqs_non_json_body` rather than a generic parse failure.
    throw new EpqsBodyError('non-json', text);
  }
  const result = EpqsResponseSchema.safeParse(parsed);
  if (!result.success) throw new EpqsBodyError('shape', text);

  const raw = result.data.value;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) throw new EpqsBodyError('shape', text);
  // ⛔ -1000000 is EPQS's "no data here" sentinel. It is a perfectly valid
  // number and would sail through any range check aimed at typos, then turn
  // into a slope of several million percent.
  if (value <= EPQS_NO_DATA) throw new EpqsBodyError('no-data', text);
  return value;
}

/** Fingerprint of a response's key set — what schema_fingerprint is taken over
 *  for a service that publishes no schema document. */
export function responseShapeFingerprint(body: unknown): string {
  const keys = body && typeof body === 'object' ? Object.keys(body as object).sort() : [];
  return createHash('sha256').update(JSON.stringify({ keys })).digest('hex');
}

/**
 * The 5 sample points: centroid, then the 4 bbox corners pulled 20% inward.
 * Inset rather than the raw corners because a bbox corner of a non-rectangular
 * parcel is usually OUTSIDE the parcel, and elevation at a point you do not own
 * is not a fact about the parcel.
 */
export function samplePoints(bbox: BBox, parcel: AnyPolygon): [number, number][] {
  const [minX, minY, maxX, maxY] = bbox;
  const dx = (maxX - minX) * 0.2;
  const dy = (maxY - minY) * 0.2;
  const centre = turf.centroid(turf.feature(parcel)).geometry.coordinates;
  return [
    [centre[0] as number, centre[1] as number],
    [minX + dx, minY + dy],
    [maxX - dx, minY + dy],
    [minX + dx, maxY - dy],
    [maxX - dx, maxY - dy],
  ];
}

/** ⛔ THE CACHE KEY, rounded to 5 dp (~1 m). EPQS's own raster is 1 m, so a
 *  finer key would cache-miss on points that resolve to the same pixel. */
export function pointKey(lng: number, lat: number): string {
  return `${lng.toFixed(5)},${lat.toFixed(5)}`;
}

export function epqsParams(lng: number, lat: number): Record<string, string> {
  return {
    x: String(lng), y: String(lat), units: 'Meters', wkid: '4326', includeDate: 'true',
  };
}

export function epqsSourceUrl(service: PointService, lng: number, lat: number): string {
  const url = new URL(service.url);
  for (const [k, v] of Object.entries(epqsParams(lng, lat))) url.searchParams.set(k, v);
  return url.toString();
}

/**
 * ⛔ THE CONTROL PROBE, RUN BEFORE THE SERVICE IS USED. The negative half is
 * the load-bearing one: it asserts that the error path is STILL plain text at
 * HTTP 200. If EPQS ever starts returning JSON errors, parseElevation's
 * non-json branch stops firing and a `{"error":…}` body would fall to the shape
 * branch — still refused, but for the wrong reason and with the wrong
 * unknown_reason on 25,000 rows. The control going red is how we find out.
 */
export async function runControlProbe(
  client: FetchClient,
  service: PointService,
): Promise<{ positive: number; negativeWasNonJson: boolean }> {
  const pos = await client.fetchPointService(service, service.control_probe.positive.params);
  const positive = parseElevation(pos.text);

  const neg = await client.fetchPointService(service, service.control_probe.negative.params);
  let negativeWasNonJson = false;
  try {
    parseElevation(neg.text);
  } catch (err) {
    negativeWasNonJson = err instanceof EpqsBodyError && err.kind === 'non-json';
  }
  if (!negativeWasNonJson) {
    throw new Error(
      `[${service.id}] CONTROL PROBE FAILED: the negative probe did not produce the measured ` +
        `plain-text-at-200 error shape. Body was ${JSON.stringify(neg.text.slice(0, 160))}. ` +
        'The parser is written against a body shape this service no longer produces.',
    );
  }
  return { positive, negativeWasNonJson };
}

export type ElevationSample = { lng: number; lat: number; elevation_m: number };

/**
 * Slope from the 5 samples: the gradient from the centroid to each of the four
 * inset corners, as a percentage.
 *
 * ⛔ WHAT THIS IS AND IS NOT. It is a 5-point sample of a bare-earth DEM, not a
 * terrain analysis. On a parcel with a bench and a bluff it reports the average
 * of the two, and the receipt says so. It is enough to separate buildable from
 * unbuildable, which is what `livability` needs; it is not a substitute for a
 * site visit and the site must not render it as one.
 */
export function slopeFromSamples(samples: readonly ElevationSample[]): SlopeSignal {
  if (samples.length < 2) {
    return slopeUnknown('epqs_sample_incomplete', SAMPLES_PER_PARCEL, samples.length);
  }
  const centre = samples[0];
  if (!centre) return slopeUnknown('epqs_sample_incomplete', SAMPLES_PER_PARCEL, samples.length);

  const slopes: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (!s) continue;
    const runM = turf.distance(
      turf.point([centre.lng, centre.lat]),
      turf.point([s.lng, s.lat]),
      { units: 'meters' },
    );
    if (runM < 1) continue; // a zero run makes an infinite slope, not a steep one
    slopes.push((Math.abs(s.elevation_m - centre.elevation_m) / runM) * 100);
  }
  if (slopes.length === 0) {
    return slopeUnknown('epqs_sample_incomplete', SAMPLES_PER_PARCEL, samples.length);
  }
  const elevations = samples.map((s) => s.elevation_m);
  return {
    mean_slope_pct: round1(slopes.reduce((a, b) => a + b, 0) / slopes.length),
    max_slope_pct: round1(Math.max(...slopes)),
    elevation_m: round1(centre.elevation_m),
    elevation_range_m: round1(Math.max(...elevations) - Math.min(...elevations)),
    samples_requested: SAMPLES_PER_PARCEL,
    samples_returned: samples.length,
    slope_unknown_reason: null,
    source_url: null,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
