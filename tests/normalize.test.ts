/** The trust boundary: sentinels, keys, and the redaction boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATE_SENTINEL_MS,
  partitionForScoring,
  positiveQuantity,
  safeDivide,
  sentinelDate,
  zeroValueShare,
  assertZeroShareWithinBudget,
} from '../pipeline/normalize/sentinel.ts';
import {
  assertObjectIdEnvelopeStable,
  assertUniqueRecordIds,
  assignKeys,
  isUnkeyed,
  normalizeParno,
} from '../pipeline/normalize/keys.ts';
import { PII_FIELDS, assertNoPii, deriveOwnerFacts, redact, stripPii } from '../pipeline/normalize/redact.ts';
import { laneOf, valueBasisFrom, ParcelSchema } from '../pipeline/normalize/parcels.ts';
import { percentileRank, rollUp } from '../pipeline/score/index.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
type Attrs = Record<string, unknown>;
const rowsOf = (name: string): Attrs[] =>
  (JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { features: { attributes: Attrs }[] }).features.map(
    (f) => f.attributes,
  );

test('⛔ a present ZERO is unknown, not cheap (RT-3)', () => {
  const zero = positiveQuantity(0);
  assert.equal(zero.status, 'unknown');
  assert.equal(zero.status === 'unknown' ? zero.reason : '', 'zero-sentinel', 'a 0 is a SENTINEL, not a measurement');
  assert.equal(positiveQuantity(-1).status, 'unknown');
  assert.equal(positiveQuantity(null).status, 'unknown');
  assert.equal(positiveQuantity('').status, 'unknown');
  assert.deepEqual(positiveQuantity(245000), { status: 'known', value: 245000 });
});

test('⛔ a zero denominator NEVER yields a finite score', () => {
  const value = positiveQuantity(125000);
  const acres = positiveQuantity(0);
  assert.equal(safeDivide(value, acres).status, 'unknown');
  assert.equal(safeDivide(positiveQuantity(0), positiveQuantity(10)).status, 'unknown');
  assert.deepEqual(safeDivide(positiveQuantity(100), positiveQuantity(4)), { status: 'known', value: 25 });
});

test('1900-01-01 is a NULL SENTINEL in every encoding it arrives in', () => {
  assert.equal(sentinelDate(DATE_SENTINEL_MS).status, 'unknown');
  assert.equal(sentinelDate('1900-01-01').status, 'unknown');
  assert.equal(sentinelDate('1/1/1900 12:00:00 AM').status, 'unknown', 'reviseyear is a STRING holding this');
  assert.equal(sentinelDate(1451606400000).status, 'known');
});

test('unknown is EXCLUDED from the denominator, never scored 0', () => {
  const rows = rowsOf('zero-sentinel.json');
  const { scored, excluded } = partitionForScoring(rows, (r) => positiveQuantity(r['parval']));
  assert.equal(scored.length + excluded.length, rows.length);
  assert.equal(excluded.length, 2, 'the two parval=0 rows leave the population entirely');

  // The defect being defended against: with the zeros scored as 0 they take the
  // TOP of a cheapness ranking. Excluded, they cannot compete at all.
  const population = scored.map((s) => s.value);
  assert.equal(population.includes(0), false);
  assert.equal(percentileRank(125000, population), 50);
});

test('the RT-3 distribution gate keys on VALUES, not on row count', () => {
  const clean = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(zeroValueShare(clean), 0);
  assert.equal(zeroValueShare([0, 1, 2, 3]), 25);
  assert.doesNotThrow(() => assertZeroShareWithinBudget('Watauga', clean, 4));
  assert.throws(() => assertZeroShareWithinBudget('Watauga', [0, 1, 2, 3], 4), /exceeds budget/);
});

test('⛔ parno alone is NOT a key (RT-2), and the composite one is', () => {
  const rows = rowsOf('duplicate-parno.json');
  const naive = rows.filter((r) => normalizeParno(r['parno']) !== '').map((r) => `${r['stcntyfips']}:${normalizeParno(r['parno'])}`);
  assert.throws(() => assertUniqueRecordIds(naive), /key collision/);

  const result = assignKeys({
    rows,
    getParno: (r) => r['parno'],
    getFips: (r) => r['stcntyfips'],
    getAttributeHash: (r) => JSON.stringify([r['parval'], r['gisacres']]),
  });
  assert.doesNotThrow(() => assertUniqueRecordIds(result.keyed.map((k) => k.record_id)));
  assert.equal(result.collapsedExactDuplicates, 1, 'the exact duplicate collapses');
  assert.equal(result.unkeyed.length, 1, "parno='' is quarantined, never merged");
  assert.equal(result.multiPartParnos.length, 1, 'differing attributes under one parno = a multi-part parcel');
});

test("⛔ parno is the EMPTY STRING, so a null check does not catch it", () => {
  assert.equal(isUnkeyed(''), 'empty-parno');
  assert.equal(isUnkeyed('   '), 'empty-parno');
  assert.equal(isUnkeyed(null), 'null-parno');
  assert.equal(isUnkeyed('1809-31-1234-000'), null);
  // The check someone would write instead, shown failing:
  const parno: unknown = '';
  assert.equal(parno === null, false, 'this is why isUnkeyed exists');
});

test('a multi-part parcel aggregates, never overwrites', () => {
  const rows = rowsOf('duplicate-parno.json').filter((r) => r['parno'] === '2907-88-0002-000');
  const result = assignKeys({
    rows,
    getParno: (r) => r['parno'],
    getFips: (r) => r['stcntyfips'],
    getAttributeHash: (r) => JSON.stringify([r['parval'], r['gisacres']]),
  });
  assert.equal(result.keyed.length, 2, 'both parts survive with their own part_seq');
  const total = result.keyed.reduce((a, k) => a + Number(k.row['gisacres']), 0);
  assert.equal(total, 40, 'a 28 + 12 tract is 40 acres, not 12');
});

test('a mid-run OBJECTID republish aborts the run', () => {
  assert.doesNotThrow(() => assertObjectIdEnvelopeStable({ min: 1, max: 47388 }, { min: 1, max: 47388 }));
  assert.throws(() => assertObjectIdEnvelopeStable({ min: 1, max: 47388 }, { min: 50001, max: 97388 }), /envelope shifted/);
});

test('⛔ PII is discarded, not hashed-and-kept (D1)', () => {
  const raw = rowsOf('pii-present.json')[0] as Attrs;
  const safe = stripPii(raw) as Attrs;
  for (const field of PII_FIELDS) assert.equal(field in safe, false, `${field} must not survive`);
  const serialised = JSON.stringify(safe);
  assert.equal(serialised.includes('ZZCANARY'), false, 'no name survives in any form, hashed or otherwise');
  assert.doesNotThrow(() => assertNoPii(safe, 'test'));
  assert.throws(() => assertNoPii(raw, 'test'), /survived the redaction boundary/);
});

test('the derived booleans are computed BEFORE the discard', () => {
  const raw = rowsOf('pii-present.json')[0] as Attrs;
  const { derived, safe } = redact(raw, 'NC', new Date('2026-08-19T00:00:00Z'));
  assert.equal(derived.owner_out_of_state, true, "mstate 'TN' against an NC parcel");
  assert.equal(derived.owner_is_entity, false);
  assert.equal(derived.owner_is_government, false);
  assert.equal(derived.tenure_years, 21, 'sale in 2005 → 21 years at 2026');
  assert.equal('ownname' in (safe as Attrs), false);
});

test('the government veto needs the parusedesc half — free text alone fails open', () => {
  const stateOwned = deriveOwnerFacts({ ownname: 'STATE OF NORTH CAROLINA', parusedesc: 'GOVERNMENT' }, 'NC');
  assert.equal(stateOwned.owner_is_government, true);

  // ⛔ The two rows a free-text veto MISSES, caught only by parusedesc — and
  // 'COMMONE' is upstream's misspelling, matched verbatim.
  const hoa = deriveOwnerFacts({ ownname: 'CASEYS GAP PROPERTY OWNERS ASSOC.', parusedesc: 'EXCLUSIONS (COMMONE AREAS)' }, 'NC');
  assert.equal(hoa.owner_is_government, true);
  const person = deriveOwnerFacts({ ownname: 'LYONS, LOUISE E', parusedesc: 'EXCLUSIONS (COMMONE AREAS)' }, 'NC');
  assert.equal(person.owner_is_government, true, 'a personal name on HOA common area is still not purchasable');
});

test('tenure_years is null on the date sentinel, never 126', () => {
  const d = deriveOwnerFacts({ saledate: DATE_SENTINEL_MS }, 'NC', new Date('2026-08-19T00:00:00Z'));
  assert.equal(d.tenure_years, null);
});

test('mstate absent is null (unknown), not false (in state)', () => {
  assert.equal(deriveOwnerFacts({ mstate: '' }, 'NC').owner_out_of_state, null);
  assert.equal(deriveOwnerFacts({ mstate: 'NC' }, 'NC').owner_out_of_state, false);
});

test('value basis: casing variants normalise; Taxable stays incomparable; unknown fails closed', () => {
  assert.equal(valueBasisFrom('Assessed'), 'market_equivalent');
  assert.equal(valueBasisFrom('ASSESSED'), 'market_equivalent', 'Northampton casing must not drop a county');
  assert.equal(valueBasisFrom('Market'), 'market_equivalent');
  assert.equal(valueBasisFrom('Taxable'), 'net_of_exemptions');
  assert.equal(valueBasisFrom(''), 'unknown');
  assert.equal(valueBasisFrom(undefined), 'unknown');
});

test('for_sale_evidence is first-class and decides the lane', () => {
  assert.equal(laneOf({ for_sale_evidence: null }), 'prospecting');
  assert.equal(
    laneOf({
      for_sale_evidence: {
        kind: 'tax_sale',
        source_url: 'https://example.gov/notice/1',
        observed_at: '2026-08-19T00:00:00.000Z',
      },
    }),
    'on-market-or-distress',
  );
  // A row cannot omit the field: the schema requires it, so drift into Lane 1
  // cannot happen by forgetting to set it.
  assert.equal(ParcelSchema.shape.for_sale_evidence.isOptional(), false);
});

test('score roll-up: unknown components leave the denominator', () => {
  const mk = (id: string, status: 'scored' | 'unknown', normalized: number | null, weight: number) => ({
    id, nominal_weight: weight, effective_weight: status === 'scored' ? weight : 0,
    status, raw: normalized, normalized, contribution: 0, basis: 'test', sources: [],
  });
  const res = rollUp([
    mk('per_acre', 'scored', 80, 20),
    mk('discount', 'unknown', null, 30),
  ] as never);
  assert.equal(res.total, 80, 'the unknown component does not drag the score down');
  assert.equal(Math.round(res.confidence * 100) / 100, 0.4, 'but it IS reported as low confidence');
});
