/**
 * The Parcel record — the zod schema at the trust boundary (plan §4).
 *
 * Written NOW, before any pipeline code exists, because this is the cheapest
 * possible moment to make the lane distinction unfalsifiable: with
 * `for_sale_evidence` first-class and nullable from the first commit, a row
 * cannot silently drift into Lane 1 downstream (§4.9, TB1 §3.1, binding).
 */
import { z } from 'zod';

/** Mirrors Measured<number> from sentinel.ts. Unknown carries its reason. */
export const MeasuredNumberSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('known'), value: z.number() }),
  z.object({
    status: z.literal('unknown'),
    reason: z.enum([
      'zero-sentinel', 'negative', 'null', 'non-numeric', 'date-sentinel', 'empty-string',
      'implausible-date',
    ]),
  }),
]);

/**
 * §4.9 — first-class and nullable. `null` means Lane 2 (PROSPECTING), which is
 * the default state of every row in the corpus. Non-null means something in the
 * PUBLIC RECORD says the parcel is available; it is never inferred.
 * Never store notice prose or photos — extract facts, link to the source.
 */
export const ForSaleEvidenceSchema = z
  .object({
    kind: z.enum(['foreclosure_notice', 'trustee_sale', 'tax_sale', 'gov_reo', 'listing']),
    source_url: z.string().url(), // must resolve — asserted by the link-check gate
    observed_at: z.string().datetime(), // what the freshness badge measures
    sale_date: z.string().datetime().optional(),
    opening_bid: z.number().nonnegative().optional(),
    ask: z.number().nonnegative().optional(),
    upset_bid_deadline: z.string().datetime().optional(), // NC's 10-business-day restart clock (B2)
  })
  .nullable();

/**
 * §4.7 (RT-9). NC `gisacres` is PLANIMETRIC POLYGON AREA; TN `DEEDAC` is the
 * DEEDED figure. On 20–40% slopes these diverge materially, and a 10–15%
 * acreage error on a 40-acre tract is a five-figure price error found after
 * earnest money. Never rank across bases without explicit normalisation.
 */
export const AcreageBasisSchema = z.enum(['gis', 'deeded', 'unknown']);

/**
 * §4.6 (TB2). `Taxable` is a genuinely different quantity — net of exemptions
 * and present-use deferral — so a deferred farm parcel shows a huge fake
 * discount if it is pooled with `Assessed`. `unknown` FAILS CLOSED.
 */
export const ValueBasisSchema = z.enum(['market_equivalent', 'net_of_exemptions', 'unknown']);

/**
 * §4.8 (E2.6). `siteadd` is an EMPTY STRING, not null, on vacant land — exactly
 * the parcels this tool exists to find. We never geocode by address at all;
 * coordinates come from the parcel polygon.
 */
export const CoordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  coord_source: z.literal('parcel-centroid'),
  approx: z.literal(false),
});

export const ParcelSchema = z.object({
  // §4.3 — `${stcntyfips}:${normalize(parno)}:${part_seq}`. NEVER objectid.
  record_id: z.string().regex(/^\d{5}:[^:]+:\d+$/),
  fips: z.string().regex(/^\d{5}$/),
  state: z.string().length(2),
  county: z.string().min(1),
  parno: z.string().min(1),
  part_seq: z.number().int().nonnegative(),
  /** > 1 renders "multi-part parcel — N recorded polygons". Never overwrite parts. */
  part_count: z.number().int().positive(),

  acreage: MeasuredNumberSchema,
  acreage_basis: AcreageBasisSchema,
  value: MeasuredNumberSchema,
  value_basis: ValueBasisSchema,
  value_basis_raw: z.string(),

  /**
   * §4.6/E8.1 — RENAMED ON INGEST. `sourcedate` equals `saledate` on 1000 of
   * 1000 rows; its authoritative alias is "Source Document Date". Printing it
   * under an "assessment vintage" label would be a WRONG NUMBER WITH AN
   * AUTHORITATIVE LABEL — worse than the omission it repaired.
   */
  deed_date: MeasuredNumberSchema,
  /** Assessment vintage comes from seeds/dim_county_assessment.csv, keyed by fips. */
  assessment_year: z.number().int().nullable(),

  geometry: z.object({
    centroid: CoordinateSchema,
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    geometry_hash: z.string(),
  }).nullable(),

  // Redaction boundary output only. No name, no mailing address, ever.
  owner_out_of_state: z.boolean().nullable(),
  owner_is_entity: z.boolean().nullable(),
  owner_is_government: z.boolean(),
  tenure_years: z.number().int().nonnegative().nullable(),

  for_sale_evidence: ForSaleEvidenceSchema,

  /** Absent from a gate-passing complete pull → `stale`. Never hard-deleted. */
  status: z.enum(['active', 'stale']),
  first_seen: z.string().datetime(),
  last_seen: z.string().datetime(),
});

export type Parcel = z.infer<typeof ParcelSchema>;
export type ForSaleEvidence = z.infer<typeof ForSaleEvidenceSchema>;

/** §4.6 staging rule. Case-unstable upstream: 'ASSESSED' (Northampton) is a
 * casing variant, and a case-sensitive WHERE drops a whole county silently. */
export function valueBasisFrom(parvaltype: unknown): z.infer<typeof ValueBasisSchema> {
  const v = (typeof parvaltype === 'string' ? parvaltype : '').trim().toUpperCase();
  switch (v) {
    case 'ASSESSED':
    case 'MARKET':
    case 'APPRAISED':
      return 'market_equivalent'; // G.S. 105-283 "true value in money"
    case 'TAXABLE':
      return 'net_of_exemptions'; // NOT comparable
    default:
      return 'unknown'; // FAIL CLOSED
  }
}

/** Lane assignment is a pure function of the field, never of a heuristic. */
export function laneOf(parcel: Pick<Parcel, 'for_sale_evidence'>): 'on-market-or-distress' | 'prospecting' {
  return parcel.for_sale_evidence === null ? 'prospecting' : 'on-market-or-distress';
}
