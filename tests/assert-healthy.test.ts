/**
 * The RT-1 regression suite. The first test is the whole reason this file
 * exists: it PROVES, rather than asserts in prose, that the check the original
 * plan relied on returns PASS on a total outage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HealthAssertionError,
  assertControlBlock,
  assertHealthy,
} from '../pipeline/fetch/assert-healthy.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const load = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

test('⛔ the naive row-floor check PASSES on a total outage — this is the trap', () => {
  const body = load('arcgis-inband-error.json') as { count?: number };
  // Exactly what Plan A's gate did: compare a count that is not there.
  const naiveGateSaysFail = (body.count as number) < 45000;
  assert.equal(
    naiveGateSaysFail,
    false,
    'undefined < 45000 must be false — if this ever becomes true the trap has changed shape',
  );
  // Same body, correct gate.
  assert.throws(() => assertHealthy(body, { minRows: 45000 }, 'nc'), HealthAssertionError);
});

test('in-band error is rejected regardless of HTTP status (499 Token Required)', () => {
  assert.throws(
    () => assertHealthy(load('arcgis-inband-error.json'), { minRows: 1 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'in-band-error',
  );
});

test('query-level in-band error (400) is rejected too', () => {
  assert.throws(
    () => assertHealthy(load('arcgis-query-error.json'), { minRows: 1 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'in-band-error',
  );
});

test('ORDER MATTERS: an error body with a huge features array still fails on the error', () => {
  const body = { error: { code: 400 }, features: new Array(99999).fill({}) };
  assert.throws(
    () => assertHealthy(body, { minRows: 1 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'in-band-error',
  );
});

test('a body with no features array fails on POSITIVE SHAPE, not on a threshold', () => {
  assert.throws(
    () => assertHealthy({ count: 0 }, { minRows: 0 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'no-features-array',
  );
});

test('null and non-objects are rejected before anything is read from them', () => {
  for (const body of [null, undefined, 'text', 42, []]) {
    assert.throws(
      () => assertHealthy(body, { minRows: 0 }, 'nc'),
      (err: unknown) => err instanceof HealthAssertionError && err.check === 'non-object-body',
    );
  }
});

test('a truncated page is rejected when the caller is not paging', () => {
  assert.throws(
    () => assertHealthy(load('truncated-response.json'), { minRows: 1 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'transfer-limit',
  );
});

test('the same truncated page is ACCEPTED when the caller is paging', () => {
  assert.doesNotThrow(() => assertHealthy(load('truncated-response.json'), { minRows: 1, paging: true }, 'nc'));
});

test('GREEN CONTROL: a healthy body passes', () => {
  assert.doesNotThrow(() => assertHealthy(load('healthy-response.json'), { minRows: 2 }, 'nc'));
});

test('rolling median floor catches drift a static floor does not', () => {
  const body = { features: new Array(100).fill({}) };
  assert.doesNotThrow(() => assertHealthy(body, { minRows: 10 }, 'nc'));
  assert.throws(
    () => assertHealthy(body, { minRows: 10, rollingMedian: 1000 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'rolling-median',
  );
});

test('control block: a wrong positive count is a FAILED run', () => {
  assert.throws(
    () => assertControlBlock({ positiveCount: 866, negativeCount: 0 }, { positiveCount: 47388, negativeCount: 0 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'control-positive',
  );
});

test('control block: a MISSING count is rejected explicitly, not by luck', () => {
  assert.throws(
    () => assertControlBlock({ positiveCount: undefined, negativeCount: 0 }, { positiveCount: 47388, negativeCount: 0 }, 'nc'),
    (err: unknown) => err instanceof HealthAssertionError && err.check === 'control-positive-shape',
  );
});

test('control block: indistinguishable controls are rejected — the 866-row fake failover', () => {
  assert.throws(
    () => assertControlBlock({ positiveCount: 0, negativeCount: 0 }, { positiveCount: 47388, negativeCount: 0 }, 'nc'),
    HealthAssertionError,
  );
});

test('GREEN CONTROL: correct controls pass', () => {
  assert.doesNotThrow(() =>
    assertControlBlock({ positiveCount: 47388, negativeCount: 0 }, { positiveCount: 47388, negativeCount: 0 }, 'nc'),
  );
});
