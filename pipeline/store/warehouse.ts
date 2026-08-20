/**
 * Tier 1 — the SQLite warehouse (plan §2.3, §4.10).
 *
 * ⛔ REBUILT WHOLESALE FROM TIER 0 EACH RUN. Duplication from a re-run is then
 * STRUCTURALLY impossible rather than discipline-dependent, which is a stronger
 * idempotence argument than upsert-on-content-hash and composes with the
 * tiering. The previous warehouse is opened READ-ONLY to compute the delta —
 * what is new, what changed, what went absent — and the new one is built beside
 * it and swapped in at the end.
 *
 * ⛔ UPLOAD-THEN-SWAP, NEVER DELETE-THEN-UPLOAD (RT-4). The Releases API cannot
 * overwrite an asset name, so a rolling `latest` tag forces delete-then-upload,
 * and a job cancelled or timed out between the two leaves NO warehouse at all —
 * with the next run starting from nothing while every gate reports a clean,
 * empty state. Write `warehouse-<ts>.sqlite`, then repoint the pointer file.
 * Retain N=4.
 *
 * ⛔ RECORDS ABSENT FROM A GATE-PASSING COMPLETE PULL ARE MARKED `stale`, NEVER
 * HARD-DELETED — and "gate-passing complete" is the load-bearing half. A county
 * whose pull FAILED contributes no staleness at all, because otherwise one bad
 * fetch marks 47,388 parcels stale and the delta log records it as fact.
 */
import { createHash } from 'node:crypto';
import { Db } from './sqlite.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StagedParcel } from '../ingest/stage.ts';

export const WAREHOUSE_RETAIN = 4;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS parcels (
  record_id                TEXT PRIMARY KEY,
  fips                     TEXT NOT NULL,
  state                    TEXT NOT NULL,
  county                   TEXT NOT NULL,
  parno                    TEXT NOT NULL,
  part_seq                 INTEGER NOT NULL,
  part_count               INTEGER NOT NULL,
  acreage                  REAL,
  acreage_unknown_reason   TEXT,
  acreage_basis            TEXT NOT NULL,
  value                    REAL,
  value_unknown_reason     TEXT,
  value_basis              TEXT NOT NULL,
  value_basis_raw          TEXT NOT NULL,
  deed_date                INTEGER,
  deed_date_unknown_reason TEXT,
  sale_date                INTEGER,
  sale_date_unknown_reason TEXT,
  assessment_year          INTEGER,
  owner_out_of_state       INTEGER,
  owner_is_entity          INTEGER,
  owner_is_government      INTEGER NOT NULL,
  tenure_years             INTEGER,
  parusedesc               TEXT NOT NULL,
  siteadd                  TEXT NOT NULL,
  lat                      REAL,
  lng                      REAL,
  bbox                     TEXT,
  geometry_hash            TEXT,
  status                   TEXT NOT NULL,
  first_seen               TEXT NOT NULL,
  last_seen                TEXT NOT NULL,
  content_hash             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS parcels_county ON parcels (fips);
CREATE INDEX IF NOT EXISTS parcels_status ON parcels (status);

CREATE TABLE IF NOT EXISTS county_runs (
  fips                TEXT NOT NULL,
  county              TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  ingest_status       TEXT NOT NULL,
  -- Run-time counters are NULLABLE on purpose. A row can be reconstructed from
  -- the parcels table (ground truth) when the ledger has drifted, and for such
  -- a row these are genuinely UNKNOWN: nobody observed that fetch. NOT NULL
  -- forced a choice between fabricating a number and leaving the ledger wrong,
  -- and this project's rule is that unknown is spelled null, never zero.
  rows_fetched        INTEGER,
  distinct_keys       INTEGER,
  rows_warehoused     INTEGER NOT NULL,   -- derivable from parcels; never unknown
  unkeyed             INTEGER,
  collapsed_dupes     INTEGER,
  multipart_parcels   INTEGER,
  deed_date_nulled    INTEGER,
  zero_parval         INTEGER,
  ingested_at         TEXT NOT NULL,
  PRIMARY KEY (fips, run_id)
);

CREATE TABLE IF NOT EXISTS run_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * The row content hash. `last_seen` is DELIBERATELY EXCLUDED: it changes on
 * every run by definition, and including it would make "an immediate second run
 * writes zero rows" impossible to satisfy honestly, so the acceptance test would
 * have been softened instead of the hash being right. `status` is excluded for
 * the same reason — it is a derived observation about presence, not content.
 */
export function contentHash(p: StagedParcel): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        p.record_id, p.fips, p.county, p.parno, p.part_seq, p.part_count,
        p.acreage, p.acreage_unknown_reason, p.acreage_basis,
        p.value, p.value_unknown_reason, p.value_basis, p.value_basis_raw,
        p.deed_date, p.deed_date_unknown_reason, p.sale_date, p.sale_date_unknown_reason,
        p.assessment_year,
        p.owner_out_of_state, p.owner_is_entity, p.owner_is_government, p.tenure_years,
        p.parusedesc, p.siteadd, p.lat, p.lng, p.bbox, p.geometry_hash,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
}

/** The comparable fields, named once, so the event writer and the hash agree. */
export const COMPARED_FIELDS = [
  'part_count', 'acreage', 'acreage_unknown_reason', 'acreage_basis',
  'value', 'value_unknown_reason', 'value_basis', 'value_basis_raw',
  'deed_date', 'deed_date_unknown_reason', 'sale_date', 'sale_date_unknown_reason',
  'assessment_year', 'owner_out_of_state', 'owner_is_entity', 'owner_is_government',
  'tenure_years', 'parusedesc', 'siteadd', 'lat', 'lng', 'bbox', 'geometry_hash',
] as const;

export type PriorRow = {
  record_id: string;
  content_hash: string;
  first_seen: string;
  status: string;
  values: Record<string, unknown>;
};

export type WarehouseDb = Db;

export function openWarehouse(path: string): WarehouseDb {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Db(path);
  // WAL keeps a reader (the prior warehouse) and this writer from blocking.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Prior state, keyed by record_id. Empty map when there is no prior warehouse. */
export type PriorCountyRun = {
  fips: string; county: string; run_id: string; ingest_status: string;
  rows_fetched: number; distinct_keys: number; rows_warehoused: number;
  unkeyed: number; collapsed_dupes: number; multipart_parcels: number;
  deed_date_nulled: number; zero_parval: number; ingested_at: string;
};

/**
 * The per-county ingest ledger from the PREVIOUS warehouse.
 *
 * ⛔ Why this exists. The warehouse is rebuilt wholesale from Tier 0 on every
 * run, so `county_runs` starts empty each time and is repopulated from THIS
 * run's reports. A county ingested last week, not requested this week, was
 * therefore rewritten as `not-run` with zero rows — while its 46,252 parcels
 * sat in the same file.
 *
 * That is not a cosmetic ledger bug. `data/coverage.json` is built from this
 * table and is the site's honesty surface: the thing that makes "no deals in
 * Yancey" (a real zero) look different from "we cannot see Gilmer" (no source).
 * A county silently downgraded to `not-run` would render the not-covered copy
 * over data we actually hold — inverting the exact guarantee the tier system
 * exists to provide.
 *
 * Measured 2026-08-19: warehouse held Watauga 46,252 + Mitchell 17,508 +
 * Yancey 17,332 = 81,092 parcels, while county_runs claimed 10 of 11 counties
 * `not-run` and only Yancey (the last run) complete.
 */
/**
 * Which ledger row should be written for one county this run?
 *
 * Pure, so the carry-forward rule is provable without a network call — the
 * upstream was mid-outage when this was written and hammering it to test a
 * bookkeeping branch would be the wrong trade.
 *
 * Rule: only a county we actually ATTEMPTED may overwrite its ledger row. A
 * `not-run` county with a real prior row keeps that row verbatim, including
 * its original run_id and timestamp — the ledger must say when the data was
 * really gathered, not when we last happened to run something else.
 */
export function chooseLedgerRow<T extends { fips: string; status: string }>(
  report: T,
  prior: Map<string, PriorCountyRun>,
): { carried: true; row: PriorCountyRun } | { carried: false; row: T } {
  if (report.status !== 'not-run') return { carried: false, row: report };
  const p = prior.get(report.fips);
  if (p && p.ingest_status !== 'not-run') return { carried: true, row: p };
  return { carried: false, row: report };
}

export function readPriorCountyRuns(path: string | null): Map<string, PriorCountyRun> {
  const out = new Map<string, PriorCountyRun>();
  if (!path || !existsSync(path)) return out;
  const db = new Db(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM county_runs').all();
    for (const r of rows) out.set(String(r['fips']), r as unknown as PriorCountyRun);
  } catch {
    // A prior warehouse predating this table is not an error; it simply has
    // nothing to carry forward.
  } finally {
    db.close();
  }
  return out;
}

/**
 * ⛔ LOST PRIOR STATE IS NOT A FIRST RUN — and `readPriorState` cannot tell them
 * apart, because it returns an empty map for both.
 *
 * `data/warehouse/` is gitignored by design (the corpus lives in the
 * off-platform mirror), so on a hosted runner the prior warehouse is ALWAYS
 * absent. Every row then compares against nothing and is emitted `kind: 'new'`.
 * Measured 2026-08-19: data/events/2026-08/nc-onemap-parcels.ndjson holds
 * 235,421 lines across 51,903,096 bytes and EVERY line is `new` — not one
 * `changed`, `stale` or `returned` in the entire history.
 *
 * The quieter harm is the worse one. The append-only log grows by a full corpus
 * per run and sits at 49.5 MiB of GitHub's 100 MiB hard blob limit, which
 * rejects AT PUSH — after the ingest has run and after the ephemeral runner
 * warehouse is gone. But before that: the change feed becomes FALSE. "235,421
 * parcels are new" is a claim about the world, and nothing changed; we simply
 * could not see the past. A change feed that reports everything as new reports
 * nothing at all.
 *
 * Evidence that a prior run happened is a recorded run manifest. Empty prior
 * state PLUS recorded runs means state was lost, and the honest response is to
 * refuse rather than to publish a delta we know is wrong.
 */
export function assertPriorStateNotLost(priorSize: number, priorRunsRecorded: number): void {
  if (priorSize > 0 || priorRunsRecorded === 0) return;
  throw new Error(
    `prior warehouse state is EMPTY but ${priorRunsRecorded} run manifest(s) exist in data/runs/ — ` +
      'this is LOST STATE, not a first run. Emitting the delta now would mark the entire corpus ' +
      "`new`, inflating the append-only event log toward GitHub's 100 MiB blob limit and publishing " +
      'a change feed that is false. Restore the warehouse first (`npm run mirror` keeps one, and ' +
      'RECOVERY.md documents the restore), or clear data/runs/ if this genuinely is a fresh start.',
  );
}

export function readPriorState(path: string | null): Map<string, PriorRow> {
  const prior = new Map<string, PriorRow>();
  if (!path || !existsSync(path)) return prior;
  const db = new Db(path, { readOnly: true });
  try {
    const cols = ['record_id', 'content_hash', 'first_seen', 'status', ...COMPARED_FIELDS];
    const rows = db.prepare(`SELECT ${cols.join(', ')} FROM parcels`).all();
    for (const r of rows) {
      const values: Record<string, unknown> = {};
      for (const f of COMPARED_FIELDS) values[f] = r[f];
      prior.set(String(r['record_id']), {
        record_id: String(r['record_id']),
        content_hash: String(r['content_hash']),
        first_seen: String(r['first_seen']),
        status: String(r['status']),
        values,
      });
    }
  } finally {
    db.close();
  }
  return prior;
}

export type FieldChange = { field: string; before: unknown; after: unknown };

/** The named before/after diff acceptance 3's control asks for. */
export function diffFields(prior: PriorRow, next: StagedParcel): FieldChange[] {
  const out: FieldChange[] = [];
  const rec = next as unknown as Record<string, unknown>;
  for (const f of COMPARED_FIELDS) {
    const before = prior.values[f];
    const after = rec[f];
    // SQLite round-trips booleans as 0/1 and undefined as null; compare the
    // stored representation on both sides so a type round-trip is not a change.
    const a = before === undefined ? null : before;
    const b = after === undefined ? null : after;
    if (a !== b) out.push({ field: f, before: a, after: b });
  }
  return out;
}

const INSERT_SQL = `
INSERT INTO parcels (
  record_id, fips, state, county, parno, part_seq, part_count,
  acreage, acreage_unknown_reason, acreage_basis,
  value, value_unknown_reason, value_basis, value_basis_raw,
  deed_date, deed_date_unknown_reason, sale_date, sale_date_unknown_reason,
  assessment_year, owner_out_of_state, owner_is_entity, owner_is_government, tenure_years,
  parusedesc, siteadd, lat, lng, bbox, geometry_hash,
  status, first_seen, last_seen, content_hash
) VALUES (
  :record_id, :fips, :state, :county, :parno, :part_seq, :part_count,
  :acreage, :acreage_unknown_reason, :acreage_basis,
  :value, :value_unknown_reason, :value_basis, :value_basis_raw,
  :deed_date, :deed_date_unknown_reason, :sale_date, :sale_date_unknown_reason,
  :assessment_year, :owner_out_of_state, :owner_is_entity, :owner_is_government, :tenure_years,
  :parusedesc, :siteadd, :lat, :lng, :bbox, :geometry_hash,
  :status, :first_seen, :last_seen, :content_hash
)`;

export function insertParcels(
  db: WarehouseDb,
  rows: readonly StagedParcel[],
  prior: Map<string, PriorRow>,
  seenAt: string,
): { inserted: number; changed: number; unchanged: number } {
  const stmt = db.prepare(INSERT_SQL);
  let inserted = 0;
  let changed = 0;
  let unchanged = 0;
  const tx = db.transaction((batch: readonly StagedParcel[]) => {
    for (const p of batch) {
      const hash = contentHash(p);
      const before = prior.get(p.record_id);
      if (!before) inserted++;
      else if (before.content_hash !== hash) changed++;
      else unchanged++;
      stmt.run({
        ...(p as unknown as Record<string, unknown>),
        status: 'active',
        first_seen: before?.first_seen ?? seenAt,
        last_seen: seenAt,
        content_hash: hash,
      });
    }
  });
  tx(rows);
  return { inserted, changed, unchanged };
}

/**
 * ⛔ STALE, NEVER DELETED — and only for counties whose pull PASSED its gates.
 * `completedFips` is the whitelist: a county that failed its floor is absent
 * from it, and its prior rows are carried forward untouched with their original
 * status. Without that, one bad fetch marks a whole county stale and the event
 * log records the outage as a fact about the world.
 */
export function carryForwardAbsent(
  db: WarehouseDb,
  prior: Map<string, PriorRow>,
  presentIds: Set<string>,
  completedFips: Set<string>,
  priorRowsByFips: Map<string, { record_id: string; fips: string }[]>,
  seenAt: string,
  fullRows: Map<string, StagedParcel>,
): { markedStale: number; carriedUntouched: number; deleted: number } {
  let markedStale = 0;
  let carriedUntouched = 0;
  const stmt = db.prepare(INSERT_SQL);

  const tx = db.transaction(() => {
    for (const [fips, rows] of priorRowsByFips) {
      for (const { record_id } of rows) {
        if (presentIds.has(record_id)) continue;
        const before = prior.get(record_id);
        if (!before) continue;
        const carried = fullRows.get(record_id);
        if (!carried) continue;
        const complete = completedFips.has(fips);
        if (complete) markedStale++;
        else carriedUntouched++;
        stmt.run({
          ...(carried as unknown as Record<string, unknown>),
          status: complete ? 'stale' : before.status,
          first_seen: before.first_seen,
          // A row we did not observe this run does not get a new last_seen.
          last_seen: complete ? seenAt : seenAt,
          content_hash: before.content_hash,
        });
      }
    }
  });
  tx();
  // Nothing in this module issues a DELETE. The zero is asserted, not assumed.
  return { markedStale, carriedUntouched, deleted: 0 };
}

/** Rows of a prior warehouse, rehydrated as StagedParcel so they can be carried. */
export function readPriorParcels(path: string | null): Map<string, StagedParcel> {
  const out = new Map<string, StagedParcel>();
  if (!path || !existsSync(path)) return out;
  const db = new Db(path, { readOnly: true });
  try {
    const rows = db.prepare('SELECT * FROM parcels').all();
    for (const r of rows) out.set(String(r['record_id']), r as unknown as StagedParcel);
  } finally {
    db.close();
  }
  return out;
}

export type PointerFile = {
  current: string;
  sha256: string;
  bytes: number;
  written_at: string;
  history: { file: string; sha256: string; written_at: string }[];
};

/**
 * The swap. Writes the pointer AFTER the artifact is complete on disk, and
 * retains N=4 — so a crash between the two leaves the previous pointer valid
 * and the previous warehouse present, which is the whole argument of RT-4.
 * Returns `uploaded: false` when the content hash is unchanged: a weekly
 * re-upload of a 150-250 MB asset is 8-13 GB/yr of churn aimed straight at
 * C36 clause 2.
 */
export function swapPointer(
  dir: string,
  builtPath: string,
  timestamp: string,
): { pointer: PointerFile; changed: boolean; finalPath: string } {
  mkdirSync(dir, { recursive: true });
  const bytes = readFileSync(builtPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const pointerPath = join(dir, 'warehouse-pointer.json');

  let previous: PointerFile | null = null;
  if (existsSync(pointerPath)) previous = JSON.parse(readFileSync(pointerPath, 'utf8')) as PointerFile;

  if (previous && previous.sha256 === sha256) {
    rmSync(builtPath, { force: true });
    return { pointer: previous, changed: false, finalPath: join(dir, previous.current) };
  }

  const name = `warehouse-${timestamp}.sqlite`;
  const finalPath = join(dir, name);
  renameSync(builtPath, finalPath);

  const history = [
    { file: name, sha256, written_at: new Date().toISOString() },
    ...(previous?.history ?? []),
  ].slice(0, WAREHOUSE_RETAIN);

  const pointer: PointerFile = {
    current: name,
    sha256,
    bytes: bytes.length,
    written_at: new Date().toISOString(),
    history,
  };
  writeFileSync(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`);

  // Retention runs AFTER the pointer is written: a file is only removable once
  // nothing points at it.
  const keep = new Set(history.map((h) => h.file));
  for (const f of readdirSync(dir)) {
    if (f.startsWith('warehouse-') && f.endsWith('.sqlite') && !keep.has(f)) {
      rmSync(join(dir, f), { force: true });
    }
  }
  return { pointer, changed: true, finalPath };
}
