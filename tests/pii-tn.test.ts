import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PII_FIELDS } from '../pipeline/normalize/redact.ts';

const has = (k: string): boolean =>
  (PII_FIELDS as readonly string[]).some((f) => f.toLowerCase() === k.toLowerCase());

test('TN owner columns are PII in BOTH casings', () => {
  for (const k of ['OWNER', 'owner', 'OWNER2', 'owner2', 'Owner']) {
    assert.equal(has(k), true, `${k} must be treated as PII`);
  }
});

test('NC owner columns still are', () => {
  for (const k of ['ownname', 'OWNNAME', 'mailadd', 'ownfrst', 'ownlast']) {
    assert.equal(has(k), true, `${k} must be treated as PII`);
  }
});

test('CONTROL — the check is not vacuous: non-PII columns are NOT matched', () => {
  // If this passed for everything, the assertions above would prove nothing.
  for (const k of ['parno', 'PARCELID', 'gisacres', 'DEEDAC', 'siteadd', 'ADDRESS', 'county']) {
    assert.equal(has(k), false, `${k} must NOT be treated as PII — it is the asset, not the person`);
  }
});
