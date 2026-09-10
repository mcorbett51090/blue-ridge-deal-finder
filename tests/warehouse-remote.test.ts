/**
 * scripts/warehouse-remote.mjs — the CI warehouse's only restore/publish path,
 * exercised end to end against a FAKE `gh` binary rather than the real GitHub
 * API. It shelled out to `gh` (an egress-allowlist-permitted global on the
 * allowlist owner exemption — see scripts/egress-permits.json), so a fake `gh`
 * placed first on PATH is a complete, honest double: the module under test
 * never knows it isn't talking to a real release.
 *
 * ⛔ WHY THIS FILE EXISTS. The module shipped with a commit message claiming
 * "the restore/publish round trip is exercised against a simulated release:
 * create, churn-skip on an unchanged hash, restore with sha verification,
 * retention of the superseded asset, refusal on a truncated asset, and the
 * genuine-first-run path" — and no such test was ever committed. A claim of
 * coverage that does not exist is exactly the kind of gap this project's own
 * gate family exists to catch elsewhere; this is that catch applied to itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const MODULE = join(ROOT, 'scripts', 'warehouse-remote.mjs');

/**
 * A fake `gh` that understands exactly the release subcommands
 * warehouse-remote.mjs issues, backed by a plain directory tree rather than
 * GitHub — so a test run never touches the network or the real repo.
 */
// warehouse-remote.mjs only ever calls `--pattern` with an EXACT filename
// (the pointer's own literal name, never a glob) — so this fake matches
// exact names only, which keeps it free of any glob/regex-escaping subtlety.
const FAKE_GH_LINES = [
  "#!/usr/bin/env node",
  "const { existsSync, mkdirSync, readdirSync, rmSync, copyFileSync } = require('node:fs');",
  "const { join, basename } = require('node:path');",
  "const STORE = process.env.FAKE_GH_STORE;",
  "const args = process.argv.slice(2);",
  "const noun = args[0];",
  "const verb = args[1];",
  "const rest = args.slice(2);",
  "const repoIdx = rest.indexOf('--repo');",
  "if (repoIdx !== -1) rest.splice(repoIdx, 2);",
  "function tagDir(tag) { return join(STORE, tag); }",
  "if (noun !== 'release') { console.error('fake gh: only release subcommands supported'); process.exit(2); }",
  "if (verb === 'view') {",
  "  const tag = rest[0];",
  "  const dir = tagDir(tag);",
  "  if (!existsSync(dir)) process.exit(1);",
  "  const jsonIdx = rest.indexOf('--json');",
  "  if (jsonIdx !== -1) {",
  "    const jqIdx = rest.indexOf('--jq');",
  "    const names = existsSync(join(dir, 'assets')) ? readdirSync(join(dir, 'assets')) : [];",
  "    if (jqIdx !== -1 && rest[jqIdx + 1] === '.assets[].name') {",
  "      process.stdout.write(names.join(String.fromCharCode(10)) + (names.length ? String.fromCharCode(10) : ''));",
  "    } else {",
  "      process.stdout.write(JSON.stringify({ assets: names.map((n) => ({ name: n })) }));",
  "    }",
  "  }",
  "  process.exit(0);",
  "}",
  "if (verb === 'create') {",
  "  const tag = rest[0];",
  "  mkdirSync(join(tagDir(tag), 'assets'), { recursive: true });",
  "  process.exit(0);",
  "}",
  "if (verb === 'download') {",
  "  const tag = rest[0];",
  "  const patternIdx = rest.indexOf('--pattern');",
  "  const dirIdx = rest.indexOf('--dir');",
  "  const pattern = patternIdx !== -1 ? rest[patternIdx + 1] : null;",
  "  const dest = dirIdx !== -1 ? rest[dirIdx + 1] : '.';",
  "  const assetsDir = join(tagDir(tag), 'assets');",
  "  if (!existsSync(assetsDir)) process.exit(1);",
  "  mkdirSync(dest, { recursive: true });",
  "  const names = readdirSync(assetsDir).filter((n) => !pattern || n === pattern);",
  "  for (const name of names) copyFileSync(join(assetsDir, name), join(dest, name));",
  "  process.exit(names.length > 0 ? 0 : 1);",
  "}",
  "if (verb === 'upload') {",
  "  const tag = rest[0];",
  "  const clobberIdx = rest.indexOf('--clobber');",
  "  if (clobberIdx !== -1) rest.splice(clobberIdx, 1);",
  "  const files = rest.slice(1);",
  "  const assetsDir = join(tagDir(tag), 'assets');",
  "  mkdirSync(assetsDir, { recursive: true });",
  "  for (const f of files) copyFileSync(f, join(assetsDir, basename(f)));",
  "  process.exit(0);",
  "}",
  "if (verb === 'delete-asset') {",
  "  const tag = rest[0];",
  "  const name = rest[1];",
  "  rmSync(join(tagDir(tag), 'assets', name), { force: true });",
  "  process.exit(0);",
  "}",
  "console.error('fake gh: unsupported verb ' + verb);",
  "process.exit(2);",
  "",
];
const FAKE_GH = FAKE_GH_LINES.join('\n');

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'brdf-warehouse-remote-'));
  const repoRoot = join(dir, 'repo');
  const store = join(dir, 'fake-gh-store');
  const binDir = join(dir, 'bin');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(store, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, FAKE_GH, { mode: 0o755 });
  return { dir, repoRoot, store, binDir };
}

function run(sandbox: ReturnType<typeof makeSandbox>, command: 'restore' | 'publish') {
  const res = spawnSync(process.execPath, [MODULE, command], {
    cwd: sandbox.repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${sandbox.binDir}:${process.env.PATH}`,
      FAKE_GH_STORE: sandbox.store,
      BRDF_ROOT: sandbox.repoRoot,
      BRDF_WAREHOUSE_TAG: 'warehouse-test',
      BRDF_WAREHOUSE_REPO: 'test/does-not-matter',
    },
  });
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

function writeLocalWarehouse(sandbox: ReturnType<typeof makeSandbox>, name: string, content: string) {
  const dir = join(sandbox.repoRoot, 'data', 'warehouse');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  writeFileSync(
    join(dir, 'warehouse-pointer.json'),
    JSON.stringify({ current: name, sha256, bytes: content.length, written_at: new Date().toISOString() }),
  );
  return sha256;
}

function markRunRecorded(sandbox: ReturnType<typeof makeSandbox>) {
  const dir = join(sandbox.repoRoot, 'data', 'runs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-01-01-run.json'), JSON.stringify({ status: 'partial' }));
}

test('restore: genuine first run (no release, no prior data/runs/) is a clean no-op', () => {
  const sandbox = makeSandbox();
  try {
    const { code, out } = run(sandbox, 'restore');
    assert.equal(code, 0, out);
    assert.match(out, /GENUINE FIRST RUN/);
    assert.equal(existsSync(join(sandbox.repoRoot, 'data', 'warehouse', 'warehouse-pointer.json')), false);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test('restore: no release BUT data/runs/ already has manifests is LOST STATE, refused', () => {
  const sandbox = makeSandbox();
  try {
    markRunRecorded(sandbox);
    const { code, out } = run(sandbox, 'restore');
    assert.notEqual(code, 0, 'lost state must not silently pass as a first run');
    assert.match(out, /LOST state/);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test('publish then restore round-trips the exact bytes, verified by sha256', () => {
  const sandbox = makeSandbox();
  try {
    writeLocalWarehouse(sandbox, 'warehouse-2026-01-01.sqlite', 'corpus-v1');
    const pub = run(sandbox, 'publish');
    assert.equal(pub.code, 0, pub.out);
    assert.match(pub.out, /published warehouse-2026-01-01\.sqlite/);

    // A fresh runner: the local warehouse is gone, exactly like a new hosted job.
    rmSync(join(sandbox.repoRoot, 'data', 'warehouse'), { recursive: true, force: true });

    const res = run(sandbox, 'restore');
    assert.equal(res.code, 0, res.out);
    assert.match(res.out, /restored warehouse-2026-01-01\.sqlite/);
    assert.match(res.out, /sha256 ok/);
    const restored = readFileSync(join(sandbox.repoRoot, 'data', 'warehouse', 'warehouse-2026-01-01.sqlite'), 'utf8');
    assert.equal(restored, 'corpus-v1');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test('publish: an unchanged hash is NOT re-uploaded — churn discipline', () => {
  const sandbox = makeSandbox();
  try {
    writeLocalWarehouse(sandbox, 'warehouse-2026-01-01.sqlite', 'corpus-v1');
    assert.equal(run(sandbox, 'publish').code, 0);
    // Same content, same file name, republished — nothing should change remotely.
    const second = run(sandbox, 'publish');
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /already holds .* not re-uploading/);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test('publish: a NEW warehouse retires the superseded asset', () => {
  const sandbox = makeSandbox();
  try {
    writeLocalWarehouse(sandbox, 'warehouse-gen1.sqlite', 'corpus-gen1');
    assert.equal(run(sandbox, 'publish').code, 0);

    writeLocalWarehouse(sandbox, 'warehouse-gen2.sqlite', 'corpus-gen2-longer-content');
    const second = run(sandbox, 'publish');
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /retired superseded asset warehouse-gen1\.sqlite/);

    const assetsDir = join(sandbox.store, 'warehouse-test', 'assets');
    const names = readdirSync(assetsDir);
    assert.ok(names.includes('warehouse-gen2.sqlite'), 'the new asset must be present');
    assert.ok(!names.includes('warehouse-gen1.sqlite'), 'the superseded asset must be gone');
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test('restore: a truncated/corrupt remote asset is refused, never silently ingested', () => {
  const sandbox = makeSandbox();
  try {
    writeLocalWarehouse(sandbox, 'warehouse-2026-01-01.sqlite', 'the-real-full-corpus');
    assert.equal(run(sandbox, 'publish').code, 0);

    // Corrupt the asset IN THE FAKE STORE, out of band — as if a transfer
    // truncated it, which a plain existence check would not catch.
    const assetPath = join(sandbox.store, 'warehouse-test', 'assets', 'warehouse-2026-01-01.sqlite');
    writeFileSync(assetPath, 'the-real-full'); // truncated

    rmSync(join(sandbox.repoRoot, 'data', 'warehouse'), { recursive: true, force: true });
    const res = run(sandbox, 'restore');
    assert.notEqual(res.code, 0, 'a hash mismatch must refuse, not ingest a truncated corpus');
    assert.match(res.out, /hashes .* but .* claims/);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});

test('restore: pointer names an asset the release does not have — refused, not guessed', () => {
  const sandbox = makeSandbox();
  try {
    const dir = join(sandbox.repoRoot, 'data', 'warehouse');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'warehouse-x.sqlite'), 'x');
    writeFileSync(
      join(dir, 'warehouse-pointer.json'),
      JSON.stringify({ current: 'warehouse-x.sqlite', sha256: 'deadbeef', bytes: 1, written_at: 'now' }),
    );
    // Publish just the pointer manually into the fake store, without the asset
    // it names, to simulate the pointer and the release disagreeing.
    mkdirSync(join(sandbox.store, 'warehouse-test', 'assets'), { recursive: true });
    cpSync(join(dir, 'warehouse-pointer.json'), join(sandbox.store, 'warehouse-test', 'assets', 'warehouse-pointer.json'));

    rmSync(dir, { recursive: true, force: true });
    const res = run(sandbox, 'restore');
    assert.notEqual(res.code, 0);
    assert.match(res.out, /pointer and the release disagree|no such asset/);
  } finally {
    rmSync(sandbox.dir, { recursive: true, force: true });
  }
});
