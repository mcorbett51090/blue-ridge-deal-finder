#!/usr/bin/env node
/**
 * PREBUILD GATE. Exits non-zero, which fails the build.
 *
 * Ported in shape from SWC's scripts/verify-data.mjs (claims-D claims 34/36): a
 * numbered list of checks that runs before `astro build`, so a payload that
 * violates the site's honesty rules cannot be rendered at all.
 *
 * These are not style checks. Each one corresponds to a specific way this site
 * could lie while looking perfectly healthy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const listings = read('src/data/fixtures/listings.json');
const coverage = read('src/data/coverage.json');
const status = read('public/data/status.json');

const errors = [];
const fail = (n, msg) => errors.push(`[${n}] ${msg}`);

// --- 0. The payload is a non-empty array of objects -------------------------
if (!Array.isArray(listings) || listings.length === 0) {
  fail(0, 'listings payload is not a non-empty array');
}

// --- 1. NO OWNER PII, enforced by a FIELD ALLOWLIST that fails closed --------
// A denylist cannot be defeated only by a field nobody has heard of yet; an
// allowlist can't be defeated by one at all. The defended failure is an upstream
// schema change arriving with owner data in it and riding to a world-visible map
// because nobody thought to add it to a denylist.
const ALLOWED = new Set([
  'id', 'fips', 'county', 'state', 'lat', 'lng', 'acres', 'assessed_value', 'price',
  'score', 'score_breakdown', 'for_sale_evidence', 'water', 'flood_zone', 'parcel_use',
  'source_url', 'record_url', 'how_to_verify', 'source_id', 'source_note',
  'first_seen', 'last_seen',
  'confidence', 'acreage_basis', 'assessment_year', 'reappraisal_year',
  'owner_out_of_state', 'owner_is_entity', 'tenure_years', 'note',
]);
const FORBIDDEN_SUBSTRINGS = ['owner_name', 'ownername', 'grantor', 'grantee', 'mailing', 'taxpayer', 'addr'];

const seen = new Set();
for (const [i, l] of listings.entries()) {
  const at = `row ${i} (${l?.id ?? 'no id'})`;

  for (const k of Object.keys(l ?? {})) {
    if (!ALLOWED.has(k)) fail(1, `${at}: non-allowlisted field "${k}"`);
    const lower = k.toLowerCase();
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      if (lower.includes(bad)) fail(1, `${at}: field "${k}" looks like owner PII`);
    }
  }

  // --- 2. Required fields present and of the right kind ---------------------
  for (const k of ['id', 'fips', 'county', 'state', 'parcel_use', 'first_seen', 'last_seen']) {
    if (typeof l?.[k] !== 'string' || l[k] === '') fail(2, `${at}: missing or empty "${k}"`);
  }
  if (typeof l?.lat !== 'number' || typeof l?.lng !== 'number') fail(2, `${at}: lat/lng must be numbers`);

  // --- 3. Globally unique ids ----------------------------------------------
  if (seen.has(l?.id)) fail(3, `${at}: duplicate id`);
  seen.add(l?.id);

  // --- 4. EVERY row is TRACEABLE to its primary source (an owner requirement)
  //
  // ⛔ This check used to read "source_url must be an http URL", and that is how
  // the defect the owner reported got in. Many counties publish no per-record
  // page at all, so a required-URL field with nothing to put in it got a
  // HOMEPAGE — and one of those homepages (gsccca.org) is a host on our own
  // sources.denied.yaml, which we never fetched and could not have. The schema
  // made honesty impossible, so the data lied.
  //
  // The owner's requirement is traceability, not the presence of a URL. It has
  // exactly two legal shapes, and a homepage is neither:
  //   • record_url  — resolves to THAT record. For the NC anchor this is a real
  //                   ArcGIS /query filtered to cntyname + parno (verified live:
  //                   1 row for a real parno, 0 for a bogus one).
  //   • record_url: null + how_to_verify — plain instructions a human can follow.
  const rec = l?.record_url ?? l?.source_url ?? null;
  if (rec === null || rec === '') {
    const how = l?.how_to_verify;
    if (typeof how !== 'string' || how.trim().length < 12) {
      fail(4, `${at}: no record_url and no usable how_to_verify — the row is untraceable`);
    }
  } else if (!/^https?:\/\//.test(rec)) {
    fail(4, `${at}: record_url is not an http(s) URL`);
  } else {
    let u = null;
    try { u = new URL(rec); } catch { fail(4, `${at}: record_url is unparseable`); }
    if (u && (u.pathname === '' || u.pathname === '/') && !u.search) {
      fail(4, `${at}: record_url is a BARE HOMEPAGE — it does not show the record`);
    }
  }

  // --- 5. UNKNOWN IS NOT ZERO ----------------------------------------------
  // `null` is the only legal spelling of unknown. A 0 in these fields is either
  // a real zero (which is meaningless for acreage and near-meaningless for an
  // assessed value) or, far more likely, an unknown that got defaulted
  // somewhere upstream. Refuse both rather than guess which.
  for (const k of ['acres', 'assessed_value', 'price']) {
    const v = l?.[k];
    if (v === undefined) fail(5, `${at}: "${k}" must be present as a number or null, not absent`);
    else if (v !== null && (typeof v !== 'number' || !Number.isFinite(v))) {
      fail(5, `${at}: "${k}" must be a finite number or null`);
    } else if (v === 0) {
      fail(5, `${at}: "${k}" is 0 — use null for unknown; 0 renders as "$0"/"0 ac" and reads as a fact`);
    }
  }

  // --- 6. The score is DERIVED from the breakdown, not asserted beside it ---
  // This is what makes "every score is explainable" literally true rather than
  // a UI promise: a score that the published breakdown does not imply fails the
  // build.
  const bd = l?.score_breakdown;
  if (!bd || !Array.isArray(bd.signals) || bd.signals.length === 0) {
    fail(6, `${at}: score_breakdown.signals missing or empty`);
  } else {
    const scored = bd.signals.filter((s) => s.value !== null);
    const denom = scored.reduce((a, s) => a + s.weight, 0);
    const derived = denom === 0 ? 0 : Math.round((scored.reduce((a, s) => a + s.weight * s.value, 0) / denom) * 100);
    if (derived !== l.score) {
      fail(6, `${at}: score ${l.score} does not match the breakdown (derives ${derived})`);
    }
    if (bd.denominator !== denom) {
      fail(6, `${at}: score_breakdown.denominator ${bd.denominator} != sum of scored weights ${denom}`);
    }
    const unknowns = bd.signals.length - scored.length;
    if (bd.unknown_count !== unknowns) {
      fail(6, `${at}: unknown_count ${bd.unknown_count} != actual ${unknowns}`);
    }
    for (const s of bd.signals) {
      if (typeof s.note !== 'string' || s.note.trim() === '') {
        fail(6, `${at}: signal "${s.key}" has no note — a score with an unexplained signal is a bare number`);
      }
      if (s.value !== null && (s.value < 0 || s.value > 1)) {
        fail(6, `${at}: signal "${s.key}" value ${s.value} outside 0..1`);
      }
      // An unknown scored as 0 is the exact bug this whole project is guarding
      // against; catch the near-miss spelling too.
      if (s.value === null && s.weight === 0) {
        fail(6, `${at}: signal "${s.key}" is unknown AND weight 0 — that is an unknown scored as zero`);
      }
    }
  }

  // --- 7. for_sale_evidence: absent by default, SOURCE-REQUIRED when asserted
  // The reference's honesty gate (an asserted fact requires a source at the type
  // level) applied to the one claim on this site that can actually hurt someone.
  const ev = l?.for_sale_evidence;
  if (ev !== null && ev !== undefined) {
    const evRec = ev.record_url ?? ev.source_url ?? null;
    const evHow = typeof ev.how_to_verify === 'string' && ev.how_to_verify.trim().length >= 12;
    if (!/^https?:\/\//.test(evRec ?? '') && !evHow) {
      fail(7, `${at}: for_sale_evidence asserted with neither a record link nor how_to_verify`);
    }
    if (!ev.observed_at || Number.isNaN(Date.parse(ev.observed_at))) {
      fail(7, `${at}: for_sale_evidence has no parseable observed_at — "we saw this" needs a when`);
    }
    if (typeof ev.label !== 'string' || ev.label === '') {
      fail(7, `${at}: for_sale_evidence has no label`);
    }
  } else if (ev === undefined) {
    fail(7, `${at}: for_sale_evidence must be present as null — absent is ambiguous with "not checked"`);
  }

  // --- 8. Water is a shape, and its unknown state is expressible ------------
  const w = l?.water;
  if (!w || typeof w.has_stream !== 'boolean' || typeof w.has_river !== 'boolean' || typeof w.has_pond !== 'boolean') {
    fail(8, `${at}: water booleans missing`);
  } else if (w.distance_m !== null && (typeof w.distance_m !== 'number' || w.distance_m < 0)) {
    fail(8, `${at}: water.distance_m must be a non-negative number or null`);
  }

  // --- 9. Every fips resolves to a tracked county --------------------------
  if (!coverage.some((c) => c.fips === l?.fips)) {
    fail(9, `${at}: fips ${l?.fips} is not in coverage.json — its coverage tier would be unknowable`);
  }
}

// --- 10. Coverage completeness and tier validity -----------------------------
const TIERS = new Set(['rich', 'partial', 'thin', 'notices-only']);
const fipsSeen = new Set();
for (const c of coverage) {
  if (!TIERS.has(c.tier)) fail(10, `coverage ${c.fips}: unknown tier "${c.tier}"`);
  if (fipsSeen.has(c.fips)) fail(10, `coverage: duplicate fips ${c.fips}`);
  fipsSeen.add(c.fips);
  for (const k of ['fips', 'state', 'county', 'region']) {
    if (typeof c[k] !== 'string' || c[k] === '') fail(10, `coverage ${c.fips}: missing "${k}"`);
  }
  // A rich/partial county claims a parcel source. A claim without one is the
  // same class of defect as an unsourced for-sale assertion.
  if ((c.tier === 'rich' || c.tier === 'partial') && !c.parcel_source) {
    fail(10, `coverage ${c.fips}: tier "${c.tier}" asserted with no parcel_source`);
  }
}

// --- 11. The status payload can express failure ------------------------------
// A status file that only knows how to say "ok" is decoration. Assert the shape
// that lets it report a source that has never run.
if (!Array.isArray(status.sources) || status.sources.length === 0) {
  fail(11, 'status.json has no sources — the freshness surface would be empty');
}
for (const s of status.sources ?? []) {
  if (!['ok', 'degraded', 'failed', 'never-run'].includes(s.state)) {
    fail(11, `status source ${s.source_id}: unknown state "${s.state}"`);
  }
  if (s.state !== 'never-run' && !s.last_success) {
    fail(11, `status source ${s.source_id}: state "${s.state}" but no last_success`);
  }
  if (s.state === 'never-run' && s.last_success) {
    fail(11, `status source ${s.source_id}: "never-run" but carries a last_success`);
  }
}
if (status.data_observed_at !== null && Number.isNaN(Date.parse(status.data_observed_at))) {
  fail(11, 'status.data_observed_at is unparseable');
}

// --- 12. The fixture set must exercise every case the UI claims to handle ----
// Without this the gates above are all vacuously satisfiable by a payload that
// simply never contains a hard case.
const need = [
  ['a Lane 1 (on-market) row', (l) => l.for_sale_evidence !== null],
  ['a Lane 2 (prospecting) row', (l) => l.for_sale_evidence === null],
  ['a row with unknown assessed_value', (l) => l.assessed_value === null],
  ['a row with unknown acres', (l) => l.acres === null],
  ['a row with water', (l) => l.water.has_stream || l.water.has_river || l.water.has_pond],
  ['a row with no water', (l) => !l.water.has_stream && !l.water.has_river && !l.water.has_pond && l.water.distance_m !== null],
  ['a row with unknown water', (l) => !l.water.has_stream && !l.water.has_river && !l.water.has_pond && l.water.distance_m === null],
  ['a row with unknown flood zone', (l) => l.flood_zone === null],
  ['a row with >= 3 unknown signals', (l) => l.score_breakdown.unknown_count >= 3],
  ['a high-scoring row (>= 80)', (l) => l.score >= 80],
  ['a low-scoring row (<= 30)', (l) => l.score <= 30],
];
for (const [what, pred] of need) {
  if (!listings.some(pred)) fail(12, `fixture set contains ${what.replace(/^a /, "no ").replace(/^an /, "no ")}`);
}
for (const tier of TIERS) {
  const fipsOfTier = new Set(coverage.filter((c) => c.tier === tier).map((c) => c.fips));
  if (!listings.some((l) => fipsOfTier.has(l.fips))) {
    fail(12, `fixture set has no row from a "${tier}" county — that tier's rendering is untested`);
  }
}

if (errors.length) {
  console.error(`\nverify-data: ${errors.length} problem(s)\n`);
  for (const e of errors) console.error('  ' + e);
  console.error('');
  process.exit(1);
}
console.log(
  `verify-data: OK — ${listings.length} rows, ${coverage.length} counties, ${status.sources.length} sources.`,
);
