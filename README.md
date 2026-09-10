# Blue Ridge Deal Finder

Finds under-market mountain property across 38 Blue Ridge counties — foreclosures, tax sales,
estate parcels and raw land — from **free public sources only**, and puts it on a map.

Personal tool. One user. No accounts, no commerce, no external users.

---

## Read this before trusting it

**This surfaces a minority of what is for sale, and misses most normal listings.** Every
MLS-derived listing is structurally unreachable without paying, and no free legal substitute
exists. It is a **complement to Zillow, not a replacement.**

What makes it worth running is that the slice it *does* reach is **largely disjoint from Zillow**:
foreclosure notices, delinquent-tax sales, estate parcels, and raw land whose creek frontage is
**computed from federal hydrography geometry** rather than mentioned in a listing description.

The system is built to find the parcel *whose listing never says "creek."*

## Two lanes, never mixed

A parcel record says a property **exists**. It does not say it is **for sale**. Half a million
parcels are almost entirely not on the market.

| Lane | Requires | Default | Answers |
|---|---|---|---|
| **On market / in distress** | non-null `for_sale_evidence` | open | What can I buy right now? |
| **Prospecting** | scored parcel, no availability evidence | collapsed | Where would I buy, if it came up? |

## Coverage is uneven, and the map says so

| State | Counties | Tier | Reality |
|---|---|---|---|
| NC | 12 | `rich` | One free statewide endpoint: assessed value, acreage, sale date, use code |
| TN | 5 | `partial` | Statewide parcels, but **no assessed value**; the value hop is unsettled |
| VA | 9 | `thin` | State layer is geometry only; several counties untested |
| GA + SC | 12 | `notices-only` | No statewide parcel layer; dominant vendor is a confirmed bot wall |

An uncovered county must **never** render like a quiet one. `data/coverage.json` carries a tier per
county and the UI is tier-aware — an empty result that reads as "no deals here" is the specific
failure this design guards against.

### Highlands–Cashiers Plateau is in scope

Glenville, Highlands, Cashiers and Sapphire span three NC counties, all tagged
`region: "Highlands–Cashiers Plateau"` in `seeds/counties.csv`: **Jackson** (37099, Glenville /
Cashiers) and **Transylvania** (37175, Sapphire / Toxaway fringe) were already `rich` and ingested
before this region existed as a label; **Macon** (37113, Highlands) was added once a live probe
reconfirmed the *same* already-vetted statewide NC OneMap anchor covers it too — 44,699 parcels,
97.3% carrying a non-zero Assessed value, `parvaltype=Assessed` on every sampled row. No new host,
no new robots/ToS review: it is the identical `nc-onemap-parcels` endpoint already serving Jackson
and Transylvania, filtered to one more county name.

Macon's tier is `rich` but its `data_state` is `not-run` — the source is proven and its row floor is
registered in `sources/sources.yaml`, but nobody has run the ingest against it yet. **Unknown is
never zero.** A quiet Macon result on the map today means "not yet collected," not "nothing here." No
standalone tax-foreclosure/notices feed specific to the plateau towns was found this pass (see
`docs/decisions/0009-highlands-cashiers-plateau.md` and `docs/probe-log.md`); that lane is recorded
as not-yet-found, not closed.

## Operating rules (non-negotiable)

- **$0/month.** No paid API, no MLS, no subscription.
- **`sources/sources.denied.yaml` wins every conflict.** A source is unreachable if robots or ToS
  say so, regardless of what its own registry entry claims.
- **One egress path.** `pipeline/fetch/client.ts` is the only module permitted to open a socket,
  enforced by an allowlist verifier over `pipeline/`, `scripts/` **and** `site/`.
- **Honest user-agent, always.** Never a browser UA, never a bot/AI-named string.
- **No owner names, ever published.** PII is consumed in memory and discarded at the redaction
  boundary; only booleans (`owner_out_of_state`, `tenure_years`) survive.
- **Cadence is a terms requirement.** See the justification block in `ingest-parcels.yml` (weekly,
  the 500k-row statewide sweep) and `ingest-distress.yml` (daily, two small per-county documents).

## Layout

```
pipeline/fetch/       client.ts — the ONLY module that may open a socket
pipeline/normalize/   redact · sentinel · keys · parcels · notices
pipeline/enrich/      nhd (water) · nfhl (flood) · epqs (slope) · tiger (roads)
pipeline/score/       weights.yaml + pure scoring fn + golden fixtures
publish/              field-allowlist export
scripts/              the gate family — every gate ships a fixture proving it can FAIL
seeds/counties.csv    the canonical 38
site/                 Astro 5 + MapLibre, client-side filtering
docs/probe-log.md     every probe: command, status, bytes, control block, verdict
docs/decisions/       ADRs
```

## Why so many guards

Four defects in this project's own planning were checks that **could not fail, reporting clean**: a
row-count floor where `undefined < 45000` is `false`; a coverage probe whose negative control also
matched; a `grep -E 'a\|b'` returning 0 unconditionally; an anchor endpoint serving points where
three signals needed polygons.

Every gate therefore ships with a fixture that proves it goes **red**. `verify-controls.mjs` is the
meta-gate that asserts this. A gate with no failing fixture is not a gate.

## Status

**The site is live:** https://mcorbett51090.github.io/blue-ridge-deal-finder/

It is a personal tool for one user, kept honest by a build that fails closed rather than a
promise. Two things worth knowing before you trust anything on it:

- **This is a frozen snapshot, not a live feed — and here is exactly why.** The corpus and the
  published payload were last regenerated **2026-08-19/20**. `ingest-parcels.yml` (weekly) had
  failed on *every* scheduled run since it was added, and `freshness.yml` had failed every run it
  ever had: `data/warehouse/` is gitignored (ADR 0008) and a hosted CI runner is destroyed at the
  end of every job, so the prior warehouse the pipeline needs to compute a real delta was
  unconditionally absent, and its own guard correctly refused to publish a false "everything is
  new" change feed against it, every time. `docs/decisions/0010-ci-warehouse-store.md` is the
  fix — a GitHub Release now carries the warehouse between runs (`scripts/warehouse-remote.mjs`),
  the missing `npm run publish` step now runs where the warehouse exists, `check-freshness.mjs` now
  agrees with `/status/`'s own definition of a usable run, and a new daily `ingest-distress.yml`
  gives Lane 1 a cadence that can actually clear its 48-hour bar. **It requires one operator step
  this repo cannot perform for itself** — bootstrapping the Release from the real warehouse, which
  lives only on the owner's machine (ADR 0008) — documented in that ADR. Until that step runs, both
  workflows still fail exactly as described above, loudly and actionably rather than silently; once
  it runs, the weekly parcel sweep, the daily distress ingest and the freshness heartbeat are all
  designed to self-sustain without it again. Until then, the data on the site gets
  **days-to-weeks older with every day that passes**, and the hub says so: a stale/snapshot banner
  appears once Lane 1 is past its 48-hour freshness bar, and `/status/` states the exact
  source-by-source last-success timestamp, including the sources that have never run at all.
- **Two lanes, and the site never blurs them.** *On market / in distress* (Lane 1 — currently
  **8 rows**: county-owned parcels acquired through tax foreclosure, all in Jackson County, NC)
  is the only thing expanded by default and is the only lane with a dated, sourced claim that a
  property is actually for sale. *Prospecting* (Lane 2 — currently **650 rows**) is every scored
  parcel in a covered county with **no** such evidence; it ships collapsed, labelled in full
  everywhere it appears, and is a research list, not a listing feed.

None of that is a defect report — it is what "frozen snapshot" means, stated in the one place
(the site itself) where it can't go stale silently. See `/status/` on the live site for the
current numbers, and `/about/` for what this project does and does not claim.
