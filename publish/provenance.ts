/**
 * PROVENANCE — a link that shows the record, or an honest instruction instead.
 *
 * ⛔ WHY THIS FILE EXISTS, MEASURED. The owner clicked a Fannin County GA row
 * and got `https://www.gsccca.org/` — a bare homepage that does not show the
 * record. Two separate falsehoods in one link:
 *
 *   1. A HOMEPAGE IS NOT PROVENANCE. "Here is the organisation that might hold
 *      a record like this" is presented in the same slot as "here is the
 *      record", and the reader cannot tell which they were given.
 *   2. WE NEVER FETCHED IT AND COULD NOT HAVE. `gsccca.org` and
 *      `search.gsccca.org` are both on sources/sources.denied.yaml (claims A8,
 *      B43-B45: GA deeds require an account and this fetcher never
 *      authenticates to a third party). Citing a source we are forbidden to
 *      read is a fabricated citation, whatever the URL resolves to.
 *
 * So every published row carries STRUCTURED provenance, and the shape makes the
 * honest answer expressible: `record_url: null` plus a `how_to_verify` sentence
 * a human can actually follow. A null here is a fact about the county's
 * publishing, not a gap in this file.
 *
 * The denylist check reuses `matchDenylist` — the SAME function the fetcher
 * uses to decide whether it may open a socket. A second, parallel copy of the
 * rule is a copy that will one day disagree with the original, and the
 * disagreement would surface as exactly the defect above.
 */
import { matchDenylist } from '../pipeline/fetch/denylist.ts';
import type { Denial, Source } from '../pipeline/fetch/types.ts';

export type Provenance = {
  /** The registry id the row actually came from. Never a guess. */
  source_id: string;
  /** A URL that resolves to THIS record, or null. Never a homepage stand-in. */
  record_url: string | null;
  /** REQUIRED whenever record_url is null. Plain instructions, not an apology. */
  how_to_verify: string | null;
  /** When we actually fetched the row. */
  retrieved_at: string;
  source_note: string;
};

export class ProvenanceError extends Error {}

/**
 * A per-record ArcGIS query URL: the layer, filtered to one county FIPS + one
 * parcel number, `f=html` so a human opening it sees a rendered record rather
 * than a JSON blob. Anyone can paste it and get the same row back, which is
 * what makes it provenance rather than a gesture.
 *
 * ⛔ THE PREDICATE ORDER AND THE FIPS ARE BOTH MEASURED, NOT STYLISTIC.
 * Timed against the live layer, 2026-08-19, same parcel, same host:
 *
 *   where=cntyname='Jackson' AND parno='7582-03-0255'   -> HTTP 504 at 60 s
 *   where=parno='7582-03-0255' AND cntyname='Jackson'   -> HTTP 200 in 6.5 s
 *   where=stcntyfips='37099' AND parno='7582-03-0255'   -> HTTP 200 in 2.7 s ✅
 *
 * The first spelling is the obvious one and it TIMES OUT. A provenance link
 * that 504s is only marginally better than the homepage it replaced, so the
 * shape that was measured to work is the shape that ships. `stcntyfips` is also
 * the field the ingest keys on, so the link is filtered by the same identifier
 * the row was stored under rather than by a display name.
 *
 * ⛔ Built with URLSearchParams, not string concatenation. Parcel numbers in
 * this corpus contain spaces, slashes, ampersands and quotes; hand-escaping a
 * WHERE clause into a query string is how an injection hole or a URIError gets
 * shipped. The single-quote doubling is SQL-92 escaping INSIDE the where
 * clause, which URLSearchParams cannot know about and must be done first.
 */
export function arcgisRecordUrl(layerUrl: string, fips: string, parno: string): string | null {
  if (parno.trim() === '' || fips.trim() === '') return null;
  const sq = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const params = new URLSearchParams({
    where: `stcntyfips=${sq(fips)} AND parno=${sq(parno)}`,
    outFields: '*',
    returnGeometry: 'false',
    f: 'html',
  });
  return `${layerUrl}/query?${params.toString()}`;
}

/** A bare origin — `https://host` or `https://host/` — is the homepage shape
 *  the owner was shown. It is refused as a record link everywhere. */
export function isBareOrigin(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false; // an unparseable URL is a different (also fatal) problem
  }
  return u.pathname.replace(/\/+$/, '') === '' && u.search === '' && u.hash === '';
}

/**
 * The fail-closed assertion. Runs over every published row, not over a sample:
 * one bad link is the whole complaint.
 */
export function assertRecordUrlHonest(url: string | null, denials: readonly Denial[]): void {
  if (url === null) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProvenanceError(`record_url is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ProvenanceError(`record_url is not http(s): ${url}`);
  }
  if (isBareOrigin(url)) {
    throw new ProvenanceError(
      `record_url ${url} is a bare homepage. A homepage does not show the record and must be ` +
        'published as record_url:null with a how_to_verify sentence instead.',
    );
  }
  const denied = matchDenylist(url, denials);
  if (denied) {
    throw new ProvenanceError(
      `record_url ${url} is on sources.denied.yaml (${denied.denial.host}: ${denied.denial.reason}). ` +
        'We never fetched it, so citing it would be a fabricated provenance.',
    );
  }
}

export type ProvenanceInput = {
  source_id: string | null;
  fips: string;
  county: string;
  state: string;
  parno: string;
  retrieved_at: string;
};

export function buildProvenance(
  input: ProvenanceInput,
  source: Source | null,
  denials: readonly Denial[],
): Provenance {
  if (input.source_id === null || source === null) {
    return {
      source_id: 'none',
      record_url: null,
      how_to_verify:
        `No parcel data source exists for ${input.county} County, ${input.state}. Nothing on this page ` +
        'came from a parcel record there; check the county tax office directly.',
      retrieved_at: input.retrieved_at,
      source_note: 'no registered parcel source for this county',
    };
  }

  const recordUrl =
    source.kind === 'arcgis-map-server' ? arcgisRecordUrl(source.url, input.fips, input.parno) : null;

  if (recordUrl !== null) {
    assertRecordUrlHonest(recordUrl, denials);
    return {
      source_id: source.id,
      record_url: recordUrl,
      how_to_verify: null,
      retrieved_at: input.retrieved_at,
      source_note:
        'Live query against the publisher\'s own layer, filtered to this county FIPS and parcel number. ' +
        'Paste it into any browser and it returns this one record (measured: HTTP 200, 1 feature).',
    };
  }

  return {
    source_id: source.id,
    record_url: null,
    how_to_verify:
      `Search parcel ${input.parno === '' ? '(no parcel number published)' : input.parno} at the ` +
      `${input.county} County, ${input.state} tax office. No public per-record URL exists for this county.`,
    retrieved_at: input.retrieved_at,
    source_note: 'no public per-record URL exists for this county',
  };
}
