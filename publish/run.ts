#!/usr/bin/env -S npx tsx
/**
 * THE PUBLISH PATH (plan §5.7, §6). Warehouse in, site payload out.
 *
 * ORDER, and each step is a refusal that runs BEFORE anything is written:
 *
 *   1. weights.yaml            — parsed fail-closed, nominal weights sum to 100
 *   2. the warehouse NAMED BY THE POINTER — never the newest by mtime (RT-4)
 *   3. enrichment interchange  — absent files degrade to `unknown`, never to 0
 *   4. score the whole corpus  — cohort percentiles need the corpus, not a sample
 *   5. VETOES                  — government / HOA commons / slivers leave the ranking
 *   6. top N candidates only   — the site inlines its dataset; 235k rows do not ship
 *   7. PROVENANCE per row      — a link that shows the record, or how_to_verify
 *   8. the field allowlist     — fails closed on any key it has not heard of
 *   9. the score arithmetic    — recomputed with the SITE's formula, per row
 *  10. coverage.json           — no-source / not-run / zero-deals kept separable
 *
 * Nothing is written until every row has passed 7-9. A partial publish that
 * dropped the failing rows would be a payload that looks clean because the
 * evidence of the problem was removed from it.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWeights, assertWeightsSumTo100 } from '../pipeline/score/config.ts';
import { loadEnrichment } from '../pipeline/score/enrich-contract.ts';
import type { SourceRef } from '../pipeline/score/enrich-contract.ts';
import { readWarehouse, type WarehouseParcel } from '../pipeline/score/read-warehouse.ts';
import { scoreCorpus, topN } from '../pipeline/score/corpus.ts';
import { loadRegistry } from '../pipeline/fetch/registry.ts';
import { loadVintageTable } from '../pipeline/normalize/vintage.ts';
import { buildProvenance } from './provenance.ts';
import { assertScoreDerivable, toListing, type PublishedListing } from './payload.ts';
import { buildCoverage, readCountySeeds } from './coverage.ts';
import { loadAllowlist, project } from './export.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** ⛔ The site INLINES its dataset today (plan §6.3). The whole corpus does not
 *  survive that at any size, so the published set is the top of the RANKING and
 *  the manifest records exactly what was left out and why. */
const DEFAULT_TOP_N = 500;

async function main(): Promise<void> {
  const topLimit = Number(arg('--top', String(DEFAULT_TOP_N)));
  // A visible slice, not a ranking — see the TN block below.
  const tnLimit = 150;
  const now = new Date();

  const cfg = loadWeights(ROOT);
  assertWeightsSumTo100(cfg);

  const wh = readWarehouse(ROOT);
  const enrichment = loadEnrichment(ROOT);
  const registry = loadRegistry(ROOT);
  const seeds = readCountySeeds(ROOT);
  const vintage = loadVintageTable(ROOT);

  const seedByFips = new Map(seeds.map((s) => [s.fips, s]));
  const sourceOfFips = (fips: string) => {
    const id = seedByFips.get(fips)?.parcel_source ?? null;
    return id === null ? null : (registry.sources.find((s) => s.id === id) ?? null);
  };

  const parcelSourceOf = (row: WarehouseParcel): SourceRef | null => {
    const src = sourceOfFips(row.fips);
    if (!src) return null;
    return { url: src.url, retrieved_at: row.last_seen, kind: 'arcgis-parcel-layer' };
  };

  const { scored, tallies } = scoreCorpus(wh.parcels, { cfg, enrichment, now, parcelSourceOf });

  const ranked = topN(scored, topLimit);

  // ── EAST TENNESSEE ──────────────────────────────────────────────────────
  // TN rows are UNRANKABLE, and for a structural reason rather than a per-row
  // failure: the statewide layer publishes no assessed value at all, so
  // `discount` (weight 30) and `per_acre` (20) — half the scoring weight — have
  // no input. topN() excludes unrankable rows by design, which is right for a
  // NC parcel we simply could not score, and wrong for an entire state the
  // owner named as a priority region: it would make East Tennessee silently
  // absent from a map that claims to cover it.
  //
  // So TN ships as its own slice, ordered by the one signal TN does publish —
  // deeded acreage — with `score: null` and the reason attached. Ordering by
  // acreage is NOT a ranking and must never be read as one; it is "biggest
  // first" because that is the only axis available, and the card says so.
  const tnSlice = scored
    .filter((c) => c.row.state === 'TN' && c.row.acreage !== null && !c.vetoed)
    .sort((a, b) => (b.row.acreage ?? 0) - (a.row.acreage ?? 0))
    .slice(0, tnLimit);

  const candidates = [...ranked, ...tnSlice];
  const allowlist = loadAllowlist(ROOT);

  const listings: PublishedListing[] = [];
  for (const c of candidates) {
    const src = sourceOfFips(c.row.fips);
    const provenance = buildProvenance(
      {
        source_id: src?.id ?? null,
        fips: c.row.fips,
        county: c.row.county,
        state: c.row.state,
        parno: c.row.parno,
        retrieved_at: c.row.last_seen,
        root: ROOT,
      },
      src,
      registry.denials,
    );
    const water = enrichment.water.get(c.row.record_id);
    const liv = enrichment.livability.get(c.row.record_id);
    const listing = toListing(c, {
      provenance,
      reappraisalYear: vintage.byFips.get(c.row.fips)?.next_reappraisal_year ?? null,
      water: water
        ? {
            has_stream: water.has_stream,
            has_river: water.has_river,
            has_pond: water.has_pond,
            distance_m: water.min_dist_flowline_m ?? water.min_dist_waterbody_m,
            named_waters: water.named_waters ?? [],
            frontage_m: water.frontage_m,
            frontage_by_regime_m: water.frontage_by_regime_m ?? null,
          }
        // ⛔ NOT `{has_stream:false,…}`. A parcel we never enriched has UNKNOWN
        // water, and false is a measurement we did not make. Rendered as "No
        // water" it would actively mislead: the creek parcel nobody advertised
        // is the entire premise of this tool, and this is the field that finds
        // it. `null` here makes the card say "not checked yet" instead.
        : null,
      floodZone: liv?.flood_zone ?? null,
    });
    assertScoreDerivable(listing);
    // Fails CLOSED on any key the allowlist has not heard of — including one an
    // upstream schema change adds tomorrow with owner data in it.
    project('listing', listing as unknown as Record<string, unknown>, allowlist);
    listings.push(listing);
  }

  const publishedByFips = new Map<string, number>();
  for (const l of listings) publishedByFips.set(l.fips, (publishedByFips.get(l.fips) ?? 0) + 1);
  // Scorable ≠ published. A county can hold 17,332 parcels, publish no assessed
  // value on ANY of them (measured: Yancey), and therefore contribute nothing —
  // which is a fact about the county's publishing, not about its land.
  const scorableByFips = new Map<string, number>();
  for (const s of scored) {
    if (s.scored_count > 0) scorableByFips.set(s.row.fips, (scorableByFips.get(s.row.fips) ?? 0) + 1);
  }

  const coverage = buildCoverage(seeds, wh.ledger, wh.rowsByFips, publishedByFips, scorableByFips);

  const manifest = {
    generated_at: now.toISOString(),
    warehouse: { file: wh.resolved.file, sha256: wh.resolved.sha256, written_at: wh.resolved.written_at },
    run_id: wh.runMeta['run_id'] ?? null,
    corpus_rows: wh.parcels.length,
    published_rows: listings.length,
    // ⛔ What was left out, counted. "Top 500" with no denominator beside it is
    // a number that cannot be checked.
    excluded: {
      vetoed: tallies.vetoed,
      no_scorable_signal: tallies.unranked_no_signal,
      ranked_below_cutoff: Math.max(0, tallies.ranked - listings.length),
      cutoff: topLimit,
    },
    signals: { known: tallies.known, unknown: tallies.unknown },
    veto_by_reason: tallies.veto_by_reason,
    cohorts: tallies.cohorts,
    // The measured administrative floors that were treated as `unknown`. A rule
    // this consequential is published, not only applied.
    value_floors: tallies.value_floors,
    enrichment_present: enrichment.present,
    provenance: {
      with_record_url: listings.filter((l) => l.provenance.record_url !== null).length,
      with_how_to_verify: listings.filter((l) => l.provenance.how_to_verify !== null).length,
    },
    geometry: {
      rows_with_coordinates: listings.filter((l) => l.lat !== null && l.lng !== null).length,
      note:
        'The parcel ingest stores attributes only — lat/lng and bbox are NULL on every warehouse row, ' +
        'so no published row can be placed on the map yet. Published as null with a stated reason, ' +
        'never as 0,0.',
    },
  };

  const outDir = join(ROOT, 'publish', 'out');
  mkdirSync(outDir, { recursive: true });
  const write = (path: string, data: unknown): number => {
    const text = `${JSON.stringify(data, null, isCompact(path) ? 0 : 2)}\n`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return Buffer.byteLength(text);
  };
  const isCompact = (p: string): boolean => p.endsWith('listings.json');

  const bytes = {
    listings: write(join(outDir, 'listings.json'), listings),
    coverage: write(join(outDir, 'coverage.json'), { generated_at: now.toISOString(), counties: coverage }),
    manifest: write(join(outDir, 'manifest.json'), manifest),
    // The site consumes the SAME bytes it was just handed — no second
    // projection, no hand-copied fixture drifting away from the pipeline.
    // Writing here rather than having the site reach into publish/out keeps
    // Astro's import graph inside site/, which is what its build expects.
    siteListings: write(join(ROOT, 'site', 'src', 'data', 'listings.json'), listings),
    siteCoverage: write(join(ROOT, 'site', 'src', 'data', 'coverage.json'), coverage),
  };

  // data/coverage.json is the repo-level honesty surface the gate family checks
  // (37 rows, one per county) and the ingest writes a run-scoped version of it.
  // This one is rebuilt from the WAREHOUSE, so a county whose ledger row was
  // lost to a wholesale rebuild still reports the parcels we actually hold.
  write(join(ROOT, 'data', 'coverage.json'), { generated_at: now.toISOString(), counties: coverage });

  // The site's copies, in the directory the site imports from. Written under
  // published/ rather than over the fixtures so the swap is a reviewable
  // one-line import change and the fixture corpus (which exercises UI cases
  // real data cannot yet reach) is not silently destroyed.
  write(join(ROOT, 'site', 'src', 'data', 'published', 'listings.json'), listings);
  write(join(ROOT, 'site', 'src', 'data', 'published', 'coverage.json'), coverage);
  write(join(ROOT, 'site', 'src', 'data', 'published', 'manifest.json'), manifest);

  console.log(
    `\n✓ publish — ${listings.length} listings from ${wh.parcels.length} corpus rows (${wh.resolved.file})\n` +
      `  vetoed ${tallies.vetoed} · unrankable ${tallies.unranked_no_signal} · ranked ${tallies.ranked}\n` +
      `  per_acre known ${tallies.known['per_acre'] ?? 0} / unknown ${tallies.unknown['per_acre'] ?? 0}\n` +
      `  record_url ${manifest.provenance.with_record_url} · how_to_verify ${manifest.provenance.with_how_to_verify}\n` +
      `  listings.json ${bytes.listings.toLocaleString('en-US')} B\n`,
  );
}

await main();
