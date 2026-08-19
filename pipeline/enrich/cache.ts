/**
 * The enrichment cache — keyed on `geometry_hash`, which is the whole point.
 *
 * ⛔ THESE ARE FEDERAL SERVICES AND WE ARE A GUEST ON THEM. A parcel whose
 * geometry has not changed must never be re-queried, and that has to be a
 * PROPERTY of the cache key rather than a habit of the caller. Keying on
 * record_id would re-query a parcel whose boundary was redrawn (wrong answer
 * served from cache); keying on the run date would re-query everything every
 * week (rude, and slow). Geometry is exactly what the answer depends on.
 *
 * Two tables, two different lifetimes:
 *   parcel_enrichment — keyed by geometry_hash. The answer.
 *   nhd_cell          — keyed by the 0.1° cell key. The RAW hydrography, shared
 *                       by every parcel in that cell. This is what collapses a
 *                       thousand parcels into three requests.
 *
 * node:sqlite, not better-sqlite3 — see pipeline/store/sqlite.ts for the
 * measured reason (.npmrc ignore-scripts means the native binding never builds).
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Db } from '../store/sqlite.ts';
import type { NhdCell } from './nhd.ts';
import type { ParcelEnrichment } from './schema.ts';

export const CACHE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS parcel_enrichment (
  geometry_hash TEXT PRIMARY KEY,
  record_id     TEXT NOT NULL,
  payload       TEXT NOT NULL,
  enriched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS parcel_enrichment_record ON parcel_enrichment (record_id);

CREATE TABLE IF NOT EXISTS nhd_cell (
  cell_key   TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parcel_geometry (
  record_id     TEXT PRIMARY KEY,
  geometry_hash TEXT NOT NULL,
  rings         TEXT NOT NULL,
  fetched_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS epqs_point (
  point_key   TEXT PRIMARY KEY,
  elevation_m REAL,
  fetched_at  TEXT NOT NULL
);
`;

export class EnrichCache {
  readonly #db: Db;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new Db(path);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec(CACHE_SCHEMA_SQL);
  }

  getEnrichment(geometryHash: string): ParcelEnrichment | null {
    const row = this.#db
      .prepare('SELECT payload FROM parcel_enrichment WHERE geometry_hash = ?')
      .get([geometryHash]);
    if (!row) return null;
    return JSON.parse(String(row['payload'])) as ParcelEnrichment;
  }

  putEnrichment(e: ParcelEnrichment): void {
    this.#db
      .prepare(
        'INSERT INTO parcel_enrichment (geometry_hash, record_id, payload, enriched_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(geometry_hash) DO UPDATE SET record_id = excluded.record_id, ' +
          'payload = excluded.payload, enriched_at = excluded.enriched_at',
      )
      .run([e.geometry_hash, e.record_id, JSON.stringify(e), e.enriched_at]);
  }

  getCell(key: string): NhdCell | null {
    const row = this.#db.prepare('SELECT payload FROM nhd_cell WHERE cell_key = ?').get([key]);
    if (!row) return null;
    return JSON.parse(String(row['payload'])) as NhdCell;
  }

  putCell(cell: NhdCell, at: string): void {
    this.#db
      .prepare(
        'INSERT INTO nhd_cell (cell_key, payload, fetched_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(cell_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at',
      )
      .run([cell.key, JSON.stringify(cell), at]);
  }

  getGeometry(recordId: string): { geometry_hash: string; rings: number[][][] } | null {
    const row = this.#db
      .prepare('SELECT geometry_hash, rings FROM parcel_geometry WHERE record_id = ?')
      .get([recordId]);
    if (!row) return null;
    return {
      geometry_hash: String(row['geometry_hash']),
      rings: JSON.parse(String(row['rings'])) as number[][][],
    };
  }

  putGeometry(recordId: string, geometryHash: string, rings: number[][][], at: string): void {
    this.#db
      .prepare(
        'INSERT INTO parcel_geometry (record_id, geometry_hash, rings, fetched_at) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(record_id) DO UPDATE SET geometry_hash = excluded.geometry_hash, ' +
          'rings = excluded.rings, fetched_at = excluded.fetched_at',
      )
      .run([recordId, geometryHash, JSON.stringify(rings), at]);
  }

  /** EPQS is cached on ROUNDED coordinates and FOREVER: bare-earth elevation at
   *  a point does not change on any timescale this project cares about, and the
   *  service is one request per point (plan §5.6). */
  getElevation(key: string): { elevation_m: number | null } | null {
    const row = this.#db.prepare('SELECT elevation_m FROM epqs_point WHERE point_key = ?').get([key]);
    if (!row) return null;
    const v = row['elevation_m'];
    return { elevation_m: typeof v === 'number' ? v : null };
  }

  putElevation(key: string, elevationM: number | null, at: string): void {
    this.#db
      .prepare(
        'INSERT INTO epqs_point (point_key, elevation_m, fetched_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(point_key) DO UPDATE SET elevation_m = excluded.elevation_m, fetched_at = excluded.fetched_at',
      )
      .run([key, elevationM, at]);
  }

  close(): void {
    this.#db.close();
  }
}
