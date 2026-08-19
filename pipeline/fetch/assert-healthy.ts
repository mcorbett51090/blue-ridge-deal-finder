/**
 * Health assertion — NEVER HTTP status (plan §4.2, E7.4/E7.5, RT-1).
 *
 * ⛔ THIS FILE EXISTS BECAUSE OF A MEASURED SILENT GREEN.
 * A nonexistent service under /secure/ answers HTTP 200 with a 62-byte body
 * `{"error":{"code":499,"message":"Token Required"}}`. A query-level failure
 * answers HTTP 200 with `{"error":{"code":400,...}}`. Neither body has a
 * `features` key — so the row-floor check that was supposed to catch a total
 * outage degrades to `undefined < 45000`, which is **false**, and the gate
 * reports PASS on an outage. The floor check was the control, and the control
 * was the bug.
 *
 * The fix is ordering: assert POSITIVE SHAPE before any threshold. Every check
 * below asks "is the thing I need present and of the right kind", never "is a
 * number I may not have below a limit".
 */

export class HealthAssertionError extends Error {
  readonly sourceId: string;
  readonly check: string;
  constructor(sourceId: string, check: string, detail: string) {
    super(`[${sourceId}] health assertion failed (${check}): ${detail}`);
    this.name = 'HealthAssertionError';
    this.sourceId = sourceId;
    this.check = check;
  }
}

export type HealthExpectation = {
  /** Static per-county floor from sources.yaml `expect.per_county_min_rows`. */
  minRows: number;
  /** True when the caller is paging and will follow `exceededTransferLimit`. */
  paging?: boolean;
  /** Trailing median row count, when one exists. Moving floor on top of the static one. */
  rollingMedian?: number | undefined;
  /** `expect.rolling_median_floor_pct` as a fraction, default 0.5. */
  rollingMedianFloorPct?: number | undefined;
};

/**
 * Throws unless `body` is a healthy ArcGIS query response for `expect`.
 * ORDER MATTERS and is asserted by tests/assert-healthy.test.mjs.
 */
export function assertHealthy(body: unknown, expect: HealthExpectation, sourceId: string): void {
  const fail = (check: string, detail: string): never => {
    throw new HealthAssertionError(sourceId, check, detail);
  };

  // 1. Shape of the envelope itself. `null` is typeof 'object'; check it first.
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return void fail('non-object-body', `got ${body === null ? 'null' : typeof body}`);
  }
  const obj = body as Record<string, unknown>;

  // 2. In-band error, BEFORE anything else is read and REGARDLESS of HTTP status.
  //    This is the check whose absence produced the `undefined < 45000` pass.
  if ('error' in obj) {
    return void fail('in-band-error', JSON.stringify(obj['error']));
  }

  // 3. Positive shape. Not "features is not short" — "features EXISTS and is an array".
  const features = obj['features'];
  if (!Array.isArray(features)) {
    return void fail(
      'no-features-array',
      `positive shape absent; keys present: ${JSON.stringify(Object.keys(obj))}`,
    );
  }

  // 4. Only now is a numeric comparison safe, because `n` is provably a number.
  const n = features.length;
  if (n < expect.minRows) {
    return void fail('row-floor', `${n} < ${expect.minRows}`);
  }

  // 5. Truncation. A silently truncated page is a partial corpus that every
  //    downstream count-based gate reads as merely "smaller".
  if (obj['exceededTransferLimit'] === true && expect.paging !== true) {
    return void fail('transfer-limit', 'exceededTransferLimit=true and caller is not paging');
  }

  // 6. Moving floor. Catches the slow drift a static floor never sees.
  if (typeof expect.rollingMedian === 'number' && expect.rollingMedian > 0) {
    const pct = expect.rollingMedianFloorPct ?? 0.5;
    const floor = expect.rollingMedian * pct;
    if (n < floor) {
      return void fail('rolling-median', `${n} < ${floor} (${pct * 100}% of trailing median)`);
    }
  }
}

/**
 * RT-1 fix #3 — the per-batch control block.
 * A batch whose positive control does not return its expected count is a FAILED
 * run, not a clean one. The negative control must ALSO be right: if both return
 * the same body, the endpoint is answering a constant and the positive control
 * passing means nothing.
 */
export function assertControlBlock(
  observed: { positiveCount: unknown; negativeCount: unknown },
  expected: { positiveCount: number; negativeCount: number },
  sourceId: string,
): void {
  const fail = (check: string, detail: string): never => {
    throw new HealthAssertionError(sourceId, check, detail);
  };

  // `undefined !== 47388` is true, so a missing count fails — but say so
  // explicitly rather than relying on that, because the same reflex is what
  // produced the `undefined < 45000` bug two checks up.
  if (typeof observed.positiveCount !== 'number') {
    return void fail('control-positive-shape', `count absent (${typeof observed.positiveCount})`);
  }
  if (typeof observed.negativeCount !== 'number') {
    return void fail('control-negative-shape', `count absent (${typeof observed.negativeCount})`);
  }
  if (observed.positiveCount !== expected.positiveCount) {
    return void fail(
      'control-positive',
      `expected ${expected.positiveCount}, got ${observed.positiveCount}`,
    );
  }
  if (observed.negativeCount !== expected.negativeCount) {
    return void fail(
      'control-negative',
      `expected ${expected.negativeCount}, got ${observed.negativeCount}`,
    );
  }
  if (observed.positiveCount === observed.negativeCount) {
    return void fail('control-indistinguishable', 'positive and negative controls agree');
  }
}
