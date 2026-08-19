#!/usr/bin/env node
/**
 * verify-controls.mjs — THE META-GATE.
 *
 * ⛔ A GATE THAT HAS NEVER BEEN OBSERVED TO FAIL IS NOT YET A GATE.
 * Every verify-*.mjs in scripts/ must have a paired fixture, and running the
 * REAL gate against that fixture must actually exit non-zero. Not a fixture
 * that exists; not a test that asserts a fixture exists — the gate itself,
 * observed going red, this run.
 *
 * The baseline is the other half and it is the half usually missing: the same
 * gate, the same scratch machinery, NO fixture planted, must go GREEN. Without
 * it, a gate that is red for an unrelated reason inside a scratch tree "proves"
 * its red fixture works while proving nothing at all.
 *
 * The gate under test is always the real file in scripts/. Only the tree it
 * INSPECTS is a scratch copy (via BRDF_ROOT), so what is proven red is the same
 * bytes CI runs.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Gate, readJson, selfRoot } from './lib/gate.mjs';
import { dropScratch, makeScratch, runGate } from './lib/scratch.mjs';

const gate = new Gate('verify-controls');
const root = selfRoot(); // the meta-gate always inspects the real repo
const manifest = readJson(join(root, 'scripts', 'gate-fixtures.json'));

function firstLineOf(out) {
  const line = out.split('\n').find((l) => l.includes('✗'));
  return (line ?? out.split('\n')[0] ?? '').trim();
}

const allEntries = { ...manifest.gates, ...manifest.non_verify_gates };

// ---------------------------------------------------------------------------
// 1. Pairing completeness — discovered on disk, not read from the manifest.
//    Keying on the manifest would let a gate ship unproven simply by not being
//    written down, which is the failure this check exists to prevent.
// ---------------------------------------------------------------------------
const exempt = new Set(manifest.exempt_from_pairing ?? []);
const discovered = readdirSync(join(root, 'scripts'))
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))
  .filter((f) => !exempt.has(f));

for (const g of discovered) {
  const entries = allEntries[g];
  if (!entries || entries.length === 0) {
    gate.fail(`gate ${g} has NO paired fixture — it has never been observed to fail, so it is not yet a gate`);
  } else if (!entries.some((e) => e.expect === 'red')) {
    gate.fail(`gate ${g} has fixtures but none with expect=red`);
  }
}
for (const g of Object.keys(manifest.gates)) {
  if (!existsSync(join(root, 'scripts', g))) gate.fail(`manifest names ${g}, which does not exist in scripts/`);
}
gate.info(`${discovered.length} verify-* gate(s) discovered on disk; ${Object.keys(allEntries).length} in the manifest`);

// ---------------------------------------------------------------------------
// 2. Baseline: unmodified scratch must go GREEN.
// ---------------------------------------------------------------------------
const baselineDir = makeScratch({});
for (const gateFile of Object.keys(allEntries)) {
  if (!existsSync(join(root, 'scripts', gateFile))) continue;
  const entries = allEntries[gateFile];
  // Non-verify gates may be legitimately red at baseline (check-freshness has
  // no data at P1); their green case is asserted by an explicit expect=green
  // entry instead.
  if (!Object.hasOwn(manifest.gates, gateFile)) continue;
  const { code, out } = runGate(gateFile, baselineDir);
  if (code !== 0) {
    gate.fail(`BASELINE RED for ${gateFile} in an unmodified scratch tree — its red fixtures prove nothing. ${firstLineOf(out)}`);
  } else {
    gate.ok(`baseline green: ${gateFile}`);
  }
  void entries;
}
dropScratch(baselineDir);

// ---------------------------------------------------------------------------
// 3. Each fixture, run against the real gate.
// ---------------------------------------------------------------------------
for (const [gateFile, entries] of Object.entries(allEntries)) {
  if (!existsSync(join(root, 'scripts', gateFile))) continue;
  for (const entry of entries) {
    const dir = makeScratch(entry.plant);
    const { code, out } = runGate(gateFile, dir, entry.args ?? []);
    dropScratch(dir);

    if (entry.expect === 'red') {
      if (code === 0) gate.fail(`${gateFile} + ${entry.name}: expected RED, exited 0 — the fixture does not fail the gate`);
      else gate.ok(`${gateFile} goes RED on ${entry.name} (exit ${code}) — ${firstLineOf(out)}`);
    } else {
      if (code !== 0) gate.fail(`${gateFile} + ${entry.name}: expected GREEN, exited ${code}. ${firstLineOf(out)}`);
      else gate.ok(`${gateFile} stays GREEN on ${entry.name}`);
    }
  }
}

gate.finish();
