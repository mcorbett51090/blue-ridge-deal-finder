import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertGeoIdentity, contains, BLUE_RIDGE_ENVELOPE, GeoIdentityError } from '../pipeline/fetch/geo-identity.ts';

/** Real coordinates from the two false positives measured 2026-08-19. */
const WATAUGA_NC = { lon: -81.68, lat: 36.21 };
const FANNIN_GA  = { lon: -84.32, lat: 34.86 };
const SEVIER_TN  = { lon: -83.56, lat: 35.80 };
const FANNIN_TX  = { lon: -96.11, lat: 33.59 };   // the "Fannin County Parcels" layer
const UNION_FL   = { lon: -82.4253, lat: 29.9263 }; // measured vertex from "Union Parcels"

test('the three priority regions are inside the envelope', () => {
  for (const p of [WATAUGA_NC, FANNIN_GA, SEVIER_TN]) {
    assert.equal(contains(BLUE_RIDGE_ENVELOPE, p), true, `${JSON.stringify(p)} should be in-region`);
  }
});

test('CONTROL — Fannin County TEXAS is rejected', () => {
  assert.throws(() => assertGeoIdentity('ga-fannin', [FANNIN_TX]), GeoIdentityError);
});

test('CONTROL — Union County FLORIDA is rejected (measured vertex)', () => {
  assert.throws(() => assertGeoIdentity('ga-union', [UNION_FL]), GeoIdentityError);
});

test('a good source passes', () => {
  assertGeoIdentity('nc-onemap-parcels', [WATAUGA_NC, FANNIN_GA, SEVIER_TN]);
});

test('ONE bad point among good ones still fails — a partial wrong-state load is still wrong', () => {
  assert.throws(() => assertGeoIdentity('mixed', [WATAUGA_NC, FANNIN_TX, SEVIER_TN]), GeoIdentityError);
});

test('CONTROL — an EMPTY sample FAILS, it does not pass', () => {
  // The whole class of defect this project keeps hitting is a check that
  // inspected nothing and reported clean.
  assert.throws(() => assertGeoIdentity('empty', []), GeoIdentityError);
});

test('CONTROL — the check is not vacuous: in and out give different answers', () => {
  const inside = contains(BLUE_RIDGE_ENVELOPE, WATAUGA_NC);
  const outside = contains(BLUE_RIDGE_ENVELOPE, FANNIN_TX);
  assert.notEqual(inside, outside, 'if these agreed the envelope would accept everything');
});
