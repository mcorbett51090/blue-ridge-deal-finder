#!/usr/bin/env node
/**
 * verify-egress-allowlist.mjs — ONE EGRESS PATH, ENFORCED BY AN ALLOWLIST (RT-11).
 *
 * ⛔ WHY THIS IS NOT A DENYLIST.
 * The version this replaces grepped for eight tokens and missed `node:https`,
 * `https.request`, `ky`, `superagent`, `needle`, `phin`, `request`, dynamic
 * `import()`, `navigator.sendBeacon` and npm lifecycle scripts — and it scanned
 * pipeline/ and scripts/ but NOT site/, where Astro executes arbitrary code at
 * build time. A denylist can only refuse constructs someone has already heard
 * of. This gate instead PERMITS a named set and refuses everything else, so a
 * transport invented tomorrow is refused today.
 *
 * The permit list lives in scripts/egress-permits.json — read from the gate's
 * OWN directory, never from BRDF_ROOT, so a scratch tree cannot hand this gate
 * a more permissive policy than the one in the repo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Gate, inspectRoot, isDir, readJson, selfRoot, walk } from './lib/gate.mjs';

const gate = new Gate('verify-egress-allowlist');
const root = inspectRoot();
const permits = readJson(join(selfRoot(), 'scripts', 'egress-permits.json'));

const SCAN_ROOTS = ['pipeline', 'scripts', 'site'];
const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx', '.astro', '.svelte', '.vue'];

const permitted = new Set(permits.permitted_modules);
const networkModules = new Set(permits.network_modules);
const owner = permits.network_owner;

const RE_STATIC = /(?:^|[\n;])\s*import\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
const RE_EXPORT_FROM = /\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s+)?from\s+['"]([^'"]+)['"]/g;
const RE_REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_DYNAMIC_LITERAL = /(?<![.\w])import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_DYNAMIC_COMPUTED = /(?<![.\w])import\s*\(\s*(?!['"])/g;

/**
 * Comments are PROSE, and prose that describes an attack is not an attack.
 * The first run of this gate flagged its own doc comment for naming
 * navigator.sendBeacon — a grep satisfied by the thing being DESCRIBED. Block
 * comments and line comments are removed before any code check runs; a trailing
 * comment is only stripped when the `//` sits outside quotes and is not part of
 * a `://` scheme, so a URL inside a string survives intact.
 */
function stripComments(src) {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return out
    .split('\n')
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return '';
      let quotes = 0;
      for (let i = 0; i < line.length - 1; i++) {
        const c = line[i];
        if ((c === "'" || c === '"' || c === '`') && line[i - 1] !== '\\') quotes++;
        if (c === '/' && line[i + 1] === '/' && line[i - 1] !== ':' && quotes % 2 === 0) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

/**
 * Astro frontmatter runs at BUILD TIME on our runner; a client <script> block
 * runs in a visitor's browser. Only the first is our crawler. See the
 * _site_policy_why block in scripts/egress-permits.json for the full ruling.
 */
function splitAstro(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return { buildTime: src, clientSide: '' };
  return { buildTime: m[1], clientSide: src.slice(m[0].length) };
}

function specifiers(src, re) {
  const out = [];
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/** 'zod/v4' → 'zod'; '@turf/turf/dist/x' → '@turf/turf'. */
function packageRoot(spec) {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isRelative(spec) {
  return spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~/');
}

let scanned = 0;
const perRoot = {};

for (const scanRoot of SCAN_ROOTS) {
  const dir = join(root, scanRoot);
  if (!isDir(dir)) {
    // ABSENT is reported, never silently counted as clean. An empty scan and a
    // clean scan are indistinguishable after the fact unless one says so.
    gate.info(`scan root ${scanRoot}/ ABSENT — 0 files scanned (not a pass for that tree)`);
    perRoot[scanRoot] = 0;
    continue;
  }
  const files = walk(dir, { exts: CODE_EXTS, skip: ['node_modules', '.git', '.astro', 'dist'] });
  perRoot[scanRoot] = files.length;
  scanned += files.length;

  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const isOwner = rel === owner;
    const src = stripComments(readFileSync(file, 'utf8'));

    const specs = [
      ...specifiers(src, RE_STATIC),
      ...specifiers(src, RE_EXPORT_FROM),
      ...specifiers(src, RE_REQUIRE),
      ...specifiers(src, RE_DYNAMIC_LITERAL),
    ];

    for (const spec of specs) {
      if (isRelative(spec)) continue;
      const pkg = packageRoot(spec);
      if (networkModules.has(spec) || networkModules.has(pkg)) {
        if (!isOwner) gate.fail(`${rel}: imports network module '${spec}' — only ${owner} may`);
        continue;
      }
      if (!permitted.has(spec) && !permitted.has(pkg)) {
        gate.fail(`${rel}: imports '${spec}', which is not on the permit list`);
      }
    }

    // A computed dynamic import cannot be checked statically at all, so it is
    // refused everywhere — including in the owner file.
    RE_DYNAMIC_COMPUTED.lastIndex = 0;
    if (RE_DYNAMIC_COMPUTED.test(src)) {
      gate.fail(
        // NB: this message deliberately avoids writing the construct it names.
        // The first draft flagged itself — the failure message matched the
        // pattern that produced it.
        `${rel}: computed dynamic module import — non-literal specifier, unresolvable at review time`,
      );
    }

    // Network-capable GLOBALS reach the network with no import at all, which is
    // precisely the hole an import-only allowlist would leave open.
    const globals = [...permits.network_globals, ...permits.network_global_calls];
    const isAstro = rel.endsWith('.astro');
    const buildTimeSrc = isAstro ? splitAstro(src).buildTime : src;
    for (const token of globals) {
      if (isOwner) break;
      // Build-time code is our crawler and gets no exemption at all.
      if (buildTimeSrc.includes(token)) {
        gate.fail(
          `${rel}: uses network global '${token}' at BUILD TIME — that request would be ` +
            `our crawler, bypassing ${owner}`,
        );
      } else if (isAstro && src.includes(token) && permits.site_client_script_globals_permitted !== true) {
        gate.fail(`${rel}: uses network global '${token}' — only ${owner} may`);
      }
    }
  }
}

// POSITIVE CONTROL. If the owner file does not exist, or contains no network
// primitive at all, then "only one module opens a socket" is vacuously true and
// this gate is measuring an empty set.
const ownerPath = join(root, owner);
if (!existsSync(ownerPath)) {
  gate.fail(`network owner ${owner} does not exist — the allowlist is asserting over nothing`);
} else {
  const ownerSrc = stripComments(readFileSync(ownerPath, 'utf8'));
  const usesNetwork =
    [...permits.network_globals, ...permits.network_global_calls].some((t) => ownerSrc.includes(t)) ||
    [...networkModules].some((m) => ownerSrc.includes(`'${m}'`) || ownerSrc.includes(`"${m}"`));
  if (!usesNetwork) {
    gate.fail(`${owner} contains no network primitive — positive control failed, gate proves nothing`);
  } else {
    gate.ok(`network owner present and network-capable: ${owner}`);
  }
}

// npm lifecycle scripts execute BEFORE any gate can inspect the tree.
for (const pkgPath of [join(root, 'package.json'), join(root, 'site', 'package.json')]) {
  if (!existsSync(pkgPath)) continue;
  const pkg = readJson(pkgPath);
  for (const name of permits.forbidden_lifecycle_scripts) {
    if (pkg.scripts && Object.hasOwn(pkg.scripts, name)) {
      gate.fail(`${relative(root, pkgPath)}: npm lifecycle script '${name}' runs before any gate`);
    }
  }
}
const npmrc = join(root, '.npmrc');
if (!existsSync(npmrc)) gate.fail('.npmrc missing — ignore-scripts=true is not in force');
else if (!/^\s*ignore-scripts\s*=\s*true\s*$/m.test(readFileSync(npmrc, 'utf8')))
  gate.fail('.npmrc does not set ignore-scripts=true');

gate.info(`scanned ${scanned} source file(s): ${Object.entries(perRoot).map(([k, v]) => `${k}=${v}`).join(' ')}`);
if (perRoot['pipeline'] === 0 || perRoot['scripts'] === 0) {
  gate.fail('pipeline/ or scripts/ yielded zero files — the scan is broken, not the tree clean');
}
gate.finish();
