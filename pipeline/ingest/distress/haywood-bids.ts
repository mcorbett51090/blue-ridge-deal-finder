/**
 * Haywood County, NC — tax-foreclosure sale notices (CivicEngage Bids module).
 *
 * A DIFFERENT SHAPE FROM JACKSON, and the difference is the point: three NC
 * counties produced three unrelated mechanisms. Jackson publishes a table of
 * properties; Haywood publishes SALE EVENTS.
 *
 * ⛔ THESE NOTICES CANNOT BE JOINED TO A PARCEL, and that is not a shortcoming
 * of this parser. The property identity lives in linked PDFs which are scanned
 * images — measured: 0 `/Font` markers, 3 `/DCTDecode` JPEG streams. There is
 * no text to extract at any price, and OCR is an unbudgeted cost the owner has
 * not agreed to.
 *
 * So these ship as COUNTY-LEVEL notices: real, dated, sourced, and explicitly
 * not attached to any parcel. A notice pinned to a guessed parcel would be a
 * false claim about a specific address; a notice with no parcel is a true claim
 * about a county. Only one of those is publishable.
 *
 * ⛔ SILENT-GREEN TRAP, measured: a bogus `CatID` returns HTTP 200 with a full
 * page — not a 404. Only the `<title>` discriminates:
 *     real  -> "Bid Postings • Tax Foreclosures"
 *     bogus -> "Haywood County, NC • CivicEngage"
 * A parser keyed on status would read a mistyped category as "no sales open".
 */

export type HaywoodNotice = {
  bid_id: string;
  title: string;
  /** The listing page for this notice — a real per-record URL. */
  record_url: string;
  county: string;
  state: 'NC';
};

export class HaywoodParseError extends Error {}

const BASE = 'https://www.haywoodcountync.gov';

/**
 * ⛔ The category title is asserted BEFORE any row is trusted. Zero rows from a
 * page that is not the Tax Foreclosures category means "we asked the wrong
 * question", never "Haywood has no foreclosures".
 */
export function parseHaywoodBids(html: string): HaywoodNotice[] {
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  if (!/tax\s*foreclosure/i.test(title)) {
    throw new HaywoodParseError(
      `Haywood bids page title is "${title}" — expected the Tax Foreclosures category. ` +
        'A bogus CatID returns HTTP 200 with a full page, so an unchecked parse would read ' +
        'a wrong category as "no sales open".',
    );
  }

  const seen = new Set<string>();
  const out: HaywoodNotice[] = [];
  const re = /bidID=(\d+)[^>]*>([^<]{4,120})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const text = m[2]!
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .trim();
    if (text === '') continue;
    out.push({
      bid_id: id,
      title: text,
      record_url: `${BASE}/Bids.aspx?bidID=${id}`,
      county: 'Haywood',
      state: 'NC',
    });
  }
  return out;
}

/**
 * A sale date parsed out of the notice title, when it states one.
 * Returns `null` rather than guessing — an unparsed date is unknown, and a
 * wrong date on a foreclosure sale is worse than no date.
 */
export function saleDateOf(title: string): string | null {
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i.exec(title);
  if (!m) return null;
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const mi = months.indexOf(m[1]!.toLowerCase());
  if (mi < 0) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}
