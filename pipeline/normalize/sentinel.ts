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
  | 'empty-string'
  /** In range for a number but not for a DATE — see arcgisEpochDate. */
  | 'implausible-date';

/**
 * ⛔ THE SENTINEL IS NOT AT UTC MIDNIGHT, AND AN EXACT-EQUALITY CHECK MISSES IT.
 *
 * P1 wrote `raw === Date.UTC(1900,0,1)` (= -2208988800000) offline. P2 measured
 * the live endpoint and the value it actually emits is -2208970800000, i.e.
 * 1900-01-01T05:00:00Z — midnight at UTC-5, the offset this layer stamps every
 * date with. The two differ by 18,000,000 ms and `===` never fires.
 *
 * control: GET .../query?where=cntyname='Ashe' AND sourcedate < timestamp '1901-01-01 00:00:00'
 *          &outFields=objectid,parno,sourcedate,saledate,revisedate,reviseyear
 *          -> HTTP 200, 8 rows sampled, EVERY row sourcedate = -2208970800000
 *             (new Date(-2208970800000).toISOString() === '1900-01-01T05:00:00.000Z')
 *          -> Date.UTC(1900,0,1) === -2208988800000, so -2208970800000 === DATE_SENTINEL_MS
 *             is FALSE on every one of them.
 * positive control, same query shape, proving the probe reads real dates too:
 *          Watauga page 0, saledate 1623128400000 -> '2021-06-08T05:00:00.000Z'
 *          (also :05:00Z — the offset is systematic, not a one-off)
 * negative control, proving the sentinel population is not the whole county:
 *          count(Ashe) = 38,836 total vs 5,958 in the 1900 window — 15.3%, not 100%.
 *
 * Blast radius had this shipped: 5,958 Ashe rows + 648 Mitchell + 402 Jackson +
 * 60 Haywood + 20 Henderson + 4 Watauga = 7,092 rows would have carried a real
 * 1900 deed date, and `current_year - year(date)` would have stamped every one of
 * them `tenure_years: 126`. Which is exactly the failure §4.6 was written to
 * prevent, defeated by an offline guess at a timezone.
 *
 * THE FIX IS A CALENDAR-DAY WINDOW, NOT A WIDER CONSTANT. Upstream county
 * systems do not agree on an offset, so the rule is "midnight 1900-01-01 in ANY
 * timezone": the UTC day before through the UTC day after. A genuine 1899-12-31
 * deed is swallowed by this, which is fail-CLOSED (it becomes `unknown`, never a
 * confident wrong number) and is the direction §4.5 requires.
 */
export const DATE_SENTINEL_MS = Date.UTC(1900, 0, 1);

/** The value MEASURED on the wire, 2026-08-19. Exported so tests assert on the
 *  real number rather than on a recomputation of the same guess. */
export const DATE_SENTINEL_OBSERVED_MS = Date.UTC(1900, 0, 1, 5);

/** Inclusive lower / exclusive upper bound of the "1900-01-01 in any timezone" window. */
export const DATE_SENTINEL_WINDOW_START_MS = Date.UTC(1899, 11, 31);
export const DATE_SENTINEL_WINDOW_END_MS = Date.UTC(1900, 0, 2);

/**
 * ⛔ SECOND SENTINEL, MEASURED AT P2: 1753-01-01, the SQL Server `datetime`
 * floor. It is not in the plan because nobody had looked; the P2 corpus scan
 * found it.
 *
 * control: `where=<11 counties> AND sourcedate >= timestamp '1753-01-01 00:00:00'
 *          AND sourcedate < timestamp '1753-01-02 00:00:00'` -> {"count":1}
 * negative control, same query shape: `sourcedate < timestamp '1700-01-01'`
 *          -> {"count":0}  (so this is a spike AT the floor, not a tail of old deeds)
 * positive control, same query shape: `sourcedate` in 2000..2026 -> {"count":227274}
 *          (the probe can see real data; the two counts above are not an empty scan)
 *
 * One row in 503,674 — negligible in aggregate, and included anyway because a
 * 1753-01-01 land transfer in western North Carolina is not a date, it is a
 * database's idea of "no value", and treating it as a 273-year tenure is the
 * exact failure §4.6 exists to prevent.
 */
export const SQLSERVER_DATE_FLOOR_START_MS = Date.UTC(1752, 11, 31);
export const SQLSERVER_DATE_FLOOR_END_MS = Date.UTC(1753, 0, 2);

/** True when an epoch-ms value lands on a known null-sentinel date in any offset. */
export function isDateSentinel(ms: number): boolean {
  if (ms >= DATE_SENTINEL_WINDOW_START_MS && ms < DATE_SENTINEL_WINDOW_END_MS) return true;
  return ms >= SQLSERVER_DATE_FLOOR_START_MS && ms < SQLSERVER_DATE_FLOOR_END_MS;
}

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
    return isDateSentinel(parsed) ? unknown('date-sentinel') : known(parsed);
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return unknown('non-numeric');
  if (raw === 0) return unknown('zero-sentinel');
  // Window, not equality. See DATE_SENTINEL_OBSERVED_MS above for the measurement.
  if (isDateSentinel(raw)) return unknown('date-sentinel');
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
