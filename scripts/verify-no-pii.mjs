#!/usr/bin/env node
/**
 * verify-no-pii.mjs — NO OWNER PII ON ANY PUBLISHED SURFACE (D1, binding).
 *
 * ⛔ THIS GATE EXISTS BECAUSE ITS PREDECESSOR READ GREEN WHILE THE PII SHIPPED.
 * Panel A's version scanned dist/ and nothing else, and reported clean while the
 * warehouse Release asset carried ~500k owner names. Scanning one of several
 * surfaces is a PROXY ASSERTION: it can pass in full while the user-visible
 * outcome is completely broken.
 *
 * Surfaces asserted here:
 *   1. the git tree (every tracked file)
 *   2. data/            — the event log and any local tier that landed on disk
 *   3. publish/out/     — the export the site consumes
 *   4. site/dist/       — the built site
 *   5. publish/allowlist.json — the payload SCHEMA, which must not even be able
 *                              to carry a PII field
 *
 * ⛔ AND EVERY SURFACE CARRIES A POSITIVE CONTROL. The canary is planted into a
 * scratch copy of each surface and the scanner must flag it there. A surface
 * that reports clean without its canary having been flagged is a BROKEN
 * SCANNER, not a clean surface — an empty result and a broken probe are
 * indistinguishable afterwards.
 *
 * Release assets (surface 2 in the plan's own list) are NOT asserted here: this
 * repo has no releases yet and P1 makes no network call. That is an OWED
 * assertion, not a satisfied one — see the receipt and P9.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Gate, inspectRoot, isDir, readJson, selfRoot, walk } from './lib/gate.mjs';
import { PII_FIELDS } from '../pipeline/normalize/redact.ts';

const gate = new Gate('verify-no-pii');
const root = inspectRoot();

const canary = readJson(join(selfRoot(), 'fixtures', 'pii-canary.json'));
const CANARY = canary.token;

/** Exemptions, printed on every run so they can never be quiet.
 *
 *  These apply to the GIT-TREE surface ONLY. The three PUBLISHED surfaces —
 *  data/, publish/out/ and site/dist/ — are never exempt from anything, because
 *  those are what actually reach the world.
 *
 *  Why `tests/` is here: a test that proves the PII gate fires must contain a
 *  PII field name to plant as a canary. Flagging it makes the gate fail
 *  precisely because someone proved it works — and the pressure that creates is
 *  to delete the proof. That is the wrong trade. A canary in a test is evidence
 *  the gate works; a canary in published output is a leak. The surface split is
 *  what keeps both true. */
const EXEMPT_PREFIXES = ['fixtures/', 'tests/'];

/**
 * A PII field in a payload is always a KEY WITH A VALUE, i.e. a quoted field
 * name followed by a colon. Matching that shape rather than the bare word is
 * what lets redact.ts name the fields it strips without tripping its own gate.
 *
 * NB: this comment deliberately does not spell the pattern out. Unlike the
 * egress gate, this one must NOT strip comments before scanning — a name in a
 * comment is still a name in the tree — so the only safe way to describe the
 * pattern here is not to write it.
 */
const JSON_KEY_RE = new RegExp(`"(${PII_FIELDS.join('|')})"\\s*:`, 'i');
const CSV_HEADER_RE = new RegExp(`(^|,)\\s*(${PII_FIELDS.join('|')})\\s*(,|$)`, 'i');

function scanText(text, path) {
  const hits = [];
  if (text.includes(CANARY)) hits.push(`${path}: canary token present`);
  const key = JSON_KEY_RE.exec(text);
  if (key) hits.push(`${path}: PII key ${key[0]}`);
  if (path.endsWith('.csv')) {
    const header = text.split('\n', 1)[0] ?? '';
    const h = CSV_HEADER_RE.exec(header);
    if (h) hits.push(`${path}: PII CSV header field '${h[2]}'`);
  }
  return hits;
}

function scanFiles(files, base) {
  const hits = [];
  for (const f of files) {
    const rel = relative(base, f).split(sep).join('/');
    if (EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue;
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue; // binary or unreadable — nothing to grep
    }
    hits.push(...scanText(text, rel));
  }
  return hits;
}

function gitTrackedFiles(dir) {
  try {
    // --others --exclude-standard includes files that are present and NOT
    // gitignored but not yet committed. An uncommitted PII file is one `git add`
    // away from permanent public history, so it is in scope now, not later.
    const out = execFileSync(
      'git',
      ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.split('\0').filter(Boolean).map((p) => join(dir, p));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// POSITIVE CONTROLS FIRST. If the scanner cannot see a planted canary, nothing
// it says afterwards means anything, so the controls run before the surfaces.
// ---------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), 'brdf-pii-control-'));
const piiFixture = readFileSync(join(selfRoot(), 'fixtures', 'pii-present.json'), 'utf8');
let controlsOk = true;
for (const surface of ['git-tree', 'data', 'publish-out', 'site-dist']) {
  const dir = join(scratch, surface);
  mkdirSync(dir, { recursive: true });
  const planted = join(dir, 'planted-parcels.json');
  writeFileSync(planted, piiFixture);
  const hits = scanFiles([planted], dir);
  if (hits.length === 0) {
    gate.fail(`CONTROL FAILED for surface '${surface}': planted canary was NOT flagged — scanner is broken`);
    controlsOk = false;
  }
}
// ALTERNATION CONTROL. The patterns are built by joining the field list with a
// regex alternation. A broken alternation still matches the FIRST alternative,
// so a control that only ever plants the first field cannot tell a working
// pattern from a broken one. This plants the LAST field, alone.
const lastField = PII_FIELDS[PII_FIELDS.length - 1];
const altControl = join(scratch, 'alternation-control.json');
writeFileSync(altControl, `{ "parno": "1", ${JSON.stringify(lastField)}: "28607" }\n`);
if (scanFiles([altControl], scratch).length === 0) {
  gate.fail(`CONTROL FAILED: '${lastField}' alone was not matched — the pattern alternation is broken`);
  controlsOk = false;
}

// The CSV path is a separate code branch and needs its own control.
const csvControl = join(scratch, 'control.csv');
writeFileSync(csvControl, `parno,ownname,mailadd\n1,${CANARY},1 X LANE\n`);
if (scanFiles([csvControl], scratch).length === 0) {
  gate.fail('CONTROL FAILED for CSV header scanning — scanner is broken');
  controlsOk = false;
}
if (controlsOk) gate.ok('positive controls: canary flagged on all 4 surface scanners + CSV header path');

// ---------------------------------------------------------------------------
// Surface 1 — the git tree
// ---------------------------------------------------------------------------
const tracked = gitTrackedFiles(root);
if (tracked === null) {
  gate.info('surface git-tree: NOT A GIT REPO from this root — enumerated via filesystem walk instead');
  const files = walk(root, { skip: ['node_modules', '.git', '.astro', 'dist'] });
  gate.info(`surface git-tree(fallback): ${files.length} file(s)`);
  for (const h of scanFiles(files, root)) gate.fail(`git-tree: ${h}`);
} else if (tracked.length === 0) {
  // Zero tracked files is a broken enumeration, not a clean tree.
  gate.fail('surface git-tree: git ls-files returned 0 files — enumeration is broken, not the tree clean');
} else {
  gate.info(`surface git-tree: ${tracked.length} tracked file(s), exempt prefixes: ${EXEMPT_PREFIXES.join(', ')}`);
  for (const h of scanFiles(tracked, root)) gate.fail(`git-tree: ${h}`);
}

// ---------------------------------------------------------------------------
// Surfaces 2-4 — on-disk output trees. ABSENT is reported as ABSENT.
// ---------------------------------------------------------------------------
for (const [label, relDir] of [
  ['data', 'data'],
  ['publish-out', join('publish', 'out')],
  ['site-dist', join('site', 'dist')],
]) {
  const dir = join(root, relDir);
  if (!isDir(dir)) {
    gate.info(`surface ${label}: ABSENT (${relDir} not built or populated) — 0 files scanned, NOT a clean result`);
    continue;
  }
  const files = walk(dir);
  gate.info(`surface ${label}: ${files.length} file(s)`);
  for (const h of scanFiles(files, root)) gate.fail(`${label}: ${h}`);
}

// ---------------------------------------------------------------------------
// Surface 5 — the payload schema itself
// ---------------------------------------------------------------------------
const allowlistPath = join(root, 'publish', 'allowlist.json');
if (!existsSync(allowlistPath)) {
  gate.fail('publish/allowlist.json missing — the payload schema is unconstrained');
} else {
  const allow = readJson(allowlistPath);
  const pii = new Set(PII_FIELDS.map((f) => f.toLowerCase()));
  // ⛔ EVERY kind in the file, discovered from the file — not a hardcoded pair.
  // A payload kind added later (the site `listing` projection was) would
  // otherwise ship UNCHECKED while this gate reported green about the two kinds
  // it happened to know the names of.
  const kinds = Object.keys(allow).filter((k) => !k.startsWith('_') && Array.isArray(allow[k]));
  if (kinds.length === 0) gate.fail('publish/allowlist.json declares no payload kinds — nothing was checked');
  for (const kind of kinds) {
    for (const field of allow[kind] ?? []) {
      if (pii.has(String(field).toLowerCase())) gate.fail(`publish/allowlist.json ${kind}: permits PII field '${field}'`);
    }
  }
  gate.ok(`publish allowlist carries no PII field (${kinds.length} kind(s): ${kinds.join(', ')})`);
}

gate.finish();
