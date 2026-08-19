/**
 * The registry guard, offline. No socket is opened by any test in this file —
 * which is the point: every refusal is decidable before a request exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  HONEST_USER_AGENT,
  RegistryGuardError,
  assertHonestUserAgent,
  assertNotPaused,
  assertRequestPermitted,
  evaluateLiveRobots,
  robotsDrift,
  sha256Hex,
} from '../pipeline/fetch/guard.ts';
import { matchDenylist } from '../pipeline/fetch/denylist.ts';
import { DenylistFileSchema, SourcesFileSchema, type Source } from '../pipeline/fetch/types.ts';
import { loadRegistry } from '../pipeline/fetch/registry.ts';

const ROOT = join(import.meta.dirname, '..');
const registry = loadRegistry(ROOT);
const denials = registry.denials;

function completeSource(overrides: Partial<Source> = {}): Source {
  const base = SourcesFileSchema.parse(
    yaml.load(readFileSync(join(ROOT, 'fixtures', 'gates', 'denied-host-enabled.yaml'), 'utf8')),
  )[0] as Source;
  return { ...base, url: 'https://services.nconemap.gov/x', id: 'test', ...overrides };
}

test('the denylist wins over a complete, enabled registry entry', () => {
  const smuggled = SourcesFileSchema.parse(
    yaml.load(readFileSync(join(ROOT, 'fixtures', 'gates', 'denied-host-enabled.yaml'), 'utf8')),
  )[0] as Source;
  assert.equal(smuggled.enabled, true, 'the fixture must be enabled — that is the point of it');
  assert.throws(
    () => assertRequestPermitted(smuggled, smuggled.url, denials),
    (err: unknown) => err instanceof RegistryGuardError && err.code === 'denylist',
  );
});

test('a denied host is refused even when the REQUEST url differs from the registry url', () => {
  const s = completeSource({ url: 'https://services.nconemap.gov/x' });
  assert.throws(
    () => assertRequestPermitted(s, 'https://www.craigslist.org/anything', denials),
    (err: unknown) => err instanceof RegistryGuardError && err.code === 'denylist',
  );
});

test('wildcard denials cover the apex, and bare denials cover subdomains', () => {
  assert.ok(matchDenylist('https://craigslist.org/', denials), 'apex must be denied by *.craigslist.org');
  assert.ok(matchDenylist('https://boone.craigslist.org/x', denials));
  assert.ok(matchDenylist('https://www.auction.com/foreclosures/nc', denials), 'subdomain + denied path');
  assert.equal(matchDenylist('https://www.auction.com/about', denials), null, 'a non-denied path on a path-scoped host');
});

test('an unparseable URL throws rather than reporting "not denied"', () => {
  assert.throws(() => matchDenylist('not a url', denials), /unparseable/);
});

test('each required field, removed one at a time, produces a refusal', () => {
  const removals: [string, (s: Source) => Source][] = [
    ['legal_basis', (s) => ({ ...s, legal_basis: undefined as never })],
    ['robots.evidence_sha256', (s) => ({ ...s, robots: { ...s.robots, evidence_sha256: null } })],
    ['schema_fingerprint', (s) => ({ ...s, schema_fingerprint: null })],
    ['user_agent', (s) => ({ ...s, user_agent: '' })],
  ];
  for (const [name, mutate] of removals) {
    assert.throws(
      () => assertRequestPermitted(mutate(completeSource()), 'https://services.nconemap.gov/x', denials),
      (err: unknown) => err instanceof RegistryGuardError && err.code === 'incomplete-registry',
      `removing ${name} must produce a refusal`,
    );
  }
});

test('robots.verdict=disallow and tos.verdict=prohibitive are refused', () => {
  assert.throws(
    () =>
      assertRequestPermitted(
        completeSource({ robots: { ...completeSource().robots, verdict: 'disallow' } }),
        'https://services.nconemap.gov/x',
        denials,
      ),
    (err: unknown) => err instanceof RegistryGuardError && err.code === 'robots-disallow',
  );
  assert.throws(
    () =>
      assertRequestPermitted(
        completeSource({ tos: { ...completeSource().tos, verdict: 'prohibitive' } }),
        'https://services.nconemap.gov/x',
        denials,
      ),
    (err: unknown) => err instanceof RegistryGuardError && err.code === 'tos-prohibitive',
  );
});

test('a browser UA is refused; the honest UA is accepted', () => {
  for (const ua of [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'blue-ridge-deal-finder-bot/1.0',
    'ClaudeBot/1.0',
  ]) {
    assert.throws(
      () => assertHonestUserAgent({ id: 't', user_agent: ua }),
      (err: unknown) => err instanceof RegistryGuardError && err.code === 'dishonest-ua',
    );
  }
  assert.doesNotThrow(() => assertHonestUserAgent({ id: 't', user_agent: HONEST_USER_AGENT }));
});

test('sources/PAUSE stops everything, and its absence does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brdf-pause-'));
  mkdirSync(join(dir, 'sources'), { recursive: true });
  assert.doesNotThrow(() => assertNotPaused(dir));
  writeFileSync(join(dir, 'sources', 'PAUSE'), 'stopped by owner\n');
  assert.throws(
    () => assertNotPaused(dir),
    (err: unknown) => err instanceof RegistryGuardError && err.code === 'paused',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('robots drift → ingest_paused, NEVER disabled (CE-4)', () => {
  const text = 'User-agent: *\nAllow: /\n';
  const digest = sha256Hex(text);
  assert.equal(robotsDrift(text, digest).status, 'unchanged');
  assert.equal(robotsDrift(text, `sha256:${digest}`).status, 'unchanged', 'the sha256: prefix is tolerated');

  const drifted = robotsDrift(`${text}Sitemap: https://x/sitemap.xml\n`, digest);
  assert.equal(drifted.status, 'ingest_paused');
  assert.notEqual(
    drifted.status as string,
    'disabled',
    'a benign robots edit must not become a total outage of the anchor',
  );
});

test('live robots is evaluated for the EXACT path, and Crawl-Delay is literal', () => {
  const robotsTxt = readFileSync(join(ROOT, 'fixtures', 'robots-crawl-delay.txt'), 'utf8');
  const url = 'https://example.gov/robots.txt';
  const allowed = evaluateLiveRobots(url, robotsTxt, 'https://example.gov/rest/services/x/query');
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.crawlDelaySeconds, 20, 'Crawl-Delay: 20 means 20 seconds');

  const blocked = evaluateLiveRobots(url, robotsTxt, 'https://example.gov/private/secret');
  assert.equal(blocked.allowed, false, 'the disallowed PATH must be refused, not just the origin allowed');
});

test('the shipped registry parses and the anchor is the POLYGON layer', () => {
  const sources = SourcesFileSchema.parse(
    yaml.load(readFileSync(join(ROOT, 'sources', 'sources.yaml'), 'utf8')),
  );
  const anchor = sources.find((s) => s.id === 'nc-onemap-parcels');
  assert.ok(anchor, 'the NC anchor must be in the registry');
  assert.match(anchor.url, /MapServer\/1$/, 'MapServer/1 is Parcels (polys)');
  assert.doesNotMatch(anchor.url, /FeatureServer\/0/, 'FeatureServer/0 is the points layer');
  assert.equal(anchor.expect.per_county_min_rows['Watauga'], 45000, 'floors are MEASURED, not guessed');
  assert.equal(anchor.control_block.positive.expect_count, 47388);
  assert.equal(anchor.control_block.negative.expect_count, 0);
});

/**
 * ⛔ THIS TEST MOVED TARGETS AT P2, AND THE MOVE IS THE POINT.
 * At P1 it read sources/sources.yaml, where the anchor carried null digests and
 * `enabled: false`. P2 captured the live evidence and flipped it true — which
 * would have left this test asserting a refusal that no longer happens, i.e. a
 * fix quietly deleting its own detector. The P1 state was preserved verbatim as
 * fixtures/gates/anchor-null-evidence.yaml and the test points there, so what is
 * proven is still the MECHANISM: an entry that is complete in every other
 * respect is refused while its two live-only digests are null.
 */
test('a registry entry with null evidence digests is refused — the P1 anchor state', () => {
  const sources = SourcesFileSchema.parse(
    yaml.load(readFileSync(join(ROOT, 'fixtures', 'gates', 'anchor-null-evidence.yaml'), 'utf8')),
  );
  const anchor = sources.find((s) => s.id === 'nc-onemap-parcels') as Source;
  assert.equal(anchor.robots.evidence_sha256, null, 'the fixture must carry null evidence — that is what it is for');
  assert.equal(anchor.schema_fingerprint, null);
  assert.throws(
    () => assertRequestPermitted(anchor, anchor.url, denials),
    (err: unknown) => err instanceof RegistryGuardError && err.code === 'incomplete-registry',
    'no live evidence means the guard must refuse the source outright',
  );
});

/**
 * The other half, and the one that would have been missing: the SHIPPED registry
 * is now permitted. Without this, "the guard refuses null digests" is satisfied
 * by a guard that refuses everything, and P2 would have shipped an anchor that
 * can never fetch.
 */
test('GREEN CONTROL: the shipped anchor is now permitted — real digests, enabled', () => {
  const sources = SourcesFileSchema.parse(
    yaml.load(readFileSync(join(ROOT, 'sources', 'sources.yaml'), 'utf8')),
  );
  const anchor = sources.find((s) => s.id === 'nc-onemap-parcels') as Source;
  assert.match(String(anchor.robots.evidence_sha256), /^[0-9a-f]{64}$/, 'robots evidence digest is captured');
  assert.match(String(anchor.schema_fingerprint), /^[0-9a-f]{64}$/, 'schema fingerprint is captured');
  assert.equal(anchor.enabled, true);
  assert.doesNotThrow(() => assertRequestPermitted(anchor, anchor.url, denials));
});

/**
 * ⛔ MEASURED: services.nconemap.gov has NO robots.txt (HTTP 404). The fetcher
 * therefore hashes the empty string, and that digest is what sources.yaml holds.
 * This test pins the relationship, because the alternative — hashing the 404 HTML
 * body — reads identically in the registry and makes the drift check fire on
 * every run.
 */
test('the anchor robots digest is the digest of the EMPTY directive text (host has no robots.txt)', () => {
  const sources = SourcesFileSchema.parse(
    yaml.load(readFileSync(join(ROOT, 'sources', 'sources.yaml'), 'utf8')),
  );
  const anchor = sources.find((s) => s.id === 'nc-onemap-parcels') as Source;
  assert.equal(anchor.robots.evidence_sha256, sha256Hex(''), 'a 404 robots.txt means zero directives');
  assert.equal(anchor.robots.verdict, 'absent', 'no file was served — nobody granted anything');
  assert.equal(robotsDrift('', String(anchor.robots.evidence_sha256)).status, 'unchanged');
  // NEGATIVE CONTROL: if the host starts serving directives, drift must fire.
  assert.equal(
    robotsDrift('User-agent: *\nDisallow: /\n', String(anchor.robots.evidence_sha256)).status,
    'ingest_paused',
    'a newly-published robots.txt must pause ingest, not be absorbed silently',
  );
});

test('the denylist has rules and every one carries a claim ref and a reason', () => {
  const parsed = DenylistFileSchema.parse(
    yaml.load(readFileSync(join(ROOT, 'sources', 'sources.denied.yaml'), 'utf8')),
  );
  assert.ok(parsed.length >= 15, `expected the full denied table, got ${parsed.length}`);
  for (const d of parsed) assert.ok(d.reason.length > 10, `${d.host} needs a real reason`);
});
