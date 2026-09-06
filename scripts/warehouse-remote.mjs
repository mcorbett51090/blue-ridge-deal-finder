#!/usr/bin/env node
/**
 * warehouse-remote.mjs — THE MISSING HALF OF THE WAREHOUSE LIFECYCLE.
 *
 * ⛔ THE FAILURE THIS EXISTS FOR, MEASURED.
 * `.github/workflows/ingest-parcels.yml` has run on a schedule three times
 * (32617980335, 33292578668, 34011615287 — 2026-08-23, 08-30, 09-06) and has
 * NEVER SUCCEEDED. Every one died in the same place:
 *
 *   Error: prior warehouse state is EMPTY but 6 run manifest(s) exist in
 *   data/runs/ — this is LOST STATE, not a first run.
 *
 * That refusal (assertPriorStateNotLost) is CORRECT and must stay. The bug is
 * that nothing could ever satisfy it. `data/warehouse/` is gitignored by
 * design, the runner is ephemeral, and the workflow committed
 * `data/events data/runs data/coverage.json` — never the warehouse. So the
 * corpus was rebuilt from nothing each run and discarded at job end. The guard
 * turned "publishes a change feed that is false" into "never publishes at
 * all", and the second failure is quieter than the first: a workflow that is
 * red every week gets read as a known-red workflow.
 *
 * The lifecycle was only ever half-written. `swapPointer` already reasons about
 * "a weekly re-upload of a 150-250 MB asset is 8-13 GB/yr of churn" and returns
 * `uploaded: false` for an unchanged hash; `.gitignore` already states the
 * intended home — "Warehouse + raw tiers live as Release assets / off-platform
 * mirror, never in git". The upload and the download were simply never built.
 * This file builds them.
 *
 * ⛔ WHY A GITHUB RELEASE AND NOT actions/cache.
 * Cache entries are EVICTED after 7 days without a hit, and the ingest cadence
 * is 7 days (a terms requirement — see the workflow header, it is not a knob).
 * Persisting the only copy of the corpus in a store whose eviction clock and
 * whose write cadence are the same number is a coin flip, and losing it lands
 * back on the lost-state refusal with no way out. Release assets do not expire,
 * are free and unmetered for a public repo, and are reachable with the
 * GITHUB_TOKEN the workflow already holds — no new secret in a public repo.
 *
 * ⛔ THIS IS NOT THE OFF-PLATFORM MIRROR AND DOES NOT REPLACE IT.
 * scripts/mirror.mjs exists because tiers 0 and 1 living ONLY as artifacts of
 * this repo means a disabled repo takes the corpus with it. A Release asset is
 * still an artifact of this repo and shares its fate exactly. This closes the
 * CI loop; mirror.mjs is still the thing that survives the repo. Both.
 *
 * Egress note: this shells out to `gh` (node:child_process is on the egress
 * allowlist) and talks only to GitHub's own API about our own repo. It is not
 * crawler traffic and never touches a county server, so it is not a second
 * client competing with pipeline/fetch/client.ts.
 *
 * Usage:
 *   node scripts/warehouse-remote.mjs restore   # release asset -> data/warehouse/
 *   node scripts/warehouse-remote.mjs publish   # data/warehouse/ -> release asset
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const TAG = process.env.BRDF_WAREHOUSE_TAG ?? 'warehouse-current';
const REPO = process.env.BRDF_WAREHOUSE_REPO ?? 'mcorbett51090/blue-ridge-deal-finder';
const WAREHOUSE_DIR = join(ROOT, 'data', 'warehouse');
const POINTER = 'warehouse-pointer.json';

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const mib = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

function die(message) {
  console.error(`\n✗ warehouse-remote: ${message}\n`);
  process.exit(1);
}

function gh(args) {
  const res = spawnSync('gh', [...args, '--repo', REPO], { encoding: 'utf8' });
  if (res.error) die(`could not run \`gh\` — ${res.error.message}`);
  return { code: res.status ?? 1, out: (res.stdout ?? '').trim(), err: (res.stderr ?? '').trim() };
}

/**
 * ⛔ The SAME definition of "a prior run happened" that assertPriorStateNotLost
 * uses — a recorded run manifest. Two places deciding independently whether
 * this is a first run is how they end up disagreeing, and the disagreement
 * would either block a legitimate bootstrap or wave through real lost state.
 */
function runsRecorded() {
  const dir = join(ROOT, 'data', 'runs');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).length;
}

const BOOTSTRAP = `No warehouse has been published to release \`${TAG}\` yet, and data/runs/ already
  records prior runs — so this checkout has LOST state rather than never having had it.
  Seed the release ONCE from the machine that holds the corpus (or from the
  off-platform mirror \`npm run mirror\` keeps):

    cd <repo with a healthy data/warehouse/>
    gh release create ${TAG} --repo ${REPO} \\
      --title "Warehouse (current)" \\
      --notes "Tier-1 SQLite corpus. Written by scripts/warehouse-remote.mjs; do not hand-edit."
    node scripts/warehouse-remote.mjs publish

  Every scheduled ingest after that restores from, and republishes to, this release.`;

function tempDir(kind) {
  const d = join(tmpdir(), `brdf-warehouse-${kind}-${process.pid}`);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

/** The remote pointer, or null when the release or the asset is absent. */
function remotePointer(dir) {
  const res = gh(['release', 'download', TAG, '--pattern', POINTER, '--dir', dir]);
  if (res.code !== 0) return null;
  const p = join(dir, POINTER);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    return die(`release ${TAG} carries an unparseable ${POINTER} — ${err.message}`);
  }
}

function restore() {
  // ⛔ data/warehouse/ IS NOT CREATED UNTIL THERE IS SOMETHING TO PUT IN IT.
  // verify-ledger-reconciles.mjs reads an EMPTY directory as a real anomaly and
  // fails closed ("DIRECTORY BUT NO POINTER ... -> fail closed"), while an
  // absent directory is the documented, legitimate CI shape. Creating the
  // directory early and then failing to fill it would turn a clean skip into a
  // red gate on every run.
  const staging = tempDir('restore');
  const pointer = remotePointer(staging);

  if (pointer === null) {
    const recorded = runsRecorded();
    rmSync(staging, { recursive: true, force: true });
    if (recorded > 0) die(BOOTSTRAP);
    // A genuine first run. Say so out loud rather than silently: the next
    // ingest emits the whole corpus as `new`, and that is true exactly once.
    console.log(
      `· no warehouse on release ${TAG}, and data/runs/ is empty — treating this as a GENUINE ` +
        'FIRST RUN. The ingest will emit the whole corpus as `new`, which is honest exactly once.',
    );
    return;
  }

  const name = pointer.current;
  if (typeof name !== 'string' || name === '') {
    die(`release ${TAG} carries a ${POINTER} with no \`current\` — it names no warehouse`);
  }

  const got = gh(['release', 'download', TAG, '--pattern', name, '--dir', staging]);
  const sqlitePath = join(staging, name);
  if (got.code !== 0 || !existsSync(sqlitePath)) {
    die(
      `release ${TAG} has a pointer naming \`${name}\` but no such asset. The pointer and the ` +
        `release disagree, and guessing which is right is how the wrong corpus gets published.\n  ${got.err}`,
    );
  }

  // ⛔ Integrity, not just presence. A truncated download is a VALID SQLite
  // prefix surprisingly often: it opens, it queries, it returns FEWER rows —
  // and fewer rows against the real corpus is a delta that marks the missing
  // ones `stale` and publishes a change feed that is false in the other
  // direction. The pointer already carries the hash; check it.
  const actual = sha256(sqlitePath);
  if (actual !== pointer.sha256) {
    die(
      `restored ${name} hashes ${actual} but ${POINTER} claims ${pointer.sha256} — ` +
        'the asset is corrupt or was replaced out of band. Refusing to ingest against it.',
    );
  }

  mkdirSync(WAREHOUSE_DIR, { recursive: true });
  renameSync(sqlitePath, join(WAREHOUSE_DIR, name));
  renameSync(join(staging, POINTER), join(WAREHOUSE_DIR, POINTER));
  rmSync(staging, { recursive: true, force: true });

  console.log(
    `✓ restored ${name} (${mib(statSync(join(WAREHOUSE_DIR, name)).size)}, sha256 ok) from release ${TAG}`,
  );
}

function publish() {
  const pointerPath = join(WAREHOUSE_DIR, POINTER);
  if (!existsSync(pointerPath)) {
    die(`${pointerPath} does not exist — there is no current warehouse to publish`);
  }
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  const name = pointer.current;
  const sqlitePath = join(WAREHOUSE_DIR, name);
  if (!existsSync(sqlitePath)) die(`${POINTER} names \`${name}\`, which is not on disk`);

  // The pointer must agree with the bytes it names BEFORE those bytes become
  // the thing every future run restores. Publishing a warehouse whose hash does
  // not match its own pointer would make restore()'s integrity check fail
  // forever, on what is by then the only copy CI has.
  const actual = sha256(sqlitePath);
  if (actual !== pointer.sha256) {
    die(`${name} hashes ${actual} but ${POINTER} claims ${pointer.sha256} — refusing to publish a disagreeing pair`);
  }

  const staging = tempDir('publish');
  const remote = remotePointer(staging);

  // ⛔ CHURN DISCIPLINE, the same one swapPointer already applies locally: an
  // unchanged corpus is not re-uploaded. A weekly re-push of a 150-250 MB asset
  // that did not change is exactly the "burden disproportionate to the
  // benefits" the cadence justification in the workflow header exists to avoid.
  if (remote !== null && remote.sha256 === pointer.sha256) {
    console.log(`· release ${TAG} already holds ${name} at this hash — not re-uploading`);
    rmSync(staging, { recursive: true, force: true });
    return;
  }

  if (remote === null && gh(['release', 'view', TAG]).code !== 0) {
    const created = gh([
      'release', 'create', TAG,
      '--title', 'Warehouse (current)',
      '--notes', 'Tier-1 SQLite corpus. Written by scripts/warehouse-remote.mjs; do not hand-edit.',
    ]);
    if (created.code !== 0) die(`could not create release ${TAG} — ${created.err}`);
    console.log(`· created release ${TAG} (it did not exist)`);
  }

  const up = gh(['release', 'upload', TAG, sqlitePath, pointerPath, '--clobber']);
  if (up.code !== 0) die(`upload to release ${TAG} failed — ${up.err}`);
  console.log(`✓ published ${name} (${mib(statSync(sqlitePath).size)}) to release ${TAG}`);

  // Retention, mirroring swapPointer's: a superseded warehouse asset is only
  // removable once nothing points at it, which is now. Without this the release
  // accumulates one full corpus per week, forever.
  const listed = gh(['release', 'view', TAG, '--json', 'assets', '--jq', '.assets[].name']);
  if (listed.code === 0) {
    for (const asset of listed.out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (asset === name || !/^warehouse-.*\.sqlite$/.test(asset)) continue;
      const del = gh(['release', 'delete-asset', TAG, asset, '--yes']);
      console.log(del.code === 0 ? `· retired superseded asset ${asset}` : `  ! could not retire ${asset} — ${del.err}`);
    }
  }
  rmSync(staging, { recursive: true, force: true });
}

const command = process.argv[2];
if (command === 'restore') restore();
else if (command === 'publish') publish();
else die(`unknown command ${command ?? '(none)'} — expected \`restore\` or \`publish\``);
