/**
 * Tier 0 — raw-redacted snapshots, content-addressed AT ROW GRANULARITY.
 *
 * ⛔ WHY ROWS AND NOT PAGES (RT-4 point 3). Page-granularity content addressing
 * is O(pages x runs), not O(changes): one changed parcel changes the sha256 of a
 * whole 5,000-row page blob, and NC alone is ~101 pages per run. The storage
 * then grows with TIME while the design claims it grows with CHANGE. Hashing
 * rows makes the claim true — a run that changes nothing emits nothing.
 *
 * ⛔ "RAW" HERE MEANS RAW-MINUS-PII, AND THAT IS NOT AN ARCHIVE OF UPSTREAM.
 * The redaction boundary runs BEFORE this writer, so a future feature that needs
 * an owner name cannot be served from the archive and must re-fetch. That is the
 * accepted cost of D1 (§2.3), stated here because this is the file where someone
 * would otherwise assume byte-fidelity.
 *
 * Snapshots are IMMUTABLE. A backfill writes a NEW dated file; it never
 * overwrites a past date's.
 */
import { createGzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { assertNoPii } from '../normalize/redact.ts';
import type { StagedParcel } from '../ingest/stage.ts';

export type RowIndex = { hashes: Set<string> };

/** The stable per-row digest. Same inputs as the warehouse content hash. */
export function rowHash(row: StagedParcel): string {
  return createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0, 24);
}

/** Previously-emitted row hashes, so only genuinely new rows are written. */
export function loadRowIndex(dir: string): RowIndex {
  const path = join(dir, 'row-index.txt');
  if (!existsSync(path)) return { hashes: new Set() };
  return { hashes: new Set(readFileSync(path, 'utf8').split('\n').filter(Boolean)) };
}

export function saveRowIndex(dir: string, index: RowIndex): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'row-index.txt'), `${[...index.hashes].join('\n')}\n`);
}

export type Tier0Result = { file: string | null; newRows: number; sha256: string | null; bytes: number };

/**
 * Write the rows whose hash is new. Returns `file: null` when there are none —
 * which is the correct outcome of an unchanged re-run and is what makes
 * "a second run writes zero rows" a property of the design rather than a
 * coincidence of the data.
 */
export async function writeTier0Snapshot(
  dir: string,
  runId: string,
  rows: Iterable<StagedParcel>,
  index: RowIndex,
): Promise<Tier0Result> {
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  const fresh: string[] = [];

  for (const row of rows) {
    // Belt and braces at the boundary itself, per row, independent of the
    // surface scan in verify-no-pii.mjs — the surface scan is the one that has
    // already been observed reading green while names shipped.
    assertNoPii(row as unknown as Record<string, unknown>, 'tier0');
    const h = rowHash(row);
    if (index.hashes.has(h)) continue;
    fresh.push(h);
    lines.push(JSON.stringify({ h, ...row }));
  }

  if (lines.length === 0) return { file: null, newRows: 0, sha256: null, bytes: 0 };

  const name = `rows-${runId}.ndjson.gz`;
  const path = join(dir, name);
  const body = `${lines.join('\n')}\n`;
  await pipeline(Readable.from([body]), createGzip(), createWriteStream(path));

  for (const h of fresh) index.hashes.add(h);
  saveRowIndex(dir, index);

  const bytes = readFileSync(path);
  return {
    file: name,
    newRows: lines.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  };
}
