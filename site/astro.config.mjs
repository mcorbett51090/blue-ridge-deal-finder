// @ts-check
import { defineConfig } from 'astro/config';

/**
 * Static, host-agnostic build. English only, no i18n.
 *
 * === Deployment target ======================================================
 *   https://mcorbett51090.github.io/blue-ridge-deal-finder/
 *   SITE = 'https://mcorbett51090.github.io'   BASE = '/blue-ridge-deal-finder'
 *
 * Every internal link routes through withBase() (src/lib/nav.ts), so SITE +
 * BASE are the only two knobs that move the site between a Pages subpath and a
 * custom-domain root. Ported from SWC (claims-D D14/D38) for exactly that
 * reason — the subpath is live here TODAY, so an un-based href is a 404, not a
 * latent risk.
 *
 * No sitemap integration, deliberately. This site republishes distress signals
 * about real people's real property; plan §6.4 rules indexing to be the INVERSE
 * of SWC's — sitewide noindex,nofollow + robots.txt Disallow: /. Shipping a
 * sitemap would advertise exactly what robots.txt withdraws (a self-
 * contradicting crawl signal). `scripts/verify-noindex.mjs` gate-checks the
 * built dist/ so this cannot silently regress.
 */
const SITE = 'https://mcorbett51090.github.io';
const BASE = '/blue-ridge-deal-finder';

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'always',
  output: 'static',
  build: { format: 'directory' },
  vite: {
    build: {
      // MapLibre is ~230 KB gz and is dynamically imported at map-boot; keep the
      // warning threshold honest rather than muting it.
      chunkSizeWarningLimit: 1200,
    },
  },
});
