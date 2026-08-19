#!/usr/bin/env node
/**
 * PROVENANCE GATE — every source link must show the RECORD, not a homepage.
 *
 * ⛔ The defect this exists to stop, reported by the owner 2026-08-19:
 * a Fannin County GA row linked to `https://www.gsccca.org/`. Two things were
 * wrong and only the first is obvious.
 *
 *   1. A bare homepage is not provenance. "Here is where this came from"
 *      is a claim, and a link that does not resolve to the record does not
 *      support it. The owner is spending money on these rows; a link that
 *      drops him on a search page he must re-run by hand is worse than no
 *      link, because it looks like verification and is not.
 *
 *   2. `gsccca.org` is on our OWN sources.denied.yaml — it requires an
 *      account and our fetcher never authenticates to a third party. So we
 *      never fetched it and could not have. The row was citing a source it
 *      did not come from.
 *
 * The honest alternatives to a deep link are `record_url: null` plus a
 * `how_to_verify` string a human can actually follow. Silence is not one of
 * them, and neither is a homepage.
 *
 * A real per-record link IS constructible for the NC anchor — an ArcGIS
 * /query filtered to cntyname + parno returns exactly that one parcel
 * (verified live 2026-08-19: 1 row for a named parno, 0 for a bogus one).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const problems = [];
let checked = 0;
let deepLinks = 0;
let honestNulls = 0;
let genericLinks = 0;

/** Hosts we are forbidden to fetch — citing one is a false provenance claim. */
function deniedHosts() {
  const p = join(ROOT, 'sources/sources.denied.yaml');
  if (!existsSync(p)) return [];
  return [...readFileSync(p, 'utf8').matchAll(/^\s*-?\s*host:\s*["']?([^"'\s#]+)/gm)].map((m) =>
    m[1].replace(/^\*\./, '').toLowerCase(),
  );
}

/** A URL whose path carries no record identity — an origin, or a lone slash. */
function isBareOrigin(u) {
  try {
    const { pathname, search } = new URL(u);
    return (pathname === '/' || pathname === '') && !search;
  } catch {
    return false;
  }
}

function walkJson(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (e === 'node_modules' || e === 'dist' || e.startsWith('.')) continue;
    const s = statSync(p);
    if (s.isDirectory()) walkJson(p, out);
    else if (e.endsWith('.json')) out.push(p);
  }
  return out;
}

const denied = deniedHosts();
const URL_KEYS = ['record_url', 'source_url', 'sourceUrl', 'url'];

function inspect(obj, file, path = '') {
  if (Array.isArray(obj)) return obj.forEach((v, i) => inspect(v, file, `${path}[${i}]`));
  if (!obj || typeof obj !== 'object') return;

  for (const k of URL_KEYS) {
    const v = obj[k];
    if (typeof v !== 'string' || !v.startsWith('http')) continue;
    checked++;
    // Owner ruling 2026-08-19: a generic link is WANTED where no per-record page
    // exists — "give me the generic link and label it as such". So the sin was
    // never the homepage; it was the UNLABELLED homepage masquerading as
    // record-level provenance. A link declared `source_scope: 'generic'` is
    // honest and useful. One left undeclared still fails.
    const scope = obj.source_scope;
    if (scope === 'generic') {
      if (typeof obj.source_label !== 'string' || obj.source_label.trim().length < 4) {
        problems.push(`${file}${path}.${k}: source_scope 'generic' with no source_label — a generic link MUST say what it is`);
      } else genericLinks++;
    } else if (isBareOrigin(v)) {
      problems.push(`${file}${path}.${k}: BARE HOMEPAGE and not labelled generic — it reads as record-level provenance and is not: ${v}`);
    } else {
      deepLinks++;
    }
    let host = '';
    try { host = new URL(v).hostname.toLowerCase(); } catch { /* handled above */ }
    if (host && denied.some((d) => host === d || host.endsWith(`.${d}`))) {
      problems.push(`${file}${path}.${k}: cites a DENIED host we never fetched: ${host}`);
    }
  }

  // A null record_url is fine ONLY with instructions a human can follow.
  // A null record_url is fine with EITHER a labelled generic link or usable
  // instructions. Silence is still not an option.
  if ('record_url' in obj && obj.record_url === null && obj.source_scope !== 'generic') {
    const how = obj.how_to_verify;
    if (typeof how !== 'string' || how.trim().length < 12) {
      problems.push(`${file}${path}: record_url is null with no usable how_to_verify`);
    } else honestNulls++;
  }

  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') inspect(v, file, `${path}.${k}`);
  }
}

for (const dir of ['site/src/data', 'publish/out', 'data']) {
  for (const f of walkJson(join(ROOT, dir))) {
    if (f.includes('/warehouse/') || f.endsWith('claim-id-map.json')) continue;
    let parsed;
    try { parsed = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    inspect(parsed, f.replace(ROOT + '/', ''));
  }
}

if (checked === 0 && honestNulls === 0 && genericLinks === 0) {
  // ⛔ Not a pass. A gate that inspected nothing must never report clean —
  // this project has shipped that mistake once already.
  console.error('verify-provenance: NO URLs INSPECTED — cannot report clean');
  process.exit(1);
}

if (problems.length) {
  console.error('verify-provenance: FAILED');
  for (const p of problems.slice(0, 25)) console.error(`  ✗ ${p}`);
  if (problems.length > 25) console.error(`  … ${problems.length - 25} more`);
  process.exit(1);
}

console.log(
  `✓ verify-provenance — ${deepLinks} record-level link(s), ${genericLinks} labelled generic, ` +
  `${honestNulls} instruction-only, 0 denied hosts cited`,
);
