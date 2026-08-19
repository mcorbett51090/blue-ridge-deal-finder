#!/usr/bin/env node
/**
 * verify-ingest-guards.mjs — the trust boundary refuses the payloads it must.
 *
 * Every entry in fixtures/ingest-expectations.json under `must_reject` is a
 * measured defect from this project's own probe log, replayed through the real
 * guard code. Delete a guard from pipeline/normalize/ and the corresponding
 * fixture stops throwing, and this gate goes red. That is the detector — not
 * the fixture count, which would still be right.
 *
 * `must_accept` is the green control. A gate that only ever sees bad input
 * cannot distinguish "rejects the right things" from "rejects everything".
 */
import { join } from 'node:path';
import { Gate, inspectRoot, readJson, selfRoot } from './lib/gate.mjs';
import { assertControlBlock, assertHealthy } from '../pipeline/fetch/assert-healthy.ts';
import { assertUniqueRecordIds, assignKeys, normalizeParno } from '../pipeline/normalize/keys.ts';
import { positiveQuantity, safeDivide, sentinelDate } from '../pipeline/normalize/sentinel.ts';
import { assertNoPii, stripPii } from '../pipeline/normalize/redact.ts';
import { assertFieldsAllowlisted, loadAllowlist } from '../publish/export.ts';

const gate = new Gate('verify-ingest-guards');
const root = inspectRoot();
const fixturesDir = join(root, 'fixtures');

const GUARDS = {
  /** §4.2 — assert POSITIVE SHAPE, never a negative threshold. */
  health(payload, entry) {
    assertHealthy(payload, { minRows: entry.min_rows ?? 1, paging: false }, 'fixture');
  },

  /** RT-1 fix #3 — the per-batch control block. */
  'control-block'(payload) {
    assertControlBlock(
      { positiveCount: payload.positiveCount, negativeCount: payload.negativeCount },
      { positiveCount: 47388, negativeCount: 0 },
      'fixture',
    );
  },

  /**
   * RT-2 — keying on `parno` alone collapses rows. This guard asserts the
   * NAIVE key is not unique, which is what makes it throw on the fixture; it
   * then checks that the composite key IS unique, so a broken assignKeys turns
   * the throw into a different, louder failure rather than into silence.
   */
  'naive-parno-key'(payload) {
    const rows = payload.features.map((f) => f.attributes);
    const naive = rows
      .filter((r) => normalizeParno(r.parno) !== '')
      .map((r) => `${r.stcntyfips}:${normalizeParno(r.parno)}`);
    const result = assignKeys({
      rows,
      getParno: (r) => r.parno,
      getFips: (r) => r.stcntyfips,
      getAttributeHash: (r) => JSON.stringify([r.parval, r.gisacres]),
    });
    assertUniqueRecordIds(result.keyed.map((k) => k.record_id)); // must NOT throw
    if (result.unkeyed.length === 0) {
      throw new Error("composite keying found no unkeyed rows — parno='' was not detected");
    }
    assertUniqueRecordIds(naive); // MUST throw on this fixture
  },

  /**
   * RT-3 — zeros are unknown, and unknown never reaches a score. Throws when the
   * payload carries zero sentinels AND they were correctly classified. If
   * sentinel.ts is ever weakened so a 0 reads as `known`, this stops throwing
   * and the gate goes red.
   */
  'zero-sentinel'(payload) {
    const rows = payload.features.map((f) => f.attributes);
    const offenders = [];
    for (const r of rows) {
      const parval = positiveQuantity(r.parval);
      const acres = positiveQuantity(r.gisacres);
      if (r.parval === 0 && parval.status !== 'unknown') {
        throw new Error(`parval 0 classified as ${parval.status} — the zero-sentinel rule did not engage`);
      }
      if (r.gisacres === 0 && acres.status !== 'unknown') {
        throw new Error(`gisacres 0 classified as ${acres.status} — the zero-sentinel rule did not engage`);
      }
      const perAcre = safeDivide(parval, acres);
      if (r.gisacres === 0 && perAcre.status !== 'unknown') {
        throw new Error('safeDivide produced a finite $/acre from a zero denominator');
      }
      if ('saledate' in r && sentinelDate(r.saledate).status === 'known' && r.saledate <= 0) {
        throw new Error('the 1900-01-01 / epoch-0 date sentinel was read as a real date');
      }
      if (parval.status === 'unknown' || acres.status === 'unknown') offenders.push(r.parno);
    }
    if (offenders.length > 0) {
      throw new Error(`${offenders.length} row(s) carry zero sentinels and are excluded from scoring, not scored 0`);
    }
  },

  /** D1 — PII must not survive the redaction boundary. */
  pii(payload) {
    const attrs = payload.features[0].attributes;
    const safe = stripPii(attrs);
    assertNoPii(safe, 'fixture'); // must NOT throw — stripPii did its job
    assertNoPii(attrs, 'raw'); // MUST throw — the raw record still carries PII
  },

  /** The publish allowlist fails CLOSED on a field nobody has heard of yet. */
  'publish-allowlist'(payload) {
    assertFieldsAllowlisted(payload.kind, payload.record, loadAllowlist(selfRoot()));
  },
};

const manifest = readJson(join(fixturesDir, 'ingest-expectations.json'));

for (const entry of manifest.must_reject ?? []) {
  const guard = GUARDS[entry.guard];
  if (!guard) {
    gate.fail(`unknown guard '${entry.guard}' in manifest`);
    continue;
  }
  let threw = null;
  try {
    guard(readJson(join(fixturesDir, entry.file)), entry);
  } catch (err) {
    threw = err;
  }
  if (!threw) {
    gate.fail(`ACCEPTED a payload that must be rejected: ${entry.file} via guard '${entry.guard}'`);
  } else if (entry.expect_check && !String(threw.message).includes(entry.expect_check)) {
    // Rejected for the WRONG reason is not a pass: the fixture would then be
    // proving a different guard than the one it was written for.
    gate.fail(`${entry.file}: rejected but not on check '${entry.expect_check}' — got: ${threw.message}`);
  } else {
    gate.ok(`${entry.guard} rejected ${entry.file}`);
  }
}

for (const entry of manifest.must_accept ?? []) {
  const guard = GUARDS[entry.guard];
  if (!guard) {
    gate.fail(`unknown guard '${entry.guard}' in manifest`);
    continue;
  }
  try {
    guard(readJson(join(fixturesDir, entry.file)), entry);
    gate.ok(`${entry.guard} accepted ${entry.file} (green control)`);
  } catch (err) {
    gate.fail(`REJECTED a payload that must be accepted: ${entry.file} — ${err.message}`);
  }
}

if ((manifest.must_accept ?? []).length === 0) {
  gate.fail('manifest has no must_accept entry — without a green control this gate cannot tell "correct" from "rejects everything"');
}

gate.finish();
