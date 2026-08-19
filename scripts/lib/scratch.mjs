/**
 * Scratch-tree machinery shared by verify-controls.mjs and tests/gates.test.ts.
 *
 * A gate is always the REAL file in scripts/; only the tree it INSPECTS is a
 * copy. Proving a copy of a gate can fail proves nothing about the gate CI runs.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { selfRoot } from './gate.mjs';

const SKELETON = [
  'sources', 'seeds', 'publish', 'pipeline', 'scripts', 'fixtures',
  'data', 'site', 'package.json', '.npmrc', 'tsconfig.json',
];

export function makeScratch(plants = {}) {
  const root = selfRoot();
  const dir = mkdtempSync(join(tmpdir(), 'brdf-control-'));
  for (const item of SKELETON) {
    const src = join(root, item);
    if (!existsSync(src)) continue;
    cpSync(src, join(dir, item), {
      recursive: true,
      filter: (p) => !p.includes('node_modules') && !p.includes('/.astro'),
    });
  }
  for (const [dest, fixture] of Object.entries(plants)) {
    const target = join(dir, dest);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(root, 'fixtures', fixture), target);
  }
  return dir;
}

export function runGate(gateFile, scratchDir, args = []) {
  const res = spawnSync(process.execPath, [join(selfRoot(), 'scripts', gateFile), ...args], {
    env: { ...process.env, BRDF_ROOT: scratchDir },
    encoding: 'utf8',
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

export function dropScratch(dir) {
  rmSync(dir, { recursive: true, force: true });
}
