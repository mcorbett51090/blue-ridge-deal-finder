#!/usr/bin/env node
/**
 * CI preflight — warehouse must exist BEFORE ingest on hosted runners.
 *
 * Measured: Actions run 34011615287 failed `assertPriorStateNotLost` — prior
 * warehouse EMPTY but 6 run manifests in data/runs/ (LOST STATE). Freshness
 * 33369287930 then failed secondary: data ~248d old vs 10d budget.
 *
 * `data/warehouse/` is gitignored (ADR 0008); hosted runners never have prior
 * state unless restored. This script fails early with an operator restore path
 * instead of letting ingest discover lost state mid-run.
 *
 * ⛔ Do NOT clear data/runs/ to silence the guard. That would make an empty
 * prior look like a first run, emit a false all-new change feed, and demote
 * the corpus. Restore the warehouse; never erase the manifests that prove it
 * existed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const dir = join(ROOT, 'data/warehouse');
const pointerPath = join(dir, 'warehouse-pointer.json');

function fail(lines) {
  console.error('ci-preflight-warehouse: FAILED');
  for (const line of lines) console.error(line);
  process.exit(1);
}

const restoreHint = [
  '  Restore via one of:',
  '    - Actions cache key prefix brdf-warehouse-v1- (CI continuity only)',
  '    - GitHub Release tag `warehouse-ci` (one-time seed from owner mirror)',
  '    - Owner local mirror ~/blue-ridge-archive (ADR 0008 real backup; see RECOVERY.md)',
  '  ⛔ Do NOT clear data/runs/ to bypass assertPriorStateNotLost — that would',
  '     emit a false all-new change feed / demotion. Restore the warehouse.',
];

if (!existsSync(pointerPath)) {
  fail([
    'missing data/warehouse/warehouse-pointer.json.',
    '  Hosted runners never ship a prior warehouse (gitignored by ADR 0008).',
    ...restoreHint,
  ]);
}

let ptr;
try {
  ptr = JSON.parse(readFileSync(pointerPath, 'utf8'));
} catch (err) {
  fail([`warehouse-pointer.json is unreadable JSON: ${err.message}`, ...restoreHint]);
}

if (!ptr.current || typeof ptr.current !== 'string') {
  fail(['warehouse-pointer.json has no usable "current" filename.', ...restoreHint]);
}

const named = join(dir, ptr.current);
if (!existsSync(named)) {
  fail([
    `pointer names "${ptr.current}" but that sqlite is missing under data/warehouse/.`,
    ...restoreHint,
  ]);
}

console.log(`✓ ci-preflight-warehouse — ${ptr.current} present at data/warehouse/`);
