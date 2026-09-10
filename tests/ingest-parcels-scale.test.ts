import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * ⛔ MEASURED. `staged.push(...county0.rows)` in pipeline/ingest-parcels.ts
 * crashed the first real multi-county run this pipeline ever completed
 * against a live warehouse: `RangeError: Maximum call stack size exceeded`,
 * thrown while staging Buncombe (134,741 fetched rows) — the largest single
 * NC target county (measured floor 128,000; sources/sources.yaml). Every
 * smaller county in the fixed-price manual test runs before this (Yancey,
 * Mitchell, Madison, Avery — all under 25,000) staged fine, which is exactly
 * why this went unnoticed until a county past V8's spread-argument ceiling
 * was actually ingested.
 *
 * `raw.push(...page.rows)` a few lines above is the SAME construct and is
 * safe on purpose — it runs once per PAGE, capped at maxRecordCount (5,000
 * here), never once per county. The distinction is the whole bug: bounded
 * spread is fine, unbounded spread over a live county's full row count is
 * not, and nothing about the syntax marks which one you're looking at.
 */
test('CONTROL — spreading ~135k elements into push() throws, reproducing the measured crash', () => {
  const big = new Array(135_000).fill(0);
  const dest: number[] = [];
  assert.throws(() => {
    dest.push(...big);
  }, /Maximum call stack size exceeded/);
});

test('the fix: a per-row loop appends the same ~135k elements with no stack limit', () => {
  const big = new Array(135_000).fill(1);
  const dest: number[] = [];
  for (const row of big) dest.push(row);
  assert.equal(dest.length, 135_000);
  assert.equal(dest[0], 1);
  assert.equal(dest[dest.length - 1], 1);
});

test('pipeline/ingest-parcels.ts no longer spreads a whole county into push()', () => {
  const src = readFileSync(join(ROOT, 'pipeline', 'ingest-parcels.ts'), 'utf8');
  // Comment lines are prose describing the defect, not the defect — strip
  // them first, or this assertion matches its own explanatory comment.
  const code = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n');
  // The per-PAGE spread (bounded to maxRecordCount, currently 5,000) is fine
  // and must stay; only the per-COUNTY one is the defect.
  assert.doesNotMatch(
    code,
    /staged\.push\(\.\.\./,
    'staged.push(...) reintroduces the unbounded spread that crashed on Buncombe (134,741 rows) — use a per-row loop',
  );
});
