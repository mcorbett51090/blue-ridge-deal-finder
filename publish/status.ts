/**
 * THE FRESHNESS SURFACE, DERIVED — not hand-typed.
 *
 * ⛔ WHY THIS FILE EXISTS. `site/public/data/status.json` was a FIXTURE with
 * `"fixture": true`, zero producers anywhere in the repo, and hand-written
 * values. It shipped to production and the live site served it. Measured
 * 2026-08-19 against the deployed site, four of its seven `source_id`s exist in
 * NO registry:
 *
 *     nc-tax-foreclosure    state: ok        last_success: 2026-08-18T11:04Z
 *     va-county-gis         state: degraded  last_success: 2026-08-04T02:10Z
 *     ga-notices            state: degraded  last_success: 2026-08-12T10:00Z  rows: 3
 *     sc-master-in-equity   state: degraded  last_success: 2026-08-14T12:00Z
 *
 * `ga-notices` asserted a SUCCESSFUL GEORGIA FETCH on a specific date, with a
 * row count, for a source that has never existed — on `/status/`, the page this
 * project built to distinguish "we cannot see this county" from "this county is
 * quiet". Its note even read "qPublic blocks automated parcel access for all
 * nine GA counties", which is true. A fabrication wrapped in an accurate caveat
 * is more convincing than one without it, and therefore worse.
 *
 * `lane1_rows: 12` / `lane2_rows: 15` were wrong too — the real payload carries
 * 8 and 650.
 *
 * The gate did not catch it because `verify-data.mjs` validates the SHAPE and
 * never asserts that a `source_id` resolves to anything. A schema check cannot
 * see an invented identifier.
 *
 * ⛔ EVERY FIELD BELOW IS DERIVED FROM SOMETHING ON DISK. Where nothing is on
 * disk the answer is `never-run` and `last_success: null` — never an estimate,
 * never a plausible-looking timestamp. "We have never recorded a run for this
 * source" is a fact; a date we made up is not.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export type PublishedSourceStatus = {
  source_id: string;
  label: string;
  last_success: string | null;
  last_attempt: string | null;
  rows: number | null;
  state: 'ok' | 'degraded' | 'failed' | 'never-run';
  note: string;
};

/** Every id the registries declare. The published surface may name NOTHING else. */
export function registrySourceIds(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of ['sources.yaml', 'sources.enrich.yaml', 'sources.candidates.yaml']) {
    const p = join(root, 'sources', file);
    if (!existsSync(p)) continue;
    const doc = yaml.load(readFileSync(p, 'utf8')) as unknown;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>;
        if (typeof o['id'] === 'string') {
          out.set(o['id'], typeof o['label'] === 'string' ? o['label'] : String(o['id']));
        }
        for (const v of Object.values(o)) walk(v);
      }
    };
    walk(doc);
  }
  return out;
}

type Manifest = { source_id?: string; started_at?: string; finished_at?: string; status?: string; totals?: Record<string, unknown> };

/** Real run history, from the manifests the ingest actually writes. */
function runsBySource(root: string): Map<string, Manifest[]> {
  const dir = join(root, 'data/runs');
  const out = new Map<string, Manifest[]>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Manifest;
      const id = m.source_id;
      if (!id) continue;
      const list = out.get(id) ?? [];
      list.push(m);
      out.set(id, list);
    } catch {
      // An unreadable manifest is not a run we may assert anything about.
    }
  }
  return out;
}

/** Counties whose coverage row names this source, and the rows we hold for them.
 *  ⛔ Needed because "no run manifest" and "never ran" are DIFFERENT facts. The
 *  TN boundary layer has 152,321 parcels in the warehouse and no manifest at
 *  all; reporting it `never-run` with no qualifier trades one false statement
 *  for another, quieter one. */
function attributedRows(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const p = join(root, 'data/coverage.json');
  if (!existsSync(p)) return out;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { counties?: Array<Record<string, unknown>> };
    for (const c of doc.counties ?? []) {
      const src = c['parcel_source'];
      const rows = c['rows'];
      if (typeof src === 'string' && typeof rows === 'number' && rows > 0) {
        out.set(src, (out.get(src) ?? 0) + rows);
      }
    }
  } catch { /* an unreadable coverage file asserts nothing */ }
  return out;
}

export function buildSourceStatuses(root: string): PublishedSourceStatus[] {
  const known = registrySourceIds(root);
  const runs = runsBySource(root);
  const attributed = attributedRows(root);
  const out: PublishedSourceStatus[] = [];

  for (const [id, label] of [...known.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const history = runs.get(id) ?? [];
    if (history.length === 0) {
      const held = attributed.get(id) ?? 0;
      out.push({
        source_id: id, label,
        last_success: null, last_attempt: null,
        rows: held > 0 ? held : null,
        state: 'never-run',
        // ⛔ THREE DIFFERENT FACTS, kept apart. "Registered but never fetched",
        // "ran and found nothing", and "data from this source is in the
        // warehouse but predates run-manifest recording" are not the same, and
        // collapsing them is the exact confusion the coverage tiers exist to
        // prevent. `state` can only carry four values, so the distinction lives
        // in the note rather than being lost.
        note:
          held > 0
            ? `No run manifest has been recorded for this source, but ${held.toLocaleString()} parcel(s) in the warehouse are attributed to it — the data predates manifest recording. Its freshness is therefore UNKNOWN, not fresh.`
            : 'Registered as a source. No run has ever been recorded for it, so nothing here has been fetched.',
      });
      continue;
    }
    const attempts = history.map((h) => h.started_at).filter((x): x is string => !!x).sort();
    const ok = history.filter((h) => h.status === 'ok' || h.status === 'complete');
    const partial = history.filter((h) => h.status === 'partial');
    const successes = [...ok, ...partial].map((h) => h.finished_at).filter((x): x is string => !!x).sort();
    const last = history[history.length - 1];
    out.push({
      source_id: id, label,
      last_success: successes.length ? (successes[successes.length - 1] as string) : null,
      last_attempt: attempts.length ? (attempts[attempts.length - 1] as string) : null,
      rows: typeof last?.totals?.['rows_warehoused'] === 'number' ? (last.totals['rows_warehoused'] as number) : null,
      state: successes.length === 0 ? 'failed' : partial.length && !ok.length ? 'degraded' : 'ok',
      note:
        successes.length === 0
          ? `${history.length} recorded attempt(s), none of which completed.`
          : `Derived from ${history.length} run manifest(s) in data/runs/.`,
    });
  }
  return out;
}
