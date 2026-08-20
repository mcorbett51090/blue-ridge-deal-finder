/**
 * Tier 2 — the append-only audit trail (plan §2.3, §4.10).
 *
 * DELTAS ONLY, in git. This is the one place git's line-oriented behaviour is a
 * feature: growth is proportional to CHANGE, not to dataset size, which is what
 * makes "a version-controlled store with change history" honest rather than a
 * 5-8 MB weekly rewrite that adds ~300 MB/year to `.git`.
 *
 * ⛔ THE PREMISE THIS FILE DEFENDS. Delta-only is the entire justification for
 * Tier 2 living in git, and the thing that destroys it is keying on `objectid`:
 * ArcGIS OBJECTIDs are server-assigned and reassigned on republish, so one
 * routine 3am republish in month 4 would append 503,674 "new parcel" events in
 * a single run. record_id is `fips:parno:part_seq` for exactly this reason.
 *
 * ⛔ APPEND-ONLY IS ENFORCED, NOT PROMISED. Files open in 'a' mode and the
 * writer refuses to run if the target already contains a line from THIS run id
 * — a re-run appending its own events twice is the failure mode a naive
 * append-only gate reads as clean growth (RT-7).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const EventSchema = z.object({
  run_id: z.string().min(1),
  ts: z.string().datetime(),
  source_id: z.string().min(1),
  fips: z.string().regex(/^\d{5}$/),
  county: z.string().min(1),
  record_id: z.string().min(1),
  kind: z.enum(['new', 'changed', 'stale', 'returned']),
  /** Set on `changed` only — one event PER FIELD, with before and after. */
  field: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
});

export type ParcelEvent = z.infer<typeof EventSchema>;

export class EventWriter {
  readonly #path: string;
  readonly #runId: string;
  #count = 0;

  constructor(repoRoot: string, sourceId: string, runId: string, month: string) {
    const dir = join(repoRoot, 'data', 'events', month);
    mkdirSync(dir, { recursive: true });
    this.#path = join(dir, `${sourceId}.ndjson`);
    this.#runId = runId;

    // RT-7 — the naive append-only gate passes vacuously. If this run id is
    // already present the file has already been written by this run, and
    // appending again doubles the delta silently.
    if (existsSync(this.#path)) {
      const existing = readFileSync(this.#path, 'utf8');
      if (existing.includes(`"run_id":"${runId}"`)) {
        throw new Error(
          `event log ${this.#path} already contains run_id ${runId} — refusing to append a second time`,
        );
      }
    }
  }

  get path(): string {
    return this.#path;
  }

  get count(): number {
    return this.#count;
  }

  append(events: readonly ParcelEvent[]): void {
    if (events.length === 0) return;
    const lines = events.map((e) => JSON.stringify(EventSchema.parse(e))).join('\n');
    appendFileSync(this.#path, `${lines}\n`, 'utf8');
    this.#count += events.length;
  }
}

export const RunManifestSchema = z.object({
  run_id: z.string(),
  source_id: z.string(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  /** ⛔ `complete` does NOT gate the deploy, and never has. Measured 2026-08-19:
   *  the newest manifest is `status: "partial"` and the site deployed anyway, and
   *  deploy.yml has no manifest check of any kind. Left as an honest status label;
   *  the real deploy gate added in Phase 0 is `npm run verify` inside deploy.yml. */
  status: z.enum(['complete', 'partial', 'failed']),
  schema_fingerprint: z.string(),
  control_block: z.object({
    positive_where: z.string(),
    positive_expected: z.number(),
    positive_observed: z.number(),
    negative_where: z.string(),
    negative_expected: z.number(),
    negative_observed: z.number(),
  }),
  counties: z.array(
    z.object({
      fips: z.string(),
      county: z.string(),
      status: z.enum(['complete', 'not-run', 'failed']),
      rows_fetched: z.number(),
      distinct_keys: z.number(),
      rows_warehoused: z.number(),
      unkeyed: z.number(),
      collapsed_duplicates: z.number(),
      multipart_parcels: z.number(),
      deed_date_nulled: z.number(),
      zero_parval: z.number(),
      pages: z.number(),
      bytes: z.number(),
      note: z.string().nullable(),
    }),
  ),
  totals: z.object({
    rows_fetched: z.number(),
    rows_warehoused: z.number(),
    inserted: z.number(),
    changed: z.number(),
    unchanged: z.number(),
    marked_stale: z.number(),
    deleted: z.number(),
    events_appended: z.number(),
  }),
  tier0: z.object({ file: z.string().nullable(), new_rows: z.number(), sha256: z.string().nullable() }),
  warehouse: z.object({ file: z.string().nullable(), sha256: z.string().nullable(), uploaded: z.boolean() }),
});

export type RunManifest = z.infer<typeof RunManifestSchema>;

export function writeRunManifest(repoRoot: string, manifest: RunManifest): string {
  const dir = join(repoRoot, 'data', 'runs');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${manifest.run_id}-${manifest.source_id}.json`);
  writeFileSync(path, `${JSON.stringify(RunManifestSchema.parse(manifest), null, 2)}\n`);
  return path;
}
