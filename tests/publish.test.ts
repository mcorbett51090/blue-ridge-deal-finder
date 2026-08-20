/**
 * The publish boundary: provenance, the field allowlist, the coverage
 * distinctions, and the score arithmetic the SITE re-derives.
 *
 * ⛔ THE PROVENANCE TESTS EXIST BECAUSE OF A MEASURED FAILURE, NOT A THEORY.
 * The owner clicked a Fannin County GA row and was given `https://www.gsccca.org/`
 * — a bare homepage, on a host that is on our OWN sources.denied.yaml, so we
 * never fetched it and could not have. Both halves are asserted here, each with
 * a control that plants exactly that URL and proves the assertion goes red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRegistry } from '../pipeline/fetch/registry.ts';
import {
  ProvenanceError,
  arcgisRecordUrl,
  assertRecordUrlHonest,
  buildProvenance,
  isBareOrigin,
} from '../publish/provenance.ts';
import {
  NOTE_INGESTED,
  NOTE_NOT_RUN,
  NOTE_NO_SCORABLE_SIGNAL,
  NOTE_NO_SOURCE,
  NOTE_ZERO_DEALS,
  buildCoverage,
  readCountySeeds,
} from '../publish/coverage.ts';
import { assertScoreDerivable, deriveScore, type PublishedListing } from '../publish/payload.ts';
import { PublishAllowlistError, loadAllowlist, project } from '../publish/export.ts';

const ROOT = join(import.meta.dirname, '..');
const REGISTRY = loadRegistry(ROOT);
const PUBLISHED = join(ROOT, 'site', 'src', 'data', 'published', 'listings.json');

// ---------------------------------------------------------------------------
// PROVENANCE
// ---------------------------------------------------------------------------

test('⛔ a homepage is not provenance — a bare origin is refused as a record link', () => {
  assert.ok(isBareOrigin('https://www.gsccca.org/'), 'the exact URL the owner was shown');
  assert.ok(isBareOrigin('https://qpublic.net'));
  assert.ok(!isBareOrigin('https://services.nconemap.gov/x/MapServer/1/query?where=parno%3D%271%27'));

  assert.throws(
    () => assertRecordUrlHonest('https://www.example.com/', REGISTRY.denials),
    ProvenanceError,
    'CONTROL: planting a homepage URL must make the assertion go RED',
  );
  assert.doesNotThrow(() =>
    assertRecordUrlHonest('https://services.nconemap.gov/a/MapServer/1/query?where=x', REGISTRY.denials),
  );
});

test('⛔ a record_url on a DENIED host is refused — citing a source we may not fetch is fabricated', () => {
  const denied = REGISTRY.denials.map((d) => d.host);
  assert.ok(denied.includes('gsccca.org'), 'gsccca.org really is on our denylist');

  assert.throws(
    () => assertRecordUrlHonest('https://gsccca.org/search/record/12345', REGISTRY.denials),
    /sources\.denied\.yaml/,
    'CONTROL: a deep link on a denied host is still a fabricated citation and must go RED',
  );
  assert.throws(() => assertRecordUrlHonest('https://qpublic.net/ga/fannin/parcel/0008', REGISTRY.denials), ProvenanceError);
});

test('a county with no parcel source publishes record_url:null and HOW TO VERIFY, never a homepage', () => {
  const p = buildProvenance(
    { source_id: null, fips: '13111', county: 'Fannin', state: 'GA', parno: '0008', retrieved_at: '2026-08-19T00:00:00.000Z', root: process.cwd() },
    null,
    REGISTRY.denials,
  );
  assert.equal(p.record_url, null);
  assert.ok(p.how_to_verify !== null && p.how_to_verify.length > 20);
  assert.match(p.how_to_verify, /Fannin/);
  assert.equal(p.source_id, 'none', 'we do not name a source we never had');
});

test('the NC OneMap record link resolves to ONE record and survives hostile parcel numbers', () => {
  const layer = 'https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1';
  const url = arcgisRecordUrl(layer, '37189', "O'BRIEN 12/3 & 4");
  assert.ok(url !== null);
  const parsed = new URL(url);
  // The platform primitive did the escaping — the quote is DOUBLED for SQL and
  // then percent-encoded for the URL, and the round trip is exact.
  assert.equal(
    parsed.searchParams.get('where'),
    "stcntyfips='37189' AND parno='O''BRIEN 12/3 & 4'",
  );
  assert.ok(!isBareOrigin(url));
  assert.doesNotThrow(() => assertRecordUrlHonest(url, REGISTRY.denials));
  assert.equal(arcgisRecordUrl(layer, '37189', ''), null, 'no parcel number means no deep link, not a homepage');
});

test('⛔ EVERY published row has honest provenance — asserted over the whole file, not a sample', () => {
  assert.ok(
    existsSync(PUBLISHED),
    `${PUBLISHED} is ABSENT. Run \`npm run publish\`. An absent artifact is not a pass.`,
  );
  const rows = JSON.parse(readFileSync(PUBLISHED, 'utf8')) as PublishedListing[];
  assert.ok(rows.length > 0, 'an empty payload proves nothing');

  let withUrl = 0;
  let withHowTo = 0;
  for (const r of rows) {
    assert.ok(r.provenance, `${r.id} has no provenance block at all`);
    assert.notEqual(r.provenance.source_id, '', `${r.id} names no source`);
    if (r.provenance.record_url === null) {
      assert.ok(
        r.provenance.how_to_verify !== null && r.provenance.how_to_verify.trim() !== '',
        `${r.id} has neither a record link NOR instructions — that is an unsourced claim`,
      );
      withHowTo++;
    } else {
      assertRecordUrlHonest(r.provenance.record_url, REGISTRY.denials);
      assert.ok(new URL(r.provenance.record_url).pathname.length > 1);
      withUrl++;
    }
    assert.ok(!Number.isNaN(Date.parse(r.provenance.retrieved_at)));
  }
  assert.equal(withUrl + withHowTo, rows.length);
});

// ---------------------------------------------------------------------------
// THE SCORE THE SITE RE-DERIVES
// ---------------------------------------------------------------------------

test('⛔ every published score is exactly what its breakdown derives', () => {
  const rows = JSON.parse(readFileSync(PUBLISHED, 'utf8')) as PublishedListing[];
  for (const r of rows) assertScoreDerivable(r);

  // ⛔ THE CONTROLS RUN ON A SYNTHETIC ROW, and that is deliberate as of
  // 2026-08-19. They used to hunt the live corpus for a row with a scored
  // signal to corrupt. Since `per_acre` became the SELECTION AXIS rather than a
  // composite component, NO published row has a scored signal — discount,
  // distress, water and livability all lack inputs — so `find()` returned
  // undefined and these controls died on a TypeError.
  //
  // The arithmetic is what is under test here, not whether today's corpus
  // happens to contain a scored row. Binding a correctness control to a DATA
  // condition means it silently stops testing the moment the data changes,
  // which is the failure this suite exists to prevent. The loop above still
  // runs over every real row.
  const synthetic = (): PublishedListing =>
    structuredClone({
      ...rows[0]!,
      id: 'synthetic:control',
      score: 61, // water 19x1 + livability 12x0 = 19 over denominator 31 -> round(61.29)
      score_breakdown: {
        signals: [
          { key: 'water', label: 'Water', weight: 19, value: 1, note: 'synthetic' },
          { key: 'livability', label: 'Livability', weight: 12, value: 0, note: 'synthetic' },
          { key: 'distress', label: 'Distress', weight: 31, value: null, note: 'synthetic unknown' },
        ],
        denominator: 31,
        unknown_count: 1,
      },
    } as PublishedListing);
  const base = synthetic();
  assert.equal(base.score, deriveScore(base.score_breakdown.signals), 'the synthetic row must itself be self-consistent, or the controls below prove nothing');
  assertScoreDerivable(base);

  const victim = synthetic();
  const scored = victim.score_breakdown.signals.find((s) => s.value !== null)!;
  scored.weight += 7;
  assert.throws(
    () => assertScoreDerivable(victim),
    /denominator|derives/,
    'CONTROL: a mutated breakdown MUST fail the derivation check',
  );

  // CONTROL 2: an unknown signal published with weight 0 is an unknown scored
  // as zero, which is the defect this whole project is built around.
  const victim2 = synthetic();
  const unknown = victim2.score_breakdown.signals.find((s) => s.value === null)!;
  unknown.weight = 0;
  assert.throws(() => assertScoreDerivable(victim2), /unknown scored as zero/);
});

test('unknown signals are excluded from the denominator in the PUBLISHED payload', () => {
  const rows = JSON.parse(readFileSync(PUBLISHED, 'utf8')) as PublishedListing[];
  // ⛔ Do NOT take rows[0]. Lane-1 rows now sort first, and they are evidenced
  // but UNSCORED — every Jackson County REO parcel is zero-valued by the county,
  // so it has no measurable signal at all and `score` is null. This test is
  // about the denominator of a row that HAS a score; pick one explicitly and
  // assert that such a row exists, rather than assuming a position.
  // ⛔ As of 2026-08-19 the live corpus contains NO scored row at all: `per_acre`
  // moved to the selection axis and the four composite signals have no inputs
  // yet. That is an honest state, not a regression — but it made this test
  // vacuous, so the denominator arithmetic is now exercised on a synthetic row
  // and the corpus is asserted separately for the property it CAN still carry
  // (an unknown always ships its nominal weight, never 0).
  for (const row of rows) {
    for (const sig of row.score_breakdown.signals) {
      assert.ok(sig.weight > 0, `${row.id}: signal ${sig.key} ships weight 0 — an unknown scored as zero`);
    }
  }
  const r: PublishedListing = structuredClone({
    ...rows[0]!,
    id: 'synthetic:denominator',
    score: 61, // water 19x1 + livability 12x0 = 19 over denominator 31 -> round(61.29)
    score_breakdown: {
      signals: [
        { key: 'water', label: 'Water', weight: 19, value: 1, note: 'synthetic' },
        { key: 'livability', label: 'Livability', weight: 12, value: 0, note: 'synthetic' },
        { key: 'distress', label: 'Distress', weight: 31, value: null, note: 'synthetic unknown' },
      ],
      denominator: 31,
      unknown_count: 1,
    },
  } as PublishedListing);
  const unknowns = r.score_breakdown.signals.filter((s) => s.value === null);
  assert.ok(unknowns.length > 0, 'the real corpus has unknowns — if not, this test is vacuous');
  assert.equal(
    r.score_breakdown.denominator,
    r.score_breakdown.signals.filter((s) => s.value !== null).reduce((a, s) => a + s.weight, 0),
  );
  for (const u of unknowns) assert.ok(u.weight > 0, 'an unknown ships its NOMINAL weight, never 0');

  // CONTROL: the naive scorer — unknown counted as 0 over the full weight —
  // produces a different, lower number on the same row.
  const all = r.score_breakdown.signals;
  const naive = Math.round(
    (all.reduce((a, s) => a + s.weight * (s.value ?? 0), 0) / all.reduce((a, s) => a + s.weight, 0)) * 100,
  );
  // This fixture HAS scored signals, so a real number is expected here — the
  // assertion states that rather than assuming it, because deriveScore now
  // returns null for a row with nothing measurable.
  assert.equal(typeof r.score, 'number', 'fixture must have at least one scored signal');
  assert.notEqual(naive, r.score);
  assert.ok(naive < (r.score as number));
  assert.equal(deriveScore(r.score_breakdown.signals), r.score);
});

// ---------------------------------------------------------------------------
// THE FIELD ALLOWLIST — fails CLOSED
// ---------------------------------------------------------------------------

test('⛔ a planted owner-identity field cannot pass the publish allowlist', () => {
  const allow = loadAllowlist(ROOT);
  const rows = JSON.parse(readFileSync(PUBLISHED, 'utf8')) as PublishedListing[];
  assert.doesNotThrow(() => project('listing', rows[0] as unknown as Record<string, unknown>, allow));

  // CONTROL: the canary. One extra key and the boundary throws.
  const canary = { ...(rows[0] as unknown as Record<string, unknown>), ownname: 'SMITH, JOHN' };
  assert.throws(() => project('listing', canary, allow), PublishAllowlistError);
  const mailing = { ...(rows[0] as unknown as Record<string, unknown>), mailadd: '1 X LANE' };
  assert.throws(() => project('listing', mailing, allow), PublishAllowlistError);

  // And no PII field may even APPEAR on the allowlist.
  for (const kind of ['parcel', 'notice', 'listing'] as const) {
    for (const field of allow[kind]) {
      assert.ok(!/ownname|mailadd|ownfrst|ownlast|mcity|mstate|mzip/i.test(field), `allowlist ${kind} permits ${field}`);
    }
  }
});

test('no published row carries any owner-identity key, checked over the whole file', () => {
  const raw = readFileSync(PUBLISHED, 'utf8');
  for (const field of ['ownname', 'ownname2', 'ownfrst', 'ownlast', 'mailadd', 'mcity', 'mstate', 'mzip']) {
    assert.ok(!new RegExp(`"${field}"\\s*:`, 'i').test(raw), `published payload carries a "${field}" key`);
  }
  // CONTROL: the same scan, on a string that DOES contain one — proving the
  // regex fires rather than the payload being clean by accident of a typo.
  assert.ok(/"ownname"\s*:/i.test('{"ownname": "X"}'));
});

// ---------------------------------------------------------------------------
// COVERAGE — no-source vs not-run vs zero-deals vs nothing-scorable
// ---------------------------------------------------------------------------

test('⛔ the four coverage states never share a sentence', () => {
  const notes = [NOTE_NO_SOURCE, NOTE_NOT_RUN, NOTE_ZERO_DEALS, NOTE_NO_SCORABLE_SIGNAL, NOTE_INGESTED];
  assert.equal(new Set(notes).size, notes.length, 'all five notes are distinct strings');
  for (const a of notes) assert.ok(a.length > 40, 'each note explains itself in a sentence a reader can act on');
});

test('coverage: a county with no source, one not run, one with a real zero and one live', () => {
  const seeds = readCountySeeds(ROOT);
  assert.equal(seeds.length, 37, 'all 37 counties, always');
  const rows = buildCoverage(
    seeds,
    [{ fips: '37199', county: 'Yancey', run_id: 'r', ingest_status: 'complete', rows_fetched: 17332, rows_warehoused: 17332, unkeyed: 0, ingested_at: '2026-08-19T00:00:00.000Z' }],
    new Map([['37189', 46252], ['37199', 17332]]),
    new Map([['37189', 103]]),
    new Map([['37189', 41073], ['37199', 0]]),
  );
  const of = (fips: string) => rows.find((r) => r.fips === fips)!;

  assert.equal(of('13111').data_state, 'no-source', 'Fannin GA — vendor bot-wall, no source has ever existed');
  assert.equal(of('13111').rows, null, 'null rows, never 0 — 0 would be a measurement');
  assert.equal(of('37021').data_state, 'not-run', 'Buncombe — source registered, not yet run');
  assert.equal(of('37189').data_state, 'ingested');
  assert.equal(of('37199').data_state, 'ingested');

  assert.notEqual(of('13111').note, of('37021').note);
  assert.notEqual(of('37021').note, of('37199').note);
  assert.notEqual(of('13111').note, of('37199').note);
  assert.ok(of('37199').note.startsWith(NOTE_NO_SCORABLE_SIGNAL), 'Yancey publishes no values — that is not "no deals"');
  assert.ok(of('37021').note.startsWith(NOTE_NOT_RUN));

  // CONTROL: a county whose rows ARE scorable but none published gets the
  // zero-deals sentence instead — the two absences do not collapse into one.
  const zeroDeals = buildCoverage(
    seeds,
    [],
    new Map([['37199', 17332]]),
    new Map(),
    new Map([['37199', 900]]),
  ).find((r) => r.fips === '37199')!;
  assert.ok(zeroDeals.note.startsWith(NOTE_ZERO_DEALS));
  assert.notEqual(zeroDeals.note, of('37199').note);
});

test('the ledger and the row count disagreeing is NAMED, never smoothed over', () => {
  const seeds = readCountySeeds(ROOT);
  const row = buildCoverage(
    seeds,
    [{ fips: '37189', county: 'Watauga', run_id: 'r', ingest_status: 'not-run', rows_fetched: 0, rows_warehoused: 0, unkeyed: 0, ingested_at: '2026-08-19T00:00:00.000Z' }],
    new Map([['37189', 46252]]),
    new Map([['37189', 103]]),
    new Map([['37189', 41073]]),
  ).find((r) => r.fips === '37189')!;
  assert.equal(row.data_state, 'ingested', 'the FILE wins: 46,252 parcels are present');
  assert.equal(row.ledger_status, 'not-run', 'and the ledger claim is still published, named');
  assert.match(row.note, /Ledger note/);
  assert.match(row.note, /46,252/);
});

test('the published coverage file on disk carries all 37 counties and every state', () => {
  const path = join(ROOT, 'data', 'coverage.json');
  assert.ok(existsSync(path), 'data/coverage.json is ABSENT — run `npm run publish`');
  const doc = JSON.parse(readFileSync(path, 'utf8')) as { counties: { fips: string; data_state: string; note: string }[] };
  assert.equal(doc.counties.length, 37);
  const states = new Set(doc.counties.map((c) => c.data_state));
  assert.ok(states.has('no-source') && states.has('not-run') && states.has('ingested'), [...states].join(','));
  for (const c of doc.counties) assert.ok(c.note.trim() !== '', `${c.fips} has an empty note`);
});

// ---------------------------------------------------------------------------
test('zero measurable signals scores NULL, not 0', () => {
  // Measured case: every East Tennessee parcel. TN's statewide layer publishes
  // no assessed value, so discount (w30) and per_acre (w20) have no input, and
  // with water unenriched a TN row has nothing scoreable at all. A 6,208-acre
  // Unicoi County tract came out at score 0 — presented as the worst possible
  // deal when the truth is that it cannot be scored.
  const none = [
    { id: 'discount', name: 'Discount', value: null, weight: 30, effective_weight: 30, contribution: 0, unknown_reason: 'no assessed value in TN' },
    { id: 'per_acre', name: '$/acre', value: null, weight: 20, effective_weight: 20, contribution: 0, unknown_reason: 'needs value' },
    { id: 'water', name: 'Water', value: null, weight: 15, effective_weight: 15, contribution: 0, unknown_reason: 'not enriched' },
  ] as unknown as Parameters<typeof deriveScore>[0];
  assert.equal(deriveScore(none), null);
});

test('CONTROL — one measurable signal still scores a NUMBER', () => {
  // Without this, the assertion above would also pass if deriveScore returned
  // null unconditionally.
  const one = [
    { id: 'discount', name: 'Discount', value: null, weight: 30, effective_weight: 30, contribution: 0, unknown_reason: 'x' },
    { id: 'per_acre', name: '$/acre', value: 0.5, weight: 20, effective_weight: 20, contribution: 10, unknown_reason: null },
  ] as unknown as Parameters<typeof deriveScore>[0];
  assert.equal(deriveScore(one), 50);
});


// ---------------------------------------------------------------------------
// EVERY PUBLISHED ENUM VALUE MUST HAVE A UI BRANCH THAT MATCHES IT
// ---------------------------------------------------------------------------

test('⛔ every acreage_basis the payload emits is one the card actually renders', () => {
  // The defect this exists for: the payload emitted `deeded` on all 150 TN rows
  // while DealCard and the detail page both tested `=== 'deed'`. The comparison
  // was false everywhere, so the badge rendered NOTHING — silently, because an
  // unmatched value in a chain of `&&` guards produces no output and no error.
  //
  // It was not a cosmetic miss. The basis IS the RT-9 disclosure: TN acreage is
  // DEEDED, NC's is planimetric polygon area, and they diverge up to 29% on
  // measured samples — the second of ADR 0002's two grounds for disabling TN
  // value scoring. The only place a reader could learn which kind of acre they
  // were reading had never displayed.
  //
  // Asserting the UI SOURCE rather than the type: a union can be edited to match
  // the data while the component keeps comparing against the old string, which
  // is exactly how these two drifted apart.
  const rows = JSON.parse(readFileSync(PUBLISHED, 'utf8')) as PublishedListing[];
  const emitted = [...new Set(rows.map((r) => (r as { acreage_basis?: string }).acreage_basis).filter(Boolean))];
  assert.ok(emitted.length > 0, 'CONTROL: the payload must emit at least one basis, or this test is vacuous');

  const card = readFileSync(join(ROOT, 'site/src/components/DealCard.astro'), 'utf8');
  const detail = readFileSync(join(ROOT, 'site/src/pages/deal/[id].astro'), 'utf8');
  for (const value of emitted) {
    assert.ok(
      card.includes(`acreage_basis === '${value}'`),
      `DealCard.astro has no branch for acreage_basis '${value}' — ${rows.filter((r) => (r as { acreage_basis?: string }).acreage_basis === value).length} published row(s) would render no badge at all`,
    );
    assert.ok(
      detail.includes(`acreage_basis === '${value}'`),
      `deal/[id].astro has no branch for acreage_basis '${value}'`,
    );
  }

  // CONTROL: the assertion discriminates — a value nothing renders must fail it.
  assert.ok(
    !card.includes("acreage_basis === 'no-such-basis'"),
    'CONTROL: a basis the card does not handle must be detectable by this test',
  );
});
