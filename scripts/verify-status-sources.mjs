#!/usr/bin/env node
/**
 * EVERY PUBLISHED source_id MUST RESOLVE TO A REGISTRY ENTRY.
 *
 * ⛔ THIS GATE EXISTS BECAUSE THE SITE SHIPPED INVENTED SOURCE HISTORY.
 * Measured 2026-08-19 against the DEPLOYED site: `data/status.json` carried
 * `"fixture": true` and listed seven sources, four of which existed in no
 * registry anywhere in the repo:
 *
 *     nc-tax-foreclosure    state: ok        last_success: 2026-08-18T11:04Z
 *     va-county-gis         state: degraded  last_success: 2026-08-04T02:10Z
 *     ga-notices            state: degraded  last_success: 2026-08-12T10:00Z  rows: 3
 *     sc-master-in-equity   state: degraded  last_success: 2026-08-14T12:00Z
 *
 * `ga-notices` asserted a successful GEORGIA fetch on a specific date, with a
 * row count, for a source that has never existed — on the page built to tell a
 * reader "we cannot see this county" apart from "this county is quiet". Its
 * note was accurate about qPublic, which made it more convincing, not less.
 *
 * ⛔ WHY THE EXISTING GATE MISSED IT. `site/scripts/verify-data.mjs` check 11
 * validates the SHAPE of status.json — field names, types, enum membership. A
 * schema check cannot see an invented identifier: `"ga-notices"` is a perfectly
 * well-formed string. Shape conformance and referential integrity are different
 * assertions, and only the second one catches a fabrication.
 *
 * The rule: a source the reader can see named MUST be a source we have declared,
 * with a robots verdict and controls attached to it. Anything else is a claim
 * about the world with nothing behind it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const problems = [];

const statusPath = join(ROOT, 'site/public/data/status.json');
if (!existsSync(statusPath)) {
  console.log('· verify-status-sources — no site/public/data/status.json; nothing published to check.');
  process.exit(0);
}

// Every id any registry declares, at any nesting depth.
const declared = new Set();
const srcDir = join(ROOT, 'sources');
if (existsSync(srcDir)) {
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.yaml')) continue;
    let doc;
    try { doc = yaml.load(readFileSync(join(srcDir, f), 'utf8')); } catch { continue; }
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === 'object') {
        if (typeof n.id === 'string') declared.add(n.id);
        Object.values(n).forEach(walk);
      }
    };
    walk(doc);
  }
}
if (declared.size === 0) problems.push('no source ids found in sources/*.yaml — the registry is the authority and it is empty');

const status = JSON.parse(readFileSync(statusPath, 'utf8'));

// ⛔ A published fixture is itself the defect. The freshness surface is derived
// (publish/status.ts); a `fixture: true` here means a hand-typed file reached
// the site again.
if (status.fixture === true) {
  problems.push('status.json carries `fixture: true` — the published freshness surface must be DERIVED, not hand-written');
}

for (const s of status.sources ?? []) {
  if (!declared.has(s.source_id)) {
    problems.push(
      `status.json names source_id '${s.source_id}' (state: ${s.state}, last_success: ${s.last_success}) ` +
        'which exists in NO registry — a source the reader can see must be one we have declared',
    );
  }
  // A success timestamp with no run behind it is the exact shape of the fabrication.
  if (s.last_success !== null && s.state === 'never-run') {
    problems.push(`status.json: '${s.source_id}' is never-run yet carries last_success ${s.last_success}`);
  }
}

if (problems.length) {
  console.error('verify-status-sources: FAILED');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`✓ verify-status-sources — ${(status.sources ?? []).length} published source(s), all resolve to a registry entry`);
