/**
 * COUNTY NOTICES -> the declared `notice` contract.
 *
 * ⛔ WHY THIS FILE EXISTS. `project()` — the fail-closed field allowlist — is
 * called exactly ONCE in this repo, for `'listing'` (publish/run.ts:206).
 * Notices went to `publish/out/notices.json` and `site/src/data/notices.json`
 * RAW, so the allowlist never ran on them. Measured pre-state control:
 *
 *     project('notice', rows[0], allowlist)
 *     -> notice payload carries non-allowlisted key(s): bid_id, title, record_url
 *
 * It would have rejected the payload every day it shipped. Three of the seven
 * published keys are off-contract, and one of them — `title` — is FREE TEXT
 * lifted verbatim from a county website and rendered on the homepage by
 * NoticeBanner (`{n.title}`).
 *
 * ⛔ WHY THAT MATTERS MORE THAN A SCHEMA MISMATCH. Today's three titles read
 * "Tax foreclosure Sale August 20, 2026 at 10:00 a.m." — benign, and note the
 * inconsistent casing between them, which is the tell that they are verbatim
 * rather than templated. But the next notice sources queued for this pipeline
 * are GEORGIA legal-organ foreclosure advertisements, whose titles conventionally
 * read `SALE UNDER POWER ... ` followed by the debtor's name. Publishing that
 * field verbatim would put a named individual's foreclosure on the front page of
 * a public site, and `verify-no-pii.mjs` would not see it: it matches field
 * NAMES, and the value-level screen added for the evidence contract is
 * regex-scoped to `^data/evidence/.+\.json$`.
 *
 * So the rule this repo already applies to `how_to_verify` applies here:
 * **template from structured fields; never pass county free text through.**
 * The label a reader sees is OURS, built from a closed-vocabulary `kind` and a
 * date we parsed. The county's own words are used only to CLASSIFY, and are then
 * discarded.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The closed vocabulary. A mechanism we do not recognise is NOT guessed at. */
export type NoticeKind = 'tax-foreclosure' | 'sale-under-power' | 'sheriff-sale' | 'county-notice';

/**
 * Classify from the county's words, then throw them away.
 *
 * ⛔ Unrecognised text becomes `county-notice`, never a guess at the mechanism.
 * The kinds differ in what a reader would DO: a tax foreclosure is a county
 * auction with an upset-bid window; a sale under power is a private
 * lender-driven sale with none. Labelling one as the other tells a reader to
 * turn up on the wrong day with the wrong money.
 */
export function classifyNotice(title: unknown): { kind: NoticeKind; recognised: boolean } {
  const t = typeof title === 'string' ? title : '';
  if (/tax\s*foreclosure/i.test(t)) return { kind: 'tax-foreclosure', recognised: true };
  if (/sale\s+under\s+power/i.test(t)) return { kind: 'sale-under-power', recognised: true };
  if (/sheriff'?s?\s+sale/i.test(t)) return { kind: 'sheriff-sale', recognised: true };
  return { kind: 'county-notice', recognised: false };
}

const FIPS_BY_COUNTY = (root: string): Map<string, string> => {
  const out = new Map<string, string>();
  const p = join(root, 'data/coverage.json');
  if (!existsSync(p)) return out;
  try {
    const doc = JSON.parse(readFileSync(p, 'utf8')) as { counties?: Array<Record<string, unknown>> };
    for (const c of doc.counties ?? []) {
      if (typeof c['county'] === 'string' && typeof c['state'] === 'string' && typeof c['fips'] === 'string') {
        out.set(`${c['state']}|${c['county']}`.toLowerCase(), c['fips']);
      }
    }
  } catch { /* unreadable coverage asserts nothing */ }
  return out;
};

export type PublishedNotice = {
  notice_id: string;
  source_id: string;
  kind: NoticeKind;
  state: string;
  county: string;
  fips: string | null;
  source_url: string;
  observed_at: string;
  sale_date: string | null;
  parcel_ref: string | null;
  matched_record_id: string | null;
};

export function toPublishedNotices(
  root: string,
  raw: ReadonlyArray<Record<string, unknown>>,
  sourceId: string,
): { notices: PublishedNotice[]; unrecognised: number } {
  const fipsBy = FIPS_BY_COUNTY(root);
  let unrecognised = 0;
  const notices = raw.map((n) => {
    const { kind, recognised } = classifyNotice(n['title']);
    if (!recognised) unrecognised += 1;
    const county = String(n['county'] ?? '');
    const state = String(n['state'] ?? '');
    return {
      notice_id: String(n['bid_id'] ?? n['notice_id'] ?? ''),
      source_id: sourceId,
      kind,
      state,
      county,
      fips: fipsBy.get(`${state}|${county}`.toLowerCase()) ?? null,
      source_url: String(n['record_url'] ?? n['source_url'] ?? ''),
      observed_at: String(n['observed_at'] ?? ''),
      sale_date: typeof n['sale_date'] === 'string' ? n['sale_date'] : null,
      // ⛔ County-level by construction: Haywood publishes the sale event, but
      // the property details are scanned images with no readable text, so there
      // is no parcel key to carry. Null is the honest value; a fuzzy match here
      // would attach a foreclosure to a specific person's property.
      parcel_ref: null,
      matched_record_id: null,
    } satisfies PublishedNotice;
  });
  return { notices, unrecognised };
}

/** The label the SITE renders — ours, built from structured fields. */
export const NOTICE_LABEL: Record<NoticeKind, string> = {
  'tax-foreclosure': 'Tax foreclosure sale',
  'sale-under-power': 'Sale under power (lender-initiated)',
  'sheriff-sale': "Sheriff's sale",
  'county-notice': 'County notice — mechanism not recognised',
};
