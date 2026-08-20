#!/usr/bin/env node
/**
 * INTERCHANGE GATE — the producer and the consumer must name the SAME path, and
 * nothing may be lost crossing it.
 *
 * ⛔ Measured 2026-08-19, and this is the defect the gate exists for.
 * `pipeline/ingest-distress.ts` wrote `data/distress/evidence.json`, holding 8
 * matched Jackson County REO parcels with real prices. `pipeline/score/
 * enrich-contract.ts` read `data/evidence/for-sale.json` and
 * `data/evidence/distress.json` — a directory that HAD NEVER EXISTED. Grep found
 * the string `data/evidence` in exactly two places, both inside that file's own
 * doc comment.
 *
 * So `discount` (weight 38) and `distress` (31) — 69 of the 100 composite points
 * — were structurally unreachable for every parcel in the corpus, while the data
 * they needed sat one directory away. Every test passed, because each SIDE was
 * internally consistent. `publish/` read the ingest path directly to build the
 * card, so the site rendered "$9,500" and looked entirely correct. A seam is
 * invisible precisely when both ends work.
 *
 * TWO ASSERTIONS, and they fail for different reasons on purpose:
 *   1. Every record the ingest produced reaches the contract. Catches a
 *      translator that silently drops records — the failure that looks like
 *      "there just isn't much evidence".
 *   2. Every `data/evidence/...` path named anywhere in the pipeline is one the
 *      contract declares. Catches the original defect and its cheaper cousin, a
 *      typo'd filename that reads as a legitimate absence.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const problems = [];
const notes = [];

// ---- what the contract DECLARES -------------------------------------------
const contractFile = join(ROOT, 'pipeline/score/enrich-contract.ts');
const declared = new Set();
if (existsSync(contractFile)) {
  const src = readFileSync(contractFile, 'utf8');
  // join(repoRoot, 'data', 'evidence', 'for-sale.json')
  for (const m of src.matchAll(/'data',\s*'evidence',\s*'([\w.-]+)'/g)) declared.add(m[1]);
  for (const m of src.matchAll(/data\/evidence\/([\w.-]+)/g)) declared.add(m[1]);
}
if (declared.size === 0) {
  problems.push('enrich-contract.ts declares no data/evidence/* path at all — the contract is the source of truth and it is empty');
}

// ---- 1. nothing is lost in translation ------------------------------------
const ingestPath = join(ROOT, 'data/distress/evidence.json');
const forSalePath = join(ROOT, 'data/evidence/for-sale.json');
if (existsSync(ingestPath)) {
  const ingest = JSON.parse(readFileSync(ingestPath, 'utf8'));
  const produced = Object.keys(ingest.evidence ?? {});
  if (!existsSync(forSalePath)) {
    if (produced.length > 0) {
      problems.push(
        `the ingest produced ${produced.length} evidence record(s) but data/evidence/for-sale.json does not exist — ` +
          'the scorer sees no evidence at all, which is exactly the defect this gate was written for',
      );
    }
  } else {
    const contract = JSON.parse(readFileSync(forSalePath, 'utf8'));
    const missing = produced.filter((id) => !(id in contract));
    if (missing.length) {
      problems.push(
        `${missing.length} of ${produced.length} ingested evidence record(s) never reached the contract: ` +
          `${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}`,
      );
    } else if (produced.length) {
      notes.push(`${produced.length}/${produced.length} ingested evidence records reached the contract`);
    }
  }
}

// ---- 2. no pipeline file names an undeclared evidence path -----------------
const scanDirs = ['publish', 'pipeline'];
const files = [];
const walk = (d) => {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|mjs|js)$/.test(e)) files.push(p);
  }
};
for (const d of scanDirs) walk(join(ROOT, d));

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const referenced = new Set();
  for (const m of src.matchAll(/'data',\s*'evidence',\s*'([\w.-]+)'/g)) referenced.add(m[1]);
  for (const m of src.matchAll(/data\/evidence\/([\w.-]+)/g)) referenced.add(m[1]);
  for (const name of referenced) {
    if (!declared.has(name)) {
      problems.push(
        `${relative(ROOT, f)} names data/evidence/${name}, which enrich-contract.ts does not declare — ` +
          `declared: ${[...declared].join(', ') || '(none)'}`,
      );
    }
  }
}

if (problems.length) {
  console.error('verify-interchange: FAILED');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`✓ verify-interchange — contract declares ${[...declared].join(', ')}${notes.length ? `; ${notes.join('; ')}` : ''}`);
