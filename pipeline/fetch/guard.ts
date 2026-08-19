/**
 * The registry guard (plan §3.3 mechanism 2, 3 and 5).
 *
 * Every decision in this file is PURE and offline: given a source entry, a URL,
 * the denylist, and (optionally) the text of a live robots.txt, decide whether a
 * socket may be opened. client.ts is the only module that acts on the answer.
 * Splitting it this way is not decoration — it is what lets P1 prove the guard
 * refuses correctly without making a single request.
 */
import robotsParser from 'robots-parser';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Denial, PointService, Source } from './types.ts';
import { matchDenylist } from './denylist.ts';

export const HONEST_USER_AGENT =
  'blue-ridge-deal-finder/1.0 (+https://github.com/mcorbett51090/blue-ridge-deal-finder; matt@ravenpower.net)';

/** The UA token robots-parser matches on. The full string is sent on the wire. */
export const UA_TOKEN = 'blue-ridge-deal-finder';

export type GuardCode =
  | 'paused'
  | 'denylist'
  | 'incomplete-registry'
  | 'robots-disallow'
  | 'tos-prohibitive'
  | 'disabled'
  | 'dishonest-ua'
  | 'robots-live-disallow'
  | 'stale-evidence';

export class RegistryGuardError extends Error {
  readonly code: GuardCode;
  readonly sourceId: string;
  constructor(code: GuardCode, sourceId: string, detail: string) {
    super(`[${sourceId}] refused (${code}): ${detail}`);
    this.name = 'RegistryGuardError';
    this.code = code;
    this.sourceId = sourceId;
  }
}

/**
 * Fields without which no request is permitted. `evidence_sha256` and
 * `schema_fingerprint` are nullable in the SCHEMA (they are digests of a live
 * response and cannot be authored offline) but NOT here: a source whose
 * evidence has never been captured is a source we have not actually checked.
 */
const REQUIRED_PATHS = [
  'legal_basis',
  'robots.verdict',
  'robots.evidence_sha256',
  'tos.verdict',
  'rate.rps',
  'user_agent',
  'schema_fingerprint',
  'control_block',
] as const;

function readPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** `sources/PAUSE` outranks everything. One commit stops the entire system. */
export function isPaused(repoRoot: string): boolean {
  return existsSync(join(repoRoot, 'sources', 'PAUSE'));
}

export function assertNotPaused(repoRoot: string): void {
  if (isPaused(repoRoot)) {
    throw new RegistryGuardError('paused', '*', 'sources/PAUSE is present — no request is made');
  }
}

/**
 * The full offline permission decision. Throws on refusal; returns void on
 * permit. Order is deliberate: the denylist is consulted FIRST, so that no
 * field a source entry carries can talk its way past a host that said no.
 */
export function assertRequestPermitted(
  source: Source,
  url: string,
  denials: readonly Denial[],
): void {
  // 1. Denylist wins every conflict — before `enabled`, before robots, before
  //    anything the registry claims about itself.
  const hit = matchDenylist(url, denials);
  if (hit) {
    throw new RegistryGuardError(
      'denylist',
      source.id,
      `${url} matches denied ${hit.matchedOn} rule ${hit.denial.host}` +
        `${hit.denial.claims.length ? ` (claims ${hit.denial.claims.join(', ')})` : ''}`,
    );
  }
  // The source's own declared URL is checked too: a denied host smuggled into
  // sources.yaml must not be fetchable via a request built from that entry.
  const declared = matchDenylist(source.url, denials);
  if (declared) {
    throw new RegistryGuardError(
      'denylist',
      source.id,
      `registry url ${source.url} matches denied rule ${declared.denial.host}`,
    );
  }

  // 2. Completeness. A missing field is a refusal, not a default.
  const missing = REQUIRED_PATHS.filter((p) => {
    const v = readPath(source, p);
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    throw new RegistryGuardError(
      'incomplete-registry',
      source.id,
      `missing required field(s): ${missing.join(', ')}`,
    );
  }

  // 3. Recorded verdicts.
  if (source.robots.verdict === 'disallow') {
    throw new RegistryGuardError('robots-disallow', source.id, 'robots.verdict == disallow');
  }
  if (source.tos.verdict === 'prohibitive') {
    throw new RegistryGuardError('tos-prohibitive', source.id, 'tos.verdict == prohibitive');
  }

  // 4. UA honesty (plan §3.3 mech. 4). A browser UA or a named-AI token here
  //    would defeat the whole disclosure posture, so it is refused mechanically
  //    rather than left to review.
  assertHonestUserAgent(source);

  if (!source.enabled) {
    throw new RegistryGuardError('disabled', source.id, 'enabled: false');
  }
}

const DISHONEST_UA_PATTERNS: readonly RegExp[] = [
  /mozilla/i,
  /chrome/i,
  /safari/i,
  /gecko/i,
  /\bbot\b/i,
  /\bAI\b/,
  /claude/i,
  /gpt/i,
  /scrapy/i,
];

export function assertHonestUserAgent(source: Pick<Source, 'id' | 'user_agent'>): void {
  if (source.user_agent !== HONEST_USER_AGENT) {
    throw new RegistryGuardError(
      'dishonest-ua',
      source.id,
      'user_agent is not the single honest UA constant',
    );
  }
  for (const re of DISHONEST_UA_PATTERNS) {
    if (re.test(source.user_agent)) {
      throw new RegistryGuardError('dishonest-ua', source.id, `UA matches ${re}`);
    }
  }
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function normaliseDigest(d: string): string {
  return d.replace(/^sha256:/i, '').toLowerCase();
}

export type RobotsDrift =
  | { status: 'unchanged' }
  | { status: 'ingest_paused'; liveSha256: string; evidenceSha256: string; action: string };

/**
 * CE-4 fix. When live robots.txt no longer matches the captured evidence the
 * source moves to `ingest_paused`, **NOT `disabled`**: stop new ingest, keep
 * serving last-known-good, flag staleness on /status/, open an issue.
 *
 * A benign upstream robots edit — a comment, a new sitemap line — must not
 * convert into a total outage of the anchor source. `disabled` would trade a
 * legal-hygiene signal for a self-inflicted data blackout.
 */
export function robotsDrift(liveText: string, evidenceSha256: string): RobotsDrift {
  const live = sha256Hex(liveText);
  if (live === normaliseDigest(evidenceSha256)) return { status: 'unchanged' };
  return {
    status: 'ingest_paused',
    liveSha256: live,
    evidenceSha256: normaliseDigest(evidenceSha256),
    action: 'halt new ingest; keep serving last-known-good; flag /status/; open an issue',
  };
}

export type LiveRobots = {
  allowed: boolean;
  crawlDelaySeconds: number | null;
};

/**
 * Evaluate freshly-fetched robots.txt for the EXACT path (plan §3.3 mech. 3).
 * Not the origin, not a cached verdict — the path we are about to request.
 * `Crawl-Delay` is honoured literally; a stated 20 s means 20 s.
 */
export function evaluateLiveRobots(robotsUrl: string, robotsText: string, targetUrl: string): LiveRobots {
  // ⛔ FIRST: is this even a robots.txt? A WAF interstitial served at HTTP 200
  // parses to zero directives, and zero directives reads as "allowed". See
  // looksLikeRobotsTxt() below for the measured case that put this line here.
  if (!looksLikeRobotsTxt(robotsText)) {
    return { allowed: false, crawlDelaySeconds: null };
  }
  const parsed = robotsParser(robotsUrl, robotsText);
  const verdict = parsed.isAllowed(targetUrl, UA_TOKEN);
  const delay = parsed.getCrawlDelay(UA_TOKEN);
  return {
    // `undefined` means the parser had no opinion. Absent robots.txt is handled
    // by the caller (fetch failed); an inconclusive parse of a PRESENT file is
    // treated as disallow — unknown is not permission.
    allowed: verdict === true,
    crawlDelaySeconds: typeof delay === 'number' && Number.isFinite(delay) ? delay : null,
  };
}

export function assertLiveRobotsAllows(sourceId: string, live: LiveRobots, targetUrl: string): void {
  if (!live.allowed) {
    throw new RegistryGuardError(
      'robots-live-disallow',
      sourceId,
      `live robots.txt disallows ${targetUrl} for ${UA_TOKEN}`,
    );
  }
}

/** Sources are re-evidenced every 30 days; 90 days is the hard fail. */
export function evidenceAgeDays(checkedAt: string, now: Date = new Date()): number {
  const t = Date.parse(`${checkedAt}T00:00:00Z`);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (now.getTime() - t) / 86_400_000;
}

/**
 * Fields without which no POINT-SERVICE request is permitted. Same argument as
 * REQUIRED_PATHS above, with `control_probe` where a queryable layer has
 * `control_block` — see the PointServiceSchema comment in types.ts for why the
 * two cannot be the same field.
 */
const REQUIRED_POINT_SERVICE_PATHS = [
  'legal_basis',
  'robots.verdict',
  'robots.evidence_sha256',
  'tos.verdict',
  'rate.rps',
  'user_agent',
  'schema_fingerprint',
  'control_probe',
] as const;

/** The offline permission decision for a point service. Throws on refusal. */
export function assertPointServicePermitted(
  service: PointService,
  url: string,
  denials: readonly Denial[],
): void {
  const hit = matchDenylist(url, denials);
  if (hit) {
    throw new RegistryGuardError(
      'denylist',
      service.id,
      `${url} matches denied ${hit.matchedOn} rule ${hit.denial.host}`,
    );
  }
  const declared = matchDenylist(service.url, denials);
  if (declared) {
    throw new RegistryGuardError(
      'denylist',
      service.id,
      `registry url ${service.url} matches denied rule ${declared.denial.host}`,
    );
  }

  const missing = REQUIRED_POINT_SERVICE_PATHS.filter((p) => {
    const v = readPath(service, p);
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    throw new RegistryGuardError(
      'incomplete-registry',
      service.id,
      `missing required field(s): ${missing.join(', ')}`,
    );
  }

  if (service.robots.verdict === 'disallow') {
    throw new RegistryGuardError('robots-disallow', service.id, 'robots.verdict == disallow');
  }
  if (service.robots.verdict === 'unreachable') {
    // ⛔ NOT the same as `absent`. `absent` means we asked and there is no file;
    // `unreachable` means we asked and could not be told. Unknown is not
    // permission — see tigerweb.geo.census.gov in sources/sources.enrich.yaml.
    throw new RegistryGuardError(
      'robots-live-disallow',
      service.id,
      'robots.verdict == unreachable — we could not obtain the directives, and unknown is not permission',
    );
  }
  if (service.tos.verdict === 'prohibitive') {
    throw new RegistryGuardError('tos-prohibitive', service.id, 'tos.verdict == prohibitive');
  }

  assertHonestUserAgent(service);

  if (!service.enabled) {
    throw new RegistryGuardError('disabled', service.id, 'enabled: false');
  }
}

/**
 * ⛔ IS THIS BODY ACTUALLY A robots.txt?
 *
 * MEASURED 2026-08-19 on tigerweb.geo.census.gov:
 *   GET /robots.txt -> HTTP **200**, 189 bytes,
 *   `<html><head><title>Request Rejected</title>…Your support ID is: 1342789…`
 * An F5 WAF answering FOR the origin. Three separate things go wrong if this
 * body is treated as robots.txt:
 *   1. robots-parser finds zero directives in HTML, so `isAllowed()` returns
 *      TRUE — a WAF refusal read as a grant of permission.
 *   2. the support ID changes on every request, so the CE-4 evidence digest
 *      never matches and the source pauses itself on every run for a reason
 *      nobody can act on.
 *   3. the status is 200, so no status-based branch anywhere sees a problem.
 * Reproduced 5/5 times, with our honest UA and with curl's default UA.
 *
 * A robots.txt is a line-oriented directive file. A non-empty body containing
 * not one recognisable directive is not one, and the honest verdict for it is
 * `unreachable`. An EMPTY body is a different thing entirely (the 404/410 case,
 * which client.ts turns into `''`) and is deliberately NOT flagged here.
 */
const ROBOTS_DIRECTIVE_RE = /^\s*(user-agent|disallow|allow|crawl-delay|sitemap|host)\s*:/im;

export function looksLikeRobotsTxt(text: string): boolean {
  if (text.trim() === '') return true; // absent, not malformed — caller's problem
  return ROBOTS_DIRECTIVE_RE.test(text);
}
