# ADR 0004 — The redaction boundary: PII is discarded, not stored

**Status:** accepted (P1) · **Owner decision D1, binding** · **Claims:** CE-5, TB3 §5

## Decision

Owner PII is consumed **in memory** at normalize and **never written to any
tier** — not Tier 0 raw, not git, not the warehouse Release asset, not `dist/`.

Discarded: `ownname`, `ownname2`, `ownfrst`, `ownlast`, `mailadd`, `mailadd2`,
`munit`, `mcity`, `mstate`, `mzip`.

Derived first, then published as **values, not names**:

| field | type | derivation |
|---|---|---|
| `owner_out_of_state` | `boolean \| null` | `mstate` present and ≠ parcel's state |
| `owner_is_entity` | `boolean \| null` | owner name matches an entity-suffix pattern |
| `owner_is_government` | `boolean` | government name pattern **OR** `parusedesc ∈ {GOVERNMENT, EXCLUSIONS (COMMONE AREAS)}` |
| `tenure_years` | `number \| null` | `now − sale_date`; `null` on the 1900 sentinel |

**Names are discarded, never hashed-and-kept.** A hash of a name, in a corpus
where the plaintext population is a published list of ~500k owner names, is a
lookup table — it is a reversible encoding dressed as an anonymisation.

## The accepted cost, stated plainly

**The raw tier is no longer byte-perfect against upstream.** A future need for
owner names requires a re-fetch, and historical names for parcels that have
since changed hands are simply gone. This was weighed and accepted: the tier
that would preserve them is the tier that would publish them.

## ⛔ `estate_or_heirs` is dropped, from scoring and from publication

An earlier design derived it from an `ownname` regex and scored it as a signal.
It is an **uncited inference about a specific living person's estate, published
on a world-visible map beside the parcel's location** — and it violates the same
plan's own rule, stated two lines earlier, that every increment requires a cited
observation with a source URL. D1 blesses four derived booleans. This is not one
of them, and it must not be re-added as a fifth.

The "estate & probate" signal may re-enter **only** through a cited probate or
tax record carrying a `source_url`. No probate source exists anywhere in this
corpus for any target county today. That is an honest gap published on
`/status/`, not a regex over a name.

## Residual, named honestly

A published `parno` plus county is a one-field lookup in the county's own public
portal. A world-visible list of *distress-flagged* parcel numbers therefore
resolves to named individuals in one click. `parno` is published anyway, because
it is the field that lets you go look a parcel up — the entire point of the
tool — and the underlying records are already individually public. Only a
private repo closes this, and D2 declined that. **Surfaced to the owner.**

## Enforcement

Two independent detectors, because the surface scan is the one already observed
reading green while names shipped:

1. `assertNoPii` runs at the boundary, per record.
2. `scripts/verify-no-pii.mjs` scans the git tree, `data/`, `publish/out/`,
   `site/dist/` **and** the publish allowlist — each with a planted canary that
   must be flagged. A surface reporting clean without its canary firing is a
   broken scanner, not a clean surface.

**Still owed:** the Release-asset surface. This repo has no releases yet and P1
makes no network call. It is an unsatisfied assertion, not a satisfied one.
