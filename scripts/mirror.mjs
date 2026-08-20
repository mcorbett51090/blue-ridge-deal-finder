#!/usr/bin/env node
/**
 * OFF-PLATFORM MIRROR — the one finding that is unrecoverable if it fires.
 *
 * ⛔ THE FAILURE THIS EXISTS FOR. GitHub's Additional Product Terms name
 * "disabling of repositories" as the penalty for misusing Actions. Tiers 0 and
 * 1 — the raw ingest snapshots and the SQLite warehouse — are gitignored and
 * live only as artifacts of THIS repo. So the documented recovery path
 * ("rebuild from Tier 0") lives inside the artifact that gets disabled.
 *
 * Everything else in this project degrades: a scraper breaks and a county goes
 * stale, a service 403s and a signal goes unknown. This one is different. If it
 * fires unmitigated, 387,742 parcels and every event ever recorded are gone,
 * and the only remedy is to re-fetch the entire corpus from counties that have
 * meanwhile moved on.
 *
 * It is one scheduled copy of two directories. It was deferred through five
 * phases and should not have been.
 *
 * ⛔ The mirror deliberately lives OUTSIDE the repo (`~/blue-ridge-archive` by
 * default). A copy inside the repo shares the fate of the repo, which is the
 * entire failure being mitigated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const DEST = process.env.BRDF_MIRROR ?? join(homedir(), 'blue-ridge-archive');

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function newestWarehouse() {
  const dir = join(ROOT, 'data/warehouse');
  const pointerPath = join(dir, 'warehouse-pointer.json');
  if (!existsSync(pointerPath)) return null;
  // ⛔ The file the POINTER names, never the newest by mtime. A failed run
  // leaves a `warehouse-building-*.sqlite` behind that was deliberately NOT
  // promoted; mirroring it would archive the artifact the pointer exists to
  // keep you away from.
  const current = JSON.parse(readFileSync(pointerPath, 'utf8')).current;
  const p = join(dir, current);
  return existsSync(p) ? p : null;
}

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

mkdirSync(DEST, { recursive: true });

const manifest = { mirrored_at: new Date().toISOString(), root: ROOT, dest: DEST, files: [] };
let copied = 0;
let skipped = 0;

// TIER 1 — the warehouse the pointer names.
const wh = newestWarehouse();
if (wh) {
  const target = join(DEST, basename(wh));
  const srcHash = sha256(wh);
  // Content-addressed: an unchanged warehouse is not recopied. 26 MB a day for
  // a file that did not change is exactly the disproportionate burden the
  // cadence discipline exists to avoid.
  if (existsSync(target) && sha256(target) === srcHash) skipped += 1;
  else { copyFileSync(wh, target); copied += 1; }
  manifest.files.push({ tier: 1, name: basename(wh), sha256: srcHash, bytes: statSync(wh).size });
} else {
  console.error('  ! no warehouse pointer — nothing to mirror at tier 1');
}

// TIER 0 — raw ingest snapshots + the append-only event log + run manifests.
for (const rel of ['data/raw', 'data/events', 'data/runs', 'data/distress', 'data/enrich']) {
  for (const f of filesUnder(join(ROOT, rel))) {
    // ⛔ NEVER archive a `-shm`. It is SQLite's runtime shared-memory index, not
    // data: it is rebuilt from the `-wal` on open, and handing SQLite a foreign
    // one is unsafe. The previous archive copied it AND RECOVERY.md told the
    // reader to restore it, which is a procedure that can corrupt the thing it is
    // meant to rescue. The `-wal` is kept: it carries committed frames, and the
    // mirror step now runs after a `wal_checkpoint(TRUNCATE)`, so it is normally 0 B.
    if (f.endsWith('.sqlite-shm')) { skipped += 1; continue; }
    const name = f.slice(ROOT.length + 1).replace(/\//g, '__');
    const target = join(DEST, name);
    const srcHash = sha256(f);
    if (existsSync(target) && sha256(target) === srcHash) { skipped += 1; }
    else { copyFileSync(f, target); copied += 1; }
    manifest.files.push({ tier: 0, name, sha256: srcHash, bytes: statSync(f).size });
  }
}

writeFileSync(join(DEST, 'MANIFEST.json'), JSON.stringify(manifest, null, 1));

// ⛔ The recovery instructions live IN THE MIRROR, not in the repo. A rebuild
// procedure stored inside the artifact that gets disabled is not a procedure.
writeFileSync(
  join(DEST, 'RECOVERY.md'),
  `# Blue Ridge Deal Finder — off-platform archive

Mirrored ${manifest.mirrored_at} from ${ROOT}.

## Why this exists

Tiers 0 and 1 are gitignored and exist only as artifacts of the GitHub repo
\`mcorbett51090/blue-ridge-deal-finder\`. GitHub's terms name repository
disabling as a penalty, and the repo's own documentation is no use once that
happens. **These instructions are here, in the archive, on purpose.**

## What is here

| file | tier | what it is |
|---|---|---|
| \`warehouse-*.sqlite\` | 1 | the whole corpus — parcels, county ledger, run metadata |
| \`data__events__*\` | 0 | append-only change log; every field that ever changed |
| \`data__runs__*\` | 0 | per-run manifests |
| \`data__distress__*\` | 0 | for-sale evidence joined to parcels |
| \`data__enrich__*\` | 0 | measured water / slope / road facts |
| \`MANIFEST.json\` | — | sha256 and byte count for every file above |

\`*.sqlite-shm\` is **excluded on purpose** — see step 3.

## To recover

1. \`git clone\` the repo, or recreate it from any fork. The CODE is on GitHub
   and in git history; only the DATA is here.
2. Copy \`warehouse-*.sqlite\` back to \`data/warehouse/\` and write
   \`data/warehouse/warehouse-pointer.json\` naming it:
   \`{"current":"<filename>","sha256":"<from MANIFEST.json>"}\`
3. Copy the \`data__*\` files back, converting \`__\` to \`/\`.
   ⛔ There is deliberately **no \`-shm\`** in this archive, and you must not
   create one. SQLite's \`-shm\` is a runtime shared-memory index, rebuilt from
   the \`-wal\` on open; restoring a foreign one can corrupt the database this
   procedure exists to rescue. A \`-wal\` beside a \`.sqlite\` is fine — open it
   once and run \`PRAGMA wal_checkpoint(TRUNCATE); PRAGMA integrity_check;\`
   before trusting it.
4. \`npm ci --ignore-scripts && npm run verify\` — 8 gates must pass.
5. \`npx tsx publish/run.ts && npm --prefix site run build\`.

Verify every file against \`MANIFEST.json\` before trusting it. A corrupted
archive that looks present is worse than an absent one.
`,
);

console.log(`✓ mirror — ${copied} file(s) copied, ${skipped} unchanged, ${manifest.files.length} tracked`);
console.log(`  ${DEST}`);
if (manifest.files.length === 0) {
  console.error('  ⛔ nothing mirrored — an empty archive is not a backup');
  process.exit(1);
}
