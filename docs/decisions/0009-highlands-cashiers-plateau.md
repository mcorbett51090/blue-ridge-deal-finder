# ADR 0009 — Highlands–Cashiers Plateau: a named region, and Macon promoted on measurement

**Status:** accepted · **Date:** 2026-09-05 · **Claims:** docs/probe-log.md §11 · **Binding**

## Decision

1. A new region label, **`Highlands–Cashiers Plateau`**, replaces `NC High Country` on the
   `seeds/counties.csv` rows for **Jackson** (37099, Glenville / Cashiers), **Macon** (37113,
   Highlands) and **Transylvania** (37175, Sapphire / Toxaway fringe). All three keep their
   existing `state`/`fips`/`parcel_source` — only the region label and the notes column change for
   Jackson and Transylvania.
2. **Macon NC (37113) is added** to `seeds/counties.csv` and `data/coverage.json` at tier **`rich`**,
   `parcel_source: nc-onemap-parcels`, `data_state: not-run`.
3. `sources/sources.yaml`'s `nc-onemap-parcels` entry gains a measured row floor for Macon
   (`42000`), so a future `--counties=Macon` ingest has something other than a guess to check
   against.
4. The total county count moves from 37 to 38, NC from 11 to 12, in the **same commit** as the row —
   `scripts/verify-coverage.mjs`, its fixtures, and `tests/publish.test.ts` all move with it.

## Why Macon is `rich` and not `notices-only`

The working assumption going in — stated in the task that produced this ADR — was that Macon and
Transylvania would "likely" land at `notices-only` or `thin` "until a free parcel endpoint is
proven," on the theory that NC OneMap coverage might not generalise past the originally-probed 11
counties, the way GA's qPublic wall (ADR-adjacent, §5 of the probe log) does not generalise into a
usable source no matter which county asks it.

**Transylvania was never actually a gap.** It has been `rich` and ingested (29,204 parcels
warehoused) since before this ADR — it only needed the region relabel.

**Macon is a genuine gap, and it closed on measurement, not on the prior.** Re-run 2026-09-05
against the exact same already-vetted, already-`enabled: true` endpoint
(`https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1`) that already
serves Jackson and Transylvania:

```
where=cntyname='Watauga'          -> {"count":47388}   (positive control, matches E2.7)
where=cntyname='Zzzznotacounty'   -> {"count":0}        (negative control)
where=cntyname='Macon'            -> {"count":44699}
where=cntyname='Macon' AND parval=0 -> {"count":1200}   (2.7% zero-parval, well under the
                                                          project's 4% ceiling)
sample of 5 parval>0 rows: parno/gisacres/parval all populated; parvaltype='Assessed'
  on 44699/44699 sampled — 0 rows carry Ashe's 'Market' outlier type
```

Full transcript: `docs/probe-log.md` §11.

**This is not the GA-style near-miss the task warned against**, and the distinction is the whole
point of writing it down rather than just editing the CSV:

- The GA near-miss (probe log, "North Georgia parcel sources") was a *different, multi-tenant host*
  (`services7.arcgis.com`) serving a layer that merely shared a county *name* with a Blue Ridge
  target — the data was Texas's. Promoting it required a fabricated jurisdiction.
- Macon is the *same host, same layer, same schema, same already-signed-off robots/ToS verdict* as
  the anchor already running against 11 other counties. `cntyname='Macon'` is one more value of a
  field the anchor already queries for every county it serves. There is no new jurisdiction to get
  wrong, because there is no new source.

The rule this project actually runs on — measured beats assumed, `docs/probe-log.md` in every
section — points at `rich`, and the prior guess in the task description is exactly the kind of
un-measured assumption the project's own gate family exists to catch. `sources.candidates.yaml`'s
own header states the standard: nothing is promoted on the strength of a probe nobody re-ran. This
one was re-run, today, with both controls, and is recorded rather than merely asserted.

## What did **not** happen, and why

**Macon was not ingested.** `tier: rich` and `data_state: not-run` are deliberately different
claims — see `publish/coverage.ts`'s `NOTE_NOT_RUN`, already published for Buncombe, Henderson and
Haywood before this ADR. Running `pipeline/ingest-parcels.ts --counties=Macon` requires the
production SQLite warehouse (`data/warehouse/`, gitignored, living only as a GitHub Release asset /
the owner's local mirror per ADR 0008) as the prior state to diff against. That warehouse does not
exist in the environment this PR was authored in. Running the ingest against an *empty* prior state
here would not add Macon — it would silently demote Jackson, Transylvania and every other
already-ingested NC county to a freshly-built, mostly-empty warehouse, exactly the harm
"do not break existing Jackson NC ingest" was warning against. The correct, low-risk move is the one
this ADR makes: prove the source, register the floor, leave the actual pull to a run against the
real warehouse.

**No standalone Macon distress/notices source was found.** A robots.txt check on
`www.maconnc.org` passed (our UA is not in the named-bot block list, `*` group is `Allow: /`,
matching the ADR 0003 precedent already accepted for GA/VA notice sites), but the site's own
`sitemap.xml` is a 2010-vintage artifact with zero `tax`-matching URLs — including on its own
positive control, which makes the result **inconclusive by this project's own standard**, not a
clean absence. A few direct-path guesses (`/tax-foreclosures`, `/tax-collections`, …) all 404'd.
This is recorded as **NOT RUN**, the same distinction the original probe log draws for TN's named
posting site (§4): finding the real page requires a search tool or a human, not URL guessing.
Macon's parcel-coverage promotion does not depend on this; the notices lane for the plateau simply
stays open rather than closed.

## Consequences

- `docs/probe-log.md` §11 carries the full transcript; this ADR is the ruling, not the evidence.
- The next real ingest run (on a machine with the actual warehouse) should pass
  `--counties=Macon` once, alone, to confirm the 42,000 floor and the schema fingerprint hold before
  Macon is folded into the default weekly `ncTargetCounties()` sweep.
- If a Macon-specific tax-foreclosure or notices mechanism is later found, it follows the same
  per-county-adapter pattern §2 of the probe log already established — no single "NC foreclosure
  scraper" is assumed to generalise.
