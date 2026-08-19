/**
 * Formatters. The ONE rule this module exists to enforce:
 *
 *   null is UNKNOWN, and unknown is never rendered as zero.
 *
 * There is no `fmtMoney(v ?? 0)` escape hatch anywhere — the functions take
 * `number | null` and return a discriminated result the templates must branch
 * on, so "$0" and "0 ac" cannot be produced by forgetting a check. The pattern
 * is SWC's graceful absence (claims-D claim 15) made non-optional.
 */

export type Maybe = { known: true; text: string } | { known: false; text: string; why: string };

const UNKNOWN_TEXT = 'unknown';

export function unknown(why: string): Maybe {
  return { known: false, text: UNKNOWN_TEXT, why };
}

export function fmtMoney(v: number | null, why = 'No value published for this parcel.'): Maybe {
  if (v === null || !Number.isFinite(v)) return unknown(why);
  return {
    known: true,
    text: new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: 0,
    }).format(v),
  };
}

export function fmtAcres(v: number | null, why = 'No parcel polygon published for this record.'): Maybe {
  if (v === null || !Number.isFinite(v)) return unknown(why);
  const n = v >= 100 ? v.toFixed(0) : v.toFixed(v < 10 ? 1 : 1);
  return { known: true, text: `${n} ac` };
}

export function fmtPerAcre(value: number | null, acres: number | null): Maybe {
  if (value === null || acres === null || acres <= 0) {
    return unknown('Needs both an assessed value and an acreage; at least one is unknown.');
  }
  return { known: true, text: `${fmtMoney(Math.round(value / acres)).text}/ac` };
}

/** A date the reader can act on. Never "Invalid Date". */
export function fmtDate(iso: string | null): Maybe {
  if (!iso) return unknown('Not recorded.');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return unknown('Unparseable timestamp in the payload.');
  return {
    known: true,
    text: d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
  };
}

export function fmtDateTime(iso: string | null): Maybe {
  if (!iso) return unknown('Not recorded.');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return unknown('Unparseable timestamp in the payload.');
  return {
    known: true,
    text: `${d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}`,
  };
}

export function fmtPercent(v: number | null): Maybe {
  if (v === null || !Number.isFinite(v)) return unknown('Not computed.');
  return { known: true, text: `${Math.round(v * 100)}%` };
}

/** Metres → a distance a human reads. */
export function fmtDistance(m: number | null): Maybe {
  if (m === null || !Number.isFinite(m)) return unknown('No water layer joined for this county.');
  if (m === 0) return { known: true, text: 'on the parcel' };
  if (m < 1000) return { known: true, text: `${Math.round(m)} m away` };
  return { known: true, text: `${(m / 1000).toFixed(1)} km away` };
}
