/**
 * The publish boundary. Everything that reaches dist/ passes through here.
 *
 * The allowlist FAILS CLOSED: an unrecognised key throws. The defended failure
 * is an upstream schema change arriving with owner data in it and riding all
 * the way to a world-visible map because nobody thought to add it to a denylist.
 * A positive list cannot be defeated by a field nobody has heard of yet.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const AllowlistFileSchema = z.object({
  parcel: z.array(z.string()),
  notice: z.array(z.string()),
  /** The PUBLISHED site payload (publish/payload.ts) — a different projection
   *  from `parcel`, with the site's key names and the structured `provenance`
   *  object that replaced the bare source URL. */
  listing: z.array(z.string()),
});

export type PayloadKind = 'parcel' | 'notice' | 'listing';

export function loadAllowlist(repoRoot: string): Record<PayloadKind, Set<string>> {
  const raw: unknown = JSON.parse(readFileSync(join(repoRoot, 'publish', 'allowlist.json'), 'utf8'));
  const parsed = AllowlistFileSchema.parse(raw);
  return {
    parcel: new Set(parsed.parcel),
    notice: new Set(parsed.notice),
    listing: new Set(parsed.listing),
  };
}

export class PublishAllowlistError extends Error {
  readonly offendingKeys: string[];
  constructor(kind: PayloadKind, keys: string[]) {
    super(`publish allowlist: ${kind} payload carries non-allowlisted key(s): ${keys.join(', ')}`);
    this.name = 'PublishAllowlistError';
    this.offendingKeys = keys;
  }
}

export function assertFieldsAllowlisted(
  kind: PayloadKind,
  record: Record<string, unknown>,
  allowlist: Record<PayloadKind, Set<string>>,
): void {
  const permitted = allowlist[kind];
  const offending = Object.keys(record).filter((k) => !permitted.has(k));
  if (offending.length > 0) throw new PublishAllowlistError(kind, offending);
}

/** Project a record down to the allowlist AFTER asserting — never instead of it.
 *  Silently dropping unknown keys would publish a clean payload and hide the
 *  schema change that produced them. */
export function project(
  kind: PayloadKind,
  record: Record<string, unknown>,
  allowlist: Record<PayloadKind, Set<string>>,
): Record<string, unknown> {
  assertFieldsAllowlisted(kind, record, allowlist);
  const out: Record<string, unknown> = {};
  for (const k of allowlist[kind]) if (k in record) out[k] = record[k];
  return out;
}
