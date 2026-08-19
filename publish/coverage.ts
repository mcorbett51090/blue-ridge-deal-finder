/**
 * coverage.json — THE HONESTY SURFACE.
 *
 * The one thing this file exists to keep separable:
 *
 *   no-source   we have never had a way to see this county at all
 *   not-run     we have a source and have not run it
 *   zero-deals  we ran it, we hold its parcels, and none of them ranked
 *
 * All three render as "nothing here" on a naive site, and they are three
 * completely different facts. A quiet North Georgia county is not a quiet
 * market — it is a vendor bot-wall (E1.1-E1.4) with no parcel source behind it,
 * permanently, and saying "no deals" there is the single most misleading thing
 * this project could print.
 *
 * ⛔ THE LEDGER AND THE FILE CAN DISAGREE, AND THE FILE WINS FOR `data_state`.
 * MEASURED 2026-08-19 on the live warehouse: `county_runs` said Watauga
 * `not-run` with 0 rows while the same SQLite file held 46,252 Watauga parcels
 * (the wholesale rebuild rewrites the ledger from THIS run's reports; the
 * carry-forward only rescues a county whose prior row was itself complete).
 * Publishing the ledger verbatim would render "we cannot see Watauga" over
 * 46,252 rows we are simultaneously serving — inverting the exact guarantee
 * this file provides. So `data_state` is computed from a COUNT of the rows
 * actually present, and the ledger claim is published beside it, named, when
 * the two disagree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CountyLedgerRow } from '../pipeline/score/read-warehouse.ts';

export type DataState = 'ingested' | 'not-run' | 'no-source';

export type CoverageRow = {
  fips: string;
  state: string;
  county: string;
  region: string;
  tier: string;
  parcel_source: string | null;
  data_state: DataState;
  /** Parcels actually in the warehouse. null when there are none to count. */
  rows: number | null;
  /** Rows of this county in the PUBLISHED payload. 0 is a real measurement here. */
  published: number;
  /** Rows that scored at least ONE signal. 0 here means the county publishes
   *  nothing we can price — a different fact from "none of them ranked". */
  scorable: number;
  ledger_status: string | null;
  last_ingested_at: string | null;
  /** Rendered verbatim. The three data_states never share a sentence. */
  note: string;
};

export type SeedCounty = {
  fips: string;
  state: string;
  county: string;
  region: string;
  tier: string;
  parcel_source: string | null;
  notes: string;
};

export function readCountySeeds(repoRoot: string): SeedCounty[] {
  const text = readFileSync(join(repoRoot, 'seeds', 'counties.csv'), 'utf8');
  const lines = text.replace(/\r/g, '').trim().split('\n');
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const at = (cells: string[], name: string): string => (cells[ix[name] ?? -1] ?? '').trim();
  const out: SeedCounty[] = [];
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const fips = at(cells, 'fips');
    if (fips === '' || seen.has(fips)) continue;
    seen.add(fips);
    out.push({
      fips,
      state: at(cells, 'state'),
      county: at(cells, 'county'),
      region: at(cells, 'region'),
      tier: at(cells, 'tier'),
      parcel_source: at(cells, 'parcel_source') === '' ? null : at(cells, 'parcel_source'),
      notes: at(cells, 'notes'),
    });
  }
  return out;
}

/** The three sentences. Kept adjacent ON PURPOSE: the acceptance control
 *  asserts they differ, and separating them is how they drift into synonyms. */
export const NOTE_NO_SOURCE =
  'NO PARCEL SOURCE EXISTS for this county — nothing has ever been collected here, so a quiet page ' +
  'means we cannot see it, not that nothing is happening.';
export const NOTE_NOT_RUN =
  'A parcel source is registered for this county but has NOT BEEN RUN yet — this is an absence of ' +
  'collection, not a measurement of zero.';
export const NOTE_ZERO_DEALS =
  'Collected and scored: we hold this county\'s parcels and NONE of them ranked into the published ' +
  'set. This is a real zero, measured.';
export const NOTE_NO_SCORABLE_SIGNAL =
  'Collected, but NOTHING HERE CAN BE SCORED: this county publishes no assessed values, so every ' +
  'signal we have is unknown for every one of its parcels. That is a gap in what the county ' +
  'publishes, not a judgement about its land.';
export const NOTE_INGESTED = 'Collected and scored — the rows below are published from real parcel records.';

export function buildCoverage(
  seeds: readonly SeedCounty[],
  ledger: readonly CountyLedgerRow[],
  rowsByFips: ReadonlyMap<string, number>,
  publishedByFips: ReadonlyMap<string, number>,
  scorableByFips: ReadonlyMap<string, number> = new Map(),
): CoverageRow[] {
  const ledgerByFips = new Map(ledger.map((l) => [l.fips, l]));
  return seeds.map((s) => {
    const led = ledgerByFips.get(s.fips) ?? null;
    const rows = rowsByFips.get(s.fips) ?? 0;
    const published = publishedByFips.get(s.fips) ?? 0;
    const scorable = scorableByFips.get(s.fips) ?? 0;

    let dataState: DataState;
    if (rows > 0) dataState = 'ingested';
    else if (s.parcel_source === null) dataState = 'no-source';
    else dataState = 'not-run';

    let note: string;
    if (dataState === 'no-source') note = NOTE_NO_SOURCE;
    else if (dataState === 'not-run') note = NOTE_NOT_RUN;
    else if (published > 0) note = NOTE_INGESTED;
    else note = scorable === 0 ? NOTE_NO_SCORABLE_SIGNAL : NOTE_ZERO_DEALS;

    // The disagreement is NAMED, not smoothed over.
    if (dataState === 'ingested' && led !== null && led.ingest_status !== 'complete') {
      note +=
        ` (Ledger note: the last run recorded this county as '${led.ingest_status}' while ${rows.toLocaleString('en-US')} ` +
        'of its parcels are present in the same warehouse — the row count is what is published here.)';
    }
    if (s.notes !== '') note += ` (Source note: ${s.notes})`;

    return {
      fips: s.fips,
      state: s.state,
      county: s.county,
      region: s.region,
      tier: s.tier,
      parcel_source: s.parcel_source,
      data_state: dataState,
      rows: rows > 0 ? rows : null,
      published,
      scorable,
      ledger_status: led?.ingest_status ?? null,
      last_ingested_at: led && led.ingest_status === 'complete' ? led.ingested_at : null,
      note,
    };
  });
}
