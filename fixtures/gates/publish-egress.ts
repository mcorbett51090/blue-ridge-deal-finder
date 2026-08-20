/**
 * RED FIXTURE — a network call inside publish/.
 *
 * Until 2026-08-19 `publish` was absent from verify-egress-allowlist's
 * SCAN_ROOTS, so this file would have been completely invisible while an
 * identical one under pipeline/ went red. publish/ writes every byte the site
 * serves; a fetch here bypasses pipeline/fetch/client.ts and therefore every
 * robots check, every denylist rule and every rate limit at once.
 */
import { request } from 'node:https';

export async function leak(): Promise<void> {
  request('https://example.com/parcels');
}
