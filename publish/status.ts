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
/** ⛔ EXPLICIT, never readdirSync. A directory scan would admit
 *  `sources.denied.yaml` — the do-not-fetch list — as a source registry the
 *  moment any row in it gained an `id:` field, which is the opposite of what
 *  that file means. The set of files that may declare a source is a decision,
 *  not a directory listing. */
export const DECLARING_FILES = ['sources.yaml', 'sources.enrich.yaml', 'sources.candidates.yaml'] as const;

export function registrySourceIds(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of DECLARING_FILES) {
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

/**
 * ⛔ THE ARTIFACT THAT PROVES A SOURCE RAN — because a run manifest does not.
 *
 * The first version of this file derived run state from `data/runs/*.json`
 * alone. That directory holds manifests for exactly ONE source, so 17 of 18
 * sources reported `never-run` — including `nc-jackson-reo`, which produced all
 * 8 Lane-1 rows the site is publishing right now, and `nc-haywood-bids`, whose
 * notice timestamp THIS SAME FILE uses as `data_observed_at`. It shipped, and it
 * was false in a new direction: a fabrication traded for a denial.
 *
 * **Absence of a manifest is absence of INSTRUMENTATION, not absence of a run.**
 * Manifest-writing was added late and only to the parcel ingest; every other
 * lane produces its output without one. So the evidence of a run is the OUTPUT
 * ON DISK, and each mapping below is an explicit claim about which artifact
 * proves which source ran — written out rather than inferred, because a clever
 * rule here would be a guess wearing a mechanism's clothes.
 */
const PRODUCED_BY: Record<string, { file: string; stamp: string; count?: (doc: Record<string, unknown>) => number | null }> = {
  'nc-jackson-reo': {
    file: 'data/distress/evidence.json',
    stamp: 'generated_at',
    count: (d) => (typeof d['matched'] === 'number' ? (d['matched'] as number) : null),
  },
  'jackson-county-reo-pdf': {
    file: 'data/distress/evidence.json',
    stamp: 'generated_at',
    count: (d) => (typeof d['matched'] === 'number' ? (d['matched'] as number) : null),
  },
  'nc-haywood-bids': {
    file: 'data/distress/notices.json',
    stamp: 'generated_at',
    count: (d) => (Array.isArray(d['notices']) ? (d['notices'] as unknown[]).length : null),
  },
  'haywood-tax-foreclosures-civicengage': {
    file: 'data/distress/notices.json',
    stamp: 'generated_at',
    count: (d) => (Array.isArray(d['notices']) ? (d['notices'] as unknown[]).length : null),
  },
  'usgs-nhd': { file: 'data/enrich/enrichment-latest.json', stamp: 'run_at' },
  'usgs-nhd-flowline': { file: 'data/enrich/enrichment-latest.json', stamp: 'run_at' },
  'usgs-nhd-waterbody': { file: 'data/enrich/enrichment-latest.json', stamp: 'run_at' },
  'usgs-nhd-area': { file: 'data/enrich/enrichment-latest.json', stamp: 'run_at' },
  'usgs-epqs': { file: 'data/enrich/enrichment-latest.json', stamp: 'run_at' },
};

function producedEvidence(root: string, id: string): { at: string; rows: number | null } | null {
  const spec = PRODUCED_BY[id];
  if (!spec) return null;
  const p = join(root, spec.file);
  if (!existsSync(p)) return null;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const at = doc[spec.stamp];
    if (typeof at !== 'string') return null;
    return { at, rows: spec.count ? spec.count(doc) : null };
  } catch {
    return null;
  }
}

/** Sources the registries record as REFUSED. They have never run and never will,
 *  and saying only "never-run" hides the reason. */
function refusedReason(root: string, id: string): string | null {
  const p = join(root, 'sources/sources.enrich.yaml');
  if (!existsSync(p)) return null;
  try {
    const doc = yaml.load(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const refused = (doc['refused'] as Array<Record<string, unknown>> | undefined) ?? [];
    const hit = refused.find((r) => r['id'] === id);
    return hit && typeof hit['refusal'] === 'string' ? (hit['refusal'] as string) : null;
  } catch {
    return null;
  }
}

/** Counties whose coverage row names this source, and the rows we hold for them.
 *  ⛔ Needed because "no run manifest" and "never ran" are DIFFERENT facts. The
 *  TN boundary layer has 152,321 parcels in the warehouse and no manifest at
 *  all; reporting it `never-run` with no qualifier trades one false statement
 *  for another, quieter one. */
type Attribution = { rows: number; lastIngestedAt: string | null; allComplete: boolean };

function attributedRows(root: string): Map<string, Attribution> {
  const out = new Map<string, Attribution>();
  const p = join(root, 'data/coverage.json');
  if (!existsSync(p)) return out;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { counties?: Array<Record<string, unknown>> };
    for (const c of doc.counties ?? []) {
      const src = c['parcel_source'];
      const rows = c['rows'];
      if (typeof src !== 'string' || typeof rows !== 'number' || rows <= 0) continue;
      const prev = out.get(src) ?? { rows: 0, lastIngestedAt: null, allComplete: true };
      // ⛔ THE LEDGER DATES THE RUN. `last_ingested_at` is written by the ingest
      // itself, so a source with parcels AND a timestamp did demonstrably run —
      // reporting it `never-run` because no manifest exists is the denial this
      // file already shipped once.
      const at = c['last_ingested_at'];
      const stamped = typeof at === 'string' ? at : null;
      out.set(src, {
        rows: prev.rows + rows,
        lastIngestedAt:
          stamped && (!prev.lastIngestedAt || stamped > prev.lastIngestedAt) ? stamped : prev.lastIngestedAt,
        allComplete: prev.allComplete && c['ledger_status'] === 'complete',
      });
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
      // Output-on-disk evidence FIRST — it is the strongest signal available and
      // the one whose absence caused the previous falsehood.
      const produced = producedEvidence(root, id);
      if (produced) {
        out.push({
          source_id: id, label,
          last_success: produced.at, last_attempt: produced.at, rows: produced.rows,
          state: 'ok',
          note: `No run manifest exists, but this source's output is on disk (${PRODUCED_BY[id]?.file}) and is what the site publishes. Timestamp is the artifact's own.`,
        });
        continue;
      }
      // ⛔ A REFUSED source is NOT a source. It is reported separately by
      // buildRefusals() — listing it under "Sources" implies it is one of ours
      // and merely idle, when in fact we decided not to fetch it. Two different
      // facts, two different arrays.
      if (refusedReason(root, id)) continue;
      const att = attributed.get(id);
      const held = att?.rows ?? 0;
      if (att && att.lastIngestedAt) {
        out.push({
          source_id: id, label,
          last_success: att.lastIngestedAt, last_attempt: att.lastIngestedAt, rows: att.rows,
          state: att.allComplete ? 'ok' : 'degraded',
          note: `No run manifest exists, but the county ledger dates this source's ingest and ${att.rows.toLocaleString()} parcel(s) are attributed to it.`,
        });
        continue;
      }
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


export type PublishedRefusal = {
  source_id: string;
  label: string;
  /** The machine-readable ground, straight from the registry. */
  refusal: string;
  /** Where the evidence for that ground is cached, so the claim is auditable. */
  evidence_url: string | null;
};

/**
 * WHAT WE FOUND AND DECIDED NOT TO FETCH.
 *
 * ⛔ This is the half of the truth the site could not previously express.
 * `SourceStatus.state` is `ok | degraded | failed | never-run` — four values,
 * none of which mean "this source exists, we found it, and their terms say no".
 * For the counties where a source EXISTS but is closed to us, "never-run" reads
 * as our omission rather than their decision, and that is precisely backwards.
 *
 * The vocabulary already existed in the registry (`refused[]` in
 * sources.enrich.yaml, gated by verify-sources.mjs for evidence-on-disk and for
 * collision with live entries). It simply never reached the reader. This lifts
 * it rather than inventing a second one.
 */
export function buildRefusals(root: string): PublishedRefusal[] {
  const out: PublishedRefusal[] = [];
  const p = join(root, 'sources/sources.enrich.yaml');
  if (!existsSync(p)) return out;
  try {
    const doc = yaml.load(readFileSync(p, 'utf8')) as Record<string, unknown>;
    for (const r of (doc['refused'] as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof r['id'] !== 'string') continue;
      out.push({
        source_id: r['id'],
        label: typeof r['label'] === 'string' ? r['label'] : r['id'],
        refusal: typeof r['refusal'] === 'string' ? r['refusal'] : 'unstated',
        evidence_url: typeof r['evidence_url'] === 'string' ? r['evidence_url'] : null,
      });
    }
  } catch { /* an unreadable registry asserts nothing */ }
  return out.sort((a, b) => a.source_id.localeCompare(b.source_id));
}
