/**
 * NC distress ingest — the phase that turns parcels into DEALS.
 *
 * Until this runs, Lane 1 ("on market / in distress") is structurally empty:
 * the corpus knows 387,742 parcels exist and nothing about whether any of them
 * can be bought.
 *
 * ⛔ THE SCALE IS SMALL AND THAT IS THE HONEST ANSWER. P0 measured roughly 30
 * distress events a year across three NC counties, and three counties produced
 * three unrelated mechanisms — a CivicEngage bids module, a calendar feed, and
 * a static PDF. There is no "NC foreclosure scraper"; there are per-county
 * adapters, and this file holds the one that yields joinable, purchasable stock.
 *
 * Writes `data/distress/evidence.json` keyed by warehouse `record_id`, which
 * `publish/` reads to populate `for_sale_evidence` and move a row into Lane 1.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { loadRegistry } from './fetch/registry.ts';
import { FetchClient } from './fetch/client.ts';
import { parseJacksonReo } from './ingest/distress/jackson-reo.ts';

const ROOT = process.cwd();
const JACKSON_FIPS = '37099';

type Evidence = {
  kind: 'county_owned_reo' | 'tax_foreclosure' | 'tax_delinquent';
  label: string;
  /** What it costs, when the county says. `null` is unknown, never 0. */
  price_usd: number | null;
  observed_at: string;
  since: string | null;
  record_url: string | null;
  generic_url: string | null;
  generic_label: string | null;
  how_to_verify: string;
};

const registry = loadRegistry(ROOT);
const client = new FetchClient(registry);
const now = new Date().toISOString();

const pointer = JSON.parse(readFileSync(join(ROOT, 'data/warehouse/warehouse-pointer.json'), 'utf8'));
const db = new DatabaseSync(join(ROOT, 'data/warehouse', pointer.current), { readOnly: true });

const evidence: Record<string, Evidence> = {};
let matched = 0;
let unmatched = 0;

// ── Jackson County REO ───────────────────────────────────────────────────────
console.log('  Jackson County REO…');
const res = await client.fetchDocument('nc-jackson-reo');
const pdf = res.body;

// The registry's schema_fingerprint is the DOCUMENT DIGEST. A change means the
// county republished, which may or may not be a layout change — so it is
// reported, not fatal. The parser's own controls (text layer, PIN-vs-row count)
// are what actually fail closed.
const digest = createHash('sha256').update(pdf).digest('hex');
const src = registry.sources.find((s) => s.id === 'nc-jackson-reo');
if (src && src.schema_fingerprint !== null && digest !== src.schema_fingerprint) {
  console.log(`  · document changed since last check (${digest.slice(0, 12)}…) — parser controls still apply`);
}

const reo = parseJacksonReo(pdf);
console.log(`  · ${reo.length} county-owned properties in the document`);

const find = db.prepare(
  "SELECT record_id, siteadd, acreage, value FROM parcels WHERE fips = ? AND parno = ? AND status = 'active'",
);

for (const r of reo) {
  const row = find.get(JACKSON_FIPS, r.pin) as { record_id?: string } | undefined;
  if (!row?.record_id) {
    // ⛔ Counted and reported, never silently dropped. A PIN the county lists but
    // our corpus lacks means OUR ingest is incomplete, not that the property
    // does not exist.
    unmatched += 1;
    console.log(`  · PIN ${r.pin} has no parcel in the warehouse — recorded as unmatched`);
    continue;
  }
  matched += 1;
  evidence[row.record_id] = {
    kind: 'county_owned_reo',
    label: 'County-owned, acquired through foreclosure',
    price_usd: r.price_owed_usd,
    observed_at: now,
    since: r.acquired,
    // The county publishes one PDF for all of them; there is no per-property
    // page, so this is a labelled generic link, never dressed up as a record one.
    record_url: null,
    generic_url: 'https://www.jacksonnc.org/DocumentCenter/View/2164',
    generic_label: 'Jackson County — properties acquired through foreclosure (PDF)',
    how_to_verify:
      `PIN ${r.pin} appears in Jackson County's own list of properties acquired through ` +
      `foreclosure. Contact the Jackson County Tax Collections office to confirm price and status.`,
  };
}

db.close();

mkdirSync(join(ROOT, 'data/distress'), { recursive: true });
writeFileSync(
  join(ROOT, 'data/distress/evidence.json'),
  JSON.stringify({ generated_at: now, matched, unmatched, evidence }, null, 1),
);

console.log(`\n✓ distress — ${matched} parcels now carry for-sale evidence, ${unmatched} unmatched`);
if (matched === 0) {
  console.error('  ⛔ zero matches: either the join key changed or no NC distress source produced rows.');
  process.exitCode = 1;
}
