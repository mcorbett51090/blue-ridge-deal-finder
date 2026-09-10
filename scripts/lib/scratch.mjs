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

/**
 * `clear` empties a subtree of the SKELETON copy before `plants` are applied —
 * for a gate whose real repo content would otherwise leak into a fixture meant
 * to test an EMPTY or SPECIFIC state of that subtree.
 *
 * ⛔ WHY THIS EXISTS. check-freshness.mjs's own fixtures were silently
 * contaminated by data/runs/ — plants only ADD files, so the real repo's
 * manifests (copied in by the skeleton above) sat alongside whatever a fixture
 * planted. That was harmless while `status: 'complete'` was the only value the
 * gate counted, because none of the real manifests ever carried it — but the
 * moment `partial` counted too (every real manifest here IS partial), a
 * fixture meant to prove a `failed`-only run stays UNKNOWN instead read
 * GREEN, off the real repo's unrelated history. And once real scheduled runs
 * start landing fresh `partial` manifests in data/runs/, the EXISTING
 * `stale-run` control (an old fixture, expecting RED) would eventually read
 * GREEN off THOSE too — a control silently stops proving anything the day the
 * bug it exists to catch gets fixed elsewhere. `clear` is the fix: a fixture
 * that needs an isolated view of a subtree says so, instead of relying on the
 * real repo never accumulating anything there.
 */
export function makeScratch(plants = {}, clear = []) {
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
  for (const rel of clear) {
    const target = join(dir, rel);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
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
