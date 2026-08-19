/**
 * Jackson County, NC — "County Properties Acquired Through Foreclosure".
 *
 * The single richest distress source measured anywhere in this project: real
 * county-owned properties, actually purchasable, each with a PIN that joins
 * EXACTLY to our parcel corpus (verified: 6 of 6 sampled PINs matched a Jackson
 * parcel, 1 row each).
 *
 * Row shape in the PDF, per property:
 *   PIN  $assessed  Owner,Name LegalDescription  price.00 $ interest $ M/YYYY
 *   7662-23-2593 $27,270 Bush,Bonnie Lt12HickoryRidge 9,500.00 $103.59 $ 6/2024
 *
 * ⛔ THE OWNER-NAME SEGMENT IS NEVER EXTRACTED.
 *
 * Owner name and legal description are fused in one run of text with no reliable
 * separator, so any parser that reached for the description would carry the name
 * with it. Rather than extract-then-redact — which leaves the name in memory, in
 * a variable, one careless log line from disk — the regex below skips that span
 * entirely with a non-capturing `.*?`. There is no variable holding it at any
 * point.
 *
 * Nothing is lost. The PIN joins to our own parcel record, which already has the
 * address, acreage, assessed value and use code. The PDF is needed for exactly
 * three facts the county knows and we do not: that the property is FOR SALE, what
 * is OWED on it, and SINCE WHEN.
 */
import { flatten, hasTextLayer } from './pdf-text.ts';

export type JacksonReo = {
  /** Joins to `parcels.parno` for fips 37099. */
  pin: string;
  /** County-assessed value as printed in the document. */
  assessed_usd: number | null;
  /** What is owed — the number that makes this actionable. */
  price_owed_usd: number | null;
  interest_usd: number | null;
  /** Month the county acquired it, as `YYYY-MM`. */
  acquired: string | null;
};

export class DistressParseError extends Error {}

const money = (s: string): number | null => {
  const t = s.replace(/[$,]/g, '');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * ⛔ An EMPTY result is only legitimate when the document genuinely lists
 * nothing. A scanned PDF, a moved URL, or a redesign all produce zero rows too,
 * and "no foreclosures in Jackson County" is a very different claim from "we
 * could not read the file". This throws on an unreadable document rather than
 * returning [] and letting a caller record a false absence.
 */
export function parseJacksonReo(pdf: Buffer): JacksonReo[] {
  if (!hasTextLayer(pdf)) {
    throw new DistressParseError(
      'Jackson REO PDF has no text layer (0 /Font markers) — it has become a scanned image. ' +
        'That is unreadable, NOT an empty list, and must not be recorded as zero properties.',
    );
  }
  const flat = flatten(pdf);
  if (flat.length < 40) {
    throw new DistressParseError(`Jackson REO PDF yielded ${flat.length} chars of text — too short to be the table`);
  }

  // ⛔ SEGMENT-WISE, not one global regex. The first attempt used a single
  // pattern requiring price + interest + date, and SILENTLY PARSED 5 OF 8
  // PROPERTIES: three Bel-Aire Estates parcels the county has held since 1/2012
  // carry no price and no interest, just an acquisition date. A greedy `.*?`
  // ran straight past them into the next record, and the only reason the loss
  // was noticed is that the PIN count was checked against the row count.
  //
  // So: find the PINs first, slice each record between them, parse within the
  // slice, and assert the two counts agree at the end.
  const pinRe = /\d{4}-\d{2}-\d{4}/g;
  const starts: number[] = [];
  let pm: RegExpExecArray | null;
  while ((pm = pinRe.exec(flat)) !== null) starts.push(pm.index);

  const rows: JacksonReo[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const seg = flat.slice(starts[i]!, starts[i + 1] ?? flat.length);
    const pin = seg.slice(0, 12);

    // Assessed value: the first $amount after the PIN.
    const assessed = /^\S{12}\$([\d,]+)/.exec(seg)?.[1] ?? null;

    // Acquisition month is the LAST M/YYYY in the segment — the only field
    // every row has. Anchoring on it rather than on price is what makes the
    // no-price rows parse at all.
    const dates = [...seg.matchAll(/(\d{1,2})\/(\d{4})/g)];
    const last = dates[dates.length - 1];

    // Price owed and interest are OPTIONAL: present on recent acquisitions,
    // absent on the 2012 ones. Absent means unknown, never 0 — a $0 owed would
    // read as "free" on a card.
    const priced = /([\d,]+\.\d{2})\$([\d,.]+|-)\$/.exec(seg);

    rows.push({
      pin,
      assessed_usd: assessed === null ? null : money(assessed),
      price_owed_usd: priced ? money(priced[1]!) : null,
      interest_usd: priced ? money(priced[2]!) : null,
      acquired: last ? `${last[2]}-${String(Number(last[1])).padStart(2, '0')}` : null,
    });
  }

  // ⛔ THE CONTROL. Every PIN in the document must produce a row. Without this
  // the parser above would have shipped 5 of 8 properties and reported success.
  if (rows.length !== starts.length) {
    throw new DistressParseError(
      `Jackson REO: found ${starts.length} PINs but parsed ${rows.length} rows — ` +
        'the table layout has changed and properties are being dropped silently.',
    );
  }

  if (rows.length === 0) {
    throw new DistressParseError(
      'Jackson REO PDF has a text layer but matched zero property rows — the table layout has ' +
        'changed. Failing loudly rather than publishing "no distressed properties in Jackson County".',
    );
  }
  return rows;
}
