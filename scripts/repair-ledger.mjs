#!/usr/bin/env node
/**
 * One-off repair for ledger drift that predates the carry-forward fix.
 *
 * The parcels table is GROUND TRUTH: it is rebuilt wholesale from Tier 0 each
 * run, so a county with rows in it demonstrably has data. `county_runs` is
 * maintained separately and had already lost Watauga and Mitchell before
 * carry-forward existed — and carry-forward then propagated that loss
 * faithfully, because it can only carry what is there.
 *
 * A repaired row is marked `carried` rather than `complete`, and its run-time
 * counters (rows_fetched, unkeyed, collapsed_dupes, multipart, deed_date_nulled)
 * are left NULL. Those are facts about a fetch that this process did not
 * observe, and inventing them would be worse than admitting the gap — the
 * whole point of the repair is to stop the ledger asserting things it cannot
 * support.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const dir = join(ROOT, 'data/warehouse');
const pointer = JSON.parse(readFileSync(join(dir, 'warehouse-pointer.json'), 'utf8'));
const dbPath = join(dir, pointer.current);
if (!existsSync(dbPath)) { console.error(`pointer names ${pointer.current}, missing`); process.exit(1); }

const db = new DatabaseSync(dbPath);

// The existing table declares the run-time counters NOT NULL, which is the
// constraint that made this repair impossible without fabricating numbers.
// Rebuild it nullable (SQLite cannot drop NOT NULL in place), preserving rows.
const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='county_runs'").get();
if (ddl && /rows_fetched\s+INTEGER NOT NULL/.test(String(ddl.sql))) {
  db.exec('BEGIN');
  db.exec(`CREATE TABLE county_runs_new (
    fips TEXT NOT NULL, county TEXT NOT NULL, run_id TEXT NOT NULL,
    ingest_status TEXT NOT NULL, rows_fetched INTEGER, distinct_keys INTEGER,
    rows_warehoused INTEGER NOT NULL, unkeyed INTEGER, collapsed_dupes INTEGER,
    multipart_parcels INTEGER, deed_date_nulled INTEGER, zero_parval INTEGER,
    ingested_at TEXT NOT NULL, PRIMARY KEY (fips, run_id))`);
  db.exec('INSERT INTO county_runs_new SELECT * FROM county_runs');
  db.exec('DROP TABLE county_runs');
  db.exec('ALTER TABLE county_runs_new RENAME TO county_runs');
  db.exec('COMMIT');
  console.log('  migrated county_runs: run-time counters are now nullable');
}
const truth = new Map();
for (const r of db.prepare('SELECT county, fips, COUNT(*) n FROM parcels GROUP BY county, fips').all()) {
  truth.set(String(r.county), { fips: String(r.fips), n: Number(r.n) });
}

let repaired = 0;
for (const [county, { fips, n }] of truth) {
  const row = db.prepare('SELECT ingest_status, rows_warehoused FROM county_runs WHERE county = ?').get(county);
  if (row && row.ingest_status !== 'not-run' && Number(row.rows_warehoused) === n) continue;
  db.prepare(`
    UPDATE county_runs
       SET ingest_status = 'carried', rows_warehoused = ?, distinct_keys = ?,
           rows_fetched = NULL, unkeyed = NULL, collapsed_dupes = NULL,
           multipart_parcels = NULL, deed_date_nulled = NULL, zero_parval = NULL
     WHERE county = ?`).run(n, n, county);
  console.log(`  repaired ${county} (${fips}): ledger -> carried, ${n.toLocaleString()} rows from ground truth`);
  repaired++;
}
db.close();
console.log(repaired ? `\n  ${repaired} county row(s) repaired.` : '\n  nothing to repair.');
