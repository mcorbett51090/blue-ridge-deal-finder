/**
 * Keys — `parno` is not unique and is empty on 518 rows (plan §4.3, RT-2).
 *
 * Measured, Watauga, one county:
 *   rows 47,388 · DISTINCT parno 46,253 → 1,135 duplicate rows (2.4%)
 *   parno = ''   518        parno IS NULL   0
 *   gisacres > 20 band (1,985 rows): 1,798 distinct parno → 9.4% duplicated
 *
 * ⛔ THE DUPLICATION IS WORST EXACTLY ON THE BIG TRACTS THIS TOOL EXISTS TO FIND.
 * And no acceptance test notices: a ±2% corpus tolerance absorbs a 2.4% collapse,
 * and "a second run appends zero events" passes under a correct key AND a wrong
 * one, because identical rows hash identically. The idempotence proof is
 * insensitive to the property it appears to prove.
 *
 * ⛔ NEVER `objectid`. ArcGIS OBJECTIDs are server-assigned and reassigned on
 * republish; one routine republish changes every record_id and appends 503,674
 * "new parcel" events to a git-tracked log in a single run.
 */

export type UnkeyedReason = 'empty-parno' | 'null-parno' | 'missing-fips';

export type KeyedRow<T> = { record_id: string; parno: string; part_seq: number; row: T };
export type UnkeyedRow<T> = { reason: UnkeyedReason; row: T };

/** Upper-cased, whitespace- and separator-stripped. Applied to BOTH sides always. */
export function normalizeParno(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function buildRecordId(stcntyfips: string, parno: string, partSeq: number): string {
  return `${stcntyfips}:${normalizeParno(parno)}:${partSeq}`;
}

/**
 * ⛔ `parno` is the EMPTY STRING, never null, on the 518 unkeyed rows — so
 * `if (id === null)` does not catch it. Same shape as `siteadd` (E2.6). This
 * check is `=== ''` on the NORMALISED value on purpose.
 */
export function isUnkeyed(parno: unknown): UnkeyedReason | null {
  if (parno === null || parno === undefined) return 'null-parno';
  if (normalizeParno(parno) === '') return 'empty-parno';
  return null;
}

export type AssignKeysInput<T> = {
  rows: readonly T[];
  getParno: (row: T) => unknown;
  getFips: (row: T) => unknown;
  /** Stable hash of the row's scored attributes — identifies exact duplicates. */
  getAttributeHash: (row: T) => string;
};

export type AssignKeysResult<T> = {
  keyed: KeyedRow<T>[];
  /** Quarantined, COUNTED and displayed on /status/. Never silently merged. */
  unkeyed: UnkeyedRow<T>[];
  /** Identical attribute hash under one parno — collapsed, count surfaced. */
  collapsedExactDuplicates: number;
  /** parno values with >1 distinct attribute hash → multi-part parcels. */
  multiPartParnos: string[];
};

/**
 * Assigns `record_id = ${fips}:${normalize(parno)}:${part_seq}`.
 *
 * Exact-duplicate rows collapse. Rows that DIFFER under one parno are a
 * multi-part parcel: they each get their own part_seq and the caller must
 * aggregate acreage across parts and set part_count > 1. NEVER OVERWRITE — a
 * 40-acre tract recorded as 28 + 12 must not become a 12-acre tract, which is
 * direct corruption of the primary signal.
 */
export function assignKeys<T>(input: AssignKeysInput<T>): AssignKeysResult<T> {
  const { rows, getParno, getFips, getAttributeHash } = input;
  const keyed: KeyedRow<T>[] = [];
  const unkeyed: UnkeyedRow<T>[] = [];
  const seenHashes = new Map<string, Set<string>>();
  let collapsedExactDuplicates = 0;

  for (const row of rows) {
    const parnoRaw = getParno(row);
    const reason = isUnkeyed(parnoRaw);
    if (reason) {
      unkeyed.push({ reason, row });
      continue;
    }
    const fips = getFips(row);
    if (typeof fips !== 'string' || fips.trim() === '') {
      unkeyed.push({ reason: 'missing-fips', row });
      continue;
    }
    const parno = normalizeParno(parnoRaw);
    const groupKey = `${fips}:${parno}`;
    const hash = getAttributeHash(row);
    const hashes = seenHashes.get(groupKey) ?? new Set<string>();
    if (hashes.has(hash)) {
      collapsedExactDuplicates++;
      continue;
    }
    hashes.add(hash);
    seenHashes.set(groupKey, hashes);
    keyed.push({ record_id: `${groupKey}:${hashes.size - 1}`, parno, part_seq: hashes.size - 1, row });
  }

  const multiPartParnos = [...seenHashes.entries()]
    .filter(([, hashes]) => hashes.size > 1)
    .map(([groupKey]) => groupKey);

  return { keyed, unkeyed, collapsedExactDuplicates, multiPartParnos };
}

/**
 * Ingest-time uniqueness assertion. The property that must hold is
 * `COUNT(DISTINCT record_id) === COUNT(*)`, checked on the WAREHOUSED rows —
 * checking it on the fetched rows keyed by parno is the check that passes while
 * 1,135 rows silently collapse.
 */
export function assertUniqueRecordIds(recordIds: readonly string[]): void {
  const seen = new Set<string>();
  const collisions: string[] = [];
  for (const id of recordIds) {
    if (seen.has(id)) collisions.push(id);
    seen.add(id);
  }
  if (collisions.length > 0) {
    throw new Error(
      `key collision: ${collisions.length} duplicate record_id(s) of ${recordIds.length} rows ` +
        `(first: ${collisions.slice(0, 3).join(', ')})`,
    );
  }
}

/**
 * OBJECTID-envelope guard (§4.3). A mid-run republish reassigns OBJECTIDs and
 * skews `resultOffset` pagination silently — every page after the republish is
 * drawn from a different ordering. Abort the run; do not stitch the pages.
 */
export function assertObjectIdEnvelopeStable(
  first: { min: number; max: number },
  latest: { min: number; max: number },
): void {
  if (first.min !== latest.min || first.max !== latest.max) {
    throw new Error(
      `OBJECTID envelope shifted mid-run (${first.min}..${first.max} → ${latest.min}..${latest.max}) ` +
        '— upstream republished; aborting rather than stitching skewed pages',
    );
  }
}
