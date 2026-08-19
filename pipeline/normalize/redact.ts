/**
 * THE REDACTION BOUNDARY (owner decision D1, binding; plan §4.4).
 *
 * PII is consumed IN MEMORY and never reaches any stored tier — not Tier 0, not
 * git, not the warehouse Release asset, not dist/. Names are DISCARDED, never
 * hashed-and-kept: a hash of a name in a corpus of 500k names is a lookup table,
 * not an anonymisation.
 *
 * ACCEPTED COST, stated plainly: the raw tier is no longer byte-perfect against
 * upstream. A future need for owner names requires a re-fetch. That is the price
 * of the boundary and it was paid deliberately — see
 * docs/decisions/0004-redaction-boundary.md.
 *
 * ⛔ `estate_or_heirs` IS NOT DERIVED HERE AND MUST NOT BE ADDED. It was an
 * uncited inference about a specific living person's estate, published on a
 * world-visible map beside the parcel's location. D1 blesses booleans about
 * residency, entity-hood and tenure; it does not bless that one.
 */

import { sentinelDate } from './sentinel.ts';

/** Consumed in memory, then dropped. Nothing on this list reaches a stored tier. */
export const PII_FIELDS = [
  'ownname',
  'ownname2',
  'ownfrst',
  'ownlast',
  'mailadd',
  'mailadd2',
  'munit',
  'mcity',
  'mstate',
  'mzip',
] as const;

export type PiiField = (typeof PII_FIELDS)[number];

export type RawOwnerFields = Partial<Record<PiiField, unknown>> & {
  parusedesc?: unknown;
  saledate?: unknown;
  state?: unknown;
};

export type OwnerDerived = {
  /** The cheapest prospecting discriminator available, and neither input plan scored it. */
  owner_out_of_state: boolean | null;
  owner_is_entity: boolean | null;
  owner_is_government: boolean;
  tenure_years: number | null;
};

const ENTITY_RE =
  /\b(LLC|L\.L\.C|INC|INCORPORATED|CORP|CORPORATION|COMPANY|CO|LP|LLP|LTD|TRUST|TRUSTEE|ASSOC|ASSOCIATION|PROPERTIES|HOLDINGS|PARTNERS|PARTNERSHIP|CHURCH|FOUNDATION|BANK)\b/i;

const GOVERNMENT_NAME_RE =
  /\b(STATE OF|COUNTY OF|CITY OF|TOWN OF|USA|UNITED STATES|FOREST SERVICE|NATIONAL PARK|DEPARTMENT OF)\b/i;

/**
 * ⛔ `COMMONE` is UPSTREAM'S MISSPELLING and is matched VERBATIM (RT-3).
 * `owntype` has exactly one distinct value in Watauga ('') and `presentval` is
 * empty on every sampled row, so this parusedesc half is the only structured
 * field the veto can key on. Without it the free-text half catches
 * "STATE OF NORTH CAROLINA" and MISSES "CASEYS GAP PROPERTY OWNERS ASSOC." and
 * "LYONS, LOUISE E" — i.e. it fails open on exactly the rows that scored highest.
 */
const GOVERNMENT_PARUSE = new Set(['GOVERNMENT', 'EXCLUSIONS (COMMONE AREAS)']);

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Derive the four published booleans, then return them ALONE. The raw record is
 * not returned in any form — this function is the only place PII is legal, and
 * its return type has no field that could carry a name out.
 */
export function deriveOwnerFacts(
  raw: RawOwnerFields,
  parcelState: string,
  now: Date = new Date(),
): OwnerDerived {
  const ownerName = [asString(raw.ownname), asString(raw.ownname2)].filter(Boolean).join(' ');
  const mstate = asString(raw.mstate).toUpperCase();
  const paruse = asString(raw.parusedesc).toUpperCase();

  const owner_is_government =
    (ownerName !== '' && GOVERNMENT_NAME_RE.test(ownerName)) || GOVERNMENT_PARUSE.has(paruse);

  // `mstate` is '' on plenty of rows, and '' is not "in state" — it is unknown.
  const owner_out_of_state = mstate === '' ? null : mstate !== parcelState.toUpperCase();

  const owner_is_entity = ownerName === '' ? null : ENTITY_RE.test(ownerName);

  const sale = sentinelDate(raw.saledate);
  const tenure_years =
    sale.status === 'known'
      ? Math.max(0, Math.floor((now.getTime() - sale.value) / (365.2425 * 86_400_000)))
      : null;

  return { owner_out_of_state, owner_is_entity, owner_is_government, tenure_years };
}

/**
 * Strip PII from an attribute bag. Returns a NEW object; the input is never
 * mutated in place, because a mutated-in-place caller that also holds a
 * reference to the raw page is how a "redacted" row keeps its names.
 */
export function stripPii<T extends Record<string, unknown>>(
  attrs: T,
): Omit<T, PiiField> {
  const out: Record<string, unknown> = {};
  const pii = new Set<string>(PII_FIELDS);
  for (const [k, v] of Object.entries(attrs)) {
    if (pii.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out as Omit<T, PiiField>;
}

/**
 * Belt and braces at the boundary itself: throw if a PII key survived. This is
 * the check that runs on every record, as opposed to verify-no-pii.mjs which
 * runs on the finished surfaces. Two independent detectors, because the surface
 * scan is the one that was already observed reading green while names shipped.
 */
export function assertNoPii(record: Record<string, unknown>, context: string): void {
  const pii = new Set<string>(PII_FIELDS);
  const found = Object.keys(record).filter((k) => pii.has(k.toLowerCase()));
  if (found.length > 0) {
    throw new Error(`[${context}] PII field(s) survived the redaction boundary: ${found.join(', ')}`);
  }
}

/**
 * The redaction boundary as one call: derive, strip, assert.
 * There is no code path that produces a stored record without going through it.
 */
export function redact<T extends Record<string, unknown>>(
  attrs: T,
  parcelState: string,
  now?: Date,
): { safe: Omit<T, PiiField>; derived: OwnerDerived } {
  const derived = deriveOwnerFacts(attrs as RawOwnerFields, parcelState, now);
  const safe = stripPii(attrs);
  assertNoPii(safe as Record<string, unknown>, 'redact');
  return { safe, derived };
}
