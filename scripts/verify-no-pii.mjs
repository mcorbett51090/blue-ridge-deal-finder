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

/**
 * VALUE-LEVEL SCREEN for data/evidence/** — structural, not a name detector.
 *
 * ⛔ Why a structure check and not a name regex. These files are built from
 * county foreclosure and REO documents, the documents most likely to carry a
 * person's name, and the rest of this gate matches field NAMES only — a grantor
 * name sitting in a VALUE passes it completely. A name REGEX would be the
 * obvious answer and it is the wrong one: it fails open on every spelling it did
 * not anticipate, and it fails closed on "Jackson County", which is a place.
 *
 * The evidence contract has no free-text field at all, by construction: every
 * value is a closed-vocabulary `kind`, a URL, an ISO timestamp, a number, null,
 * or a label this repo authored. So the honest assertion is not "does this look
 * like a name" but "is this value one of the shapes the contract can produce".
 * Anything else is off-contract and refused, whatever it says. That catches a
 * name without ever trying to recognise one — including names it has never seen.
 */
const EVIDENCE_ALLOWED_KEYS = new Set([
  'kind', 'label', 'source_url', 'observed_at', 'sale_date', 'opening_bid', 'price',
]);
const ISO_RE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;
const URL_RE = /^https?:\/\/\S+$/;
/** Labels this repo authors. Kept explicit and short — if a new one is needed it
 *  is one line here, and that line is a deliberate decision to publish a string. */
const AUTHORED_LABELS = new Set(['County-owned, acquired through foreclosure']);

function scanEvidenceValues(text, path) {
  const hits = [];
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return [`${path}: not parseable JSON — the evidence contract must be machine-checkable`];
  }
  const visit = (node, where) => {
    if (node === null || typeof node === 'number' || typeof node === 'boolean') return;
    if (typeof node === 'string') {
      if (URL_RE.test(node) || ISO_RE.test(node) || AUTHORED_LABELS.has(node)) return;
      if (/^[a-z][a-z0-9_-]*$/.test(node)) return; // a closed-vocabulary token
      hits.push(
        `${path}: ${where} carries free text that the contract cannot produce — ` +
          `"${node.slice(0, 60)}${node.length > 60 ? '…' : ''}". Evidence values are URLs, ISO ` +
          'timestamps, closed-vocabulary tokens, numbers or authored labels; anything else may carry a name.',
      );
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${where}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      // Record ids are object KEYS at the top level and are parcel identifiers.
      const isTopLevelId = where === '$';
      if (!isTopLevelId && !EVIDENCE_ALLOWED_KEYS.has(k)) {
        hits.push(
          `${path}: ${where}.${k} is not a field the evidence contract declares — ` +
            'an undeclared field is an unreviewed surface, and this one is built from foreclosure documents.',
        );
      }
      visit(v, `${where}.${k}`);
    }
  };
  visit(doc, '$');
  return hits;
}

/**
 * VALUE-LEVEL SCREEN for the NOTICE contract.
 *
 * ⛔ Scoped separately from the evidence screen on purpose. The evidence rule
 * ("no free text at all") cannot be applied to every published file — listings
 * carry legitimate prose in `note` and `basis` strings, and running the strict
 * rule there would produce thousands of false positives, which is how a real
 * signal gets switched off.
 *
 * Notices CAN take the strict treatment because their contract is closed: every
 * field has a known shape. Notices are built from county foreclosure postings —
 * and the Georgia legal-organ sources queued next carry the DEBTOR'S NAME in the
 * advertisement title. Until now nothing screened them: `project()` never ran on
 * notices, and the evidence screen is regex-scoped to `^data/evidence/`.
 */
const NOTICE_KINDS = new Set(['tax-foreclosure', 'sale-under-power', 'sheriff-sale', 'county-notice']);
const NOTICE_SHAPES = {
  notice_id: /^[A-Za-z0-9._-]{1,40}$/,
  source_id: /^[a-z0-9-]{1,60}$/,
  state: /^[A-Z]{2}$/,
  county: /^[A-Za-z][A-Za-z .'-]{0,40}$/,
  fips: /^[0-9]{5}$/,
  source_url: /^https?:\/\/\S+$/,
  observed_at: /^\d{4}-\d{2}-\d{2}([T ].*)?$/,
  sale_date: /^\d{4}-\d{2}-\d{2}$/,
};

function scanNoticeValues(text, path) {
  const hits = [];
  let rows;
  try {
    const doc = JSON.parse(text);
    rows = Array.isArray(doc) ? doc : (doc.notices ?? []);
  } catch {
    return [`${path}: not parseable JSON — the notice contract must be machine-checkable`];
  }
  for (const [i, n] of rows.entries()) {
    if (!n || typeof n !== 'object') continue;
    for (const [k, v] of Object.entries(n)) {
      if (v === null) continue;
      if (k === 'kind') {
        if (!NOTICE_KINDS.has(v)) hits.push(`${path}[${i}].kind '${String(v).slice(0, 40)}' is outside the closed vocabulary`);
        continue;
      }
      const shape = NOTICE_SHAPES[k];
      if (!shape) {
        hits.push(`${path}[${i}].${k} is not a field the notice contract declares — an undeclared field on a surface built from foreclosure postings is an unreviewed one`);
        continue;
      }
      if (typeof v !== 'string' || !shape.test(v)) {
        hits.push(
          `${path}[${i}].${k} does not match its declared shape — "${String(v).slice(0, 60)}". ` +
            'County postings name people; a value that is not the shape we expect may be carrying one.',
        );
      }
    }
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
    // The evidence contract gets the extra, value-level screen.
    if (/^data\/evidence\/.+\.json$/.test(rel)) hits.push(...scanEvidenceValues(text, rel));
    // ⛔ PUBLISHED notice surfaces only — publish/out and the site's copy, both
    // of them, never just one. NOT data/distress/notices.json: that is the
    // INGEST record of what the county actually posted, and it legitimately
    // keeps the raw `title` because the title is what we classify from. The
    // contract applies where the bytes reach a reader.
    if (/^(publish\/out|site\/src\/data)\/notices\.json$/.test(rel)) hits.push(...scanNoticeValues(text, rel));
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



// ⛔ THE RAW COUNTY TEXT MUST NEVER REACH A PUBLISHED SURFACE.
//
// The ingest keeps the county's own `title` — that is the record of what was
// posted, and it is what `classifyNotice` reads. The published contract has no
// free-text field at all. This asserts the SEAM between them: every title in
// data/distress/notices.json must be absent from every published notice file.
//
// It matters because the sources queued next are Georgia legal-organ
// advertisements, whose titles conventionally carry the DEBTOR'S NAME. A
// regression that re-added `title` to the projection would put a named
// individual's foreclosure on the homepage, and no field-NAME check would see
// it — the field is called `title`, which is not a PII field name.
{
  const ingestPath = join(root, 'data/distress/notices.json');
  if (existsSync(ingestPath)) {
    let titles = [];
    try {
      const doc = JSON.parse(readFileSync(ingestPath, 'utf8'));
      titles = ((Array.isArray(doc) ? doc : doc.notices) ?? [])
        .map((n) => n?.title)
        .filter((t) => typeof t === 'string' && t.trim().length > 8);
    } catch { /* an unreadable ingest asserts nothing */ }
    let checked = 0;
    for (const surface of ['publish/out/notices.json', 'site/src/data/notices.json']) {
      const sp = join(root, surface);
      if (!existsSync(sp)) continue;
      checked += 1;
      const body = readFileSync(sp, 'utf8');
      for (const t of titles) {
        if (body.includes(t)) {
          gate.fail(
            `${surface}: carries the county's raw posting text verbatim ("${t.slice(0, 60)}") — ` +
              'the published contract has no free-text field, and these postings name people',
          );
        }
      }
    }
    gate.info(`notice seam: ${titles.length} ingest title(s) confirmed absent from ${checked} published surface(s)`);
  }
}

gate.finish();
