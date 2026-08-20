/**
 * P7 acceptance suite. Every test below has a CONTROL that proves it can fail —
 * either an adjacent case that must come out differently, or an assertion that
 * the naive implementation would pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { looksLikeRobotsTxt, evaluateLiveRobots } from '../pipeline/fetch/guard.ts';
import {
  attr, cellsCovering, cellKeyOf, computeWater, dedupeCell, isPerennialWaterbodyFCode,
  isWatercourseFType, normaliseCell, parseAreas, parseFlowlines, prefilterCell, regimeOfFCode,
  SEARCH_RADIUS_M, type NhdCell,
} from '../pipeline/enrich/nhd.ts';
import { coverageFrom, computeFlood, isSfhaZone, isUndeterminedZone, parseFloodZones } from '../pipeline/enrich/nfhl.ts';
import { EpqsBodyError, parseElevation, slopeFromSamples, pointKey } from '../pipeline/enrich/epqs.ts';
import { computeRoad } from '../pipeline/enrich/tiger.ts';
import { WaterSignalSchema, FloodSignalSchema } from '../pipeline/enrich/schema.ts';
import { geometryHash, ringsToMultiPolygon, signedArea, type AnyPolygon } from '../pipeline/enrich/geometry.ts';
import * as turf from '@turf/turf';

const F = join(import.meta.dirname, '..', 'fixtures', 'enrich');
const load = (n: string): unknown => JSON.parse(readFileSync(join(F, n), 'utf8'));
const text = (n: string): string => readFileSync(join(F, n), 'utf8');

function parcelPolygon(name = 'parcel-square.json'): AnyPolygon {
  const rings = (load(name) as { rings: number[][][] }).rings;
  const mp = ringsToMultiPolygon(rings);
  assert.ok(mp, 'fixture parcel must produce a polygon');
  return mp;
}

function cell(flowFixture: string | null, wbFixture: string | null, areaFixture: string | null): NhdCell {
  return {
    key: '-81.8,36.1',
    bbox: [-81.8, 36.1, -81.7, 36.2],
    flowlines: flowFixture ? parseFlowlines(load(flowFixture)) : [],
    waterbodies: wbFixture ? parseAreas(load(wbFixture), 'usgs-nhd-waterbody') : [],
    areas: areaFixture ? parseAreas(load(areaFixture), 'usgs-nhd-area') : [],
  };
}

// ───────────────────────────────────────────────────────────── acceptance 1 ──
// THREE DISTINCT OUTCOMES, NOT TWO.

test('acceptance 1a: a parcel with a creek crossing it reports has_stream and frontage > 0', () => {
  const w = computeWater({
    parcel: parcelPolygon(),
    parcelIsBboxOnly: false,
    cells: [cell('nhd-flowline-perennial.json', null, null)],
    sourceUrl: null,
  });
  assert.equal(w.has_stream, true);
  assert.ok(w.water_frontage_m !== null && w.water_frontage_m > 0, 'frontage must be a positive number');
  // The line crosses the whole square at 36.105, so the frontage is the square's
  // width there: 0.01 deg of longitude at 36.105N ≈ 899 m. Asserted as a real
  // number with a tolerance, not merely "> 0" — a truthy check passes on 1 mm.
  assert.ok(
    Math.abs((w.water_frontage_m as number) - 899) < 15,
    `expected ~899 m of frontage, got ${w.water_frontage_m}`,
  );
  assert.equal(w.min_dist_flowline_m, 0);
  assert.equal(w.water_unknown_reason, null);
  assert.equal(w.water_confidence, 'polygon-intersection');
  assert.deepEqual(w.named_waters, ['Fixture Creek']);
});

test('acceptance 1b CONTROL: a parcel with no water reports has_stream FALSE — measured, not unknown', () => {
  const w = computeWater({
    parcel: parcelPolygon(),
    parcelIsBboxOnly: false,
    cells: [cell('nhd-flowline-distant.json', null, null)],
    sourceUrl: null,
  });
  assert.equal(w.has_stream, false, 'a searched parcel with no crossing creek is FALSE');
  assert.equal(w.water_frontage_m, 0);
  // ⛔ and it is NOT unknown. This is the distinction the whole file exists for.
  assert.equal(w.water_unknown_reason, null);
  // The creek is ~2.8 km away, beyond the 500 m search radius, so the distance
  // is null WITH search_radius_m beside it — never a made-up large number.
  assert.equal(w.min_dist_flowline_m, null);
  assert.equal(w.search_radius_m, SEARCH_RADIUS_M);
});

test('acceptance 1c CONTROL: a parcel outside NHD coverage is UNKNOWN, not false', () => {
  const w = computeWater({
    parcel: parcelPolygon(),
    parcelIsBboxOnly: false,
    cells: [cell('nhd-empty.json', 'nhd-empty.json', 'nhd-empty.json')],
    sourceUrl: null,
  });
  assert.equal(w.water_unknown_reason, 'nhd_no_coverage_in_cell');
  assert.equal(w.has_stream, null, '⛔ unknown is null, NEVER false');
  assert.equal(w.water_frontage_m, null, '⛔ unknown is null, NEVER 0');
  assert.equal(w.distance_to_water_m, null);
});

test('acceptance 1 CONTROL: the three outcomes are genuinely distinct values', () => {
  const p = parcelPolygon();
  const yes = computeWater({ parcel: p, parcelIsBboxOnly: false, cells: [cell('nhd-flowline-perennial.json', null, null)], sourceUrl: null });
  const no = computeWater({ parcel: p, parcelIsBboxOnly: false, cells: [cell('nhd-flowline-distant.json', null, null)], sourceUrl: null });
  const unk = computeWater({ parcel: p, parcelIsBboxOnly: false, cells: [cell('nhd-empty.json', null, null)], sourceUrl: null });
  const outcomes = new Set([String(yes.has_stream), String(no.has_stream), String(unk.has_stream)]);
  assert.equal(outcomes.size, 3, `expected three distinct outcomes, got ${[...outcomes].join('/')}`);
});

// ───────────────────────────────────────────────────────────── acceptance 2 ──
// PERENNIAL vs INTERMITTENT vs EPHEMERAL vs UNSPECIFIED.

test('acceptance 2: FCode 46003 reports INTERMITTENT frontage and ZERO perennial frontage', () => {
  const w = computeWater({
    parcel: parcelPolygon(),
    parcelIsBboxOnly: false,
    cells: [cell('nhd-flowline-intermittent.json', null, null)],
    sourceUrl: null,
  });
  const regimes = w.frontage_by_regime_m;
  assert.ok(regimes);
  assert.equal(regimes.perennial, 0, '⛔ a dry-season ditch must not report perennial frontage');
  assert.ok(regimes.intermittent > 800, `expected the frontage under intermittent, got ${JSON.stringify(regimes)}`);
});

test('acceptance 2 CONTROL: the SAME geometry with FCode 46006 reports it as perennial', () => {
  // Identical fixture geometry; only the FCode differs. If this and the test
  // above ever agree, the classifier is not reading the code at all.
  const inter = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [cell('nhd-flowline-intermittent.json', null, null)], sourceUrl: null });
  const peren = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [cell('nhd-flowline-perennial.json', null, null)], sourceUrl: null });
  assert.equal(inter.water_frontage_m, peren.water_frontage_m, 'same geometry, so the same total');
  assert.notDeepEqual(inter.frontage_by_regime_m, peren.frontage_by_regime_m, 'but NOT the same breakdown');
  assert.ok((peren.frontage_by_regime_m as { perennial: number }).perennial > 800);
  assert.equal((peren.frontage_by_regime_m as { intermittent: number }).intermittent, 0);
});

test('⛔ FCode 46000 (no hydrographic category) is UNSPECIFIED, never perennial', () => {
  // 342 of 499 flowlines in the measured Watauga cell carry this code. Calling
  // it perennial would make 69% of our water claims invented.
  assert.equal(regimeOfFCode(46000), 'unspecified');
  assert.equal(regimeOfFCode(46006), 'perennial');
  assert.equal(regimeOfFCode(46003), 'intermittent');
  assert.equal(regimeOfFCode(46007), 'ephemeral');
  const w = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [cell('nhd-flowline-unspecified.json', null, null)], sourceUrl: null });
  assert.equal((w.frontage_by_regime_m as { perennial: number }).perennial, 0);
  assert.ok((w.frontage_by_regime_m as { unspecified: number }).unspecified > 800);
});

test('⛔ an ArtificialPath through a waterbody is NOT creek frontage', () => {
  assert.equal(isWatercourseFType(460), true);
  assert.equal(isWatercourseFType(558), false, 'ArtificialPath is a topology device, not a stream');
  const w = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [cell('nhd-flowline-artificial-path.json', null, null)], sourceUrl: null });
  assert.equal(w.has_stream, false);
  assert.equal(w.water_frontage_m, 0);
});

test('has_river comes from the AREA layer — a measured width, not the word "River"', () => {
  const w = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [cell(null, null, 'nhd-area-river.json')], sourceUrl: null });
  assert.equal(w.has_river, true);
  // and an overlapping river area is water ON the parcel, so the distance agrees
  assert.equal(w.distance_to_water_m, 0);
  assert.ok((w.waterbody_overlap_m2 as number) > 0);
  const noRiver = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [cell('nhd-flowline-perennial.json', null, null)], sourceUrl: null });
  assert.equal(noRiver.has_river, false, 'CONTROL: a creek line alone is not a river');
});

// ───────────────────────────────────────── the NHD attribute-casing trap ──
test('⛔ attr() reads NHD attributes case-insensitively across layers', () => {
  // Measured: layer 6 -> lowercase, layers 9/12 -> UPPERCASE, same service.
  assert.equal(attr({ fcode: 46006 }, 'fcode'), 46006);
  assert.equal(attr({ FCODE: 39004 }, 'fcode'), 39004);
});

test('⛔ CONTROL: attr() THROWS on an absent field rather than returning undefined', () => {
  // The naive read is the bug: `undefined === 46006` is false, so every feature
  // silently becomes "not perennial" and nothing anywhere reports a problem.
  const naive = ({ FCODE: 39004 } as Record<string, unknown>)['fcode'];
  assert.equal(naive, undefined, 'the naive lowercase read really does miss it');
  assert.equal(naive === 39004, false, 'and compares false against the true value');
  assert.throws(() => attr({ FCODE: 39004 }, 'nosuchfield'), /is absent/);
});

test('a waterbody fixture with UPPERCASE keys is parsed and classified correctly', () => {
  const wbs = parseAreas(load('nhd-waterbody-uppercase-fields.json'), 'usgs-nhd-waterbody');
  assert.equal(wbs.length, 1);
  assert.equal(wbs[0]?.fcode, 39004);
  assert.equal(isPerennialWaterbodyFCode(39004), true);
  const w = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [cell(null, 'nhd-waterbody-uppercase-fields.json', null)], sourceUrl: null });
  assert.equal(w.has_pond, true);
  assert.ok((w.waterbody_overlap_m2 as number) > 0);
});

test('an in-band error at HTTP 200 is refused, never parsed as zero features', () => {
  assert.throws(() => parseFlowlines(load('nhd-inband-error.json')), /in-band error/);
});

// ───────────────────────────────────────────────────────────── acceptance 3 ──
// NFHL AVAILABILITY.

test('acceptance 3: a parcel outside NFHL coverage is UNKNOWN, not "not in a floodplain"', () => {
  const coverage = coverageFrom(load('nfhl-availability-absent.json'));
  assert.equal(coverage, 'absent');
  const f = computeFlood({ parcel: parcelPolygon(), coverage, zones: [], sourceUrl: null });
  assert.equal(f.flood_unknown_reason, 'nfhl_no_coverage');
  assert.equal(f.in_sfha, null, '⛔ NEVER false — FEMA has not looked at this parcel');
  assert.equal(f.flood_zone, null);
  assert.equal(f.pct_parcel_in_floodplain, null);
});

test('acceptance 3 CONTROL: the schema goes RED on any code that returns a boolean where coverage is absent', () => {
  // This is the control the acceptance criterion asks for: an implementation
  // that "helpfully" answers in_sfha:false for an unmapped parcel cannot even
  // be constructed — the parse boundary rejects it.
  assert.throws(
    () =>
      FloodSignalSchema.parse({
        flood_zone: 'X', in_sfha: false, pct_parcel_in_floodplain: 0,
        nfhl_coverage: 'absent', flood_unknown_reason: null, source_url: null,
      }),
    /never "not in a floodplain"|in_sfha is asserted/,
  );
});

test('acceptance 3 CONTROL: WITH coverage present, a zone-level zero IS a real measurement', () => {
  const coverage = coverageFrom(load('nfhl-availability-present.json'));
  assert.equal(coverage, 'present');
  const f = computeFlood({ parcel: parcelPolygon(), coverage, zones: [], sourceUrl: null });
  assert.equal(f.in_sfha, false, 'mapped and outside every zone polygon — a measured false');
  assert.equal(f.flood_zone, 'X');
  assert.equal(f.flood_unknown_reason, null);
});

test('an AE zone over half the parcel yields in_sfha and a coverage fraction', () => {
  const zones = parseFloodZones(load('nfhl-zone-ae.json'));
  const f = computeFlood({ parcel: parcelPolygon(), coverage: 'present', zones, sourceUrl: null });
  assert.equal(f.in_sfha, true);
  assert.equal(f.flood_zone, 'AE');
  assert.ok(
    Math.abs((f.pct_parcel_in_floodplain as number) - 50) < 2,
    `expected ~50% coverage, got ${f.pct_parcel_in_floodplain}`,
  );
});

test('⛔ zone D is "undetermined", which is neither SFHA nor safe', () => {
  assert.equal(isSfhaZone('AE'), true);
  assert.equal(isSfhaZone('VE'), true);
  assert.equal(isSfhaZone('X'), false);
  assert.equal(isSfhaZone('D'), false);
  assert.equal(isUndeterminedZone('D'), true);
});

test('CONTROL: an unreadable NFHL body is `unknown`, never `absent`', () => {
  assert.equal(coverageFrom({ error: { code: 500 } }), 'unknown');
  assert.equal(coverageFrom('not json at all'), 'unknown');
  assert.equal(coverageFrom(load('nfhl-availability-absent.json')), 'absent');
});

// ───────────────────────────────────────────────────────────── acceptance 4 ──
// EPQS PLAIN TEXT AT HTTP 200.

test('acceptance 4: a text/plain 200 body FAILS the parse — it does not yield NaN', () => {
  const body = text('epqs-empty-geometry-200.txt');
  // The naive implementation, for comparison: this is what shipped elsewhere.
  const naive = Number((body as unknown as { value?: string }).value);
  assert.ok(Number.isNaN(naive), 'the naive read really does produce NaN');
  assert.throws(() => parseElevation(body), (err: unknown) => err instanceof EpqsBodyError && err.kind === 'non-json');
});

test('acceptance 4: the second measured error body ("Call failed") is caught too', () => {
  assert.throws(
    () => parseElevation(text('epqs-call-failed-200.txt')),
    (err: unknown) => err instanceof EpqsBodyError && err.kind === 'non-json',
  );
});

test('acceptance 4 CONTROL: a healthy body parses — and `value` is a STRING on the wire', () => {
  const raw = JSON.parse(text('epqs-ok.json')) as { value: unknown };
  assert.equal(typeof raw.value, 'string', 'upstream really does send a string');
  assert.equal(parseElevation(text('epqs-ok.json')), 1188.127319336);
});

test('⛔ the -1000000 no-data sentinel is refused, not treated as an elevation', () => {
  assert.throws(
    () => parseElevation(text('epqs-no-data-sentinel.json')),
    (err: unknown) => err instanceof EpqsBodyError && err.kind === 'no-data',
  );
});

test('slope: a 5-sample set yields mean and max; too few samples is unknown, not 0', () => {
  const s = slopeFromSamples([
    { lng: -81.795, lat: 36.105, elevation_m: 1000 },
    { lng: -81.798, lat: 36.102, elevation_m: 1050 },
    { lng: -81.792, lat: 36.102, elevation_m: 1100 },
    { lng: -81.798, lat: 36.108, elevation_m: 950 },
    { lng: -81.792, lat: 36.108, elevation_m: 900 },
  ]);
  assert.ok(s.mean_slope_pct !== null && s.mean_slope_pct > 0);
  assert.ok((s.max_slope_pct as number) >= (s.mean_slope_pct as number));
  assert.equal(s.samples_returned, 5);
  assert.equal(s.elevation_range_m, 200);

  const short = slopeFromSamples([{ lng: -81.795, lat: 36.105, elevation_m: 1000 }]);
  assert.equal(short.mean_slope_pct, null, '⛔ one sample is unknown, never a slope of 0');
  assert.equal(short.slope_unknown_reason, 'epqs_sample_incomplete');
});

test('EPQS cache key rounds to the 1 m raster, so two sub-metre points share it', () => {
  assert.equal(pointKey(-81.813512345, 36.147812345), pointKey(-81.8135123, 36.1478123));
  assert.notEqual(pointKey(-81.8135, 36.1478), pointKey(-81.8136, 36.1478));
});

// ───────────────────────────────────────────────────────────── acceptance 5 ──
// CACHE BY geometry_hash: ZERO NETWORK CALLS ON UNCHANGED GEOMETRY.

test('acceptance 5: identical geometry hashes identically; a changed ring changes the hash', () => {
  const rings = (load('parcel-square.json') as { rings: number[][][] }).rings;
  const same = JSON.parse(JSON.stringify(rings)) as number[][][];
  assert.equal(geometryHash(rings), geometryHash(same), 'unchanged geometry must hit the cache');

  const moved = JSON.parse(JSON.stringify(rings)) as number[][][];
  (moved[0] as number[][])[0] = [-81.8001, 36.1];
  assert.notEqual(geometryHash(rings), geometryHash(moved), 'a moved boundary must MISS the cache');
});

test('acceptance 5: a warm cell cache issues ZERO requests; a cold one issues three', async () => {
  const { loadCells } = await import('../pipeline/enrich/index.ts');
  const { EnrichCache } = await import('../pipeline/enrich/cache.ts');
  const cache = new EnrichCache(':memory:');
  const counters = { nhdRequests: 0, parcelGeometryRequests: 0, epqsRequests: 0, timeouts: 0, slowestWaterMs: 0 };

  // A counting stand-in for FetchClient. No socket: the point of the test is
  // the REQUEST COUNT, and a real client would make the count depend on the
  // network being up.
  let calls = 0;
  const fake = {
    fetchJson: async (sourceId: string) => {
      calls++;
      return {
        url: `https://example.invalid/${sourceId}`,
        status: 200,
        body: { features: [] },
        bytes: 0,
      };
    },
  };

  const key = cellKeyOf(-81.795, 36.105);
  await loadCells(fake as never, cache, [key], counters, new Date().toISOString());
  assert.equal(calls, 3, 'cold: flowline + waterbody + area');
  assert.equal(counters.nhdRequests, 3);

  // ⛔ THE CONTROL THAT MAKES THE ZERO MEAN SOMETHING: the same call again.
  await loadCells(fake as never, cache, [key], counters, new Date().toISOString());
  assert.equal(calls, 3, 'warm: ZERO further requests');
  assert.equal(counters.nhdRequests, 3);

  // And a DIFFERENT cell must still go out — otherwise "zero" would just mean
  // "the fetcher is broken", which passes the same assertion.
  await loadCells(fake as never, cache, [cellKeyOf(-80.0, 35.0)], counters, new Date().toISOString());
  assert.equal(calls, 6, 'a new cell issues its three requests');
  cache.close();
});

test('cell keys and covering: a parcel near a cell edge pulls both cells', () => {
  assert.equal(cellKeyOf(-81.795, 36.105), '-81.8,36.1');
  const oneCell = cellsCovering([-81.79, 36.11, -81.78, 36.12]);
  assert.equal(oneCell.length, 1);
  const straddling = cellsCovering([-81.81, 36.09, -81.79, 36.11]);
  assert.ok(straddling.length >= 4, `a bbox straddling both axes touches 4 cells, got ${straddling.length}`);
});

// ─────────────────────────────────────────────── geometry, and the ring trap ──
test('⛔ Esri hole rings are honoured — a naive reader gains the hole area', () => {
  const withHole = parcelPolygon('parcel-square-with-hole.json');
  const solid = parcelPolygon('parcel-square.json');
  const areaWithHole = turf.area(turf.feature(withHole));
  const areaSolid = turf.area(turf.feature(solid));
  assert.ok(areaWithHole < areaSolid, 'the hole must REDUCE the area');

  // The naive reader: every ring treated as its own outer polygon.
  const rings = (load('parcel-square-with-hole.json') as { rings: number[][][] }).rings;
  const naive = turf.area(turf.multiPolygon(rings.map((r) => [r])));
  assert.ok(naive > areaSolid, 'and the naive read really does over-count');

  // A point inside the hole is NOT in the parcel.
  const inHole = turf.point([-81.795, 36.105]);
  assert.equal(turf.booleanPointInPolygon(inHole, turf.feature(withHole)), false);
  assert.equal(turf.booleanPointInPolygon(inHole, turf.feature(solid)), true, 'CONTROL: it is inside the solid one');
});

test('signedArea distinguishes the two windings', () => {
  const ring = [[-81.8, 36.1], [-81.8, 36.11], [-81.79, 36.11], [-81.79, 36.1], [-81.8, 36.1]];
  assert.ok(signedArea(ring) > 0);
  assert.ok(signedArea([...ring].reverse()) < 0);
});

// ─────────────────────────────────────────── road access, and the WAF robots ──
test('⛔ a WAF interstitial served at HTTP 200 is NOT a robots.txt, and is not permission', () => {
  const waf = readFileSync(
    join(import.meta.dirname, '..', 'sources', 'evidence', 'robots', 'tigerweb.geo.census.gov.robots-200-waf-body.html'),
    'utf8',
  );
  assert.match(waf, /Request Rejected/, 'the cached evidence is the body we measured');
  assert.equal(looksLikeRobotsTxt(waf), false);

  // ⛔ THE CONTROL. Without the shape check, robots-parser finds no directives
  // in HTML and answers ALLOWED — a WAF refusal read as a grant of permission.
  const verdict = evaluateLiveRobots(
    'https://tigerweb.geo.census.gov/robots.txt',
    waf,
    'https://tigerweb.geo.census.gov/arcgis/rest/services/x/MapServer/0/query?f=json',
  );
  assert.equal(verdict.allowed, false, 'unknown is not permission');
});

test('CONTROL: a real robots.txt is still parsed, and its Disallow still bites', () => {
  const fema = readFileSync(
    join(import.meta.dirname, '..', 'sources', 'evidence', 'robots', 'hazards.fema.gov.robots.txt'),
    'utf8',
  );
  assert.equal(looksLikeRobotsTxt(fema), true, 'the detector must not reject genuine robots files');
  const verdict = evaluateLiveRobots(
    'https://hazards.fema.gov/robots.txt',
    fema,
    'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/0/query?f=json',
  );
  assert.equal(verdict.allowed, false, 'FEMA disallows /arcgis and /*?* — this is why flood is unknown');
});

test('CONTROL: an EMPTY body (the 404 case) is still treated as absent, not malformed', () => {
  // sources.yaml's nc-onemap-parcels entry depends on this: a 404 robots.txt
  // becomes '' in client.ts, and '' must keep meaning "no restriction stated".
  assert.equal(looksLikeRobotsTxt(''), true);
  const verdict = evaluateLiveRobots('https://services.nconemap.gov/robots.txt', '', 'https://services.nconemap.gov/x/query');
  assert.equal(verdict.allowed, true);
});

test('landlocked is a veto, and zero roads from an UNHEALTHY query is unknown, not landlocked', () => {
  const p = parcelPolygon();
  const unhealthy = computeRoad({ parcel: p, roads: [], queryHealthy: false, searchRadiusM: 800, sourceUrl: null });
  assert.equal(unhealthy.landlocked, null, '⛔ a failed query must not condemn the parcel');
  assert.equal(unhealthy.road_unknown_reason, 'tiger_unhealthy_response');

  const healthyNone = computeRoad({ parcel: p, roads: [], queryHealthy: true, searchRadiusM: 800, sourceUrl: null });
  assert.equal(healthyNone.landlocked, true, 'searched 800 m, found nothing — a real veto');

  const tooNarrow = computeRoad({ parcel: p, roads: [], queryHealthy: true, searchRadiusM: 100, sourceUrl: null });
  assert.equal(tooNarrow.landlocked, null, 'CONTROL: "none within 100 m" is not "none at all"');
});

// ───────────────────────────────────────────── the unknown/measured invariant ──
test('⛔ the schema refuses a signal that is both unknown AND measured', () => {
  assert.throws(
    () =>
      WaterSignalSchema.parse({
        has_stream: true, has_river: false, has_pond: false,
        water_frontage_m: 100, frontage_by_regime_m: { perennial: 100, intermittent: 0, ephemeral: 0, unspecified: 0 },
        distance_to_water_m: 0, min_dist_flowline_m: 0, min_dist_waterbody_m: null,
        waterbody_overlap_m2: 0, named_waters: [], search_radius_m: 500,
        water_confidence: 'polygon-intersection',
        water_unknown_reason: 'nhd_no_coverage_in_cell',
        source_url: null,
      }),
    /must not also carry values/,
  );
});

test('⛔ the schema refuses a signal that is neither unknown NOR measured', () => {
  assert.throws(
    () =>
      WaterSignalSchema.parse({
        has_stream: null, has_river: null, has_pond: null,
        water_frontage_m: null, frontage_by_regime_m: null,
        distance_to_water_m: null, min_dist_flowline_m: null, min_dist_waterbody_m: null,
        waterbody_overlap_m2: null, named_waters: [], search_radius_m: 500,
        water_confidence: null, water_unknown_reason: null, source_url: null,
      }),
    /say why, or measure it/,
  );
});

test('bbox-only geometry is labelled as such, never as a polygon result', () => {
  const w = computeWater({
    parcel: parcelPolygon(),
    parcelIsBboxOnly: true,
    cells: [cell('nhd-flowline-perennial.json', null, null)],
    sourceUrl: null,
  });
  assert.equal(w.water_confidence, 'bbox-approximation');
});


// ───────────────────────────────────────────── Phase 4: the affordability ladder
// Measured on the real corpus 2026-08-19: the worst parcel
// (37175:8594-94-2018-000:0, two cells, one holding a 181,882-vertex NHDArea)
// took 324.6 s. dedupe -> 116.6 s, + bbox prefilter -> 69.7 s, + clip-to-cell
// -> 1.4 s. Each rung below is the regression test for one of those.

test('⛔ a feature returned by TWO quarter-fetches is counted ONCE (dedupe)', () => {
  // The real shape of the bug: fetchCellBbox splits a cell into quarters on a
  // transfer-limit error and flatMaps the parts. A feature straddling the split
  // comes back from every quarter it touches. computeWater does
  // `frontage += metres`, so the duplicate is COUNTED TWICE and published
  // frontage inflates — up to 4x, measured, in the densest cells.
  const line = {
    permanent_identifier: '{STRADDLES-THE-SPLIT}',
    gnis_name: 'Baker Creek',
    ftype: 460,
    fcode: 46006,
    regime: 'perennial' as const,
    geometry: { type: 'MultiLineString' as const, coordinates: [[[-82.75, 35.15], [-82.74, 35.16]]] },
  };
  const merged: NhdCell = {
    key: '-82.7,35.1',
    bbox: [-82.7, 35.1, -82.6, 35.2],
    flowlines: [line, { ...line }, { ...line }, { ...line }], // 4 quarters, one feature
    waterbodies: [],
    areas: [],
  };
  assert.equal(merged.flowlines.length, 4, 'CONTROL: the un-deduped merge really does carry 4 copies');
  const deduped = dedupeCell(merged);
  assert.equal(deduped.flowlines.length, 1);
  assert.equal(
    deduped.flowlines.length,
    new Set(deduped.flowlines.map((f) => f.permanent_identifier)).size,
    'one row per permanent_identifier',
  );
});

test('⛔ dedupe falls back to geometry when permanent_identifier is empty — and keeps DISTINCT shapes', () => {
  const mk = (id: string, lng: number) => ({
    permanent_identifier: id, gnis_name: null, ftype: 460, fcode: 46006, regime: 'perennial' as const,
    geometry: { type: 'MultiLineString' as const, coordinates: [[[lng, 35.15], [lng + 0.01, 35.16]]] },
  });
  const cell: NhdCell = {
    key: '-82.7,35.1', bbox: [-82.7, 35.1, -82.6, 35.2],
    flowlines: [mk('', -82.75), mk('', -82.75), mk('', -82.72)], // two identical, one different
    waterbodies: [], areas: [],
  };
  const out = dedupeCell(cell);
  assert.equal(out.flowlines.length, 2, 'identical shapes collapse; a DIFFERENT shape must survive');
});

test('⛔ the bbox prefilter keeps a feature NEAR the parcel — the skirt is not optional', () => {
  // A creek outside the polygon but inside SEARCH_RADIUS_M must survive, or
  // min_dist_flowline_m silently becomes null and "we did not look" is
  // published as "no water nearby".
  const near = {
    permanent_identifier: 'NEAR', gnis_name: null, ftype: 460, fcode: 46006, regime: 'perennial' as const,
    geometry: { type: 'MultiLineString' as const, coordinates: [[[-82.7003, 35.1], [-82.7003, 35.2]]] },
  };
  const faraway = {
    ...near,
    permanent_identifier: 'FAR',
    geometry: { type: 'MultiLineString' as const, coordinates: [[[-82.2, 35.1], [-82.2, 35.2]]] },
  };
  const cell: NhdCell = {
    key: '-82.7,35.1', bbox: [-82.7, 35.1, -82.6, 35.2],
    flowlines: [near, faraway], waterbodies: [], areas: [],
  };
  // search box around a parcel at -82.70/-82.699, expanded by the radius
  const kept = prefilterCell(cell, [-82.705, 35.099, -82.6985, 35.1015]);
  const ids = kept.flowlines.map((f) => f.permanent_identifier);
  assert.ok(ids.includes('NEAR'), 'a feature within the search box MUST survive the filter');
  assert.ok(!ids.includes('FAR'), 'CONTROL: a genuinely distant feature is rejected, or the filter does nothing');
});

test('⛔ a parcel over its water budget is UNKNOWN with enrich_timeout — never has_stream:false', () => {
  // The most dangerous confusion available here. The budget is exceeded exactly
  // where hydrography is DENSE, so recording a timeout as a measured negative
  // would null out the water-rich parcels and leave the dry ones measured —
  // making the signal anti-correlated with water.
  const w = computeWater({
    parcel: parcelPolygon(),
    parcelIsBboxOnly: false,
    budgetMs: -1, // already past the deadline on entry: deterministic, no sleep
    cells: [cell('nhd-flowline-perennial.json', null, null)],
    sourceUrl: null,
  });
  assert.equal(w.water_unknown_reason, 'enrich_timeout');
  assert.equal(w.has_stream, null, 'a timeout is UNKNOWN — false would be a measured absence');
  assert.equal(w.has_river, null);
  assert.equal(w.has_pond, null);
  assert.equal(w.water_frontage_m, null, 'a partial frontage is a floor, not a measurement');

  // CONTROL: the SAME parcel and cell, with a real budget, does measure water.
  // Without this the test passes against a computeWater that returns unknown
  // for everything.
  const ok = computeWater({
    parcel: parcelPolygon(), parcelIsBboxOnly: false, budgetMs: 60_000,
    cells: [cell('nhd-flowline-perennial.json', null, null)], sourceUrl: null,
  });
  assert.equal(ok.has_stream, true);
  assert.equal(ok.water_unknown_reason, null);
});

test('⛔ normaliseCell does not change the answer — clip is an optimisation, not a measurement', () => {
  // ⛔ WHY BOTH CELLS. The clip is only safe because of an invariant that a
  // single-cell fixture does not exhibit: NHD returns a feature for EVERY cell
  // whose envelope it intersects, and `cellsCovering(expandBbox(parcel, 500 m))`
  // loads every cell within the search radius. So the part of a feature clipped
  // away from cell C is delivered by neighbour C', which is loaded whenever the
  // parcel is near enough to care.
  //
  // The fixture parcel sits on the -81.8 boundary and its creek runs from
  // -81.81 to -81.78, i.e. across it. Production loads FOUR cells here
  // (-81.9,36.0 · -81.9,36.1 · -81.8,36.0 · -81.8,36.1). Handing normaliseCell
  // one cell and expecting the whole creek asks it to keep geometry that belongs
  // to a cell the test never supplied — which is how this test first failed, and
  // the failure was the fixture's, not the code's.
  const raw = cell('nhd-flowline-perennial.json', null, null);
  const west: NhdCell = { ...raw, key: '-81.9,36.1', bbox: [-81.9, 36.1, -81.8, 36.2] };
  const cells = [raw, west];
  const before = computeWater({ parcel: parcelPolygon(), parcelIsBboxOnly: false, cells, sourceUrl: null });
  const after = computeWater({
    parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: cells.map(normaliseCell), sourceUrl: null,
  });
  assert.deepEqual(after, before, 'dedupe + prefilter + clip must be output-identical');
  // CONTROL: the comparison is not vacuous — this parcel really does measure water.
  assert.equal(before.has_stream, true);
  assert.ok((before.water_frontage_m as number) > 0);
});

test('⛔ a creek shared by TWO loaded cells is measured ONCE, not twice (cross-cell dedupe)', () => {
  // Measured on the cached corpus 2026-08-19: 46 of 46 parcels that load more
  // than one cell share at least one flowline between those cells — NHD returns
  // a feature for EVERY cell envelope it intersects, and computeWater does
  // `frontage += metres`. So every parcel near a cell boundary had its frontage
  // multiplied by the number of cells that returned its creek. This is a SECOND
  // inflation bug, independent of the quarter-split duplication inside one cell,
  // and no amount of per-cell deduping can see it.
  const raw = cell('nhd-flowline-perennial.json', null, null);
  const asNeighbour: NhdCell = { ...raw, key: '-81.9,36.1', bbox: [-81.9, 36.1, -81.8, 36.2] };

  const oneCell = computeWater({
    parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [raw], sourceUrl: null,
  });
  const twoCells = computeWater({
    parcel: parcelPolygon(), parcelIsBboxOnly: false, cells: [raw, asNeighbour], sourceUrl: null,
  });

  assert.ok((oneCell.water_frontage_m as number) > 0, 'CONTROL: the single-cell case really does measure a creek');
  assert.equal(
    twoCells.water_frontage_m,
    oneCell.water_frontage_m,
    'the SAME creek delivered by two cells must not double the frontage',
  );
  assert.deepEqual(twoCells.frontage_by_regime_m, oneCell.frontage_by_regime_m);
  assert.equal(twoCells.min_dist_flowline_m, oneCell.min_dist_flowline_m);
});
