/**
 * THE CONTRACT BETWEEN SCORING AND ENRICHMENT — and the degradation rule.
 *
 * `water` (15) and `livability` (10) are computed from NHD / FEMA / EPQS /
 * TIGER geometry by `pipeline/enrich/`, which is being built in parallel and
 * did not exist when this file was written (measured: `ls -1 pipeline/enrich/`
 * -> 0 entries, with `ls -1 pipeline/normalize/` -> 7 as the positive control
 * proving the enumerator works). `distress` (25) needs the P4 notice lane, and
 * `discount` (30) needs a PRICE, which no parcel field carries at all.
 *
 * ⛔ THE DEGRADATION IS THE POINT, NOT A STOPGAP. An absent enrichment file
 * produces `status: 'unknown'` with a stated reason, which LEAVES THE
 * DENOMINATOR. It never produces a zero. A row scored on `per_acre` alone gets
 * a real number and a confidence of 0.2, and both render. That is the whole
 * discipline of this project expressed at its most load-bearing seam: the
 * absence of a data source must be visible as an absence, never as a bad score.
 *
 * The interchange is a FILE, not a function import, so the two halves can land
 * in either order and neither blocks the other:
 *
 *   data/enrich/water.json        { "<record_id>": WaterFacts, ... }
 *   data/enrich/livability.json   { "<record_id>": LivabilityFacts, ... }
 *   data/evidence/for-sale.json   { "<record_id>": ForSaleEvidence, ... }
 *   data/evidence/distress.json   { "<record_id>": DistressObservation[], ... }
 *
 * Each is validated with zod on read: a malformed enrichment file is a throw,
 * not a silently-empty map, because an empty map and a broken parse are
 * indistinguishable in the output otherwise — every row would read `unknown`
 * and nothing would say why.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DistressKindSchema } from './config.ts';

export const SourceRefSchema = z.object({
  url: z.string().url(),
  retrieved_at: z.string().datetime(),
  kind: z.string().min(1),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** §5.5 — every number here comes from GEOMETRY. A listing adjective is not
 *  frontage, and there is deliberately no text field to put one in. */
export const WaterFactsSchema = z.object({
  frontage_m: z.number().nonnegative().nullable(),
  min_dist_flowline_m: z.number().nonnegative().nullable(),
  min_dist_waterbody_m: z.number().nonnegative().nullable(),
  waterbody_overlap_m2: z.number().nonnegative().nullable(),
  has_stream: z.boolean(),
  has_river: z.boolean(),
  has_pond: z.boolean(),
  /** NHD `gnis_name` of the intersecting features — "Baker Creek", not "a creek".
   *  Naming the water is the difference between a score and something you can go
   *  and look at on a map. Empty when NHD publishes no name for the feature. */
  named_waters: z.array(z.string()).default([]),
  /** Frontage split by NHD FCode regime. A dry ditch is not creek frontage:
   *  46006 is perennial, 46003 intermittent, 46007 ephemeral. Collapsing these
   *  would let a seasonal drainage score as a year-round creek. */
  frontage_by_regime_m: z
    .object({
      perennial: z.number().nonnegative(),
      intermittent: z.number().nonnegative(),
      ephemeral: z.number().nonnegative(),
      unspecified: z.number().nonnegative(),
    })
    .nullable()
    .default(null),
  source: SourceRefSchema,
});
export type WaterFacts = z.infer<typeof WaterFactsSchema>;

/** §5.6. `flood_zone` is the FEMA zone string at the centroid; 'X'/'B'/'C' are
 *  outside the 1% annual-chance floodplain. `null` is UNKNOWN, never 'X'. */
export const LivabilityFactsSchema = z.object({
  flood_zone: z.string().nullable(),
  flood_coverage_fraction: z.number().min(0).max(1).nullable(),
  slope_pct: z.number().nonnegative().nullable(),
  road_distance_m: z.number().nonnegative().nullable(),
  source: SourceRefSchema,
});
export type LivabilityFacts = z.infer<typeof LivabilityFactsSchema>;

/** §5.3 — every increment requires a cited observation. No LLM anywhere in the
 *  ingest path, so there is no field here for an inferred one. */
export const DistressObservationSchema = z.object({
  // ⛔ ONE vocabulary, imported — not a second copy. A restated enum is a
  // vocabulary that disagrees with the increments the first time either is
  // edited, and the disagreement scores NaN. See assertDistressIncrementsComplete.
  kind: DistressKindSchema,
  source_url: z.string().url(),
  observed_at: z.string().datetime(),
});
export type DistressObservation = z.infer<typeof DistressObservationSchema>;

/**
 * §4.9 / §5.2 — THE ONLY THING THAT CAN EVER SUPPLY A PRICE.
 * There is no sale-price field among the 71 ingested parcel columns, so
 * `discount` is `unknown` for every prospecting row permanently, by
 * construction. It is not a gap to be filled in later with an estimate.
 */
export const ForSaleEvidenceSchema = z.object({
  // ⛔ `county-owned-reo` is its OWN member and must not be folded into
  // `tax-foreclosure`. It is a COMPLETED outright-ownership state — the county
  // already took the property and now sells it directly, with no auction, no
  // redemption window and no competing bids — whereas every other member here
  // describes a process unfolding TOWARD a future sale. `scoreDistress()` builds
  // the component's `basis` as `kind.replace(/_/g,' ')` and schema.ts documents
  // basis as rendered verbatim on the card, so collapsing the two would print a
  // false mechanism sentence on the only 8 properties a reader can actually buy.
  // A reader acting on "tax delinquent" versus "already county-owned, buy
  // directly" does something different. (FORGE tiebreak TB-2, 2026-08-19.)
  kind: z.enum([
    'listing',
    'tax-foreclosure',
    'county-owned-reo',
    'sheriff-sale',
    'master-in-equity',
    'estate-notice',
    'auction',
  ]),
  label: z.string().min(1),
  source_url: z.string().url(),
  observed_at: z.string().datetime(),
  sale_date: z.string().nullable(),
  opening_bid: z.number().positive().nullable(),
  /** The number `discount` divides by. Null means evidence without a price. */
  price: z.number().positive().nullable(),
});
export type ForSaleEvidence = z.infer<typeof ForSaleEvidenceSchema>;

export type Enrichment = {
  water: Map<string, WaterFacts>;
  livability: Map<string, LivabilityFacts>;
  forSale: Map<string, ForSaleEvidence>;
  distress: Map<string, DistressObservation[]>;
  /** Which interchange files were PRESENT. Printed in the run summary and
   *  published in the manifest — an absent source must be legible as absent. */
  present: Record<'water' | 'livability' | 'for_sale' | 'distress', boolean>;
};

export const EMPTY_ENRICHMENT: Enrichment = {
  water: new Map(),
  livability: new Map(),
  forSale: new Map(),
  distress: new Map(),
  present: { water: false, livability: false, for_sale: false, distress: false },
};

function loadMap<T>(path: string, schema: z.ZodType<T>): Map<string, T> | null {
  if (!existsSync(path)) return null;
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const parsed = z.record(z.string(), schema).parse(raw);
  return new Map(Object.entries(parsed));
}

export function loadEnrichment(repoRoot: string): Enrichment {
  const water = loadMap(join(repoRoot, 'data', 'enrich', 'water.json'), WaterFactsSchema);
  const livability = loadMap(join(repoRoot, 'data', 'enrich', 'livability.json'), LivabilityFactsSchema);
  const forSale = loadMap(join(repoRoot, 'data', 'evidence', 'for-sale.json'), ForSaleEvidenceSchema);
  const distress = loadMap(
    join(repoRoot, 'data', 'evidence', 'distress.json'),
    z.array(DistressObservationSchema),
  );
  return {
    water: water ?? new Map(),
    livability: livability ?? new Map(),
    forSale: forSale ?? new Map(),
    distress: distress ?? new Map(),
    present: {
      water: water !== null,
      livability: livability !== null,
      for_sale: forSale !== null,
      distress: distress !== null,
    },
  };
}
