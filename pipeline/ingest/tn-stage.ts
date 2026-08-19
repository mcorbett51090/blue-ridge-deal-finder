/**
 * East Tennessee staging — the same StagedParcel shape, a different upstream.
 *
 * TN is STRUCTURALLY THINNER THAN NC and the differences are not cosmetic:
 *
 *   NC (NC1Map_Parcels/MapServer/1)     TN (Tennessee_Property_Boundaries/0)
 *   ─────────────────────────────────   ────────────────────────────────────
 *   gisacres   GIS-computed acreage     DEEDAC   DEEDED acreage
 *   parval     assessed value           —        NOTHING. No value field at all.
 *   parvaltype value basis              —        n/a
 *   sourcedate deed date                —        n/a
 *   saledate   last sale (epoch ms)     —        n/a
 *   siteadd    situs address            ADDRESS  situs address
 *   ownname    owner (PII)              OWNER    owner (PII), plus OWNER2
 *   parno      parcel id                PARCELID parcel id
 *   —                                   LINK_TPAD  join key to the state
 *                                                  assessment system
 *
 * ⛔ NO ASSESSED VALUE EXISTS. `discount` (weight 30) and `per_acre` (20) are
 * therefore permanently UNKNOWN for every TN row — half the scoring weight,
 * unavailable by construction, not by omission. `value` is null with a reason
 * and is NEVER 0: a zero would rank every TN parcel as infinitely cheap.
 *
 * ⛔ ACREAGE BASIS DIFFERS. NC's is computed from polygon geometry; TN's comes
 * off the deed instrument. They disagree materially on irregular mountain
 * parcels, and `acreage_basis` records which so a cross-state comparison cannot
 * silently mix them. `deeded` is the honest label here, not `gis`.
 *
 * ⛔ LINK_TPAD IS NOT FOLLOWED. It points at where TN value lives, but the
 * coverage probe for that hop failed its own control (a page listing all 95
 * counties matched every county name, including the ones TPAD excludes), so
 * whether our five targets are covered is genuinely unknown. Shipping
 * value-disabled is the honest state; guessing would be worse than the gap.
 */
import { redact } from '../normalize/redact.ts';
import { positiveQuantity } from '../normalize/sentinel.ts';
import { flatten, type StagedParcel } from './stage.ts';

export type TnStageContext = { state: 'TN'; county: string; fips: string; now: Date };

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

export function stageTnRow(
  attrs: Record<string, unknown>,
  recordId: string,
  parcelId: string,
  partSeq: number,
  partCount: number,
  ctx: TnStageContext,
): StagedParcel {
  // ── THE REDACTION BOUNDARY ──────────────────────────────────────────────
  // OWNER / OWNER2 are consumed here and never referenced again. redact()
  // throws if any PII key survives, and matching is case-insensitive, so the
  // uppercase TN spelling is caught by the same list as NC's lowercase one.
  const { safe, derived } = redact(attrs, ctx.state, ctx.now);
  const a = safe as Record<string, unknown>;

  // DEEDAC, not gisacres — and the same zero-as-unknown sentinel rule applies:
  // a 0-acre parcel is a county that published nothing, not a parcel of no size.
  const acreage = positiveQuantity(a['DEEDAC'] ?? a['deedac']);
  const acreageCols = flatten(acreage);

  const address = str(a['ADDRESS'] ?? a['address']);

  return {
    record_id: recordId,
    fips: ctx.fips,
    state: 'TN',
    county: ctx.county,
    parno: parcelId,
    part_seq: partSeq,
    part_count: partCount,

    acreage: acreageCols.value,
    acreage_unknown_reason: acreageCols.unknown_reason,
    // Deeded, never 'gis'. Mislabelling this would let a deeded figure be
    // compared against a GIS-computed one as though they measured the same thing.
    acreage_basis: acreage.status === 'known' ? 'deeded' : 'unknown',

    value: null,
    value_unknown_reason:
      'Tennessee\'s statewide parcel layer publishes no assessed value — there is no such field ' +
      'among its 17 columns. Value lives in the state assessment system (LINK_TPAD), a separate ' +
      'hop whose coverage for these counties is unverified, so it is not followed. Unknown, not zero.',
    value_basis: 'unknown',
    value_basis_raw: '',

    deed_date: null,
    deed_date_unknown_reason: 'The TN layer publishes no deed date.',
    sale_date: null,
    sale_date_unknown_reason: 'The TN layer publishes no sale date.',

    assessment_year: null,

    owner_out_of_state: derived.owner_out_of_state === null ? null : derived.owner_out_of_state ? 1 : 0,
    owner_is_entity: derived.owner_is_entity === null ? null : derived.owner_is_entity ? 1 : 0,
    owner_is_government: derived.owner_is_government ? 1 : 0,
    // Tenure needs a sale date, which TN does not publish.
    tenure_years: null,

    // TN publishes PARCEL_TYPE rather than a use description. Kept verbatim
    // rather than mapped onto NC's vocabulary — an invented mapping would make
    // the veto's use-class patterns match things they were never measured against.
    parusedesc: str(a['PARCEL_TYPE'] ?? a['parcel_type']),
    siteadd: address,

    lat: null,
    lng: null,
  } as StagedParcel;
}
