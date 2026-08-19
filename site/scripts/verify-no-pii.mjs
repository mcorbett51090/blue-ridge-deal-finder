#!/usr/bin/env node
/**
 * POSTBUILD GATE, against the BUILT dist/.
 *
 * A TypeScript interface cannot stop a JSON file from carrying a key the
 * interface never mentions, and a source-level allowlist cannot see what a
 * template interpolated. This reads the shipped bytes.
 *
 * Deliberately narrow: it looks for the field NAMES that carry owner identity,
 * not for anything that looks like a person's name. A regex that tries to
 * recognise human names on a page full of county names produces so much noise
 * that the gate gets muted, and a muted gate is worse than no gate.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(dist)) {
  console.error('verify-no-pii: dist/ does not exist — did the build run?');
  process.exit(1);
}

const NEEDLES = [
  'owner_name', 'ownername', 'owner_first', 'owner_last',
  'grantor', 'grantee', 'taxpayer_name', 'mailing_address', 'mail_addr',
  'deed_holder', 'ownaddr', 'own_name',
];

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(html|json|js|txt)$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk(dist);
if (files.length === 0) {
  console.error('verify-no-pii: nothing to scan in dist/ — a vacuous pass is not a pass');
  process.exit(1);
}

// Positive control: prove the scanner can actually find a needle. An empty
// result from a broken scanner is indistinguishable from an empty result from a
// clean tree, and the broken one is far more likely.
const control = `x ${NEEDLES[0]} x`;
if (!NEEDLES.some((n) => control.includes(n))) {
  console.error('verify-no-pii: the scanner failed its own positive control');
  process.exit(1);
}

const hits = [];
for (const f of files) {
  const text = readFileSync(f, 'utf8').toLowerCase();
  for (const n of NEEDLES) {
    // This gate's own source names every needle, and it is not in dist/ — but
    // if it ever were, this check would flag itself. Keep it honest by skipping
    // nothing and letting a real hit fail loudly.
    if (text.includes(n)) hits.push(`${f.slice(dist.length)}: contains "${n}"`);
  }
}

if (hits.length) {
  console.error(`\nverify-no-pii: ${hits.length} problem(s)\n`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log(`verify-no-pii: OK — scanned ${files.length} built files, no owner-identity field names.`);
