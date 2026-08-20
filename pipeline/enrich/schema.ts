/**
 * The enrichment result shape (plan §5.5, §5.6).
 *
 * ⛔ THE ONE INVARIANT THIS FILE ENCODES: A SIGNAL IS EITHER MEASURED OR IT
 * CARRIES A REASON, AND NEVER BOTH, AND NEVER NEITHER.
 *
 * The owner's complaint that opened P7 was that every signal rendered
 * "unknown". The tempting fix is to make the unknowns into numbers. The
 * dangerous fix is to make them into ZEROS and FALSES, which look like numbers
 * and read like measurements:
 *   `has_stream: false`  says we looked and there is no stream.
 *   `has_stream: null` + `water_unknown_reason: 'nhd_no_coverage'`
 *                        says we could not look.
 * A buyer acts differently on those two, so the type system is not allowed to
 * let them collapse. Every block below is refined so that a non-null reason
 * forces every measured field to null — asserted at the parse boundary, not
 * left to a convention someone forgets at 11pm.
 */
import { z } from 'zod';

/** Why a signal could not be measured. Closed set — a free-text reason is a
 *  reason nobody can filter on, and the site renders these verbatim. */
export const WaterUnknownReason = z.enum([
  /** No NHD feature of any kind within the locality probe — coverage, not water. */
  'nhd_no_coverage_in_cell',
  /** The parcel polygon could not be obtained, so nothing can be intersected. */
  'parcel_geometry_absent',
  /** NHD answered, but not with a body we can trust (in-band error, bad shape). */
  'nhd_unhealthy_response',
  /** The water computation exceeded its per-parcel budget and was abandoned.
   *  ⛔ THIS IS UNKNOWN, NOT ABSENT, and the distinction is the whole reason the
   *  reason exists. A timeout tracks HYDROGRAPHIC DENSITY — the denser the
   *  stream network, the longer the maths — so recording it as `has_stream:
   *  false` would null out exactly the water-rich parcels and leave the dry ones
   *  measured, making the `water` signal ANTI-CORRELATED with water. That is
   *  worse than no signal, because it is confidently backwards. */
  'enrich_timeout',
]);

export const FloodUnknownReason = z.enum([
  /** hazards.fema.gov/robots.txt disallows /arcgis and /*?* — see sources.enrich.yaml. */
  'nfhl_robots_disallow',
  /** NFHL layer 0 (Availability) has no polygon covering this parcel. */
  'nfhl_no_coverage',
  'parcel_geometry_absent',
  'nfhl_unhealthy_response',
]);

export const SlopeUnknownReason = z.enum([
  'epqs_non_json_body',
  'epqs_no_elevation_at_point',
  'parcel_geometry_absent',
  'epqs_sample_incomplete',
]);

export const RoadUnknownReason = z.enum([
  /** tigerweb.geo.census.gov robots.txt is a WAF page — see sources.enrich.yaml. */
  'tiger_robots_unobtainable',
  'tiger_no_coverage',
  'parcel_geometry_absent',
  'tiger_unhealthy_response',
]);

/**
 * NHD hydrographic regime, from FCode. ⛔ `unspecified` IS NOT `perennial`.
 *
 * MEASURED in one 0.1° cell over Watauga County NC, 2026-08-19 — 499 flowlines:
 *   fcode 46000 Stream/River, no hydrographic category   342  (69%)
 *   fcode 46006 Stream/River: Perennial                   90  (18%)
 *   fcode 46003 Stream/River: Intermittent                27  (5%)
 *   fcode 55800 Artificial Path (through a waterbody)     35  (7%)
 *   fcode 33400 Connector (synthetic)                      5  (1%)
 * Two thirds of the flowlines in this county carry NO regime at all. Reporting
 * those as perennial creek frontage would be the single biggest fabrication
 * available in this codebase, so `unspecified` is its own bucket and the site
 * can say "stream, regime not recorded by USGS" — which is the truth.
 */
export const WaterRegime = z.enum(['perennial', 'intermittent', 'ephemeral', 'unspecified']);

export const FrontageByRegimeSchema = z.object({
  perennial: z.number().nonnegative(),
  intermittent: z.number().nonnegative(),
  ephemeral: z.number().nonnegative(),
  unspecified: z.number().nonnegative(),
});

/** How the numbers were derived. Rendered next to them, never hidden. */
export const WaterConfidence = z.enum([
  /** The real recorded parcel polygon was intersected with the real NHD lines. */
  'polygon-intersection',
  /**
   * ⛔ Only the parcel BBOX was available, so "crosses the property" is really
   * "crosses the bounding rectangle". A bbox over-reports frontage for any
   * parcel that is not rectangular. Never emitted silently.
   */
  'bbox-approximation',
]);

const WaterMeasuredSchema = z.object({
  has_stream: z.boolean().nullable(),
  has_river: z.boolean().nullable(),
  has_pond: z.boolean().nullable(),
  /** Length of flowline ∩ parcel polygon, ALL regimes summed. */
  water_frontage_m: z.number().nonnegative().nullable(),
  frontage_by_regime_m: FrontageByRegimeSchema.nullable(),
  /** min(min_dist_flowline_m, min_dist_waterbody_m). 0 when water is on the parcel. */
  distance_to_water_m: z.number().nonnegative().nullable(),
  min_dist_flowline_m: z.number().nonnegative().nullable(),
  min_dist_waterbody_m: z.number().nonnegative().nullable(),
  waterbody_overlap_m2: z.number().nonnegative().nullable(),
  /** GNIS names of the intersecting features. CORROBORATION ONLY (plan §5.5). */
  named_waters: z.array(z.string()),
  /** Nothing beyond this radius was looked for; a null distance means "not within". */
  search_radius_m: z.number().positive(),
  water_confidence: WaterConfidence.nullable(),
  water_unknown_reason: WaterUnknownReason.nullable(),
  /** Deep link to the exact NHD query behind these numbers (verify-provenance). */
  source_url: z.string().url().nullable(),
});

/**
 * The refinement that makes "unknown is never zero" a PROPERTY rather than a
 * promise. Every measured field must be null when a reason is present, and
 * every one of them must be non-null when it is absent.
 */
export const WaterSignalSchema = WaterMeasuredSchema.superRefine((w, ctx) => {
  // ⛔ THE DISTANCE FIELDS ARE DELIBERATELY NOT IN THIS LIST.
  // `min_dist_flowline_m: null` alongside `search_radius_m: 500` is a
  // MEASUREMENT — "we looked out to 500 m and there is no flowline" — not an
  // unmeasured field. Demanding a number there would force the code to invent
  // one (Infinity, -1, or 9999), and every one of those becomes a plausible
  // distance the moment it reaches a template. The first live run of P7 failed
  // this refinement for exactly that reason, which is the refinement working.
  const measured = [
    w.has_stream, w.has_river, w.has_pond, w.water_frontage_m,
    w.frontage_by_regime_m, w.waterbody_overlap_m2, w.water_confidence,
  ];
  if (w.water_unknown_reason !== null) {
    if ([...measured, w.min_dist_flowline_m, w.min_dist_waterbody_m, w.distance_to_water_m].some((v) => v !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `water_unknown_reason=${w.water_unknown_reason} but measured fields are present — ` +
          'an unknown signal must not also carry values',
      });
    }
  } else if (measured.some((v) => v === null)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'water has no unknown_reason but some measured fields are null — say why, or measure it',
    });
  }
});

export const FloodSignalSchema = z
  .object({
    /** FEMA zone string, e.g. 'AE', 'X', 'VE'. Never invented. */
    flood_zone: z.string().nullable(),
    /** Special Flood Hazard Area — the A/AE/AH/AO/AR/A99/V/VE zones. */
    in_sfha: z.boolean().nullable(),
    pct_parcel_in_floodplain: z.number().min(0).max(100).nullable(),
    /** ⛔ NFHL layer 0. `absent` means NOT MAPPED, which is not "not at risk". */
    nfhl_coverage: z.enum(['present', 'absent', 'unknown']),
    flood_unknown_reason: FloodUnknownReason.nullable(),
    source_url: z.string().url().nullable(),
  })
  .superRefine((f, ctx) => {
    const measured = [f.flood_zone, f.in_sfha, f.pct_parcel_in_floodplain];
    if (f.flood_unknown_reason !== null && measured.some((v) => v !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `flood_unknown_reason=${f.flood_unknown_reason} but measured fields are present`,
      });
    }
    if (f.nfhl_coverage !== 'present' && f.in_sfha !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'in_sfha is asserted where NFHL coverage is not `present` — a parcel FEMA has ' +
          'not mapped is UNKNOWN, never "not in a floodplain"',
      });
    }
  });

export const SlopeSignalSchema = z
  .object({
    mean_slope_pct: z.number().nonnegative().nullable(),
    max_slope_pct: z.number().nonnegative().nullable(),
    /** Centroid elevation, metres. Kept because it is the one raw measurement. */
    elevation_m: z.number().nullable(),
    elevation_range_m: z.number().nonnegative().nullable(),
    samples_requested: z.number().int().nonnegative(),
    samples_returned: z.number().int().nonnegative(),
    slope_unknown_reason: SlopeUnknownReason.nullable(),
    source_url: z.string().url().nullable(),
  })
  .superRefine((s, ctx) => {
    if (s.slope_unknown_reason !== null && s.mean_slope_pct !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'slope carries both a reason and a value' });
    }
    if (s.samples_returned > s.samples_requested) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'more samples returned than requested' });
    }
  });

export const RoadSignalSchema = z
  .object({
    distance_to_road_m: z.number().nonnegative().nullable(),
    road_class: z.string().nullable(),
    /**
     * ⛔ A VETO, not a deduction (plan §5.6). Landlocked mountain land is the
     * classic trap. `null` means we could not tell — and an untested parcel is
     * NOT publishable as road-accessible.
     */
    landlocked: z.boolean().nullable(),
    road_unknown_reason: RoadUnknownReason.nullable(),
    source_url: z.string().url().nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.road_unknown_reason !== null && (r.distance_to_road_m !== null || r.landlocked !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'road carries both a reason and a value' });
    }
  });

export const ParcelEnrichmentSchema = z.object({
  record_id: z.string().min(1),
  /** ⛔ THE CACHE KEY. Unchanged geometry must never be re-queried (§3.4). */
  geometry_hash: z.string().min(1),
  enriched_at: z.string().datetime(),
  water: WaterSignalSchema,
  flood: FloodSignalSchema,
  slope: SlopeSignalSchema,
  road: RoadSignalSchema,
});

export type WaterSignal = z.infer<typeof WaterSignalSchema>;
export type FloodSignal = z.infer<typeof FloodSignalSchema>;
export type SlopeSignal = z.infer<typeof SlopeSignalSchema>;
export type RoadSignal = z.infer<typeof RoadSignalSchema>;
export type ParcelEnrichment = z.infer<typeof ParcelEnrichmentSchema>;
export type Regime = z.infer<typeof WaterRegime>;

/** The one way to build an unknown water block, so the invariant cannot be
 *  hand-typed wrongly at a call site. */
export function waterUnknown(
  reason: z.infer<typeof WaterUnknownReason>,
  searchRadiusM: number,
  sourceUrl: string | null = null,
): WaterSignal {
  return {
    has_stream: null, has_river: null, has_pond: null,
    water_frontage_m: null, frontage_by_regime_m: null,
    distance_to_water_m: null, min_dist_flowline_m: null, min_dist_waterbody_m: null,
    waterbody_overlap_m2: null, named_waters: [],
    search_radius_m: searchRadiusM, water_confidence: null,
    water_unknown_reason: reason, source_url: sourceUrl,
  };
}

export function floodUnknown(
  reason: z.infer<typeof FloodUnknownReason>,
  coverage: 'absent' | 'unknown' = 'unknown',
): FloodSignal {
  return {
    flood_zone: null, in_sfha: null, pct_parcel_in_floodplain: null,
    nfhl_coverage: coverage, flood_unknown_reason: reason, source_url: null,
  };
}

export function slopeUnknown(
  reason: z.infer<typeof SlopeUnknownReason>,
  requested = 0,
  returned = 0,
): SlopeSignal {
  return {
    mean_slope_pct: null, max_slope_pct: null, elevation_m: null, elevation_range_m: null,
    samples_requested: requested, samples_returned: returned,
    slope_unknown_reason: reason, source_url: null,
  };
}

export function roadUnknown(reason: z.infer<typeof RoadUnknownReason>): RoadSignal {
  return {
    distance_to_road_m: null, road_class: null, landlocked: null,
    road_unknown_reason: reason, source_url: null,
  };
}
