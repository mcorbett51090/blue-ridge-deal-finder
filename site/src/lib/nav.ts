/**
 * Base-aware link helper (ported verbatim in spirit from SWC's src/lib/nav.ts —
 * claims-D D14). EVERY internal href goes through withBase(), so the site works
 * identically at the GitHub-Pages subpath (/blue-ridge-deal-finder/) and at a
 * custom-domain root (/).
 *
 * This is not optional here: the live target IS the subpath, so a bare
 * `href="/status/"` is a 404 on the deployed site while working fine in `astro
 * dev`. That asymmetry is the whole reason the helper exists.
 */
const BASE = import.meta.env.BASE_URL; // '/blue-ridge-deal-finder/' or '/'

/** Prefix an app-absolute path with the deployment base, collapsing double slashes. */
export function withBase(path: string): string {
  const p = path.startsWith('/') ? path.slice(1) : path;
  return `${BASE}${p}`.replace(/\/{2,}/g, '/');
}
