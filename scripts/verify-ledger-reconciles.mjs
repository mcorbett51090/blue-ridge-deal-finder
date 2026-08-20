#!/usr/bin/env node
/**
 * LEDGER RECONCILIATION — the county ledger must agree with the parcels table.
 *
 * ⛔ Measured 2026-08-19. The warehouse held 235,421 parcels while
 * `county_runs` claimed 171,661 across 6 counties: Watauga (46,252) and
 * Mitchell (17,508) had their rows sitting in the same file while the ledger
 * called them `not-run` with 0 rows.
 *
 * Why that is not a bookkeeping nit: `data/coverage.json` is built from this
 * ledger and is the site's honesty surface — the thing that makes "no deals in
 * Yancey" (a real zero) render differently from "we cannot see Fannin" (no
 * source exists). A county silently downgraded to `not-run` shows the
 * not-covered copy over 46,252 parcels we actually hold. It inverts the exact
 * guarantee the tier system exists to provide.
 *
 * Why a carry-forward fix was not enough: the ledger is maintained SEPARATELY
 * from the data it describes, so it can drift. Carry-forward stopped new drift
 * but faithfully propagated drift that already existed. A separately-maintained
 * count that is allowed to disagree with its data is a bug generator; only an
 * asserted invariant closes it.
 *
 * The invariant: every county with parcels has a ledger row that is not
 * `not-run`, and the ledger's warehoused total equals the parcel count.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
// node:sqlite, not better-sqlite3 — .npmrc sets ignore-scripts=true (npm
// lifecycle scripts are an egress path the allowlist gate never sees), which
// also prevents better-sqlite3's native addon from ever building. The pipeline
// hit this first and wraps node:sqlite in pipeline/store/sqlite.ts.
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const dir = join(ROOT, 'data/warehouse');
const pointerPath = join(dir, 'warehouse-pointer.json');

/** What the COMMITTED, world-visible ledger claims we hold. This is the thing a
 *  reader of the site actually sees, so it is the claim that must be honoured. */
function committedClaim() {
  const cov = join(ROOT, 'site/src/data/coverage.json');
  if (!existsSync(cov)) return { counties: 0, rows: 0 };
  const c = JSON.parse(readFileSync(cov, 'utf8'));
  const ing = c.filter((x) => (x.rows ?? 0) > 0 || x.data_state === 'ingested');
  return { counties: ing.length, rows: ing.reduce((a, x) => a + (x.rows ?? 0), 0) };
}

if (!existsSync(pointerPath)) {
  // ⛔ FAIL-CLOSED. This used to exit 0 while printing "NOT a pass for that
  // artifact" — a sentence that is true and a status code that says the
  // opposite, so `npm run verify` counted it green. If the COMMITTED
  // coverage.json claims ingested counties, an absent warehouse is not
  // "nothing ingested yet", it is the site publishing a ledger describing data
  // that exists nowhere — precisely the drift this gate was written to catch.
  const claim = committedClaim();
  if (claim.rows > 0) {
    console.error('verify-ledger-reconciles: FAILED');
    console.error(`  ✗ no warehouse pointer, but the committed coverage.json claims ${claim.rows.toLocaleString()} rows across ${claim.counties} counties`);
    process.exit(1);
  }
  console.log('· verify-ledger-reconciles — no warehouse pointer and the committed ledger claims nothing. Consistent.');
  process.exit(0);
}

// ⛔ THE POINTER MUST DESCRIBE THE FILE IT NAMES. Measured 2026-08-19: the
// pointer carried sha256 baf17b77…/75,862,016 while the file it named held
// 87d87fff…/201,588,736 — it was stamped mid-ingest and never re-stamped. A
// sha nobody verifies is not an integrity guarantee, it is a decoration, and
// the mirror copies that stale value into MANIFEST.json as the archive's own
// record of truth. Verify it or stop writing it.
{
  const ptr = JSON.parse(readFileSync(pointerPath, 'utf8'));
  const named = join(dir, ptr.current);
  if (existsSync(named) && (ptr.sha256 || ptr.bytes)) {
    const buf = readFileSync(named);
    const actualBytes = buf.length;
    const actualSha = createHash('sha256').update(buf).digest('hex');
    const bad = [];
    if (ptr.bytes !== undefined && ptr.bytes !== actualBytes) bad.push(`bytes: pointer ${Number(ptr.bytes).toLocaleString()} vs file ${actualBytes.toLocaleString()}`);
    if (ptr.sha256 && ptr.sha256 !== actualSha) bad.push(`sha256: pointer ${String(ptr.sha256).slice(0, 12)}… vs file ${actualSha.slice(0, 12)}…`);
    if (bad.length) {
      console.error('verify-ledger-reconciles: FAILED');
      console.error(`  ✗ warehouse-pointer.json does not describe ${ptr.current}`);
      for (const b of bad) console.error(`      ${b}`);
      process.exit(1);
    }
  }
}

// ⛔ Read the file the POINTER names, never the newest by mtime. A failed run
// leaves a `warehouse-building-*.sqlite` behind that is deliberately NOT
// promoted; reading by mtime picks up exactly the file the pointer exists to
// keep you away from.
const current = JSON.parse(readFileSync(pointerPath, 'utf8')).current;
const dbPath = join(dir, current);
if (!existsSync(dbPath)) {
  console.error(`verify-ledger-reconciles: pointer names ${current}, which does not exist`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const truth = new Map();
for (const r of db.prepare('SELECT county, COUNT(*) n FROM parcels GROUP BY county').all()) {
  truth.set(String(r.county), Number(r.n));
}
const ledger = new Map();
for (const r of db.prepare('SELECT county, ingest_status, rows_warehoused FROM county_runs').all()) {
  ledger.set(String(r.county), { status: String(r.ingest_status), rows: Number(r.rows_warehoused ?? 0) });
}
db.close();

if (truth.size === 0) {
  // ⛔ FAIL-CLOSED, same reasoning as the absent-pointer branch above.
  const claim = committedClaim();
  if (claim.rows > 0) {
    console.error('verify-ledger-reconciles: FAILED');
    console.error(`  ✗ warehouse holds 0 parcels, but the committed coverage.json claims ${claim.rows.toLocaleString()} rows across ${claim.counties} counties`);
    process.exit(1);
  }
  console.log('· verify-ledger-reconciles — warehouse empty and the committed ledger claims nothing. Consistent.');
  process.exit(0);
}

const problems = [];
for (const [county, n] of truth) {
  const l = ledger.get(county);
  if (!l) { problems.push(`${county}: ${n.toLocaleString()} parcels but NO ledger row at all`); continue; }
  if (l.status === 'not-run') {
    problems.push(`${county}: ${n.toLocaleString()} parcels but ledger says "not-run" — the site would render "we cannot see this county" over data we hold`);
  }
  if (l.rows !== n) {
    problems.push(`${county}: ledger claims ${l.rows.toLocaleString()} warehoused, parcels table has ${n.toLocaleString()}`);
  }
}
const ledgerTotal = [...ledger.values()].reduce((a, b) => a + b.rows, 0);
const truthTotal = [...truth.values()].reduce((a, b) => a + b, 0);
if (ledgerTotal !== truthTotal) {
  problems.push(`TOTAL: ledger ${ledgerTotal.toLocaleString()} vs warehouse ${truthTotal.toLocaleString()} (off by ${Math.abs(truthTotal - ledgerTotal).toLocaleString()})`);
}

if (problems.length) {
  console.error('verify-ledger-reconciles: FAILED');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`✓ verify-ledger-reconciles — ${truth.size} counties, ${truthTotal.toLocaleString()} parcels, ledger agrees exactly`);
