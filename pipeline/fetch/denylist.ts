/**
 * The denylist matcher (plan §3.2, §3.3 mechanism 2).
 *
 * THE DENYLIST WINS EVERY CONFLICT. This module is consulted before the source
 * registry is even read, and its verdict is not overridable by any field a
 * source entry carries. A registry entry is our claim about a host; the denylist
 * is the host's claim about us, plus rulings (paid, auth-required) that are
 * about our own conduct and do not depend on their robots.txt at all.
 */
import type { Denial } from './types.ts';

export type DenyMatch = { denial: Denial; matchedOn: 'host' | 'path' };

function hostMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();
  if (p.startsWith('*.')) {
    const bare = p.slice(2);
    // `*.craigslist.org` must also deny the apex — a wildcard that leaves the
    // apex reachable denies the subdomains and permits the site.
    return h === bare || h.endsWith(`.${bare}`);
  }
  // A bare host pattern denies its subdomains too: `auction.com` must cover
  // `www.auction.com`, or the rule is one DNS label away from useless.
  return h === p || h.endsWith(`.${p}`);
}

/** Returns the matching denial, or null. Never throws — the caller decides. */
export function matchDenylist(rawUrl: string, denials: readonly Denial[]): DenyMatch | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    // An unparseable URL is not "not denied". Refuse to answer; the guard turns
    // a null-with-no-URL into a hard failure rather than a permit.
    throw new Error(`denylist: unparseable URL ${JSON.stringify(rawUrl)}`);
  }
  const path = (u.pathname + u.search).toLowerCase();

  for (const denial of denials) {
    if (!hostMatches(denial.host, u.hostname)) continue;
    if (!denial.paths || denial.paths.length === 0) return { denial, matchedOn: 'host' };
    for (const prefix of denial.paths) {
      if (path.startsWith(prefix.toLowerCase())) return { denial, matchedOn: 'path' };
    }
  }
  return null;
}
