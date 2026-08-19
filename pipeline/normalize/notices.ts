/**
 * The Notice record — foreclosure / trustee-sale / tax-sale postings.
 *
 * This is the ONLY data in the system that moves on a sub-48-hour clock, and it
 * is the sole legitimate producer of `for_sale_evidence`. Facts are extracted
 * and the source is linked; notice PROSE and photos are never stored (B47,
 * folded in as a hard rule rather than a preference).
 */
import { z } from 'zod';

export const NoticeSchema = z.object({
  notice_id: z.string().min(1),
  source_id: z.string().min(1),
  kind: z.enum(['foreclosure_notice', 'trustee_sale', 'tax_sale', 'gov_reo']),
  state: z.string().length(2),
  county: z.string().min(1),
  fips: z.string().regex(/^\d{5}$/),

  /** Must resolve — asserted by the link-check gate. No link, no notice. */
  source_url: z.string().url(),
  observed_at: z.string().datetime(),

  /** Whatever identifier the notice itself printed. Free text upstream. */
  parcel_ref: z.string().nullable(),
  /** Set only when the ref matched a parcel by key, never by fuzzy address. */
  matched_record_id: z.string().nullable(),

  sale_date: z.string().datetime().nullable(),
  opening_bid: z.number().nonnegative().nullable(),
  /** NC's upset-bid window restarts on each bid — 10 BUSINESS days (B2). */
  upset_bid_deadline: z.string().datetime().nullable(),

  /** TN third-party postings must run >= 20 continuous days (B14). */
  posting_days: z.number().int().nonnegative().nullable(),
});

export type Notice = z.infer<typeof NoticeSchema>;

/** Notice → the parcel's first-class field. Nothing else may construct one. */
export function toForSaleEvidence(notice: Notice): {
  kind: Notice['kind'];
  source_url: string;
  observed_at: string;
  sale_date?: string;
  opening_bid?: number;
  upset_bid_deadline?: string;
} {
  const out: {
    kind: Notice['kind'];
    source_url: string;
    observed_at: string;
    sale_date?: string;
    opening_bid?: number;
    upset_bid_deadline?: string;
  } = { kind: notice.kind, source_url: notice.source_url, observed_at: notice.observed_at };
  if (notice.sale_date !== null) out.sale_date = notice.sale_date;
  if (notice.opening_bid !== null) out.opening_bid = notice.opening_bid;
  if (notice.upset_bid_deadline !== null) out.upset_bid_deadline = notice.upset_bid_deadline;
  return out;
}
