/**
 * Shared plumbing for the gate family.
 *
 * BRDF_ROOT lets verify-controls.mjs point a REAL gate at a scratch tree
 * containing a failing fixture. The gate under test is never a copy — the same
 * bytes that run in CI are the bytes proven to go red.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The repo the gate INSPECTS. Overridable; defaults to this checkout. */
export function inspectRoot() {
  return process.env['BRDF_ROOT'] ? resolve(process.env['BRDF_ROOT']) : resolve(HERE, '..', '..');
}

/** The repo the gate's own CONFIG lives in. Never overridable — a scratch tree
 *  must not be able to hand a gate a more permissive permit list. */
export function selfRoot() {
  return resolve(HERE, '..', '..');
}

export class Gate {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.notes = [];
  }
  info(msg) {
    this.notes.push(msg);
    console.log(`  · ${msg}`);
  }
  fail(msg) {
    this.failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
  ok(msg) {
    console.log(`  ✓ ${msg}`);
  }
  /** Report EVERY failure, then exit. Stopping at the first one hides the rest
   *  in the same run — the masking failure mode. */
  finish() {
    if (this.failures.length > 0) {
      console.error(`\n✗ ${this.name}: ${this.failures.length} failure(s)`);
      process.exitCode = 1;
      return false;
    }
    console.log(`✓ ${this.name}`);
    return true;
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Recursive file walk. Skips the directories that are never ours to police. */
export function walk(dir, { exts = null, skip = ['node_modules', '.git', '.astro'] } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (skip.includes(entry.name)) continue;
      const full = join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        if (exts && !exts.some((e) => entry.name.endsWith(e))) continue;
        out.push(full);
      }
    }
  }
  return out;
}

export function isDir(p) {
  return existsSync(p) && statSync(p).isDirectory();
}
