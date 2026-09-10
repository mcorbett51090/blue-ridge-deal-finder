#!/usr/bin/env node
/**
 * check-freshness.mjs — how old is the newest ingest, and is that acceptable?
 *
 * Invoked by .github/workflows/freshness.yml as:
 *   node scripts/check-freshness.mjs --max-age-days 10
 *
 * ⛔ READ docs/decisions/0006-heartbeat.md BEFORE TRUSTING THIS.
 * A monitor that runs on the schedule it monitors cannot detect that schedule
 * being disabled: when the scheduler stops, the monitor stops with it and
 * reports nothing, forever — which is byte-identical to healthy. This script is
 * the IN-BAND half only. Its real product is the freshness fact written into
 * the published site, where staleness is visible on the artifact a human
 * actually looks at.
 *
 * ⛔ AND AN ABSENT MANIFEST IS NOT FRESH. `Math.max()` of an empty list is
 * -Infinity, and `-Infinity > maxAgeMs` is false — the exact `undefined < floor`
 * shape that made a total outage read as a pass elsewhere in this repo. No
 * manifests is an explicit, loud UNKNOWN.
 *
 * ⛔ `status: 'partial'` IS EVIDENCE OF A REAL RUN, NOT UNKNOWN.
 * `ingest-parcels.ts` marks a manifest `complete` only when EVERY target
 * county in the full sweep was attempted and succeeded in that one run — a
 * single flaky county (or a deliberate `--counties=` subset, e.g. the
 * `--counties=Macon` operation ADR 0009 names as the next one) makes it
 * `partial` instead, forever, because counties not attempted THIS run are
 * always appended as `not-run`. Measured: every manifest this project has
 * ever produced is `partial` or `failed`, never `complete` — so requiring
 * `complete` made this gate fail on every real run regardless of how much
 * genuinely fresh, gate-passing data it warehoused.
 *
 * `publish/status.ts` already drew this line correctly for the SAME manifests
 * (`ok = complete`, `degraded = partial`, both count as a real `last_success`;
 * only `failed` — zero successful counties — does not). This gate now agrees
 * with the surface that publishes freshness to the reader, instead of holding
 * every real run to a stricter, silently unreachable bar that surface never
 * applied. A `failed` manifest (every attempted county errored) still counts
 * for nothing — it is not evidence anything current was warehoused.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gate, inspectRoot, walk } from './lib/gate.mjs';

const gate = new Gate('check-freshness');
const root = inspectRoot();

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : fallback;
}

const maxAgeDays = argValue('--max-age-days', 10);
const runsDir = join(root, 'data', 'runs');
const now = Date.now();

if (!existsSync(runsDir)) {
  gate.fail(
    `data/runs/ does not exist — no ingest has ever completed. This is UNKNOWN, not fresh. ` +
      `(Expected until P2 ships; the gate is loud on purpose so it cannot be mistaken for healthy.)`,
  );
  gate.finish();
} else {
  const manifests = walk(runsDir, { exts: ['.json'] });
  if (manifests.length === 0) {
    gate.fail('data/runs/ is empty — 0 manifests. An empty list is UNKNOWN, never fresh.');
    gate.finish();
  } else {
    // Evidence of a real, gate-passing run — `complete` (every target county
    // succeeded) OR `partial` (at least one county succeeded; the rest were
    // simply not attempted this run, which is not the same as this run having
    // produced nothing). `failed` is excluded: it means every attempted county
    // errored, so the run warehoused nothing new to be fresh about.
    const USABLE_STATUSES = new Set(['complete', 'partial']);
    let newest = null;
    let usable = 0;
    for (const path of manifests) {
      let m;
      try {
        m = JSON.parse(readFileSync(path, 'utf8'));
      } catch (err) {
        gate.fail(`${path}: unparseable manifest — ${err.message}`);
        continue;
      }
      if (!USABLE_STATUSES.has(m.status)) continue;
      usable++;
      const t = Date.parse(m.finished_at ?? m.started_at ?? '');
      if (!Number.isFinite(t)) {
        gate.fail(`${path}: status=${m.status} but no parseable finished_at/started_at`);
        continue;
      }
      if (newest === null || t > newest) newest = t;
    }

    if (usable === 0) {
      gate.fail(
        `${manifests.length} manifest(s) found but none has status=complete or status=partial — UNKNOWN, not fresh`,
      );
    } else if (newest === null) {
      gate.fail('no complete/partial manifest carried a usable timestamp — UNKNOWN, not fresh');
    } else {
      const ageDays = (now - newest) / 86_400_000;
      gate.info(`newest usable (complete/partial) run: ${new Date(newest).toISOString()} (${ageDays.toFixed(2)}d old)`);
      if (ageDays > maxAgeDays) {
        gate.fail(`data is ${ageDays.toFixed(1)}d old, budget is ${maxAgeDays}d`);
      } else {
        gate.ok(`data age ${ageDays.toFixed(2)}d within the ${maxAgeDays}d budget`);
      }
    }
    gate.finish();
  }
}
