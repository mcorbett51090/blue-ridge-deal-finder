/**
 * ADAPTER — distress ingest output -> the shape SCORING expects.
 *
 * ⛔ Why this file exists, and it is the same seam as `pipeline/enrich/to-contract.ts`.
 * Two sides were built in parallel against different paths, each internally correct:
 *
 *   the ingest writes   data/distress/evidence.json   { evidence: { "<record_id>": {...} } }
 *   the scorer reads    data/evidence/for-sale.json   { "<record_id>": ForSaleEvidence }
 *                       data/evidence/distress.json   { "<record_id>": DistressObservation[] }
 *
 * `data/evidence/` HAS NEVER EXISTED. Grep found the string in exactly two
 * places, both inside `enrich-contract.ts`'s own doc comment — nothing ever
 * wrote there. So `discount` (weight 38) and `distress` (31) — 69 of the 100
 * composite points — were structurally unreachable for every parcel in the
 * corpus, while the prices `discount` needs sat on disk one directory away.
 * `publish/run.ts` read the ingest path directly and rendered "$9,500" on the
 * card, which is why the seam was invisible: the site looked right.
 *
 * Translate, do not rewrite either side. The ingest file stays the record of
 * what was observed; this is the projection scoring consumes.
 *
 * ⛔ ABSENCE STAYS ABSENCE. A parcel with no evidence is simply not in the
 * output. It is never emitted with a zero, a placeholder, or an empty array —
 * "no notice mentions this parcel" and "we never looked" are different facts and
 * `scoreDistress` distinguishes them by presence.
 *
 * ⛔ NO FREE TEXT CROSSES THIS BOUNDARY. The output shapes carry no prose field:
 * `how_to_verify` is deliberately NOT projected. These records are built from
 * county foreclosure and REO documents — the documents most likely to name a
 * person — and `verify-no-pii.mjs` matches field NAMES, not values. The only
 * strings that cross are a `kind` from a closed vocabulary, a label this repo
 * authored, and a URL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ForSaleEvidenceSchema,
  DistressObservationSchema,
  type ForSaleEvidence,
  type DistressObservation,
} from '../../score/enrich-contract.ts';

type Json = Record<string, unknown>;

/** Ingest `kind` -> the two closed vocabularies. Both are needed and they are
 *  spelled differently on purpose: ForSaleEvidence.kind is hyphenated (it is
 *  rendered as a label) and DistressObservation.kind is snake_case (it keys
 *  `weights.yaml`'s increments). A silent mismatch here scores NaN — see
 *  assertDistressIncrementsComplete. */
const FOR_SALE_KIND: Record<string, ForSaleEvidence['kind']> = {
  county_owned_reo: 'county-owned-reo',
};
const DISTRESS_KIND: Record<string, DistressObservation['kind']> = {
  county_owned_reo: 'county_owned_reo',
};

export type InterchangeResult = {
  for_sale: number;
  distress: number;
  /** Notices READ but deliberately NOT projected, with the reason. */
  notices_unjoinable: number;
  skipped_unknown_kind: string[];
};

export function buildEvidenceContract(root: string): InterchangeResult {
  const out: InterchangeResult = { for_sale: 0, distress: 0, notices_unjoinable: 0, skipped_unknown_kind: [] };
  const src = join(root, 'data/distress/evidence.json');
  const forSale: Record<string, ForSaleEvidence> = {};
  const distress: Record<string, DistressObservation[]> = {};

  if (existsSync(src)) {
    const doc = JSON.parse(readFileSync(src, 'utf8')) as Json;
    const evidence = (doc['evidence'] as Record<string, Json> | undefined) ?? {};
    for (const [recordId, e] of Object.entries(evidence)) {
      const rawKind = String(e['kind'] ?? '');
      const fsKind = FOR_SALE_KIND[rawKind];
      const dKind = DISTRESS_KIND[rawKind];
      if (!fsKind || !dKind) {
        // ⛔ Refuse loudly rather than guess a neighbouring member. Mapping an
        // unknown mechanism onto an existing one prints a false sentence on the
        // card, because scoreDistress renders `kind` verbatim into its basis.
        out.skipped_unknown_kind.push(rawKind);
        continue;
      }
      // A URL is REQUIRED by the contract. Prefer the exact record; fall back to
      // the labelled generic page. If neither exists there is no citable source
      // and the row must not assert evidence at all.
      const url = (e['record_url'] as string | null) ?? (e['generic_url'] as string | null) ?? null;
      if (!url) continue;
      const observedAt = String(e['observed_at'] ?? '');
      const priceRaw = e['price_usd'];
      const price = typeof priceRaw === 'number' && priceRaw > 0 ? priceRaw : null;

      forSale[recordId] = ForSaleEvidenceSchema.parse({
        kind: fsKind,
        label: String(e['label'] ?? 'County-owned, acquired through foreclosure'),
        source_url: url,
        observed_at: observedAt,
        // REO is a COMPLETED state: the county already owns it and sells it
        // directly. There is no scheduled sale and no opening bid, and inventing
        // either would be the "unknown rendered as a value" defect.
        sale_date: null,
        opening_bid: null,
        price,
      } satisfies ForSaleEvidence);

      distress[recordId] = [
        DistressObservationSchema.parse({ kind: dKind, source_url: url, observed_at: observedAt }),
      ];
      out.for_sale += 1;
      out.distress += 1;
    }
  }

  // ⛔ NOTICES ARE READ AND DELIBERATELY NOT PROJECTED. They are county-level:
  // Haywood publishes the sale event, but the property details are scanned
  // images with no readable text, so no parcel key exists to join on. A
  // record-keyed contract cannot carry them, and attaching one to a parcel we
  // merely believe is involved would be inventing the exact claim this project
  // refuses to make. They stay in data/distress/notices.json, where the site
  // renders them as county-level facts with a link.
  const noticesPath = join(root, 'data/distress/notices.json');
  if (existsSync(noticesPath)) {
    const nd = JSON.parse(readFileSync(noticesPath, 'utf8')) as Json;
    out.notices_unjoinable = ((nd['notices'] as unknown[] | undefined) ?? []).length;
  }

  for (const [rel, payload] of [
    ['data/evidence/for-sale.json', forSale],
    ['data/evidence/distress.json', distress],
  ] as const) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(payload, null, 1)}\n`);
  }
  return out;
}
