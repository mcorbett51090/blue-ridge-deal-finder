/**
 * The SQLite driver adapter.
 *
 * ⛔ SUBSTRATE COLLISION FOUND AT P2 — FLAGGED FOR RATIFICATION, NOT DECIDED HERE.
 *
 * Plan §2.5 names `better-sqlite3` as the warehouse driver. Plan RT-11 puts
 * `ignore-scripts=true` in .npmrc because npm lifecycle scripts run before any
 * gate can inspect the tree. THOSE TWO REQUIREMENTS ARE INCOMPATIBLE, and the
 * incompatibility is total rather than partial:
 *
 *   better-sqlite3 is a NATIVE module. Its binding is produced by a `install`
 *   lifecycle script (`prebuild-install || node-gyp rebuild`). With
 *   ignore-scripts=true that script never runs, so the binding never exists.
 *
 * MEASURED on this host, 2026-08-19:
 *   require('better-sqlite3')  -> Error: Could not locate the bindings file,
 *                                 13 paths tried, none present
 *   npm rebuild better-sqlite3 --build-from-source
 *                              -> "rebuilt dependencies successfully" and NO
 *                                 binding (npm rebuild honours .npmrc too — the
 *                                 success message is about the no-op)
 *   npm rebuild better-sqlite3 --ignore-scripts=false --foreground-scripts
 *                              -> node-gyp FAILS: better-sqlite3 11.10.0 has no
 *                                 prebuild for this ABI and the source build errors
 *   require('node:sqlite')     -> works, CONTROL: round-tripped two rows through
 *                                 an in-memory table with both positional and
 *                                 named parameters
 *
 * ⛔ AND CI WOULD HAVE FAILED THE SAME WAY. ingest-parcels.yml runs
 * `npm ci --ignore-scripts`, which does not run prebuild-install either. So the
 * first scheduled ingest would have died at the warehouse step on a green tree —
 * every gate passing, no data written. This was not a host quirk.
 *
 * WHAT THIS FILE DOES ABOUT IT: uses `node:sqlite`, which is in the Node
 * standard library, needs no install script and no native build, and writes the
 * SAME SQLite file format. Tier 1 as an ARTIFACT is unchanged — the Release
 * asset is still `warehouse-<ts>.sqlite` and still opens in any SQLite client.
 * Only the driver differs.
 *
 * ⛔ WHAT IT COSTS, STATED PLAINLY: `node:sqlite` is stable from Node 24 and is
 * flag-gated (`--experimental-sqlite`) on Node 22, which is the version §2.5
 * names and ingest-parcels.yml pins. The workflows and `engines` therefore move
 * to Node 24. That is a real change to a plan constant and it is the Team Lead's
 * call, not mine — it is in the P2 receipt as an open question. Reverting is one
 * file: restore better-sqlite3 here and the callers are untouched.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type Row = Record<string, unknown>;

export type Statement = {
  run(params?: Row | unknown[]): void;
  all(params?: Row | unknown[]): Row[];
  get(params?: Row | unknown[]): Row | undefined;
};

export class Db {
  readonly #db: DatabaseSync;

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.#db = new DatabaseSync(path, options.readOnly === true ? { readOnly: true } : {});
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  prepare(sql: string): Statement {
    const stmt: StatementSync = this.#db.prepare(sql);
    return {
      run(params) {
        if (params === undefined) stmt.run();
        else if (Array.isArray(params)) stmt.run(...(params as never[]));
        else stmt.run(params as never);
      },
      all(params) {
        const rows =
          params === undefined
            ? stmt.all()
            : Array.isArray(params)
              ? stmt.all(...(params as never[]))
              : stmt.all(params as never);
        return rows as Row[];
      },
      get(params) {
        const row =
          params === undefined
            ? stmt.get()
            : Array.isArray(params)
              ? stmt.get(...(params as never[]))
              : stmt.get(params as never);
        return row as Row | undefined;
      },
    };
  }

  /**
   * better-sqlite3 shipped a `transaction()` helper; node:sqlite does not, so it
   * is written out. ROLLBACK on throw is the part that must not be forgotten: a
   * half-applied county is worse than a failed one, because it looks complete.
   */
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      this.#db.exec('BEGIN');
      try {
        fn(...args);
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  close(): void {
    this.#db.close();
  }
}
