/**
 * Staging — raw ArcGIS attributes to the normalized parcel record.
 *
 * ⛔ THE REDACTION BOUNDARY IS IN THIS FILE, AND IT SITS BETWEEN THE HEALTH
 * ASSERT AND THE TIER-0 WRITE (plan §4.4, D1 binding). `stageRow()` is the only
 * function that ever sees an owner name, it derives three booleans from it, and
 * it returns a record whose TYPE has no field a name could travel in. There is
 * no code path from a live page to a stored tier that does not pass through here.
 *
 * Order, and every step is load-bearing:
 *   1. redact()        — derive owner facts, strip PII, assert none survived
 *   2. sentinel rules  — 0 is UNKNOWN, not cheap; the 1900 date is nulled
 *   3. basis allowlist — fail-closed; 'ASSESSED' and 'Assessed' are one thing
 *   4. sourcedate -> deed_date — a RENAME, because it is the deed date and
 *      printing it as assessment vintage is a wrong number with an
 *      authoritative label (E8.1: it equals saledate on 1000 of 1000 rows)
 *   5. vintage join    — assessment_year comes from NCDOR, keyed by fips
 */
import { createHash } from 'node:crypto';
import { arcgisEpochDate, assertEpochUnitsPlausible, tenureYears } from '../normalize/dates.ts';
import { assignKeys, type AssignKeysResult } from '../normalize/keys.ts';
import { valueBasisFrom } from '../normalize/parcels.ts';
import { redact } from '../normalize/redact.ts';
import { positiveQuantity, type Measured } from '../normalize/sentinel.ts';
import { assessmentYearFor, type VintageTable } from '../normalize/vintage.ts';

/** Flattened Measured<number> — SQLite has no discriminated unions. */
export type MeasuredColumns = { value: number | null; unknown_reason: string | null };

export function flatten(m: Measured<number>): MeasuredColumns {
  return m.status === 'known'
    ? { value: m.value, unknown_reason: null }
    : { value: null, unknown_reason: m.reason };
}

export type StagedParcel = {
  record_id: string;
  fips: string;
  state: string;
  county: string;
  parno: string;
  part_seq: number;
  part_count: number;

  acreage: number | null;
  acreage_unknown_reason: string | null;
  acreage_basis: 'gis' | 'deeded' | 'unknown';

  value: number | null;
  value_unknown_reason: string | null;
  value_basis: 'market_equivalent' | 'net_of_exemptions' | 'unknown';
  value_basis_raw: string;

  /** §4.6 — RENAMED from `sourcedate`. Epoch ms, or null on the 1900 sentinel. */
  deed_date: number | null;
  deed_date_unknown_reason: string | null;
  sale_date: number | null;
  sale_date_unknown_reason: string | null;

  assessment_year: number | null;

  owner_out_of_state: number | null;
  owner_is_entity: number | null;
  owner_is_government: number;
  tenure_years: number | null;

  parusedesc: string;
  /** '' on vacant land — kept as evidence of vacancy, never geocoded from. */
  siteadd: string;

  lat: number | null;
  lng: number | null;
  bbox: string | null;
  geometry_hash: string | null;
};

export type StageContext = {
  state: string;
  county: string;
  vintage: VintageTable;
  now: Date;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v);
}

/**
 * The attribute hash that decides "exact duplicate" vs "multi-part parcel".
 * It covers the SCORED attributes only. Including `objectid` would make every
 * duplicate row unique and collapse nothing; including the owner block would
 * make a mailing-address correction look like a new polygon.
 */
export function attributeHash(attrs: Record<string, unknown>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        attrs['parval'], attrs['gisacres'], attrs['parvaltype'],
        attrs['saledate'], attrs['sourcedate'], attrs['parusedesc'], attrs['siteadd'],
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}

/**
 * One raw attribute bag -> one staged parcel. `partSeq`/`partCount` come from
 * the keying pass, which needs the whole county to see multi-part parcels.
 */
export function stageRow(
  attrs: Record<string, unknown>,
  recordId: string,
  parno: string,
  partSeq: number,
  partCount: number,
  ctx: StageContext,
): StagedParcel {
  // ── 1. THE REDACTION BOUNDARY ───────────────────────────────────────────
  // Everything after this line is name-free by construction: `derived` holds
  // booleans, `safe` has had the PII keys removed, and redact() throws if any
  // survived. `attrs` itself is not referenced again.
  const { safe, derived } = redact(attrs, ctx.state, ctx.now);
  const a = safe as Record<string, unknown>;

  // ── 2. sentinels — the upstream emits 0, never NULL (RT-3) ──────────────
  const acreage = positiveQuantity(a['gisacres']);
  const value = positiveQuantity(a['parval']);

  // ── 3./4. dates. `sourcedate` becomes `deed_date`, here and nowhere else. ─
  const deedDate = arcgisEpochDate(a['sourcedate'], 'sourcedate');
  const saleDate = arcgisEpochDate(a['saledate'], 'saledate');

  const fips = str(a['stcntyfips']);
  const county = str(a['cntyname']) || ctx.county;

  const acreageCols = flatten(acreage);
  const valueCols = flatten(value);
  const deedCols = flatten(deedDate);
  const saleCols = flatten(saleDate);

  return {
    record_id: recordId,
    fips,
    state: ctx.state,
    county,
    parno,
    part_seq: partSeq,
    part_count: partCount,

    acreage: acreageCols.value,
    acreage_unknown_reason: acreageCols.unknown_reason,
    // §4.7 (RT-9) — NC `gisacres` is PLANIMETRIC polygon area, never deeded.
    // Carried as a field, rendered as a badge, never silently ranked across.
    acreage_basis: acreage.status === 'known' ? 'gis' : 'unknown',

    value: valueCols.value,
    value_unknown_reason: valueCols.unknown_reason,
    value_basis: valueBasisFrom(a['parvaltype']),
    value_basis_raw: str(a['parvaltype']),

    deed_date: deedCols.value,
    deed_date_unknown_reason: deedCols.unknown_reason,
    sale_date: saleCols.value,
    sale_date_unknown_reason: saleCols.unknown_reason,

    // ── 5. vintage. NOT from the parcel layer — it is not in it. ───────────
    assessment_year: assessmentYearFor(ctx.vintage, fips, county),

    owner_out_of_state: derived.owner_out_of_state === null ? null : derived.owner_out_of_state ? 1 : 0,
    owner_is_entity: derived.owner_is_entity === null ? null : derived.owner_is_entity ? 1 : 0,
    owner_is_government: derived.owner_is_government ? 1 : 0,
    tenure_years: tenureYears(saleDate, ctx.now),

    parusedesc: str(a['parusedesc']),
    siteadd: str(a['siteadd']),

    lat: null,
    lng: null,
    bbox: null,
    geometry_hash: null,
  };
}

export type StagedCounty = {
  county: string;
  rows: StagedParcel[];
  unkeyed: { reason: string; parno: string; fips: string }[];
  collapsedExactDuplicates: number;
  multiPartParnos: string[];
  /** Every distinct record_id the fetch produced. Acceptance 2's left-hand side. */
  distinctKeys: Set<string>;
  fetchedRows: number;
};

/**
 * Key and stage a whole county. Keying needs the full county in hand because a
 * multi-part parcel is only visible across rows, and §4.3 forbids the
 * overwrite that a streaming key would do: a 40-acre tract recorded as 28 + 12
 * must not become a 12-acre tract.
 */
export function stageCounty(rawRows: readonly Record<string, unknown>[], ctx: StageContext): StagedCounty {
  const keyed: AssignKeysResult<Record<string, unknown>> = assignKeys({
    rows: rawRows,
    getParno: (r) => r['parno'],
    getFips: (r) => r['stcntyfips'],
    getAttributeHash: (r) => attributeHash(r),
  });

  // part_count per (fips, parno) group — SUM/aggregate happens downstream at
  // scoring; what matters here is that both parts SURVIVE and are labelled.
  const partCounts = new Map<string, number>();
  for (const k of keyed.keyed) {
    const group = k.record_id.slice(0, k.record_id.lastIndexOf(':'));
    partCounts.set(group, (partCounts.get(group) ?? 0) + 1);
  }

  const rows = keyed.keyed.map((k) => {
    const group = k.record_id.slice(0, k.record_id.lastIndexOf(':'));
    return stageRow(k.row, k.record_id, k.parno, k.part_seq, partCounts.get(group) ?? 1, ctx);
  });

  // The seconds-vs-milliseconds check, at the level where a unit slip actually
  // shows up. Per row it is indistinguishable from a genuine 1970s deed — 11 of
  // which exist in Watauga alone.
  for (const field of ['deed_date', 'sale_date'] as const) {
    assertEpochUnitsPlausible(
      rows.map((r) =>
        r[field] === null
          ? ({ status: 'unknown', reason: 'null' } as const)
          : ({ status: 'known', value: r[field] } as const),
      ),
      field,
      ctx.county,
    );
  }

  return {
    county: ctx.county,
    rows,
    unkeyed: keyed.unkeyed.map((u) => ({
      reason: u.reason,
      parno: str(u.row['parno']),
      fips: str(u.row['stcntyfips']),
    })),
    collapsedExactDuplicates: keyed.collapsedExactDuplicates,
    multiPartParnos: keyed.multiPartParnos,
    distinctKeys: new Set(rows.map((r) => r.record_id)),
    fetchedRows: rawRows.length,
  };
}

/**
 * ACCEPTANCE 2 — `COUNT(DISTINCT key)` fetched == `COUNT(*)` warehoused, per
 * county. This is the test that discriminates where a ±2% corpus tolerance does
 * not: a 2.4% single-county key collapse sits comfortably inside ±2% of the
 * corpus, and the "second run appends zero events" idempotence proof passes
 * under a correct key AND a wrong one.
 */
export function assertCountsReconcile(
  county: string,
  distinctKeysFetched: number,
  rowsWarehoused: number,
): void {
  if (distinctKeysFetched === 0) {
    throw new Error(`[${county}] reconciliation asserted over ZERO keys — an empty set always reconciles`);
  }
  if (distinctKeysFetched !== rowsWarehoused) {
    throw new Error(
      `[${county}] KEY COLLAPSE: ${distinctKeysFetched} distinct key(s) fetched but ` +
        `${rowsWarehoused} row(s) warehoused (delta ${rowsWarehoused - distinctKeysFetched}). ` +
        'Rows were merged or dropped by the key contract.',
    );
  }
}
