/**
 * Reading the warehouse — and reading the RIGHT one.
 *
 * ⛔ THE CURRENT WAREHOUSE IS THE FILE NAMED BY warehouse-pointer.json, NEVER
 * THE NEWEST BY MTIME. That distinction has already bitten once in this repo.
 * `swapPointer` writes the pointer only AFTER a build is complete on disk
 * (RT-4), and a run that FAILED deliberately leaves its half-built artifact in
 * place while the pointer keeps naming the last good one. Picking by mtime
 * therefore picks exactly the file the safety mechanism was designed to
 * exclude, and does it silently — the failure mode is a publish of a corpus
 * that no gate ever passed.
 *
 * Measured while writing this: data/warehouse/ held 4 `warehouse-*.sqlite`
 * files plus 2 `warehouse-building-*.sqlite` from an in-flight run, and the
 * newest by mtime was NOT the one the pointer named.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Db } from '../store/sqlite.ts';

export const PointerSchema = z.object({
  current: z.string().min(1),
  sha256: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  written_at: z.string(),
});

export type ResolvedWarehouse = {
  path: string;
  file: string;
  sha256: string;
  written_at: string;
};

export class NoWarehouseError extends Error {}

export function resolveWarehouse(repoRoot: string): ResolvedWarehouse {
  const dir = join(repoRoot, 'data', 'warehouse');
  const pointerPath = join(dir, 'warehouse-pointer.json');
  if (!existsSync(pointerPath)) {
    throw new NoWarehouseError(
      `no warehouse pointer at ${pointerPath} — no ingest has ever completed. ` +
        'This is an ABSENCE of data, not an empty corpus, and must be published as one.',
    );
  }
  const pointer = PointerSchema.parse(JSON.parse(readFileSync(pointerPath, 'utf8')));
  const path = join(dir, pointer.current);
  if (!existsSync(path)) {
    throw new NoWarehouseError(
      `warehouse pointer names ${pointer.current}, which is not on disk. Refusing to fall back to ` +
        'another file: a silent substitution would publish an unknown corpus as the current one.',
    );
  }
  return { path, file: pointer.current, sha256: pointer.sha256, written_at: pointer.written_at };
}

/** Exactly the columns scoring and publishing are allowed to see. `SELECT *`
 *  would hand every future upstream column to the publish path by default. */
export const PARCEL_COLUMNS = [
  'record_id', 'fips', 'state', 'county', 'parno', 'part_seq', 'part_count',
  'acreage', 'acreage_unknown_reason', 'acreage_basis',
  'value', 'value_unknown_reason', 'value_basis', 'value_basis_raw',
  'deed_date', 'sale_date', 'assessment_year',
  'owner_out_of_state', 'owner_is_entity', 'owner_is_government', 'tenure_years',
  'parusedesc', 'siteadd', 'lat', 'lng', 'status', 'first_seen', 'last_seen',
] as const;

export type WarehouseParcel = {
  record_id: string;
  fips: string;
  state: string;
  county: string;
  parno: string;
  part_seq: number;
  part_count: number;
  acreage: number | null;
  acreage_unknown_reason: string | null;
  acreage_basis: string;
  value: number | null;
  value_unknown_reason: string | null;
  value_basis: string;
  value_basis_raw: string;
  deed_date: number | null;
  sale_date: number | null;
  assessment_year: number | null;
  owner_out_of_state: number | null;
  owner_is_entity: number | null;
  owner_is_government: number;
  tenure_years: number | null;
  parusedesc: string;
  /** SITUS address — the property's own location, i.e. the thing being sold.
   *  NOT `mailadd`, which is where the OWNER lives and is stripped as PII at
   *  the redaction boundary. Empty on 26% of the corpus and on 52% of VACANT
   *  parcels, and 100% absent in Avery County, so it is nullable by nature. */
  siteadd: string | null;
  lat: number | null;
  lng: number | null;
  status: string;
  first_seen: string;
  last_seen: string;
};

export type CountyLedgerRow = {
  fips: string;
  county: string;
  run_id: string;
  ingest_status: string;
  rows_fetched: number;
  rows_warehoused: number;
  unkeyed: number;
  ingested_at: string;
};

export type WarehouseRead = {
  resolved: ResolvedWarehouse;
  parcels: WarehouseParcel[];
  ledger: CountyLedgerRow[];
  /** Measured row counts per fips. The LEDGER is a claim about a run; this is a
   *  count of what is actually in the file, and the two can disagree. */
  rowsByFips: Map<string, number>;
  runMeta: Record<string, string>;
};

/**
 * ⛔ `status = 'stale'` rows are EXCLUDED from scoring but COUNTED.
 * A stale row is one a gate-passing complete pull did not return — it may have
 * been split, merged or sold. Ranking it as a current deal would publish a
 * parcel that the county no longer says exists.
 */
export function readWarehouse(repoRoot: string, options: { includeStale?: boolean } = {}): WarehouseRead {
  const resolved = resolveWarehouse(repoRoot);
  const db = new Db(resolved.path, { readOnly: true });
  try {
    const parcels = db
      .prepare(`SELECT ${PARCEL_COLUMNS.join(', ')} FROM parcels${options.includeStale === true ? '' : " WHERE status = 'active'"}`)
      .all() as unknown as WarehouseParcel[];

    const rowsByFips = new Map<string, number>();
    for (const r of db.prepare('SELECT fips, COUNT(*) AS n FROM parcels GROUP BY fips').all()) {
      rowsByFips.set(String(r['fips']), Number(r['n']));
    }

    const ledger = db
      .prepare(
        'SELECT fips, county, run_id, ingest_status, rows_fetched, rows_warehoused, unkeyed, ingested_at FROM county_runs',
      )
      .all() as unknown as CountyLedgerRow[];

    const runMeta: Record<string, string> = {};
    for (const r of db.prepare('SELECT key, value FROM run_meta').all()) {
      runMeta[String(r['key'])] = String(r['value']);
    }

    return { resolved, parcels, ledger, rowsByFips, runMeta };
  } finally {
    db.close();
  }
}
