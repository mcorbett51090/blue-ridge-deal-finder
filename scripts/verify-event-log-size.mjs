#!/usr/bin/env node
/**
 * THE APPEND-ONLY EVENT LOG MUST STAY PUSHABLE.
 *
 * ⛔ GitHub rejects any blob over 100 MiB, and the rejection happens AT PUSH —
 * after the ingest has run, after the warehouse is built, after the events are
 * written. On a hosted runner `data/warehouse/` is gitignored, so the ephemeral
 * warehouse is discarded when the job ends and the whole run is lost with it.
 * A limit you discover at push time is a limit you discover too late.
 *
 * Measured 2026-08-19: `data/events/2026-08/nc-onemap-parcels.ndjson` is
 * 51,903,096 bytes across 235,421 lines, and EVERY line is `kind: "new"` —
 * not one `changed`, `stale` or `returned` in the entire history. That is the
 * second half of the problem: the delta is computed against
 * `readPriorState(path)`, which returns an EMPTY map when the prior warehouse is
 * absent, and it is always absent in CI because it is gitignored by design. So
 * every scheduled run re-emits the full corpus as new, and the file grows by
 * another ~50 MB rather than by the handful of rows that actually changed.
 *
 * `EventWriter` opens one file per source per MONTH, so this is also
 * CALENDAR-DEPENDENT: a September run starts a fresh file and the problem
 * disappears until that one grows. A test written in September would pass over a
 * repo that breaks in August.
 *
 * The floor is set BELOW GitHub's hard limit on purpose. A gate that fires at
 * 100 MiB fires at the same moment the push fails, which is no warning at all.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.env.BRDF_ROOT ?? process.cwd();
const MIB = 1024 * 1024;
// The ceiling is declared in data/events/size-policy.json so it is reviewable in
// a diff rather than buried in a script, and so this gate has a red fixture that
// does not require committing an 80 MiB file to prove it fires.
const POLICY_PATH = join(ROOT, 'data/events/size-policy.json');
let policy = { max_mib: 80, hard_limit_mib: 100 };
if (existsSync(POLICY_PATH)) {
  try {
    const p = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
    if (typeof p.max_mib === 'number') policy = { ...policy, ...p };
  } catch {
    console.error('verify-event-log-size: FAILED');
    console.error('  ✗ data/events/size-policy.json is unparseable — an unreadable policy is not a policy');
    process.exit(1);
  }
}
/** GitHub's hard rejection threshold. Not ours to change. */
const HARD_LIMIT_MIB = policy.hard_limit_mib;
/** Ours: enough headroom that a single further run cannot cross the hard limit. */
const FAIL_AT_MIB = policy.max_mib;

const dir = join(ROOT, 'data/events');
if (!existsSync(dir)) {
  console.log('· verify-event-log-size — no data/events/ in this checkout; nothing to size.');
  process.exit(0);
}

const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (!p.endsWith('size-policy.json')) files.push(p);
  }
};
walk(dir);

const problems = [];
let largest = 0;
for (const f of files) {
  const mib = statSync(f).size / MIB;
  if (mib > largest) largest = mib;
  if (mib >= FAIL_AT_MIB) {
    problems.push(
      `${relative(ROOT, f)} is ${mib.toFixed(1)} MiB — over the ${FAIL_AT_MIB} MiB ceiling and heading for ` +
        `GitHub's ${HARD_LIMIT_MIB} MiB hard blob limit, which rejects AT PUSH, after the ingest has already run. ` +
        'Shard the month file, or stop re-emitting unchanged rows.',
    );
  }
}

if (problems.length) {
  console.error('verify-event-log-size: FAILED');
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(
  `✓ verify-event-log-size — ${files.length} event file(s), largest ${largest.toFixed(1)} MiB ` +
    `(ceiling ${FAIL_AT_MIB}, GitHub hard limit ${HARD_LIMIT_MIB})`,
);
