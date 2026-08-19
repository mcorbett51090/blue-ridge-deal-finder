/**
 * Zero-as-unknown (plan §4.5, RT-3) and the 1900-01-01 date sentinel (§4.6).
 *
 * ⛔ THE UPSTREAM NEVER EMITS NULL. IT EMITS 0.
 * Measured, Watauga: parval IS NULL = 0 but parval = 0 on 797 rows (1.7%);
 * gisacres IS NULL = 0 but gisacres = 0 on 3,326 rows (7.0%). A rule that says
 * "unknown is never scored 0" defends against NULL and never engages, because a
 * present zero looks like a measurement.
 *
 * And the arithmetic puts those rows at the TOP: parval/gisacres = 0 is the
 * cheapest possible value in every percentile bucket. The sampled rows are
 * STATE OF NORTH CAROLINA / GOVERNMENT and HOA "EXCLUSIONS (COMMONE AREAS)" —
 * structurally not purchasable at any price. Extrapolated to NC: ~8,500 rows
 * with parval=0 and ~35,000 with gisacres=0 competing for first place.
 *
 * CONTRACT: unknown is EXCLUDED FROM THE SCORING DENOMINATOR. It is never
 * scored 0, never scored 100, never imputed. It does not compete.
 */

export type Measured<T> =
  | { status: 'known'; value: T }
  | { status: 'unknown'; reason: UnknownReason };

export type UnknownReason =
  | 'zero-sentinel'
  | 'negative'
  | 'null'
  | 'non-numeric'
  | 'date-sentinel'
  | 'empty-string';

/** 1900-01-01T00:00:00Z in epoch ms. `saledate` is epoch MILLISECONDS (§4.9). */
export const DATE_SENTINEL_MS = Date.UTC(1900, 0, 1);

/** `reviseyear` is a STRING holding this. Not a date, not a year. */
export const DATE_SENTINEL_STRINGS: readonly string[] = [
  '1/1/1900 12:00:00 AM',
  '1900-01-01',
  '1900-01-01T00:00:00Z',
  '1900-01-01T00:00:00.000Z',
];

export const known = <T>(value: T): Measured<T> => ({ status: 'known', value });
export const unknown = <T>(reason: UnknownReason): Measured<T> => ({ status: 'unknown', reason });

/**
 * A quantity where zero cannot be a real measurement: assessed value, acreage.
 * `<= 0` is unknown, not cheap.
 */
export function positiveQuantity(raw: unknown): Measured<number> {
  if (raw === null || raw === undefined) return unknown('null');
  if (typeof raw === 'string' && raw.trim() === '') return unknown('empty-string');
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return unknown('non-numeric');
  if (n === 0) return unknown('zero-sentinel');
  if (n < 0) return unknown('negative');
  return known(n);
}

/** Epoch-ms date field. The 1900 sentinel is nulled, never aged. */
export function sentinelDate(raw: unknown): Measured<number> {
  if (raw === null || raw === undefined) return unknown('null');
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t === '') return unknown('empty-string');
    if (DATE_SENTINEL_STRINGS.includes(t)) return unknown('date-sentinel');
    const parsed = Date.parse(t);
    if (!Number.isFinite(parsed)) return unknown('non-numeric');
    return parsed === DATE_SENTINEL_MS ? unknown('date-sentinel') : known(parsed);
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return unknown('non-numeric');
  if (raw === 0) return unknown('zero-sentinel');
  if (raw === DATE_SENTINEL_MS) return unknown('date-sentinel');
  return known(raw);
}

/**
 * ⛔ EVERY DIVISION IS GUARDED. A finite score out of a zero denominator is the
 * exact shape that ranks government land first.
 */
export function safeDivide(numerator: Measured<number>, denominator: Measured<number>): Measured<number> {
  if (numerator.status === 'unknown') return numerator;
  if (denominator.status === 'unknown') return denominator;
  if (denominator.value === 0) return unknown('zero-sentinel');
  const q = numerator.value / denominator.value;
  return Number.isFinite(q) ? known(q) : unknown('non-numeric');
}

/**
 * Split a population into the rows that may be scored and the rows that may not.
 * The percentile denominator is `scored.length` — NOT the row count. Including
 * unknowns in the denominator silently shifts every percentile.
 */
export function partitionForScoring<T>(
  rows: readonly T[],
  select: (row: T) => Measured<number>,
): { scored: { row: T; value: number }[]; excluded: { row: T; reason: UnknownReason }[] } {
  const scored: { row: T; value: number }[] = [];
  const excluded: { row: T; reason: UnknownReason }[] = [];
  for (const row of rows) {
    const m = select(row);
    if (m.status === 'known') scored.push({ row, value: m.value });
    else excluded.push({ row, reason: m.reason });
  }
  return { scored, excluded };
}

/**
 * RT-3 distribution gate. Row counts and schema shape were the only things both
 * input plans gated on; this class of defect lives in the VALUES.
 */
export function zeroValueShare(values: readonly unknown[]): number {
  if (values.length === 0) return 0;
  const zeros = values.filter((v) => positiveQuantity(v).status === 'unknown').length;
  return (zeros / values.length) * 100;
}

export function assertZeroShareWithinBudget(
  county: string,
  values: readonly unknown[],
  maxPct: number,
): void {
  const pct = zeroValueShare(values);
  if (pct > maxPct) {
    throw new Error(
      `[${county}] zero/unknown parval share ${pct.toFixed(2)}% exceeds budget ${maxPct}% — ` +
        'run fails for review (RT-3 distribution gate)',
    );
  }
}
