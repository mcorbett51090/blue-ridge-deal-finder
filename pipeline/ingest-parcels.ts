#!/usr/bin/env -S npx tsx
/**
 * The parcel ingest entrypoint (plan §7 P2).
 *
 * ORDER, and every step is here because something measured went wrong without it:
 *
 *   1. registry load + guard           — refuses before a socket exists
 *   2. layer metadata `?f=json`
 *   3. SCHEMA FINGERPRINT              — asserted BEFORE any data query; a
 *                                        mismatch aborts and ingests NOTHING
 *   4. CONTROL BLOCK                   — positive 47,388 / negative 0, and the
 *                                        two bodies must differ (RT-1 fix #3)
 *   5. per county: OID envelope -> pages -> assertHealthy per page
 *   6. REDACTION BOUNDARY              — before Tier 0, before git, before dist/
 *   7. key / dedupe / multi-part / unkeyed quarantine
 *   8. sentinels, basis allowlist, sourcedate -> deed_date, vintage join
 *   9. Tier 0 (row-granularity) -> warehouse rebuild -> events -> manifest
 *  10. data/coverage.json              — 37 rows, counties not run say SO
 *
 * ⛔ A COUNTY THAT FAILS ITS FLOOR CONTRIBUTES NOTHING AND MARKS NOTHING STALE.
 * The alternative — letting a failed fetch mark 47,388 parcels absent — writes
 * an outage into the audit trail as a fact about the world.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  ATTRIBUTE_FIELDS,
  fetchLayerMetadata,
  objectIdFieldOf,
  readCounty,
  runControlBlock,
} from './fetch/arcgis.ts';
import { FetchClient } from './fetch/client.ts';
import { getSource, loadRegistry } from './fetch/registry.ts';
import { assertSchemaFingerprint, fieldNames } from './fetch/schema-fingerprint.ts';
import { assertObjectIdEnvelopeStable } from './normalize/keys.ts';
import { loadVintageTable } from './normalize/vintage.ts';
import { assertVintageJoinComplete } from './normalize/vintage.ts';
import { assertCountsReconcile, stageCounty, type StagedParcel } from './ingest/stage.ts';
import { EventWriter, writeRunManifest, type ParcelEvent, type RunManifest } from './store/events.ts';
import { loadRowIndex, writeTier0Snapshot } from './store/tier0.ts';
import {
  contentHash,
  carryForwardAbsent,
  diffFields,
  insertParcels,
  openWarehouse,
  chooseLedgerRow,
  readPriorCountyRuns,
  readPriorParcels,
  readPriorState,
  swapPointer,
  assertPriorStateNotLost,
} from './store/warehouse.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ID = 'nc-onemap-parcels';

function arg(flag: string): string | null {
  const withEq = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (withEq) return withEq.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
}

/** The 11 NC target counties, read from the seed so the list has one home. */
function ncTargetCounties(): { fips: string; county: string }[] {
  const lines = readFileSync(join(ROOT, 'seeds', 'counties.csv'), 'utf8').trim().split('\n');
  const header = (lines[0] ?? '').split(',');
  const ix = Object.fromEntries(header.map((h, i) => [h.trim(), i]));
  const seen = new Set<string>();
  const out: { fips: string; county: string }[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const fips = (c[ix['fips'] ?? 0] ?? '').trim();
    if ((c[ix['state'] ?? 1] ?? '').trim() !== 'NC') continue;
    if ((c[ix['parcel_source'] ?? 5] ?? '').trim() !== SOURCE_ID) continue;
    if (seen.has(fips)) continue; // seeds/counties.csv repeats its first row
    seen.add(fips);
    out.push({ fips, county: (c[ix['county'] ?? 2] ?? '').trim() });
  }
  return out;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  const runId = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const month = runId.slice(0, 7);

  const registry = loadRegistry(ROOT);
  const source = getSource(registry, SOURCE_ID);
  const client = new FetchClient(registry);

  // ── 2/3. Metadata and the pre-build schema gate ─────────────────────────
  const { meta, bytes: metaBytes } = await fetchLayerMetadata(client, source);
  const known = JSON.parse(
    readFileSync(join(ROOT, 'sources', 'evidence', 'schema', 'nc-onemap-parcels.MapServer-1.fields.json'), 'utf8'),
  ) as { fields: string[] };
  if (!source.schema_fingerprint) throw new Error('schema_fingerprint is null — the source may not fetch');
  assertSchemaFingerprint(meta, source.schema_fingerprint, source.id, known.fields);
  const oidField = objectIdFieldOf(meta);
  const pageSize = Math.min(meta.maxRecordCount, 5000);
  console.log(
    `✓ schema fingerprint matches (${meta.fields.length} fields, ${metaBytes} B, ` +
      `oid='${oidField}', maxRecordCount=${meta.maxRecordCount})`,
  );

  // Every field we ask for must exist in the schema we just verified. Without
  // this an outFields typo yields HTTP 200 and a silently narrower row.
  const available = new Set(fieldNames(meta));
  const missing = ATTRIBUTE_FIELDS.filter((f) => !available.has(f));
  if (missing.length > 0) throw new Error(`outFields not present in layer schema: ${missing.join(', ')}`);

  // ── 4. The control block, before any data query ─────────────────────────
  const { positiveCount: positiveObserved, negativeCount: negativeObserved } =
    await runControlBlock(client, source);
  console.log(`✓ control block: positive=${positiveObserved} negative=${negativeObserved}`);

  // ── inputs ──────────────────────────────────────────────────────────────
  const vintage = loadVintageTable(ROOT);
  const targets = ncTargetCounties();
  const requested = (arg('--counties') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const plan = requested.length > 0 ? targets.filter((t) => requested.includes(t.county)) : targets;
  if (requested.length > 0 && plan.length !== requested.length) {
    throw new Error(`--counties named ${requested.join(', ')}; matched only ${plan.map((p) => p.county).join(', ')}`);
  }

  const warehouseDir = join(ROOT, 'data', 'warehouse');
  const tier0Dir = join(ROOT, 'data', 'raw', SOURCE_ID);
  mkdirSync(warehouseDir, { recursive: true });
  mkdirSync(tier0Dir, { recursive: true });

  const pointerPath = join(warehouseDir, 'warehouse-pointer.json');
  const priorFile = existsSync(pointerPath)
    ? join(warehouseDir, (JSON.parse(readFileSync(pointerPath, 'utf8')) as { current: string }).current)
    : null;
  const prior = readPriorState(priorFile);
  const priorParcels = readPriorParcels(priorFile);
  const priorCountyRuns = readPriorCountyRuns(priorFile);

  // Refuses when prior state was LOST rather than never existing — see
  // assertPriorStateNotLost for the measurement that motivated it.
  assertPriorStateNotLost(
    prior.size,
    existsSync(join(ROOT, 'data', 'runs'))
      ? readdirSync(join(ROOT, 'data', 'runs')).filter((f: string) => f.endsWith('.json')).length
      : 0,
  );

  // ── 5-8. per county ─────────────────────────────────────────────────────
  const staged: StagedParcel[] = [];
  const events: ParcelEvent[] = [];
  const countyReports: RunManifest['counties'] = [];
  const completedFips = new Set<string>();
  const seenAt = startedAt.toISOString();

  for (const { fips, county } of plan) {
    const minRows = source.expect.per_county_min_rows[county] ?? 0;
    if (minRows === 0) throw new Error(`${county}: no MEASURED row floor in sources.yaml — floors are not guessed`);

    const raw: Record<string, unknown>[] = [];
    let pages = 0;
    let bytes = 0;
    try {
      const result = await readCounty({
        client,
        source,
        county,
        oidField,
        pageSize,
        minRows,
        onPage: (page) => {
          raw.push(...page.rows);
          process.stdout.write(`\r  ${county}: ${raw.length} rows…`);
        },
      });
      pages = result.pages;
      bytes = result.bytes;
      // §4.3 — a mid-run republish reassigns OBJECTIDs and skews resultOffset
      // pagination silently. Abort rather than stitch pages from two orderings.
      assertObjectIdEnvelopeStable(result.envelopeBefore, result.envelopeAfter);
      process.stdout.write('\n');
    } catch (err) {
      process.stdout.write('\n');
      console.error(`  ✗ ${county} FAILED: ${String(err)}`);
      countyReports.push({
        fips, county, status: 'failed',
        rows_fetched: raw.length, distinct_keys: 0, rows_warehoused: 0,
        unkeyed: 0, collapsed_duplicates: 0, multipart_parcels: 0,
        deed_date_nulled: 0, zero_parval: 0, pages, bytes,
        note: String(err).slice(0, 300),
      });
      continue;
    }

    const county0 = stageCounty(raw, { state: 'NC', county, vintage, now: startedAt });
    assertCountsReconcile(county, county0.distinctKeys.size, county0.rows.length);
    assertVintageJoinComplete(county0.rows);

    const deedNulled = county0.rows.filter((r) => r.deed_date_unknown_reason === 'date-sentinel').length;
    const zeroParval = county0.rows.filter((r) => r.value_unknown_reason === 'zero-sentinel').length;

    for (const row of county0.rows) {
      const before = prior.get(row.record_id);
      if (!before) {
        events.push({ run_id: runId, ts: seenAt, source_id: SOURCE_ID, fips, county, record_id: row.record_id, kind: 'new', field: null, before: null, after: null });
      } else if (before.content_hash !== contentHash(row)) {
        for (const c of diffFields(before, row)) {
          events.push({ run_id: runId, ts: seenAt, source_id: SOURCE_ID, fips, county, record_id: row.record_id, kind: 'changed', field: c.field, before: c.before ?? null, after: c.after ?? null });
        }
      } else if (before.status === 'stale') {
        events.push({ run_id: runId, ts: seenAt, source_id: SOURCE_ID, fips, county, record_id: row.record_id, kind: 'returned', field: null, before: null, after: null });
      }
    }

    staged.push(...county0.rows);
    completedFips.add(fips);
    countyReports.push({
      fips, county, status: 'complete',
      rows_fetched: county0.fetchedRows,
      distinct_keys: county0.distinctKeys.size,
      rows_warehoused: county0.rows.length,
      unkeyed: county0.unkeyed.length,
      collapsed_duplicates: county0.collapsedExactDuplicates,
      multipart_parcels: county0.multiPartParnos.length,
      deed_date_nulled: deedNulled,
      zero_parval: zeroParval,
      pages, bytes, note: null,
    });
    console.log(
      `  ✓ ${county}: ${county0.fetchedRows} fetched -> ${county0.rows.length} keyed ` +
        `(${county0.unkeyed.length} unkeyed, ${county0.collapsedExactDuplicates} exact dupes, ` +
        `${county0.multiPartParnos.length} multi-part, ${deedNulled} deed_date nulled)`,
    );
  }

  // Counties not attempted this run are recorded EXPLICITLY as not-run. An
  // absent row and a zero row are indistinguishable to every downstream reader.
  for (const t of targets) {
    if (countyReports.some((c) => c.fips === t.fips)) continue;
    countyReports.push({
      fips: t.fips, county: t.county, status: 'not-run',
      rows_fetched: 0, distinct_keys: 0, rows_warehoused: 0,
      unkeyed: 0, collapsed_duplicates: 0, multipart_parcels: 0,
      deed_date_nulled: 0, zero_parval: 0, pages: 0, bytes: 0,
      note: 'not attempted in this run — NOT a measurement of zero',
    });
  }

  // ── 9. Tier 0, warehouse, events, manifest ──────────────────────────────
  const rowIndex = loadRowIndex(tier0Dir);
  const tier0 = await writeTier0Snapshot(tier0Dir, runId, staged, rowIndex);

  const buildPath = join(warehouseDir, `warehouse-building-${runId}.sqlite`);
  if (existsSync(buildPath)) throw new Error(`${buildPath} already exists`);
  const db = openWarehouse(buildPath);
  const inserted = insertParcels(db, staged, prior, seenAt);

  const presentIds = new Set(staged.map((r) => r.record_id));
  const priorByFips = new Map<string, { record_id: string; fips: string }[]>();
  for (const [id, p] of priorParcels) {
    const list = priorByFips.get(p.fips) ?? [];
    list.push({ record_id: id, fips: p.fips });
    priorByFips.set(p.fips, list);
  }
  const carried = carryForwardAbsent(db, prior, presentIds, completedFips, priorByFips, seenAt, priorParcels);
  for (const [id, p] of priorParcels) {
    if (presentIds.has(id) || !completedFips.has(p.fips)) continue;
    if (prior.get(id)?.status === 'stale') continue;
    events.push({ run_id: runId, ts: seenAt, source_id: SOURCE_ID, fips: p.fips, county: p.county, record_id: id, kind: 'stale', field: null, before: null, after: null });
  }

  const stmt = db.prepare('INSERT INTO county_runs (fips, county, run_id, ingest_status, rows_fetched, distinct_keys, rows_warehoused, unkeyed, collapsed_dupes, multipart_parcels, deed_date_nulled, zero_parval, ingested_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const c of countyReports) {
    // A county NOT attempted this run keeps its previous ledger row. Without
    // this the wholesale rebuild rewrites it as `not-run`/0 while its parcels
    // remain in the same warehouse — and data/coverage.json, the site's
    // honesty surface, then renders "we cannot see this county" over data we
    // actually hold. Only a county we really attempted may overwrite its row.
    const choice = chooseLedgerRow(c, priorCountyRuns);
    if (choice.carried) {
      const carriedRow = choice.row;
      stmt.run([
        carriedRow.fips, carriedRow.county, carriedRow.run_id, carriedRow.ingest_status,
        carriedRow.rows_fetched, carriedRow.distinct_keys, carriedRow.rows_warehoused,
        carriedRow.unkeyed, carriedRow.collapsed_dupes, carriedRow.multipart_parcels,
        carriedRow.deed_date_nulled, carriedRow.zero_parval, carriedRow.ingested_at,
      ]);
      continue;
    }
    stmt.run([c.fips, c.county, runId, c.status, c.rows_fetched, c.distinct_keys, c.rows_warehoused, c.unkeyed, c.collapsed_duplicates, c.multipart_parcels, c.deed_date_nulled, c.zero_parval, seenAt]);
  }
  const metaStmt = db.prepare('INSERT OR REPLACE INTO run_meta (key, value) VALUES (?,?)');
  metaStmt.run(['run_id', runId]);
  metaStmt.run(['schema_fingerprint', source.schema_fingerprint]);
  metaStmt.run(['source_id', SOURCE_ID]);
  db.close();

  // A FAILED RUN DOES NOT BECOME THE CURRENT WAREHOUSE (acceptance 4: "leaves
  // existing rows untouched"). The built file is kept for inspection but the
  // pointer keeps naming the last good one — otherwise a run that fetched
  // nothing quietly promotes itself, and the NEXT run diffs against an empty
  // corpus and appends a 'new' event for the entire dataset.
  const anyFailedCounty = countyReports.some((c) => c.status === 'failed');
  const swap = anyFailedCounty
    ? {
        pointer: {
          current: priorFile ? (priorFile.split('/').pop() ?? '') : '',
          sha256: '', bytes: 0, written_at: seenAt, history: [],
        },
        changed: false,
        finalPath: buildPath,
      }
    : swapPointer(warehouseDir, buildPath, runId);
  if (anyFailedCounty) {
    console.error(
      '  ! run has failed counties — pointer NOT swapped; last-known-good warehouse ' +
        `${priorFile ?? '(none)'} remains current`,
    );
  }

  const writer = new EventWriter(ROOT, SOURCE_ID, runId, month);
  writer.append(events);

  const anyFailed = countyReports.some((c) => c.status === 'failed');
  const anyNotRun = countyReports.some((c) => c.status === 'not-run');
  const manifest: RunManifest = {
    run_id: runId,
    source_id: SOURCE_ID,
    started_at: seenAt,
    finished_at: new Date().toISOString(),
    status: anyFailed ? 'failed' : anyNotRun ? 'partial' : 'complete',
    schema_fingerprint: source.schema_fingerprint,
    control_block: {
      positive_where: source.control_block.positive.where,
      positive_expected: source.control_block.positive.expect_count,
      positive_observed: positiveObserved,
      negative_where: source.control_block.negative.where,
      negative_expected: source.control_block.negative.expect_count,
      negative_observed: negativeObserved,
    },
    counties: countyReports,
    totals: {
      rows_fetched: countyReports.reduce((a, c) => a + c.rows_fetched, 0),
      rows_warehoused: staged.length,
      inserted: inserted.inserted,
      changed: inserted.changed,
      unchanged: inserted.unchanged,
      marked_stale: carried.markedStale,
      deleted: carried.deleted,
      events_appended: writer.count,
    },
    tier0: { file: tier0.file, new_rows: tier0.newRows, sha256: tier0.sha256 },
    warehouse: { file: swap.pointer.current, sha256: swap.pointer.sha256, uploaded: swap.changed },
  };
  const manifestPath = writeRunManifest(ROOT, manifest);
  writeCoverage(ROOT, countyReports, seenAt);

  console.log(
    `\n✓ run ${runId} — ${manifest.status}\n` +
      `  fetched ${manifest.totals.rows_fetched}, warehoused ${manifest.totals.rows_warehoused}\n` +
      `  inserted ${inserted.inserted}, changed ${inserted.changed}, unchanged ${inserted.unchanged}, ` +
      `stale ${carried.markedStale}, deleted ${carried.deleted}\n` +
      `  events ${writer.count}, tier0 new rows ${tier0.newRows}, warehouse uploaded=${swap.changed}\n` +
      `  manifest ${manifestPath}`,
  );
}

/**
 * data/coverage.json — 37 rows, one per county, and the ones this system has
 * never ingested SAY SO. `status: 'not-run'` with `rows: null`, never `rows: 0`:
 * a zero is a measurement and this is an absence.
 */
function writeCoverage(root: string, reports: RunManifest['counties'], at: string): void {
  const lines = readFileSync(join(root, 'seeds', 'counties.csv'), 'utf8').trim().split('\n');
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));
  const byFips = new Map(reports.map((r) => [r.fips, r]));

  const seen = new Set<string>();
  const counties = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const fips = (c[ix['fips'] ?? 0] ?? '').trim();
    if (seen.has(fips)) continue;
    seen.add(fips);
    const r = byFips.get(fips);
    counties.push({
      fips,
      state: (c[ix['state'] ?? 1] ?? '').trim(),
      county: (c[ix['county'] ?? 2] ?? '').trim(),
      tier: (c[ix['tier'] ?? 4] ?? '').trim(),
      parcel_source: (c[ix['parcel_source'] ?? 5] ?? '').trim() || null,
      status: r ? r.status : 'no-source',
      rows: r && r.status === 'complete' ? r.rows_warehoused : null,
      unkeyed: r && r.status === 'complete' ? r.unkeyed : null,
      last_ingested_at: r && r.status === 'complete' ? at : null,
      note:
        r?.note ??
        (r ? null : 'no parcel source has been registered for this county — see P6/P8'),
    });
  }
  writeFileSync(
    join(root, 'data', 'coverage.json'),
    `${JSON.stringify({ generated_at: at, counties }, null, 2)}\n`,
  );
}

await main();
