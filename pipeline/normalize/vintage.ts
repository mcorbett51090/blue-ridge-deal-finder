/**
 * NCDOR assessment-vintage join (plan §4.6, TB2 binding).
 *
 * `parval` is frozen county-wide at the last reappraisal's market level —
 * G.S. 105-287 forbids adjusting appraised value between reappraisals for
 * general economic change — so vintage is a PER-COUNTY CONSTANT and `cntyfips`
 * is a complete key for it. It is not in the parcel layer at all; it comes from
 * seeds/dim_county_assessment.csv, built from the NCDOR reappraisal schedule.
 *
 * ⛔ THE TRIM IS LOAD-BEARING ON BOTH SIDES.
 * NCDOR ships trailing whitespace on the county name of every row ('Ashe ',
 * 'Avery '). The seed as committed has already been trimmed by the P0 pass, so
 * the committed file alone CANNOT prove the trim works — a join with no TRIM at
 * all reads green against it. That is why the control is
 * fixtures/ncdor-untrimmed.csv, which reproduces the raw NCDOR shape (trailing
 * spaces on BOTH the fips and the county columns).
 *
 * VALIDITY AND JOINING ARE SEPARATED ON PURPOSE. Cells are always trimmed for
 * SCHEMA validation — '37009 ' is a valid fips that has been typed badly, not an
 * invalid one, and failing the zod parse there would make the control go red for
 * the wrong reason (a loud throw instead of the silent join miss the acceptance
 * test is actually about). The raw, as-shipped values are kept alongside, and
 * `trimJoinKeys: false` builds the INDEX from those instead. That reproduces the
 * real defect: every row parses, every row looks fine, and `assessment_year` is
 * null on all of them. Nothing in the pipeline passes the option.
 *
 * ⛔ The committed seed is also CRLF. `split('\n')` therefore leaves a '\r' on
 * the LAST cell of every row, which today is `retrieved_at` and tomorrow is
 * whatever column someone appends after it. Every cell is stripped, not just
 * the ones that currently hurt.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const CountyAssessmentSchema = z.object({
  fips: z.string().regex(/^\d{5}$/),
  county: z.string().min(1),
  /** As shipped by NCDOR, whitespace and all. The untrimmed join key. */
  fips_raw: z.string(),
  county_raw: z.string(),
  last_reappraisal_year: z.number().int().min(1900).max(2100),
  next_reappraisal_year: z.number().int().min(1900).max(2100),
  cycle_years: z.number().int().positive(),
  source_url: z.string().url(),
  retrieved_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export type CountyAssessment = z.infer<typeof CountyAssessmentSchema>;

export type VintageTable = {
  byFips: Map<string, CountyAssessment>;
  byName: Map<string, CountyAssessment>;
  rows: CountyAssessment[];
};

export type LoadVintageOptions = {
  /**
   * ⛔ TEST-ONLY, and it is one side of the join, not both. `false` builds the
   * lookup index from the raw as-shipped values while the other side of the
   * join (the parcel layer's clean `cntyname`/`stcntyfips`) stays trimmed —
   * which is precisely "remove the TRIM() from one side" from acceptance 7.
   */
  trimJoinKeys?: boolean;
};

/** Strips the CR that the CRLF seed leaves on the last cell of every row. */
function noCr(raw: string): string {
  return raw.replace(/\r/g, '');
}

export function parseVintageCsv(text: string, options: LoadVintageOptions = {}): VintageTable {
  const trimKeys = options.trimJoinKeys !== false;
  const lines = text.split('\n').filter((l) => noCr(l).trim() !== '');
  const header = (lines[0] ?? '').split(',').map((h) => noCr(h).trim());
  const ix = Object.fromEntries(header.map((h, i) => [h, i]));

  const rows: CountyAssessment[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const raw = (name: string): string => noCr(cells[ix[name] ?? -1] ?? '');
    const at = (name: string): string => raw(name).trim();
    rows.push(
      CountyAssessmentSchema.parse({
        // Trimmed for VALIDITY: '37009 ' is a correct fips typed badly, not an
        // invalid one. The untrimmed original is kept beside it so the join
        // control has something real to be wrong about.
        fips: at('fips'),
        county: at('county'),
        fips_raw: raw('fips'),
        county_raw: raw('county'),
        last_reappraisal_year: Number(at('last_reappraisal_year')),
        next_reappraisal_year: Number(at('next_reappraisal_year')),
        cycle_years: Number(at('cycle_years')),
        source_url: at('source_url'),
        retrieved_at: at('retrieved_at'),
      }),
    );
  }

  return {
    rows,
    byFips: new Map(rows.map((r) => [trimKeys ? r.fips : r.fips_raw, r])),
    // The NAME index is upper-cased because the parcel layer spells counties in
    // title case. With trimKeys off this holds 'ASHE ' while the lookup asks for
    // 'ASHE', and nothing matches — silently, on every row.
    byName: new Map(rows.map((r) => [(trimKeys ? r.county : r.county_raw).toUpperCase(), r])),
  };
}

export function loadVintageTable(repoRoot: string, options: LoadVintageOptions = {}): VintageTable {
  const path = join(repoRoot, 'seeds', 'dim_county_assessment.csv');
  return parseVintageCsv(readFileSync(path, 'utf8'), options);
}

/**
 * The join itself. `fips` is the complete key; the NAME is a cross-check, not a
 * fallback — if the two disagree the seed is mis-keyed and we want to know,
 * rather than to quietly prefer one.
 */
export function assessmentYearFor(
  table: VintageTable,
  fips: string,
  countyName: string,
): number | null {
  // This side is ALWAYS trimmed. The control perturbs the seed index, not the
  // caller — a control that trims neither side would still match and prove
  // nothing, which is the trap in "remove the TRIM" stated loosely.
  const byFips = table.byFips.get(fips.trim());
  const byName = table.byName.get(countyName.trim().toUpperCase());
  if (byFips && byName && byFips.fips !== byName.fips) {
    throw new Error(
      `vintage seed disagrees with itself: fips ${fips} -> ${byFips.county}, ` +
        `name ${countyName} -> ${byName.fips}. Refusing to pick a winner.`,
    );
  }
  const hit = byFips ?? byName;
  return hit ? hit.last_reappraisal_year : null;
}

/**
 * Acceptance 7. `count(*) where assessment_year is null` must be 0 across the
 * ingested corpus. Stated as a positive shape — the rows that JOINED — so a
 * table that failed to load reads as a failure rather than as "no nulls found
 * in an empty set".
 */
export function assertVintageJoinComplete(
  observed: readonly { fips: string; county: string; assessment_year: number | null }[],
): void {
  if (observed.length === 0) {
    throw new Error('vintage join asserted over ZERO rows — an empty set has no nulls and proves nothing');
  }
  const missing = observed.filter((r) => r.assessment_year === null);
  if (missing.length > 0) {
    const names = [...new Set(missing.map((m) => `${m.fips}/${m.county}`))].slice(0, 5);
    throw new Error(
      `vintage join incomplete: ${missing.length} of ${observed.length} row(s) have assessment_year = null ` +
        `(e.g. ${names.join(', ')}). NCDOR ships trailing whitespace — the join must TRIM BOTH SIDES.`,
    );
  }
}
