#!/usr/bin/env node
/**
 * verify-coverage.mjs — the county list is exactly 37 rows, and every row is tiered.
 *
 * 37 is arithmetic, not a preference: NC 11 + GA 9 + VA 9 + TN 5 + SC 3. The
 * scope document said "~38" and an earlier probe said the tail was "22"; both
 * were one-off, in opposite directions, and neither error was visible until
 * someone added the columns up. A gate that asserts the total AND the per-state
 * split catches a row being added to one state and dropped from another, which
 * a bare total never would.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gate, inspectRoot } from './lib/gate.mjs';

const gate = new Gate('verify-coverage');
const root = inspectRoot();

const EXPECTED_TOTAL = 37;
const EXPECTED_BY_STATE = { NC: 11, GA: 9, VA: 9, TN: 5, SC: 3 };
const TIER_ENUM = ['rich', 'partial', 'thin', 'notices-only'];

const path = join(root, 'seeds', 'counties.csv');
if (!existsSync(path)) {
  gate.fail(`missing ${path}`);
} else {
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const header = (lines[0] ?? '').split(',');
  const rows = lines.slice(1);

  for (const col of ['fips', 'state', 'county', 'tier', 'parcel_source']) {
    if (!header.includes(col)) gate.fail(`counties.csv header missing column '${col}'`);
  }
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));

  if (rows.length !== EXPECTED_TOTAL) {
    gate.fail(`counties.csv has ${rows.length} data rows, expected exactly ${EXPECTED_TOTAL} (NC 11 + GA 9 + VA 9 + TN 5 + SC 3)`);
  } else {
    gate.ok(`counties.csv has exactly ${EXPECTED_TOTAL} rows`);
  }

  const byState = {};
  const seenFips = new Set();
  let untiered = 0;

  for (const [n, line] of rows.entries()) {
    const cells = line.split(',');
    const fips = (cells[ix['fips']] ?? '').trim();
    const state = (cells[ix['state']] ?? '').trim();
    const county = (cells[ix['county']] ?? '').trim();
    const tier = (cells[ix['tier']] ?? '').trim();
    const label = county || `row ${n + 2}`;

    if (!/^\d{5}$/.test(fips)) gate.fail(`${label}: fips '${fips}' is not 5 digits`);
    if (seenFips.has(fips)) gate.fail(`${label}: duplicate fips ${fips}`);
    seenFips.add(fips);

    // ⛔ '' is not "untiered by omission" in any way a truthiness check would
    // catch differently from a typo — both are refused, and both are named.
    if (tier === '') {
      gate.fail(`${label}: tier is empty — every county carries a tier`);
      untiered++;
    } else if (!TIER_ENUM.includes(tier)) {
      gate.fail(`${label}: tier '${tier}' is not one of ${TIER_ENUM.join(' | ')}`);
      untiered++;
    }

    byState[state] = (byState[state] ?? 0) + 1;
  }

  for (const [state, expected] of Object.entries(EXPECTED_BY_STATE)) {
    const actual = byState[state] ?? 0;
    if (actual !== expected) gate.fail(`state ${state}: ${actual} counties, expected ${expected}`);
  }
  for (const state of Object.keys(byState)) {
    if (!(state in EXPECTED_BY_STATE)) gate.fail(`unexpected state '${state}' in counties.csv`);
  }
  if (untiered === 0 && rows.length > 0) gate.ok(`all ${rows.length} counties carry a tier in the four-tier enum`);

  // data/coverage.json is produced by the pipeline; absent at P1 because there
  // is no data. Reported as absent, never counted as agreeing.
  const coveragePath = join(root, 'data', 'coverage.json');
  if (!existsSync(coveragePath)) {
    gate.info('data/coverage.json ABSENT — no ingest has run yet (P1 has no data); not a pass for that artifact');
  } else {
    const coverage = JSON.parse(readFileSync(coveragePath, 'utf8'));
    const list = Array.isArray(coverage) ? coverage : coverage.counties;
    if (!Array.isArray(list)) gate.fail('data/coverage.json is not an array and has no `counties` array');
    else if (list.length !== EXPECTED_TOTAL) gate.fail(`data/coverage.json has ${list.length} rows, expected ${EXPECTED_TOTAL}`);
    else gate.ok(`data/coverage.json has exactly ${EXPECTED_TOTAL} rows`);
  }
}

gate.finish();
