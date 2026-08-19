import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseLedgerRow, type PriorCountyRun } from '../pipeline/store/warehouse.ts';

/**
 * The defect this guards, measured 2026-08-19: the warehouse is rebuilt
 * wholesale each run, so `county_runs` was repopulated from only the current
 * run's counties. Watauga (46,252 parcels) and Mitchell (17,508) sat in the
 * warehouse while the ledger called them `not-run` with 0 rows.
 *
 * That inverts the site's honesty guarantee. `data/coverage.json` is built from
 * this ledger and is what makes "no deals in Yancey" (a real zero) render
 * differently from "we cannot see Gilmer" (no source exists). A county wrongly
 * downgraded to `not-run` shows the not-covered copy over data we hold.
 */
const prior = (fips: string, status: string, rows: number): PriorCountyRun => ({
  fips, county: 'X', run_id: 'RUN-OLD', ingest_status: status,
  rows_fetched: rows, distinct_keys: rows, rows_warehoused: rows,
  unkeyed: 0, collapsed_dupes: 0, multipart_parcels: 0,
  deed_date_nulled: 0, zero_parval: 0, ingested_at: 'THEN',
});

test('a county not attempted this run KEEPS its prior ledger row', () => {
  const map = new Map([['37189', prior('37189', 'complete', 46252)]]);
  const r = chooseLedgerRow({ fips: '37189', status: 'not-run' }, map);
  assert.equal(r.carried, true);
  assert.equal((r.row as PriorCountyRun).rows_warehoused, 46252);
  // The ORIGINAL run id and timestamp survive: the ledger must record when the
  // data was actually gathered, not when we last ran something else.
  assert.equal((r.row as PriorCountyRun).run_id, 'RUN-OLD');
  assert.equal((r.row as PriorCountyRun).ingested_at, 'THEN');
});

test('CONTROL — a county we DID attempt overwrites its prior row', () => {
  const map = new Map([['37189', prior('37189', 'complete', 46252)]]);
  const r = chooseLedgerRow({ fips: '37189', status: 'complete' }, map);
  assert.equal(r.carried, false, 'a real attempt must win, or a shrinking county could never be recorded');
});

test('CONTROL — a FAILED attempt also overwrites, so an outage is visible', () => {
  const map = new Map([['37189', prior('37189', 'complete', 46252)]]);
  const r = chooseLedgerRow({ fips: '37189', status: 'failed' }, map);
  assert.equal(r.carried, false, 'a failure must not be masked by yesterday success');
});

test('a not-run county with a not-run prior stays not-run', () => {
  const map = new Map([['37009', prior('37009', 'not-run', 0)]]);
  assert.equal(chooseLedgerRow({ fips: '37009', status: 'not-run' }, map).carried, false);
});

test('a not-run county with NO prior row stays not-run', () => {
  assert.equal(chooseLedgerRow({ fips: '37009', status: 'not-run' }, new Map()).carried, false);
});

test('CONTROL — the test can fail: carrying forward is observable', () => {
  const map = new Map([['37189', prior('37189', 'complete', 46252)]]);
  const carried = chooseLedgerRow({ fips: '37189', status: 'not-run' }, map);
  const fresh = chooseLedgerRow({ fips: '37189', status: 'complete' }, map);
  assert.notEqual(carried.carried, fresh.carried,
    'if these agreed, the function would be a no-op and every other assertion here would be vacuous');
});
