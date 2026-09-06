/**
 * THE freshness verdict, in one place.
 *
 * Before this module, the header badge (FreshnessBadge.astro) and the status
 * page each recomputed "is Lane 1 stale" independently, in the browser, from
 * their own copy of the same three lines of arithmetic — and one of the two
 * copies fetched the wrong URL (a relative path resolved against the PAGE,
 * `/status/data/status.json`, instead of the SITE, `/data/status.json` — a
 * 404 on every load of /status/). The result was a real, observed split
 * verdict: the header said "412 h old, past the 48 h bar" while the status
 * page said "status file unreachable — freshness unknown", on the same
 * deploy, about the same fact. Two computations of one fact will eventually
 * disagree; one computation, imported twice, cannot.
 *
 * Both callers now import `verdictFor()` and `WHAT_TO_DO` from here, fetch
 * through `statusJsonUrl()` (which is base-aware — the bug above, fixed at its
 * root), and render the SAME string.
 */

export type FreshnessState = 'ok' | 'stale' | 'never' | 'unknown';

export interface FreshnessVerdict {
  state: FreshnessState;
  /** Hours since observation, or null when unknown/unparseable. */
  hours: number | null;
}

/** Pure — no Date.now() capture needed by the caller; testable without mocking. */
export function verdictFor(iso: string | null, barHours: number, now: number = Date.now()): FreshnessVerdict {
  if (!iso) return { state: 'never', hours: null };
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return { state: 'unknown', hours: null };
  const hours = (now - t) / 3600000;
  return { state: hours > barHours ? 'stale' : 'ok', hours };
}

/** "412 h old, past the 48 h bar" / "<1 h old" / etc — the exact suffix both the
 *  header badge and the status page print, so the two can never read as two
 *  different facts about the same timestamp. */
export function ageSuffix(v: FreshnessVerdict, barHours: number): string {
  if (v.state === 'never') return '— nothing observed yet';
  if (v.state === 'unknown' || v.hours === null) return '— freshness unknown';
  const rounded = v.hours < 1 ? '<1' : Math.floor(v.hours).toString();
  return v.state === 'stale' ? `— ${rounded} h old, past the ${barHours} h bar` : `— ${rounded} h old`;
}

/** The "what to do now" line for a stale (or never-observed) Lane 1 snapshot.
 *  Shown wherever the verdict is surfaced — the banner, the badge's title
 *  attribute, and the status page — so the answer to "so what do I do about
 *  it" is the same sentence everywhere it is asked. */
export const WHAT_TO_DO_STALE =
  'A newer on-market/distress lead may exist that this snapshot has not seen yet — treat Lane 1 ' +
  "as a starting point, not a live feed, until the next run. This does not affect Lane 2's parcel " +
  'or coverage facts, which update on their own slower, weekly cadence.';

export const WHAT_TO_DO_NEVER =
  'No Lane 1 data has ever been observed — the on-market/distress ingest has not produced a run ' +
  'yet. The prospecting lane below is unaffected; it comes from a separate, already-loaded parcel corpus.';

export function whatToDo(state: FreshnessState): string | null {
  if (state === 'stale') return WHAT_TO_DO_STALE;
  if (state === 'never') return WHAT_TO_DO_NEVER;
  return null;
}
