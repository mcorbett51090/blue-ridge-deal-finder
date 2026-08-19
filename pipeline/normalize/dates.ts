/**
 * ArcGIS date fields — EPOCH MILLISECONDS, and this module is the only place
 * that is allowed to believe it (plan §7 P2: "a dedicated normalizer WITH ITS
 * OWN UNIT TEST, because a string-vs-epoch mistake here silently produces 1970
 * dates").
 *
 * The failure being defended against is specific and quiet: `new Date('1623128400000')`
 * is Invalid Date, and `new Date(Number('2021-06-08'))` is NaN, but
 * `new Date(1623128400)` — the same number read as SECONDS — is 1970-01-19.
 * None of those throw. All of them render. Only the last one renders something
 * that looks like a plausible date, and it is 51 years wrong.
 *
 * control: live page 0 of Watauga, `typeof attributes.saledate` -> 'number',
 *          value 1623128400000 -> '2021-06-08T05:00:00.000Z'. A seconds-based
 *          reading of the same value gives '+53401-11-27', and a string-based
 *          reading gives Invalid Date — so all three interpretations are
 *          distinguishable and the assertions below can fail.
 *
 * ⛔ READ THE COMMENT ON assertEpochUnitsPlausible BEFORE TIGHTENING ANYTHING
 * HERE. The first draft of this file put the unit check per-row and it aborted
 * the first live run on a genuine 1970 deed.
 */
import { sentinelDate, unknown, type Measured } from './sentinel.ts';

/**
 * Milliseconds in the plausible range for a recorded land transaction.
 * A value outside this is a data-quality problem in ONE ROW, not a systematic
 * failure, so it becomes `unknown` — fail-closed — rather than throwing.
 *
 * MEASURED across all 11 NC counties (503,674 rows), 2026-08-19:
 *   sourcedate < 1700-01-01  -> 0 rows
 *   sourcedate > 2100-01-01  -> 1 row  (max is 95755737600000, i.e. year 5004)
 *   CONTROL, same query shape, sourcedate in 2000..2026 -> 227,274 rows
 * Two bad rows in half a million. Throwing on either would have aborted the
 * whole corpus over a typo in a single county record.
 */
const MIN_PLAUSIBLE_MS = Date.UTC(1700, 0, 1);
const MAX_PLAUSIBLE_MS = Date.UTC(2100, 0, 1);

/**
 * ⛔ THE SECONDS-VS-MILLISECONDS CHECK IS A CORPUS-LEVEL CHECK, NOT A PER-ROW ONE.
 *
 * The first version of this module rejected any row whose value was below
 * ~1e11 (1973-03-03) on the theory that such a value must be seconds that were
 * never multiplied. It aborted the very first live Watauga run on
 * `sourcedate=20667600000` — 1970-08-28 — which is a perfectly real deed date.
 *
 * control: `where=cntyname='Watauga' AND sourcedate > timestamp '1970-01-01'
 *          AND sourcedate < timestamp '1973-03-03'` -> {"count":11}
 *          Eleven genuine Watauga deeds live inside the band the guard called
 *          impossible. A per-row rule cannot tell them from a unit slip.
 *
 * What DOES distinguish them: a unit slip is systematic. If upstream started
 * emitting seconds, EVERY value in the county would land in 1970-01-01..1973-03-03,
 * not eleven of them. So the check is on the maximum across the county, where
 * the two hypotheses actually differ.
 */
const SECONDS_MISREAD_CEILING_MS = 1e11;

export class EpochUnitError extends Error {
  constructor(field: string, county: string, maxObserved: number, sampleSize: number) {
    super(
      `[${county}] ${field}: the LARGEST value across ${sampleSize} row(s) is ${maxObserved} ` +
        `(${new Date(maxObserved).toISOString()}), which is below the ${new Date(SECONDS_MISREAD_CEILING_MS).toISOString()} ` +
        'ceiling. A whole county cannot predate 1973; upstream is emitting SECONDS, not milliseconds. ' +
        `Read as seconds the same value is ${new Date(maxObserved * 1000).toISOString()}. Aborting rather than ` +
        'publishing a corpus of 1970 dates.',
    );
    this.name = 'EpochUnitError';
  }
}

/**
 * The ONE conversion. Returns Measured<number> in epoch ms; `unknown` for null,
 * empty, the 1900 and 1753 sentinels, and for a date outside 1700..2100.
 * Never throws — see the corpus-level check below for the failure that should.
 */
export function arcgisEpochDate(raw: unknown, _field = 'date'): Measured<number> {
  const m = sentinelDate(raw);
  if (m.status === 'unknown') return m;
  if (m.value < MIN_PLAUSIBLE_MS || m.value > MAX_PLAUSIBLE_MS) return unknown('implausible-date');
  return m;
}

/**
 * The systematic check, run once per county over the values that parsed. Throws,
 * because a unit change upstream invalidates every row and must stop the run.
 *
 * An EMPTY set is not "plausible" — it is unknown, and saying so out loud is the
 * difference between this and `Math.max()` of nothing being -Infinity, which
 * compares false against every ceiling and reports a clean pass.
 */
export function assertEpochUnitsPlausible(
  values: readonly Measured<number>[],
  field: string,
  county: string,
): void {
  const known = values.filter((v) => v.status === 'known').map((v) => v.value);
  if (known.length === 0) {
    // Every row unknown is a legitimate state for a county where the field is
    // absent entirely (sourcedate is missing in 5 of 11 target counties), so
    // this is reported by the caller, not thrown here.
    return;
  }
  const max = known.reduce((a, b) => (b > a ? b : a), known[0] as number);
  if (max < SECONDS_MISREAD_CEILING_MS) {
    throw new EpochUnitError(field, county, max, known.length);
  }
}

/** Epoch ms -> ISO-8601 date-time string. Never a locale format. */
export function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Epoch ms -> `YYYY-MM-DD` in UTC. What a card renders. */
export function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * §4.4 — `tenure_years = current_year - year(sale_date)`, and `null` on the
 * sentinel. Kept here rather than in redact.ts so the sentinel rule and the
 * arithmetic that depends on it cannot drift apart.
 */
export function tenureYears(saleDate: Measured<number>, now: Date = new Date()): number | null {
  if (saleDate.status !== 'known') return null;
  const years = Math.floor((now.getTime() - saleDate.value) / (365.2425 * 86_400_000));
  return years < 0 ? 0 : years;
}
