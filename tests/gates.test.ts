/**
 * ⛔ THE RED CASE IS THE ONE THAT MATTERS.
 *
 * Every gate is run twice: against the real repo (must be green) and against a
 * scratch tree carrying its failing fixture (must be red). A gate proven only
 * green is indistinguishable from a gate that always exits 0.
 *
 * The pairing is read from scripts/gate-fixtures.json and the gate list is
 * DISCOVERED FROM DISK, so a gate added without a fixture fails this suite
 * rather than quietly not being covered by it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { dropScratch, makeScratch, runGate } from '../scripts/lib/scratch.mjs';

const ROOT = join(import.meta.dirname, '..');
type Entry = { name: string; expect: 'red' | 'green'; plant?: Record<string, string>; args?: string[] };
type Manifest = {
  gates: Record<string, Entry[]>;
  non_verify_gates: Record<string, Entry[]>;
  exempt_from_pairing: string[];
};
const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'gate-fixtures.json'), 'utf8')) as Manifest;
const allEntries: Record<string, Entry[]> = { ...manifest.gates, ...manifest.non_verify_gates };

const discovered = readdirSync(join(ROOT, 'scripts'))
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))
  .filter((f) => !manifest.exempt_from_pairing.includes(f));

test('every gate on disk has a paired RED fixture', () => {
  assert.ok(discovered.length > 0, 'no gates discovered — the discovery is broken, not the tree empty');
  for (const gate of discovered) {
    const entries = allEntries[gate];
    assert.ok(entries?.length, `${gate} has no paired fixture — it is not yet a gate`);
    assert.ok(
      entries.some((e) => e.expect === 'red'),
      `${gate} has fixtures but none that must make it fail`,
    );
  }
});

for (const gate of discovered) {
  test(`${gate} is GREEN against the real repo`, () => {
    const { code, out } = runGate(gate, ROOT);
    assert.equal(code, 0, `${gate} failed on the real repo:\n${out}`);
  });
}

for (const [gate, entries] of Object.entries(allEntries)) {
  for (const entry of entries) {
    test(`${gate} is ${entry.expect.toUpperCase()} on fixture '${entry.name}'`, () => {
      const dir = makeScratch(entry.plant ?? {});
      try {
        const { code, out } = runGate(gate, dir, entry.args ?? []);
        if (entry.expect === 'red') {
          assert.notEqual(code, 0, `${gate} exited 0 on '${entry.name}' — the fixture does not fail the gate:\n${out}`);
          assert.match(out, /✗/, 'a red gate must say why');
        } else {
          assert.equal(code, 0, `${gate} exited ${code} on '${entry.name}', expected green:\n${out}`);
        }
      } finally {
        dropScratch(dir);
      }
    });
  }
}

test('the meta-gate itself passes', () => {
  const { code, out } = runGate('verify-controls.mjs', ROOT);
  assert.equal(code, 0, out);
});
