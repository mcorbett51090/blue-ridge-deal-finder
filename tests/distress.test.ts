import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { parseJacksonReo, DistressParseError } from '../pipeline/ingest/distress/jackson-reo.ts';
import { hasTextLayer, flatten } from '../pipeline/ingest/distress/pdf-text.ts';

const PDF = 'fixtures/distress/jackson-reo.pdf';

test('the real Jackson REO document parses every PIN it contains', { skip: !existsSync(PDF) }, () => {
  const rows = parseJacksonReo(readFileSync(PDF));
  // 8 is the measured count. The parser's own PIN-vs-row control is what
  // enforces completeness; this pins the number so a silent shrink is visible.
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => /^\d{4}-\d{2}-\d{4}$/.test(r.pin)));
});

test('⛔ NO OWNER NAME survives parsing — the segment is never captured', { skip: !existsSync(PDF) }, () => {
  const rows = parseJacksonReo(readFileSync(PDF));
  const json = JSON.stringify(rows);
  // The document contains "Bush,Bonnie", "Clark,RennieJr", "Heino,Olga" and
  // others. None may appear in the output.
  for (const name of ['Bush', 'Clark', 'Heino', 'Lester', 'Teel', 'Kevlin']) {
    assert.equal(json.includes(name), false, `owner surname "${name}" leaked into the parsed output`);
  }
  // CONTROL: the names really ARE in the source, so the assertion above is not
  // passing because the document happens to be name-free.
  const flat = flatten(readFileSync(PDF));
  assert.ok(flat.includes('Bush'), 'CONTROL: the source document must contain the names being excluded');
});

test('a rows-with-no-price record still parses, with price UNKNOWN not zero', { skip: !existsSync(PDF) }, () => {
  const rows = parseJacksonReo(readFileSync(PDF));
  const noPrice = rows.filter((r) => r.price_owed_usd === null);
  // The three Bel-Aire Estates parcels held since 1/2012 carry no price.
  assert.ok(noPrice.length >= 1, 'the document has price-less rows; they must parse, not be dropped');
  for (const r of noPrice) {
    assert.notEqual(r.price_owed_usd, 0, 'absent price must be null — a $0 would read as "free"');
    assert.ok(r.acquired, 'a price-less row still has an acquisition date');
  }
});

test('CONTROL — a scanned (text-layer-free) PDF THROWS, it does not return []', () => {
  // "Unreadable" and "no properties listed" are different facts. Haywood
  // County's foreclosure PDFs are scanned images; returning [] for one would
  // publish "no distressed properties in Haywood" as though it were measured.
  const fake = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n');
  assert.equal(hasTextLayer(fake), false);
  assert.throws(() => parseJacksonReo(fake), DistressParseError);
});
