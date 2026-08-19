#!/usr/bin/env node
/**
 * verify-sources.mjs — the registry is complete, and the denylist wins.
 *
 * Two independent things are asserted here, and the second is the one that
 * matters: not just "every field is filled in" (a source can be complete and
 * still be one we are forbidden to touch), but "no entry, however complete and
 * however confidently `enabled: true`, names a host on the denylist".
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { Gate, inspectRoot } from './lib/gate.mjs';
import { DenylistFileSchema, SourcesFileSchema } from '../pipeline/fetch/types.ts';
import { matchDenylist } from '../pipeline/fetch/denylist.ts';
import { HONEST_USER_AGENT, evidenceAgeDays } from '../pipeline/fetch/guard.ts';

const gate = new Gate('verify-sources');
const root = inspectRoot();

const MAX_EVIDENCE_AGE_DAYS = 90; // re-evidenced every 30; 90 is the hard fail
const MAX_RPS = 2.0;
const TIER_ENUM_RICH = 'rich';

/** E6.1 — the POINT layer. Its attribute table mirrors the polygon layer's, so
 *  every attribute test passes while three of five deal signals go silently
 *  uncomputable. It must never appear in the registry. */
const POINT_LAYER_MARKER = 'FeatureServer/0';

function loadYamlFile(path) {
  if (!existsSync(path)) {
    gate.fail(`missing ${path}`);
    return null;
  }
  return { text: readFileSync(path, 'utf8'), data: yaml.load(readFileSync(path, 'utf8')) };
}

const sourcesFile = loadYamlFile(join(root, 'sources', 'sources.yaml'));
const deniedFile = loadYamlFile(join(root, 'sources', 'sources.denied.yaml'));

if (sourcesFile && deniedFile) {
  let sources = [];
  let denials = [];

  const sParsed = SourcesFileSchema.safeParse(sourcesFile.data ?? []);
  if (!sParsed.success) {
    for (const issue of sParsed.error.issues) {
      gate.fail(`sources.yaml [${issue.path.join('.')}]: ${issue.message}`);
    }
  } else {
    sources = sParsed.data;
  }

  const dParsed = DenylistFileSchema.safeParse(deniedFile.data ?? []);
  if (!dParsed.success) {
    for (const issue of dParsed.error.issues) {
      gate.fail(`sources.denied.yaml [${issue.path.join('.')}]: ${issue.message}`);
    }
  } else {
    denials = dParsed.data;
  }

  if (denials.length === 0) {
    // An empty denylist fails OPEN, which is the one direction it must not.
    gate.fail('sources.denied.yaml has zero rules — a failed read is indistinguishable from a policy');
  }
  for (const d of denials) {
    if (!d.reason || d.reason.trim().length < 10) gate.fail(`denylist ${d.host}: reason is missing or too short`);
    if (!Array.isArray(d.claims)) gate.fail(`denylist ${d.host}: claims array missing`);
  }

  // ---- the denylist wins every conflict -----------------------------------
  for (const s of sources) {
    let hit = null;
    try {
      hit = matchDenylist(s.url, denials);
    } catch (err) {
      gate.fail(`source ${s.id}: ${String(err)}`);
    }
    if (hit) {
      gate.fail(
        `source ${s.id} (enabled=${s.enabled}) targets ${s.url}, denied by rule ${hit.denial.host} ` +
          `[${hit.denial.claims.join(', ')}] — the denylist wins regardless of what the entry claims`,
      );
    }
  }

  // ---- POSITIVE + NEGATIVE CONTROL on the matcher itself -------------------
  // Without these, a matcher that silently returns null for everything reads as
  // "no conflicts found" — the same shape as a clean registry.
  const controlDenied = matchDenylist('https://boone.craigslist.org/search/rea', denials);
  if (!controlDenied) gate.fail('CONTROL FAILED: a known-denied craigslist URL was not matched — matcher is broken');
  const controlAllowed = matchDenylist('https://services.nconemap.gov/x', denials);
  if (controlAllowed) gate.fail('CONTROL FAILED: the NC anchor host matched the denylist — matcher over-matches');

  // ---- per-source completeness --------------------------------------------
  for (const s of sources) {
    if (s.user_agent !== HONEST_USER_AGENT) gate.fail(`source ${s.id}: user_agent is not the honest UA constant`);
    if (s.rate.rps > MAX_RPS) gate.fail(`source ${s.id}: rate.rps ${s.rate.rps} exceeds ceiling ${MAX_RPS}`);
    if (s.rate.concurrency > 2) gate.fail(`source ${s.id}: rate.concurrency ${s.rate.concurrency} > 2`);

    const robotsAge = evidenceAgeDays(s.robots.checked_at);
    if (robotsAge > MAX_EVIDENCE_AGE_DAYS) gate.fail(`source ${s.id}: robots evidence is ${Math.round(robotsAge)}d old (max ${MAX_EVIDENCE_AGE_DAYS})`);
    const tosAge = evidenceAgeDays(s.tos.checked_at);
    if (tosAge > MAX_EVIDENCE_AGE_DAYS) gate.fail(`source ${s.id}: tos evidence is ${Math.round(tosAge)}d old (max ${MAX_EVIDENCE_AGE_DAYS})`);

    if (s.enabled) {
      // A source may only be live once its evidence actually exists. These two
      // digests are the only fields that cannot be authored offline, which is
      // exactly why they are the two an impatient commit would fake.
      if (!s.robots.evidence_sha256) gate.fail(`source ${s.id}: enabled with robots.evidence_sha256 = null`);
      if (!s.schema_fingerprint) gate.fail(`source ${s.id}: enabled with schema_fingerprint = null`);
      if (s.robots.verdict === 'disallow') gate.fail(`source ${s.id}: enabled with robots.verdict = disallow`);
      if (s.tos.verdict === 'prohibitive') gate.fail(`source ${s.id}: enabled with tos.verdict = prohibitive`);
    } else {
      gate.info(`source ${s.id}: enabled=false — the fetcher will refuse it (expected until P2)`);
    }
  }

  // ---- the anchor is the POLYGON layer ------------------------------------
  // Comments are stripped first: this check flagged sources.yaml's own warning
  // ABOUT the point layer on its first run. A grep is satisfied by the thing
  // being described, so the thing being described has to be removed first.
  const sourcesCode = sourcesFile.text
    .split('\n')
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
  if (sourcesCode.includes(POINT_LAYER_MARKER)) {
    gate.fail(
      `sources.yaml references ${POINT_LAYER_MARKER} — that is Parcels (pts). ` +
        'Three of five deal signals need polygons; see docs/decisions/0001-polygons-not-points.md',
    );
  }

  // ---- floors are cross-checked against seeds/counties.csv ----------------
  // Not against a copy of the numbers in this gate: a magic number duplicated
  // into the gate is edited in both places by the same commit that softens it.
  const countiesPath = join(root, 'seeds', 'counties.csv');
  if (existsSync(countiesPath)) {
    const rows = readFileSync(countiesPath, 'utf8').trim().split('\n').slice(1);
    for (const line of rows) {
      const [, , county, , tier, parcelSource] = line.split(',');
      if (tier !== TIER_ENUM_RICH || !parcelSource) continue;
      const src = sources.find((s) => s.id === parcelSource);
      if (!src) {
        gate.fail(`county ${county}: tier=rich names parcel_source '${parcelSource}' with no registry entry`);
        continue;
      }
      const floor = src.expect.per_county_min_rows[county];
      if (typeof floor !== 'number') {
        gate.fail(`source ${parcelSource}: no measured row floor for rich county ${county}`);
      } else if (floor < 1000) {
        gate.fail(`source ${parcelSource}: row floor for ${county} is ${floor} — implausibly low, floors are measured`);
      }
    }
  } else {
    gate.fail('seeds/counties.csv missing — cannot cross-check row floors');
  }

  gate.info(`${sources.length} source(s), ${denials.length} denial rule(s)`);
}

gate.finish();
