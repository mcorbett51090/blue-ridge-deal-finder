/**
 * pipeline/fetch/client.ts — THE ONLY MODULE PERMITTED TO OPEN A SOCKET.
 *
 * scripts/verify-egress-allowlist.mjs enforces that claim across pipeline/,
 * scripts/ and site/: every import is checked against a permit list, and the
 * network-capable globals (`fetch`, `XMLHttpRequest`, `navigator.sendBeacon`,
 * `WebSocket`, `EventSource`, dynamic `import()`) are permitted in this file
 * alone. That is an ALLOWLIST, not the eight-token denylist that missed
 * `node:https`, `ky`, `superagent`, `needle`, `phin` and npm lifecycle scripts.
 *
 * Nothing here runs at import time. Importing this module opens no socket, which
 * is what lets the P1 tests exercise the guard offline.
 *
 * Order of refusal, every request, no exceptions:
 *   PAUSE file → denylist → registry completeness → recorded verdicts → UA
 *   honesty → live robots for the exact path → rate limit → request.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import {
  HONEST_USER_AGENT,
  RegistryGuardError,
  assertLiveRobotsAllows,
  assertNotPaused,
  assertPointServicePermitted,
  assertRequestPermitted,
  evaluateLiveRobots,
  robotsDrift,
  type RobotsDrift,
} from './guard.ts';
import type { Registry } from './registry.ts';
import { getSource } from './registry.ts';
import type { PointService, Source } from './types.ts';

export { HONEST_USER_AGENT };

export type SourceStatus = 'active' | 'ingest_paused';

export type FetchOptions = {
  /** Query string / path appended to the source's base url. */
  path?: string;
  searchParams?: Record<string, string>;
  signal?: AbortSignal;
};

export type FetchResult = { url: string; status: number; body: unknown; bytes: number };

/** A point-service response, UNPARSED. The caller owns the parse — see fetchPointService. */
export type PointFetchResult = {
  url: string;
  status: number;
  text: string;
  contentType: string | null;
  bytes: number;
};

/** Per-host token bucket. Concurrency 1 per host by default (plan §3.1). */
class HostLimiter {
  #nextFreeAt = new Map<string, number>();
  #chain = new Map<string, Promise<void>>();

  async acquire(host: string, minIntervalMs: number): Promise<void> {
    // Serialise per host — concurrency 1 — by chaining onto the last promise.
    const prior = this.#chain.get(host) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    this.#chain.set(
      host,
      prior.then(() => mine),
    );
    await prior;

    const now = Date.now();
    const readyAt = this.#nextFreeAt.get(host) ?? 0;
    if (readyAt > now) await sleep(readyAt - now);
    this.#nextFreeAt.set(host, Date.now() + minIntervalMs);
    // Released immediately after the delay: the interval, not the response
    // time, is what bounds our request rate.
    release();
  }
}

export type ClientState = {
  status: SourceStatus;
  drift: RobotsDrift | null;
};

export class FetchClient {
  readonly #registry: Registry;
  readonly #limiter = new HostLimiter();
  readonly #robotsCache = new Map<string, { text: string; url: string }>();
  readonly #state = new Map<string, ClientState>();

  constructor(registry: Registry) {
    this.#registry = registry;
  }

  stateOf(sourceId: string): ClientState {
    return this.#state.get(sourceId) ?? { status: 'active', drift: null };
  }

  /**
   * Fetch one URL for one source, with every guard applied first.
   * Throws RegistryGuardError on refusal — refusal is never a soft return value,
   * because a soft return is exactly what a caller forgets to check.
   */
  async fetchJson(sourceId: string, options: FetchOptions = {}): Promise<FetchResult> {
    const source = getSource(this.#registry, sourceId);

    // 1. Kill switch outranks everything, including a source we believe is fine.
    assertNotPaused(this.#registry.repoRoot);

    // 2–5. Denylist, completeness, recorded verdicts, UA honesty. All offline.
    const target = buildUrl(source, options);
    assertRequestPermitted(source, target, this.#registry.denials);

    // 6. Live robots for the EXACT path, this run, not the cached verdict.
    const live = await this.#liveRobots(source, target);
    if (this.stateOf(sourceId).status === 'ingest_paused') {
      throw new RegistryGuardError(
        'stale-evidence',
        sourceId,
        'robots.txt drifted from captured evidence — source is ingest_paused ' +
          '(last-known-good keeps serving; re-evidence and update sources.yaml)',
      );
    }
    assertLiveRobotsAllows(sourceId, live, target);

    // 7. Rate limit. Crawl-Delay is honoured LITERALLY and always wins over our
    //    own rps when it is the slower of the two.
    const host = new URL(target).hostname;
    const rpsIntervalMs = 1000 / source.rate.rps;
    const crawlDelayMs = (live.crawlDelaySeconds ?? source.rate.crawl_delay_s ?? 0) * 1000;
    await this.#limiter.acquire(host, Math.max(rpsIntervalMs, crawlDelayMs));

    return this.#requestWithBackoff(source, target, options.signal);
  }

  /**
   * Fetch one keyless POINT service, returning the RAW BODY TEXT.
   *
   * ⛔ WHY THIS IS NOT fetchJson. fetchJson does `JSON.parse(text)` inside the
   * retry loop, so a service that answers an error with PLAIN TEXT at HTTP 200
   * gets five parse failures, five backoffs and a generic "failed after 5
   * attempts" — the caller never sees the body that would have explained it.
   * USGS EPQS does exactly that, measured 2026-08-19:
   *   x=-999&y=-999 -> 200, Content-Type: application/json, body
   *   `The operation was attempted on an empty geometry.`
   * The parse therefore belongs to the CALLER, which is the only code that
   * knows what a healthy body for this service looks like. This method's job is
   * the guard chain and the socket, and nothing else.
   *
   * Same order of refusal as fetchJson: PAUSE, denylist, completeness, recorded
   * verdicts, UA honesty, live robots for the exact path, rate limit, request.
   */
  async fetchPointService(
    service: PointService,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<PointFetchResult> {
    assertNotPaused(this.#registry.repoRoot);

    const url = new URL(service.url);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const target = url.toString();

    assertPointServicePermitted(service, target, this.#registry.denials);

    const live = await this.#liveRobots(service, target);
    assertLiveRobotsAllows(service.id, live, target);

    const host = new URL(target).hostname;
    const rpsIntervalMs = 1000 / service.rate.rps;
    const crawlDelayMs = (live.crawlDelaySeconds ?? service.rate.crawl_delay_s ?? 0) * 1000;
    await this.#limiter.acquire(host, Math.max(rpsIntervalMs, crawlDelayMs));

    const init: RequestInit = {
      headers: { 'user-agent': service.user_agent, accept: 'application/json' },
      redirect: 'follow',
    };
    if (signal) init.signal = signal;
    const res = await globalThis.fetch(target, init);
    const text = await res.text();
    return {
      url: target,
      status: res.status,
      text,
      contentType: res.headers.get('content-type'),
      bytes: Buffer.byteLength(text),
    };
  }

  async #liveRobots(source: Source | PointService, target: string) {
    const origin = new URL(target).origin;
    const robotsUrl = `${origin}/robots.txt`;
    let cached = this.#robotsCache.get(robotsUrl);
    if (!cached) {
      const res = await globalThis.fetch(robotsUrl, {
        headers: { 'user-agent': HONEST_USER_AGENT, accept: 'text/plain' },
        redirect: 'follow',
      });
      // 404/410 = no robots.txt = no restriction stated. A 5xx is NOT that:
      // an unreachable robots.txt is unknown, and unknown is refuse.
      if (res.status >= 500) {
        throw new RegistryGuardError(
          'robots-live-disallow',
          source.id,
          `robots.txt unreachable (HTTP ${res.status}) — unknown is not permission`,
        );
      }
      const text = res.ok ? await res.text() : '';
      cached = { text, url: robotsUrl };
      this.#robotsCache.set(robotsUrl, cached);

      // CE-4: drift moves the source to ingest_paused, never to disabled.
      if (source.robots.evidence_sha256) {
        const drift = robotsDrift(text, source.robots.evidence_sha256);
        if (drift.status === 'ingest_paused') {
          this.#state.set(source.id, { status: 'ingest_paused', drift });
        }
      }
    }
    return evaluateLiveRobots(cached.url, cached.text, target);
  }

  async #requestWithBackoff(
    source: Source,
    target: string,
    signal: AbortSignal | undefined,
  ): Promise<FetchResult> {
    const maxAttempts = 5;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const init: RequestInit = {
          headers: { 'user-agent': source.user_agent, accept: 'application/json' },
          redirect: 'follow',
        };
        if (signal) init.signal = signal;
        const res = await globalThis.fetch(target, init);
        const text = await res.text();

        // 429/5xx get a backoff; everything else is handed to assertHealthy,
        // which ignores HTTP status entirely (§4.2 — a 200 can be an outage).
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`HTTP ${res.status}`);
        }
        return {
          url: target,
          status: res.status,
          body: text.length ? (JSON.parse(text) as unknown) : null,
          bytes: Buffer.byteLength(text),
        };
      } catch (err) {
        lastError = err;
        if (attempt === maxAttempts) break;
        const base = source.rate.backoff === 'linear' ? attempt : 2 ** (attempt - 1);
        const jitter = Math.floor(Math.random() * 250);
        await sleep(base * 1000 + jitter);
      }
    }
    throw new Error(
      `[${source.id}] ${target} failed after ${maxAttempts} attempts: ${String(lastError)}`,
    );
  }
}

export function buildUrl(source: Source, options: FetchOptions): string {
  const url = new URL(source.url + (options.path ?? ''));
  for (const [k, v] of Object.entries(options.searchParams ?? {})) url.searchParams.set(k, v);
  return url.toString();
}
