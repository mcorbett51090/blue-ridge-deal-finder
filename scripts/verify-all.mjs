#!/usr/bin/env node
/**
 * verify-all.mjs — the gate family, in order, failing loudly.
 *
 * ⛔ EVERY GATE RUNS EVEN AFTER ONE FAILS.
 * Short-circuiting on the first red hides every later gate behind it: the run
 * reports one problem, someone fixes it, and the next run reports the second —
 * so a five-defect tree takes five round trips and, worse, looks like it is
 * getting better each time. Collect all verdicts, print all of them, exit once.
 *
 * verify-controls runs LAST and on purpose: it is the gate that asserts the
 * others can fail, so it should be evaluated against the tree the others just
 * judged.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const GATES = [
  ['verify-egress-allowlist.mjs', 'one egress path, enforced by an allowlist (RT-11)'],
  ['verify-sources.mjs', 'registry complete; the denylist wins every conflict'],
  ['verify-coverage.mjs', 'exactly 37 counties, every one tiered'],
  ['verify-ingest-guards.mjs', 'the trust boundary rejects every known-bad payload'],
  ['verify-no-pii.mjs', 'no owner PII on any published surface (D1)'],
  ['verify-provenance.mjs', 'every source link shows the RECORD, never a homepage'],
  ['verify-ledger-reconciles.mjs', 'the county ledger agrees with the parcels table'],
  ['verify-controls.mjs', 'META: every gate proven to go RED against its fixture'],
];

/**
 * Deliberately NOT in this list: scripts/check-freshness.mjs. It measures
 * ingest recency and is legitimately red until P2 puts data on disk, so wiring
 * it into `npm run verify` would train everyone to ignore a red gate. It runs
 * from .github/workflows/freshness.yml, and verify-controls proves it can go
 * both red and green.
 */
const results = [];
for (const [file, why] of GATES) {
  console.log(`\n── ${file} — ${why}`);
  const res = spawnSync(process.execPath, [join(here, file)], { stdio: 'inherit' });
  results.push({ file, code: res.status ?? 1 });
}

const failed = results.filter((r) => r.code !== 0);
console.log('\n══════════════════════════════════════════════════════════');
for (const r of results) console.log(`${r.code === 0 ? '✓' : '✗'} ${r.file}${r.code === 0 ? '' : ` (exit ${r.code})`}`);
console.log(`${results.length - failed.length}/${results.length} gates green`);

if (failed.length > 0) {
  console.error(`\n✗ GATE FAMILY FAILED: ${failed.map((f) => f.file).join(', ')}`);
  process.exit(1);
}
console.log('✓ gate family green');
