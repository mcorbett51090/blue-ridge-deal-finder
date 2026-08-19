#!/usr/bin/env node
/**
 * POSTBUILD GATE, against the BUILT dist/.
 *
 * The sitewide noindex claim lives in exactly one template, which makes it one
 * careless prop away from being false on some page nobody re-checked. Assert it
 * on the artifact that actually ships, not on the source that was supposed to
 * produce it.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
if (!existsSync(dist)) {
  console.error('verify-noindex: dist/ does not exist — did the build run?');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.html')) out.push(p);
  }
  return out;
}

const pages = walk(dist);
if (pages.length === 0) {
  console.error('verify-noindex: dist/ contains no HTML — a vacuous pass is not a pass');
  process.exit(1);
}

const bad = [];
for (const p of pages) {
  const html = readFileSync(p, 'utf8');
  if (!/<meta\s+name="robots"\s+content="noindex,\s*nofollow"/i.test(html)) {
    bad.push(`${p.slice(dist.length)}: missing robots noindex,nofollow`);
  }
}

const robots = join(dist, 'robots.txt');
if (!existsSync(robots)) bad.push('robots.txt missing from dist/');
else if (!/^\s*Disallow:\s*\/\s*$/m.test(readFileSync(robots, 'utf8'))) {
  bad.push('robots.txt does not Disallow: /');
}

if (bad.length) {
  console.error(`\nverify-noindex: ${bad.length} problem(s)\n`);
  for (const b of bad) console.error('  ' + b);
  process.exit(1);
}
console.log(`verify-noindex: OK — ${pages.length} pages all carry noindex,nofollow; robots.txt disallows all.`);
