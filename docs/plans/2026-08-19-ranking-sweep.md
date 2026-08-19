# FORGE G6 — `plan.md` (authoritative): blue-ridge-deal-finder ranking sweep

**Repo:** `/Users/matthewcorbett/blue-ridge-deal-finder` @ `b37082a` · **Date:** 2026-08-19 ·
**Depth:** standard · **Privacy posture:** sensitive (local execution capped).

This file supersedes `plan-A.md` and `plan-B.md`. They are **not merged as peers.** The critic
(G4a) and the red team (G5) overturned premises both plans were built on, and the orchestrator's
own probes were corrected four times. **Where an input plan conflicts with a later measurement,
the measurement wins.** Every place this plan overrules an input plan is marked
`⟂ OVERRULES` with the measurement that decides it.

---

## 1. Situation

### What is broken

1. **The ranking cannot rank.** `site/src/data/listings.json` publishes exactly two values:
   `100` × 500 and `null` × 158. `scorePerAcre()` uses `invert(population.percentileOf(perAcre))`
   — a **rank transform** — and `publish/run.ts` selects `topN()` on that same axis, so the
   published set is the top 0.24 % of a rank distribution and is **flat by construction**.
   Measured on the 494 published scored rows carrying both value and acreage: raw `$/acre` spans
   **$3.91 – $336,897, 411 distinct values, 86,189×** (10,826× *within Watauga alone*), while the
   normalized value spans **0.267 points out of 100**. The information for a real ranking is
   already in the payload; the transform throws it away.

2. **A live data bug is shipping right now.** `fetchCellBbox` quarter-splits on
   `exceededTransferLimit` and merges with `flatMap` and **no dedupe by `permanent_identifier`**.
   11 of 60 cached cells carry duplicates. `computeWater` does `frontage[regime] += metres`, so
   **published frontage metres — rendered verbatim on the card — are inflated up to 4×**, worst in
   the densest counties. The score cannot see it (`scoreWater` normalizes frontage to the constant
   `cfg.water.frontage_score`), so no gate, no test and neither plan's proposed spread gate catches
   it. This is the site's single differentiating claim, and it is wrong on the public origin today.

3. **55 of 100 nominal weight points have never fired and are not scheduled to.** `discount`
   (w30) needs `evidence.price` AND `value > 0` AND `value_basis === 'market_equivalent'`; the only
   priced rows in existence are the 8 Jackson REO parcels and **all 8 have `assessed_value: null`**
   (the county zero-values property it owns). `distress` (w25) fires only on notice-matched
   parcels — 8 matched; Haywood's 3 notices are a scanned PDF and are not parcel-joinable.

4. **The scorer reads a path nothing writes.** Producer `pipeline/ingest-distress.ts:133` writes
   `data/distress/evidence.json` (8 records, each with a real `price_usd`). Consumer
   `pipeline/score/enrich-contract.ts:138,140` reads `data/evidence/for-sale.json` and
   `data/evidence/distress.json`. **`data/evidence/` does not exist.** Both sides are internally
   consistent, so every test passes.

5. **The enriched set and the published set are disjoint.** 19 published rows carry a water value;
   **all 19 have `denominator: 15`** and **0 of them also have `per_acre`**. `pipeline/enrich`
   selects by acreage DESC; `publish/run.ts` selects by score. Enriching harder does not put water
   on published rows.

6. **The enricher is pathologically slow, and its cost is not where anyone said it was.** Measured
   offline on the worst record (`37175:8594-94-2018-000:0`, no network, both NHD cells cached): it
   **completes in 381.8 s**. 78 % of that is **4 NHDArea polygons of 181,882 vertices** — three of
   them exact duplicates of one feature whose bbox spans 0.83° × 0.89° ≈ 74 cells. Flowlines are
   73.9 s of 381.8 s.

7. **The gates gate nothing about what ships.** Verified on the same commit `6cfcb90`: `Deploy to
   GitHub Pages` **succeeded** while `Gates` **failed**. `deploy.yml` has no `needs:` and no
   `workflow_run:` on Gates and never runs `npm run verify`. `Gates` was red on every push for the
   whole session while the site shipped every time. Separately, `verify-no-pii.mjs` matches PII
   **field names**, not values — a grantor name in free text passes.

### What was already fixed and shipped this session (context, not scope)

- **`6cfcb90` — "Map told five lies; each one is now measured, not argued."** Five map/filter
  defects fixed. **Deployed and verified live.**
- **`b37082a` — "The control fixture CI could never see."** `verify-ledger-reconciles`'s red
  control fixture was gitignored, so Gates was red on every push and everyone had learned to ignore
  it. **Deployed and verified live.**
- A live enrichment process (**PID 24359**, ~5 h wall) was found grinding at 12–30 parcels/hour.
  ⟂ **OVERRULES both plans' "zero rows committed / nothing is lost by killing it."** It has
  **87 durable rows, 91 geometries, 60 cached cells (~175 MB)** and a 20 MB WAL. The kill is still
  correct — the cost is quadratic and it will not finish — but the reason is the opposite one, and
  the 87 rows are the only real throughput sample anyone has.

---

## 2. The five decisions this plan makes

**D1 — The cheapest fix goes first, and neither input plan lists it.**
Replace the rank transform in `scorePerAcre()` with a **cohort-relative magnitude normalization**.
Simulated on the real rows: **85 distinct scores across 0–100** (p10=5, p25=12, p50=36, p75=57,
p90=74) where there is now **1**. Offline, zero fetches, no dependency on the enricher, the
backfill, or 2.6 h of EPQS. **It reaches `scope.md`'s success signal on its own.**
⟂ **OVERRULES claim C6** ("saturation is by SELECTION, not by broken normalization"), which
foreclosed this branch for both panels. C6 is right about the mechanism and wrong about the remedy:
selection and normalization compose, and only one of them is expensive to change.

**D2 — Demote and rename the Lane-2 number. Adopted, as the default, deliberately.**
On 650 not-for-sale rows the published number cannot be an under-market estimate, because the only
under-market input — a price — does not exist for them and will not after any plan on the table.
What it honestly is, is *"how cheap per acre is this, against its own county's comparables."*
Publish it as **`cheapness`**, computed from the per-acre magnitude alone. Water and slope stay as
**labelled, separately rendered attributes and filters** — they are real and useful — but they are
**not blended into the published number**. Reserve the word **score** for Lane 1, where a price
exists.
*Consequences, all of them wins:* the 55 dead weight points leave the card; the denominator stops
varying by a factor of six; `confidence` becomes interpretable; **Plan A's P4 (the evidence floor,
a threshold calibrated from a distribution that does not exist yet, plus a `weights.yaml` edit that
must dodge `assertWeightsSumTo100`) is deleted entirely**; and the CE-4 failure — a beautiful
distribution that ranks nothing useful, at a 466:1 amenity-to-price variance ratio, with every gate
green — becomes **structurally impossible**, because the ranked quantity is price-derived by
construction.
*Honest note, not a hedge:* the field rename diverges from `scope.md`'s literal wording. The
normalization change in Phase 1 satisfies the success signal either way; the rename is contained in
one small phase (schema + allowlist + card label + ADR) and is reversible in one commit if the
owner prefers the old name. The default is: **rename.**

**D3 — Lane 1 outranks Lane 2, and the ordering of work says so.**
The product is Lane 1 — the lane the UI opens by default. It holds **8 rows the scorer cannot
score** and **3 Haywood foreclosure sales dated 2026-08-20, i.e. tomorrow**. Both panels ranked
Lane-1 coverage last because it "doesn't move the 500-way tie." Each was locally correct; jointly
it is an error of ranking work by the proxy instead of the mission. Lane-1 honesty (Phase 3) lands
before any enrichment scale-up, and Lane-1 **coverage** (Phase 6 — more county feeds, OCR for the
Haywood notices) is scheduled **ahead of** the county backfill.

**D4 — TB-1 = A and TB-2 = B are binding, and TB-2 is a correctness gate, not a label.**
Declare a fixed selection axis and write it to one file both the enricher and the publisher read
(Phase 2) — this is the same mechanism that fixes the disjoint enrichment/publication sets. Extend
the `county_owned_reo` enum **and** `weights.yaml`'s `increments` in the **same commit** as the
evidence wiring: an undeclared kind yields `increments[kind] → undefined → NaN → clamp(NaN) → null`
while still carrying weight 25 into the denominator, i.e. a component that claims to be *scored*
and serialises to *unknown*, with a NaN in the numerator.

**D5 — The +68 % backfill is out of this sweep.**
`data/events/2026-08/nc-onemap-parcels.ndjson` is already a committed **51,903,096-byte** blob at
220.47 bytes/line; +263,292 rows projects to **~109.95 MB**, one file per source per month, no LFS.
GitHub rejects the push **after** the ingest has run — and on a hosted runner the ephemeral
warehouse is discarded, losing the whole run. The trigger is calendar-dependent, so no test finds
it. The backfill also lands in exactly the three densest-hydrography counties in the corpus, and it
forces a second full enrichment pass. It is deferred to Phase 7 behind a writer shard and a staged
blob-size gate.

---

## 3. Phases

Standing rules for every phase: `npm run verify && npm test` green before the first write and again
before the commit; any phase that opens a socket runs `npm run verify` green **before the first
request**; every new `scripts/verify-*.mjs` ships a red fixture registered in
`scripts/gate-fixtures.json`, because `verify-controls.mjs` discovers gates from disk and fails any
with no `expect: "red"` entry.

---

### Phase 0 — Stop shipping a wrong number; make the gates gate; take the snapshot

`depends_on_claims: []`

**Goal.** Three things that are cheap, urgent, and prerequisites for everything that follows: stop
publishing frontage metres that are up to 4× wrong; make `Deploy` actually depend on `Gates`; and
snapshot the only copy of 175 MB of cached geometry before Phase 4 changes the cache format.

**Steps.**
1. **`PRAGMA wal_checkpoint(TRUNCATE)` on `data/enrich/enrichment.sqlite`, then kill PID 24359.**
   87 enriched rows / 91 geometries / 60 cells are durable and WAL-mode SQLite is crash-safe
   (verified by restore test). Record the 87-row throughput sample before discarding the process —
   it is the only real one.
2. **`npm run mirror` — after the kill (so the DB is quiescent), before any `nhd.ts` edit.** The
   existing archive ran at 14:46, **18 minutes into** the live run, and holds **39 of 87**
   enrichments and **30 of 60** cells. Everything since exists only in a gitignored file.
   ⟂ **OVERRULES Plan A**, which schedules `npm run mirror` only in P5, against the parcel
   warehouse; its P0 has no mirror step at all.
3. **Fix the mirror procedure while here:** stop archiving `enrichment.sqlite-shm` and remove the
   "convert `__` to `/`" `-shm` restore step from `RECOVERY.md` — handing SQLite a foreign `-shm`
   is unsafe. Recompute and rewrite `warehouse-pointer.json`'s `sha256`/`bytes` (measured stale:
   pointer says `baf17b77… / 75,862,016`, disk holds `87d87fff… / 201,588,736`) and add pointer-sha
   verification to `verify-ledger-reconciles.mjs`, or stop writing a sha nobody maintains.
4. **Suppress the frontage metre figure** in the water `basis` string until Phase 4's dedupe lands:
   render *"mapped stream or river runs through the parcel polygon (USGS NHD)"* with **no number**.
   Printing a number known to be wrong by up to 4× on the site's single differentiating claim is
   the same defect class as a link that looks like verification and is not.
5. **Gate the deploy.** `deploy.yml`'s `build` job gets `npm run verify` as its **first step**
   (preferred over `workflow_run:` — it is one line, has no cross-workflow latency, and cannot be
   satisfied by a stale prior run).
6. **Fix the stale literal** in `pipeline/store/events.ts`: *"`complete` gates the deploy:
   deploy.yml refuses a manifest that is not."* It does not and never has; the newest manifest is
   `status: "partial"` and deployed regardless.

**Files.** `scripts/mirror.mjs`, `RECOVERY.md`, `scripts/verify-ledger-reconciles.mjs`,
`pipeline/score/signals.ts` (water basis string), `.github/workflows/deploy.yml`,
`pipeline/store/events.ts`, `data/warehouse/warehouse-pointer.json`.

**Pre-build gates.** `npm run verify && npm test`. No socket opens in this phase — assert it.

**Acceptance (each fails if the phase silently did nothing).**
1. `~/blue-ridge-archive/MANIFEST.json` shows a **new** run timestamp and the restored DB reports
   `parcel_enrichment ≥ 87`, `nhd_cell ≥ 60` (today's archive: 39 / 30). Restore into a scratch dir
   and run `PRAGMA integrity_check`.
2. `grep -c 'm of mapped' site/src/data/listings.json` → **0** after republish (today: > 0).
   **Control:** the same grep against the pre-change build is non-zero, so the assertion is shown to
   discriminate.
3. **A deliberately-red gate must turn `Deploy` red.** Plant a known-red fixture on a scratch
   branch, push, and assert the `Deploy` run **fails**. Reading the YAML is not enough — the whole
   finding is that a config that *looks* gated was not.
4. `warehouse-pointer.json`'s `sha256` matches the file it names, asserted by
   `verify-ledger-reconciles.mjs`; the gate is red against the current (stale) pointer before the
   fix.

---

### Phase 1 — Cohort-relative magnitude normalization (the decisive fix)

`depends_on_claims: [C5, C6]` — and it **retires C6's remedy clause**.

**Goal.** Reach `scope.md`'s success signal offline, before spending anything on data.

**Steps.**
1. **Compare two variants on the real 494 rows, offline, and pick by measurement — do not assume.**
   (a) `log10($/acre)`, min–max within `(fips, use-bucket, band)` cohort, inverted;
   (b) median/IQR-relative on the same log axis, clamped.
   Variant (a) is simulated at **85 distinct / 0–100** but is **outlier-sensitive**: Watauga's
   $336,897 sets that county's floor single-handedly. Variant (b) is the likely-more-robust
   candidate and has **not** been measured. Record both distributions (distinct count, quartiles,
   per-county range, top-20 membership overlap) in `docs/probe-log.md` and the choice at the fix
   site.
2. Implement the winner in `scorePerAcre()`. Keep the repo's standing rule — **ranked inside its own
   county cohort, never against a national threshold** — which both variants preserve.
3. **The meaning of the signal changes**, from *"cheaper than N % of comparable parcels"* to
   *"how cheap, relative to its county cohort's range."* The card's note string and an ADR change
   with it, in the same commit. A number whose meaning changed silently is worse than one that is
   flat.
4. Ship `scripts/verify-score-spread.mjs` and register it in `verify-all.mjs` + `gate-fixtures.json`.
   Assertions: ≥ 50 distinct non-null published values; no single value > 10 % of rows; IQR ≥ 10
   points; `scores.every(s => s === 100)` is fatal. **Red fixture is free and unusually strong:**
   copy today's committed `site/src/data/listings.json` verbatim to
   `fixtures/gates/listings-saturated.json` — the gate is then proven red against the *actual
   historical failure*, not a synthetic imitation of it.

**Files.** `pipeline/score/signals.ts`, `pipeline/score/weights.yaml` (note/params only),
`docs/decisions/00NN-per-acre-magnitude-normalization.md` (new),
`scripts/verify-score-spread.mjs` (new), `fixtures/gates/listings-saturated.json` (new),
`scripts/gate-fixtures.json`, `scripts/verify-all.mjs`, `tests/score.test.ts`.

**Pre-build gates.** `npm run verify && npm test`. Phase 0 acceptance #3 green (so what this phase
publishes is actually gated). **No socket opens** — assert it.

**Acceptance (each fails if the phase silently did nothing).**
1. `count(distinct non-null score)` on `site/src/data/listings.json` **≥ 50** (today **1**).
   **Control:** the pre-change scorer, run through the identical harness, yields **1** — the test
   is demonstrated to discriminate.
2. **Monotonicity within a cohort:** for any two published rows in the same `(fips, use-bucket,
   band)`, the cheaper raw `$/acre` scores strictly higher. A transform that produces spread by
   scrambling order passes a distinct-count gate and fails this one.
3. **Outlier-sensitivity assertion:** removing the single most extreme `$/acre` row from a county
   moves no other row in that county by more than **X points** (X fixed from step 1's measurement).
   This is the assertion that would have caught min–max being the wrong choice.
4. `verify-score-spread.mjs` exits non-zero against `fixtures/gates/listings-saturated.json` and
   zero against the new build; `verify-controls.mjs` green.

---

### Phase 2 — Declare one selection axis, in one file both sides read (TB-1 = A)

`depends_on_claims: [C2, C4, C6, C11]`

**Goal.** Kill the disjoint enrichment/publication sets, and make the selection rule a **published
fact** rather than an emergent property of two independent sorts.

**Design.**
- `publish/run.ts` gains an explicit two-step selection: **POOL** = top **K = 750** by the declared
  axis, plus every for-sale-evidenced row, minus vetoed rows; **PUBLISH** = the pool, capped at
  `N = 500`. The pool is written to `data/enrich/pool.json`, and `pipeline/enrich`'s candidate
  selection reads **that file**, not `selectCandidates()`'s acreage-DESC window.
- `manifest.selection = { axis, pool_k, published_n, rule }` — in the same register as
  `value_floors` and `excluded` already are.

**⟂ OVERRULES the critic's CE-7 objection, on a measurement.** CE-7 argues the selector is
saturated *inside* the pool it selects, converting `per_acre` into a constant. That is a property
of **rank** transforms. After Phase 1 the ranked quantity is a **magnitude**, and the published
slice's raw `$/acre` spans 86,189× — so the axis carries real variance inside its own pool. Phase 2
therefore keeps TB-1's mechanism (a declared, fixed, published axis, which is what fixes the
disjoint sets) without inheriting the flat-offset defect, and **asserts the difference** in
acceptance #4 rather than assuming it.

**Files.** `publish/run.ts`, `pipeline/enrich/index.ts` (read the pool file),
`scripts/build-enrich-pool.mjs` (new), `scripts/verify-enrich-pool.mjs` (new),
`fixtures/gates/listings-outside-pool.json` (new), `scripts/gate-fixtures.json`,
`tests/publish.test.ts`.

**Pre-build gates.** Phase 1 green. `npm run verify && npm test`. No socket.

**Acceptance (each fails if the phase silently did nothing).**
1. `manifest.selection` exists with all four fields; absent = red.
2. Every published `record_id` is in the pool — asserted by **recomputing the pool in the test**,
   never by trusting the writer. The 8 for-sale rows are in the pool regardless of rank.
3. **The invariance test that is the whole point:** score the corpus twice, the second time with an
   enrichment that changes water/slope on 200 pool rows. **Pool membership byte-identical; published
   attribute rendering differs.** Control: changing a field no signal reads (`named_waters`) leaves
   both identical.
4. **The anti-CE-7 assertion:** the spread of the per-acre component *within the published slice* is
   **≥ 20 points of 100** (today, measured: **0.267**). A pool of constants fails this.
5. `verify-enrich-pool.mjs`: every published row is either in `data/enrich/water.json` or carries a
   non-null `water_unknown_reason`. Red fixture `fixtures/gates/listings-outside-pool.json`.

---

### Phase 3 — Lane 1: one evidence path, the enum precondition, and the PII value screen (TB-2 = B)

`depends_on_claims: [C3, C4, C8]`

**Goal.** Make the 8 rows the owner can actually buy fully honest, and close the producer/consumer
split. This is **not** the fix for the 500-way tie; both plans size it correctly at 8 rows.

**Steps.**
1. **In ONE commit** (TB-2 addendum — doing either half alone ships a NaN): add
   `'county-owned-reo'` to `ForSaleEvidenceSchema.kind`, the matching zod value, **and** a
   `county_owned_reo` key to `weights.yaml`'s `distress.increments`. REO warrants the highest-
   confidence increment: it is a *completed* outright-ownership state, not a pending-sale notice.
   Record the reasoning as an inline note (5 lines, single-user tool — not a full ADR).
2. **Regression test in the same commit:** an *undeclared* `kind` must yield an honest
   `unknownComponent`, **never** a scored component whose value serialises to `null` via
   `clamp(NaN)`. Red today by construction.
3. New `pipeline/ingest/distress/to-contract.ts` (modelled on `pipeline/enrich/to-contract.ts`:
   translate, don't rewrite either side; absence stays absence) reads `data/distress/evidence.json`
   + `notices.json`, writes `data/evidence/for-sale.json` and `data/evidence/distress.json` in the
   contract's zod shapes. `publish/run.ts` drops its direct read at :79–83 and projects
   `for_sale_evidence` and `listing.price` from the contract. `lane` gets **one** producer — derive
   it in `payload.ts` **or** delete it from `allowlist.json`, never both.
4. **PII, and this is why Phase 0 step 5 had to come first.** These are **new git-tracked published
   surfaces built from foreclosure and county-REO documents** — the documents most likely to carry a
   person's name. `verify-no-pii.mjs` matches field **names**, not values. Therefore: template
   `how_to_verify` from structured fields (PIN, office, phone) exactly as the current ingest does,
   **never** pass county free text through verbatim; **and** add a value-level name screen scoped to
   `data/evidence/**`.
5. **Lane-1 cheapness uses the asking price, not the assessed value** — the 8 REO rows have
   `price_usd: 9500` and `assessed_value: null`. A price-basis `$/acre` is a genuinely better
   quantity than an assessed-basis one and **must not enter an assessed-basis cohort**; the existing
   `CrossBasisRankingError` guard is the right instrument. Assert it is still throwing.

**Files.** `pipeline/ingest/distress/to-contract.ts` (new), `pipeline/score/enrich-contract.ts`,
`pipeline/score/weights.yaml`, `pipeline/score/signals.ts`, `publish/run.ts`, `publish/payload.ts`,
`publish/allowlist.json`, `scripts/verify-interchange.mjs` (new), `scripts/verify-no-pii.mjs`,
`fixtures/gates/evidence-off-contract.json` (new), `scripts/gate-fixtures.json`,
`tests/score.test.ts`.

**Pre-build gates.** Phase 0 acceptance #3 green (**hard** — this phase creates the published
surface the PII floor exists to protect). `npm run verify && npm test`. No socket.

**Acceptance (each fails if the phase silently did nothing).**
1. `manifest.enrichment_present.for_sale === true` (today `false`).
2. **≥ 8 published rows carry a non-null `listing.price`** (today **0**).
3. Exactly the rows with `for_sale_evidence !== null` have `lane === 'market'`; count **8**.
4. A `county_owned_reo` observation produces a **numeric** distress component with the declared
   increment; an *undeclared* kind produces `unknown`, not `null`-via-NaN. **Both directions**, or
   the test is satisfied by a scorer that nulls everything.
5. `verify-interchange.mjs` red if `publish/` or `pipeline/score/` reads an evidence-shaped path not
   named in `enrich-contract.ts`, or if a `record_id` in `data/distress/evidence.json` is absent
   from `data/evidence/for-sale.json`. Red fixture planted; `verify-controls.mjs` green.
6. **PII canary:** a synthetic grantor name planted in a `how_to_verify` **value** in
   `data/evidence/for-sale.json` makes `verify-no-pii.mjs` exit non-zero. Today it exits zero —
   that is the finding.

---

### Phase 4 — Make the enricher affordable: the measured mitigation ladder

`depends_on_claims: [C11]`

**Goal.** Bring the worst-case parcel from **381.8 s** to inside a stated budget, and un-inflate the
frontage metres.

**⟂ OVERRULES both plans' P0/B1 step 3 (a bbox/R-tree prefilter over the cell's FLOWLINES) and the
orchestrator brief they copied it from.** Measured: flowlines are **73.9 s of 381.8 s**. The
prefilter removes **21 %** of the cost, leaving ~302 s — so P0 would **fail its own "< 30 s"
acceptance test after the work was done**, and P0 hard-blocks the downstream phases in Plan A's DAG.
⟂ **OVERRULES both plans' "reproduce the hang on one record"**: there is no hang and no pathological
record; the job is uniformly expensive in dense cells, and a one-record repro will succeed at
producing a slow record and **teach the wrong lesson**.

**The ladder, in the order its measured value justifies.**
1. **Dedupe by `permanent_identifier` when merging quarter-fetches** — 3 of the 4 giant areas are
   exact duplicates of one feature. **381.8 s → ~155 s for a 3-line change**, and it is
   simultaneously the fix for the shipping frontage-inflation bug.
2. **Bbox prefilter on flowlines + waterbodies** (what both plans specify — genuinely worth doing,
   just not sufficient). **~155 s → ~78 s.** Measured rejection: 142 of 4,147 flowlines kept (3.4 %),
   4 of 124 waterbodies (3.2 %).
3. **The missing step: clip cell geometries to the cell bbox once, at cache-write time.**
   `turf.bboxClip` against `cellBboxOf(key)` in `fetchCellOnce`, before `putCell`, with a skirt
   **≥ `SEARCH_RADIUS_M` (500 m)**. This is the only mitigation that touches the residual 76 s, it
   is paid **once per cell instead of once per parcel**, and it shrinks the 18.97 MB cell payload.
   It is a **cache-format change** — Phase 0's mirror is its precondition. *Fallback if refetching
   is unacceptable:* clip on read, memoised per `(cell_key, feature_id)`.
   **Bias check:** none, provided the skirt ≥ 500 m — `scoreWater` discards any distance > `mid_m`
   (400 m) and `flowDist`/`wbDist` are nulled above `SEARCH_RADIUS_M`. A **zero** skirt would
   silently shorten frontage for parcels straddling a cell edge — an `unknown→0` shape — which is
   exactly what acceptance #2 exists to catch.
4. **Then, and only then, the per-parcel timeout**, with its budget set from the **post-fix measured
   p99 × 3**, recorded beside the constant. ⟂ **OVERRULES both plans' 20 s default**: the flowline
   loop alone is 73.9 s before any area is touched, so at 20 s essentially every Pisgah/Nantahala
   parcel yields `enrich_timeout` and the safety net becomes the geographic filter it was written to
   prevent. Plan A's reasoning about timeout bias is correct and its own default defeats it.
5. **Heartbeat + counters.** Five hours producing one log line is why "hung" and "grinding" were
   indistinguishable from outside.
6. **Re-derive the 87 already-enriched rows** and diff — some committed `water.json` values, and the
   git-tracked `enrichment-latest.json`, are already inflated. Restore the frontage metre string in
   the card once the diff is clean.

**⟂ OVERRULES Plan A's P0 step 6 (re-tile to finer NHD cells).** Not done: it invalidates the whole
`nhd_cell` cache and shifts cost from CPU to egress on a 0.5 rps host. Clip-at-cache-write is
strictly cheaper. Routed to Phase 7 as a recorded non-decision.

**Files.** `pipeline/enrich/nhd.ts` (dedupe, prefilter, clip-at-write),
`pipeline/enrich/geometry.ts`, `pipeline/enrich/index.ts` (timeout, heartbeat, counters),
`pipeline/enrich/schema.ts` (`water_unknown_reason: 'enrich_timeout'`),
`fixtures/enrich/nhd-giant-area-82.7-35.2.json` (new), `tests/enrich.test.ts`.

**Pre-build gates.** Phase 0 mirror complete (**hard** — this changes the cache format).
`npm run verify && npm test`. **No socket opens in this phase** — assert it; an enrichment fix that
quietly re-fetches cannot be tested offline, and both cells are already cached.

**Acceptance (each fails if the phase silently did nothing).**
1. The worst-case fixture record completes in **< 30 s**. **Control:** the same test against the
   pre-fix path takes **≥ 300 s** — this is a measured pair, not an aspiration.
2. **Byte-identical results** on all seven existing `fixtures/enrich/nhd-*.json` **plus the new
   giant-area fixture**. ⟂ The existing fixture set contains **no** giant-area case and would pass a
   clipping bug unchanged — extending it is load-bearing, not tidiness.
3. **Dedupe regression:** a synthetic 2-quarter merge in which one feature straddles the boundary
   yields `flowlines.length === distinct(permanent_identifier).length`. **Red today by
   construction.**
4. Re-deriving the 87 rows changes ≥ 1 published `frontage_m` value **downward** and none upward;
   the diff is recorded. A phase that did nothing produces an empty diff.
5. A parcel exceeding the budget returns `status: 'unknown'` with
   `water_unknown_reason === 'enrich_timeout'` and **never** `has_stream: false`. A timeout recorded
   as a measured negative is the single most dangerous confusion available here.
6. `counters.timeouts` is reported and ≥ 1 heartbeat per 25 parcels is emitted. A silent run fails.

---

### Phase 5 — Validity before spend: 20-row Spearman + a 50-parcel slope histogram

`depends_on_claims: [C2, C11]`

**Goal.** ⟂ **OVERRULES both plans on the same point:** every gate either panel proposes measures
the **shape** of the distribution and none measures its **validity**. A plan can produce a beautiful
distribution that ranks nothing useful with all gates green. This phase buys the only external
validity signal available, and it costs about half an hour.

**Steps.**
1. **Owner-labelled Spearman.** Sample 20 published rows stratified across the new `cheapness`
   range; the owner ranks them by eye, once; compute Spearman ρ against the published order. Record
   ρ, the sample, and the date in `docs/probe-log.md`. **This is the only instrument in the whole
   programme that can fail for the right reason.** A low ρ does not automatically block — it
   triggers a recorded decision, because a single-user tool's owner is the ground truth.
2. **Slope histogram de-risk — 50 parcels × 5 EPQS requests at 0.4 rps ≈ 10 minutes.**
   ⟂ **OVERRULES both plans**, which commit ~2.6 h of EPQS to `livability` on the strength of a
   **synthetic** replay ("59 distinct scores"), when exactly **4** real livability values exist on
   disk (slope 12.1 / 14.9 / 15.9 / 24.4 %). `scoreLivability` is `clamp(100 − slope/30 × 100)`, so
   **every parcel steeper than 30 % mean slope collapses to exactly 0** — in counties whose defining
   feature is mountains. Measure the histogram **before** the spend.
3. Record the sampling-error caveat honestly: slope comes from **5 EPQS points** (centroid + four
   20 %-inset bbox corners) over hundreds of metres. Both plans reject "publish an extra decimal"
   because it *"manufactures a spread that is noise"* and then propose to rank on a 5-sample slope
   estimate. Under **D2** slope no longer drives the published number, which resolves the
   inconsistency — it is an attribute, held to an attribute's standard.

**Files.** `docs/probe-log.md`, `scripts/probe-slope-histogram.mjs` (new, throwaway-grade is fine),
`docs/decisions/` if the ρ result forces a ruling.

**Pre-build gates.** Phases 1–2 green (there must be a real ranking to label). `npm run verify`
green **before the first socket** — this phase opens one.

**Acceptance.**
1. A ρ value, a dated 20-row sample, and the owner's labels exist on disk. **Absence is failure** —
   a phase that "ran" without producing the labelled set did nothing.
2. A slope histogram over ≥ 50 real parcels exists, with the **share clamping to 0 at ≥ 30 % slope**
   stated as a number. If that share exceeds 40 %, Phase 6's slope pass is **re-scoped or dropped**,
   and the reason is recorded — that decision is this phase's product.

---

### Phase 6 — Enrich the pool, and expand Lane-1 coverage

`depends_on_claims: [C2, C3, C4, C11]`

Two lanes, deliberately in this order. Under **D2** neither is on the critical path for the success
signal — Phase 1 already delivered it. That is the point.

**6a — Lane-1 coverage (the mission item, ranked first).** More counties' foreclosure / tax-sale /
upset-bid feeds, and OCR for the 3 Haywood notices dated **2026-08-20**. This is the only work in
the entire programme that increases the count of things the owner can **actually buy**, and it is
what the README says the site is for. OCR is unbudgeted today (probe-log §2.3) and must be scoped
here rather than waved at.
*Acceptance:* the count of rows with `for_sale_evidence` **increases from 8**; each new row carries
a resolving source URL and a `how_to_verify` built from structured fields. A phase that added a
feed but no rows fails.

**6b — Attribute enrichment for the pool (water, then slope).** `npm run enrich --
--ids-from data/enrich/pool.json`. Water cost per parcel is **now measured** (Phase 4), not
extrapolated from the 87 pre-fix rows, which are biased toward cheap cells. Slope is rate-bound and
predictable at ~12.5 s/parcel (5 requests at 0.4 rps) — **~2.6 h for K=750**, and is run only if
Phase 5's histogram justified it. Runs **locally**: the weekly-cadence TERMS justification in
`ingest-parcels.yml` governs *hosted-runner* burden; a polite local crawl at ≤ 1 rps with an honest
UA and a contact address is inside the posture ADR 0003 already establishes. `sources.enrich.yaml`
is unchanged — **no new host is contacted**; `fema-nfhl` (robots-disallow) and `census-tigerweb`
(robots-unobtainable — the WAF serves HTML at 200, which `robots-parser` reads as ALLOWED) stay in
`refused[]`, and flood and road stay honestly unknown.
*Acceptance:* `manifest.signals.known.water ≥ 600` (today **25**); **≥ 3 of water's 4 bands**
(1.0 / 0.7 / 0.4 / 0.0) appear among published rows — if every water row is again `1.0` the plateau
has been recreated and the phase is red; **idempotence** — a re-run gives
`report.from_cache === report.enriched` and byte-identical contract files; timeouts ≤ 1 % of the
pool **and** ⟂ an **absolute** floor, not only Plan A's relative S8 (*max per-county unknown share
≤ 2× corpus share*), which **passes at a 90 % timeout rate** when the degradation is uniform —
which is exactly what happens once the pool is dominated by dense-hydrography counties.

**Pre-build gates.** Phase 4 acceptance green (**hard** — enriching before the ladder lands repeats
a multi-hour silent grind, this time on a schedule). Phase 5's histogram ruling recorded.
`npm run verify` green **before the first socket**.

---

### Phase 7 — Routed, deferred, and recorded (no code except the two guards)

`depends_on_claims: [C10, C14]`

1. **The +68 % county backfill (Buncombe / Henderson / Haywood) — deferred out of this sweep (D5).**
   Preconditions before it may ever run: (a) shard `EventWriter`'s path to
   `data/events/<YYYY-MM>/<sourceId>-<fips>.ndjson` (or gzip the committed log — it packs 64:1, so
   git storage was never the issue; the **blob-size limit** is); (b) a **new gate: fail if any file
   staged for commit exceeds 90 MB**; (c) the ledger gate's absent-pointer and empty-parcels
   branches must exit **non-zero when `data/coverage.json` claims any county is `ingested`** — today
   both print an honest sentence and `exit 0`, so `verify-all.mjs` reports 8/8 green over a
   destroyed warehouse while a committed coverage surface still asserts the rows; (d) the
   Buncombe reappraisal-vintage discrepancy (seed note vs NCDOR's 2026-27 table, last 2021 / next
   2027) resolved **before** the ingest, or vintage decay is wrong for 26.8 % of the corpus.
   When it runs: **locally**, one county at a time, `npm run mirror` first, with a controlled count
   probe per county carrying a **negative** control (`cntyname='Zzzznotacounty' → 0`) and a
   **positive** control (an already-ingested county within ±2 % of its `coverage.json` rows) — ADR
   0005 recorded byte-identical `1=1 → 866 / Watauga → 0 / Zzzznotacounty → 0`, so an uncontrolled
   count is not evidence. **Not** on a hosted runner: `ingest-parcels.yml` commits the **ledger**
   while discarding the **warehouse** (gitignored, ephemeral runner), which manufactures the exact
   drift `verify-ledger-reconciles.mjs` exists to catch.
   *(a) and (b) are the only code in this phase* — they are cheap and they close a wall this repo
   has now met twice.
2. **NHD re-tiling** — recorded as considered and rejected in favour of clip-at-cache-write; revisit
   only if Phase 4's measured distribution says otherwise.
3. **Yancey: 17,332 rows ingested, 9 scorable.** A county present and functionally invisible. Filed
   with the measurement; it is a coverage/quality question, not a ranking one.
4. **The A6 class — a published literal that stopped being true** — has no gate. Propose a check
   that every free-text assertion in the manifest is derived from a value in the same object, or is
   absent.

---

## 4. Dependency DAG and critical path

```
  Phase 0  kill + checkpoint + MIRROR
           suppress frontage metres
           deploy.yml runs npm run verify
                 │
     ┌───────────┼───────────────────────────────┬──────────────────────┐
     │           │                               │                      │
     ▼           ▼                               ▼                      ▼
  Phase 1     Phase 3  Lane-1 evidence      Phase 4  enricher      Phase 7  guards
  MAGNITUDE   (enum + increments + PII)     ladder (dedupe →       (event shard,
  NORMALIZ.   ── hard dep on Phase 0 §5     bbox → clip)           >90 MB gate)
     │           │                               │
     ▼           │                               │
  Phase 2     ◄──┘                               │
  declare axis + pool.json                       │
     │                                           │
     ├──────────────► Phase 5  VALIDITY ◄────────┘
     │                (Spearman + slope histogram)
     │                        │
     └────────────────────────┴──────────► Phase 6a Lane-1 coverage
                                           Phase 6b pool enrichment
                                                    │
                                                    ▼
                                              republish + gates
```

**Critical path to the success signal: `Phase 0 → Phase 1`.** That is the whole of it — one offline
file change behind three cheap safety steps. ⟂ Both input plans put a multi-day, CPU-pathological,
three-host data programme on the critical path for an outcome a one-file offline change reaches
first.

**Parallelism.** Phases 1, 3 and 4 touch disjoint files and contend on no shared rate limiter (Phase
4 opens no socket at all). Phase 3 is the only one with a hard dependency on Phase 0 beyond the
mirror, because it creates the published surface the PII floor protects. Phase 6b and Phase 7's
deferred backfill contend on nothing (USGS/NHD vs nc-onemap) but are sequenced anyway, because the
backfill redraws the pool and would force a second enrichment pass.

**Hard blocks, each with its mechanism:**
- Phase 0 mirror **→** Phase 4 (cache-format change destroys 30 unmirrored cells / 48 unmirrored
  enrichments; recovery is ~6 min of egress **plus ~5 h of CPU**).
- Phase 0 §5 (deploy gating) **→** Phase 3 (new published surface built from name-bearing documents).
- Phase 1 **→** Phase 2 (the pool axis is only meaningful once the axis carries variance).
- Phase 4 **→** Phase 6b (enriching before the ladder repeats a multi-hour silent grind).
- Phase 5 **→** Phase 6b's slope pass (do not spend 2.6 h on a lever that may clamp to a new
  plateau at 0).

---

## 5. Risk matrix (critic's + red team's, merged)

| # | Risk | P | Impact | Status | Mitigation / waiver |
|---|---|---|---|---|---|
| **H1** | **The flowline prefilter is the wrong fix** — 73.9 s of 381.8 s; the giant area's bbox spans ~74 cells so feature-level rejection is structurally guaranteed to keep it; per-part rejection keeps 100.00 % of vertices (1 part, 1 ring set). | 0.8 | Critical | **Mitigated** | Phase 4's measured ladder: dedupe → bbox → **clip-at-cache-write**. Acceptance #1 carries a paired 300 s pre-fix control, so a partial fix goes red *before* the downstream phases depend on it. |
| **H2** | **Frontage inflated up to 4× on the live site** — 11 of 60 cells duplicated; `frontage += metres`; invisible to every gate because `scoreWater` normalizes to a constant. | 1.0 (**shipping now**) | High | **Mitigated** | Phase 0 §4 stops printing the number **today**; Phase 4 §1 dedupes; Phase 4 acceptance #3–#4 prove it. Waiver if deferred: keep the qualitative sentence — **never** print a number known to be wrong. |
| **H3** | **A green gate suite certifies an amenity index** — every proposed gate measures distribution shape; price would contribute ~0.12 of 100 score points at a 466:1 ratio. | was 0.75 | High | **Structurally eliminated** by **D2** (published number is price-derived only) + Phase 2 acceptance #4 (per-acre spread inside the slice ≥ 20 points) + Phase 5's Spearman. |
| **H4** | **The cheap fix is never found** — a `settled`-tiered C6 sentence closed the normalization branch for both panels. | was 0.7 | High | **Eliminated** — it is Phase 1, first on the critical path. C6's remedy clause is retired in writing. |
| **H5** | **Deploy is not gated by Gates; the PII floor is advisory at publish time.** Verified on `6cfcb90`: Deploy SUCCESS / Gates FAILURE, same commit. Plus `verify-no-pii` matches field **names**, not values. | 1.0 (**true today**) | High | **Mitigated** — Phase 0 §5 + Phase 3 §4, with a **live red-fixture push control** (acceptance #3), because reading the YAML is precisely what would not have caught this. |
| **H6** | **The +68 % backfill crosses GitHub's 100 MiB blob limit** — 51,903,096 B committed today, ~109.95 MB projected, one file per source per month, no LFS; rejected **after** the ingest; on a runner the ephemeral warehouse is lost. Calendar-dependent, so no test finds it. | 0.9 if run in Aug | High | **Deferred + mitigated** — **D5**: out of this sweep; Phase 7 ships the writer shard and a >90 MB staged-blob gate as its preconditions. Explicit waiver if the owner runs it anyway: run **locally**, after a month boundary, accepting the same wall on the next full refresh. |
| **H7** | **The mission loses to the metric** — both panels demoted Lane 1 (8 rows, 3 sales tomorrow, the default-open lane) because it "doesn't move the tie". | was 0.8 | Critical (product) | **Mitigated** by **D3**: Phase 3 is early, Phase 6a precedes the backfill, and the Haywood OCR is scoped rather than waved at. |
| **H8** | **55 dead weight points preserved**, requiring a delicate calibrated floor that dodges `assertWeightsSumTo100`. | was 0.8 | Medium | **Eliminated** by **D2** — Plan A's P4 is deleted, not repaired. |
| **M1** | **Timeout default 3× below the measured floor** (20 s vs a 73.9 s flowline loop) makes `water` anti-correlated with water; Plan A's relative S8 **passes at a 90 % timeout rate** when degradation is uniform. | 0.7 if shipped as written | Med-High | **Mitigated** — Phase 4 §4 sets the budget from post-fix measured p99 × 3; Phase 6b adds an **absolute** corpus-wide unknown-share floor beside the relative test. |
| **M2** | **`livability` clamps to a new plateau at 0** — `clamp(100 − slope/30 × 100)`, 4 real values on disk, "59 distinct" is synthetic. | 0.45 | High (if on critical path) | **Mitigated** — Phase 5's 10-minute, 50-parcel histogram gates the 2.6 h spend; and under **D2** slope is an attribute, not the ranked number. |
| **M3** | **The mirror covers half of what Phase 4 changes** — 39/87 enrichments, 30/60 cells; the hot copy's integrity was luck (`sha256` then `copyFileSync` as two reads of a file being written). | 0.5 | Medium | **Mitigated** — Phase 0 §2 mirrors **after** the kill, so the DB is quiescent; §3 fixes the `-shm` defect and the stale pointer sha. |
| **M4** | **A destroyed or half-built warehouse passes the gate family** while committed `coverage.json` still claims coverage — both gate branches `exit 0`; `data/warehouse/` is gitignored so only the mirror can restore it. | 0.4 | Medium | **Mitigated** — Phase 7 §1(c): those branches exit non-zero when coverage claims `ingested`. The gate already holds both facts. |
| **M5** | **Ranking on a 5-sample slope estimate produces spread from instrument noise**, while "one extra decimal" was rejected for exactly that reason. | 0.4 | Medium | **Mitigated** by **D2** (slope is not ranked) + Phase 5 §3 recording the caveat. |
| **L1** | **The kill discards the only throughput sample** (87 rows, 20 MB WAL) as "worthless" on a retracted premise. | 0.4 | Low | **Mitigated** — Phase 0 §1 checkpoints and records the sample first. |

**No HIGH item is unmitigated and no waiver is implicit.** The two explicit waivers on offer, both
owner-facing: (H2) keep the qualitative frontage sentence for one cycle if Phase 4 slips; (H6) run
the backfill locally after a month boundary and accept the deferral, recorded as a deferral.

---

## 6. `[unverified]` claims, each paired with the step that settles it

| # | Claim, still unverified | Settled by |
|---|---|---|
| U1 | Which magnitude normalization is right — log10 min–max (simulated 85 distinct, **outlier-sensitive**: Watauga's $336,897 sets that county's floor alone) vs a median/IQR-relative variant (**never measured**). | **Phase 1 step 1** — both computed on the real 494 rows; Phase 1 acceptance #3 is the outlier-sensitivity assertion. |
| U2 | The post-ladder per-parcel water cost. "Under budget" is a projection from a 3-rung ladder whose third rung (clip-at-cache-write) has **not been run**. | **Phase 4 acceptance #1** + a timed 25-parcel sample in Phase 6b that **includes a Transylvania parcel**, so the sample contains the worst cell rather than avoiding it. |
| U3 | The empirical slope distribution, and whether `livability` collapses to a new plateau at 0. Four real values exist. | **Phase 5 step 2** — 50 parcels × 5 EPQS ≈ 10 minutes, and its acceptance #2 is the go/no-go. |
| U4 | Whether the ranking agrees with human judgement at all. **No external validity signal exists anywhere in the repo.** | **Phase 5 step 1** — 20 owner-labelled rows, Spearman ρ, recorded. |
| U5 | The three counties' parcel counts (134,741 / 75,373 / 53,178). A **dated in-repo measurement** in ADR 0007, not re-measured against the live source this session. | **Phase 7 §1** — the controlled count probe, with its negative and positive controls, before any ingest. |
| U6 | Buncombe's reappraisal vintage — the seed note and NCDOR's 2026-27 table disagree (last 2021 / next 2027). Affects 26.8 % of the corpus. | **Phase 7 §1(d)** — resolved **before** the ingest, or vintage decay is wrong at that scale. |
| U7 | Exactly which committed `water.json` / `enrichment-latest.json` values are inflated (11 of 60 cells affected; which of the 87 rows). | **Phase 4 acceptance #4** — the re-derivation diff, recorded. |
| U8 | Whether `verify-no-pii.mjs` can see a name in a **value** in the new evidence surfaces. Measured today: it matches field names only. | **Phase 3 acceptance #6** — the planted-grantor canary, which exits zero today. |
| U9 | Whether the on-disk warehouse matches its own pointer (`baf17b77… / 75,862,016` claimed vs `87d87fff… / 201,588,736` actual, mutated ~2 h after the pointer was written). | **Phase 0 §3** + acceptance #4 — recompute, rewrite, and make the gate check it. |
| U10 | Whether `Deploy` actually blocks once wired. | **Phase 0 acceptance #3** — a deliberate red-fixture push on a scratch branch. Config that *looks* gated is what produced this finding. |

---

## 7. Alternatives considered

| Option | What it is | Trade-off | Verdict |
|---|---|---|---|
| **A. Demote and rename** (the critic's honest ruling) | Publish cohort-relative cheapness as what it is; water/slope become labelled attributes; reserve `score` for Lane 1. | Diverges from `scope.md`'s literal wording ("a spread of **scores**"); costs a schema + allowlist + card-label + ADR change. **Buys:** the amenity-index failure becomes impossible, 55 dead weight points leave the card, the varying denominator dies, and Plan A's most delicate phase is deleted. | **ADOPTED (D2).** Reversible in one commit if the owner prefers the old name; Phase 1 satisfies the success signal either way. |
| **B. Do-less** | Phase 0 + Phase 1 only. Stop shipping the wrong frontage number, gate the deploy, fix the normalization. Ship. | The 8 Lane-1 rows stay unscored; the enricher stays unaffordable; the disjoint sets stay disjoint. **But it reaches the stated success signal in a day, with no fetches.** | **Viable and honest.** If the session budget collapses, execute exactly this and stop — do **not** start Phase 4 or 6 partially. This is the recommended fallback, not a failure mode. |
| **C. Both plans as written** | P0-style flowline prefilter → decouple → enrich → evidence floor → +68 % backfill. | Measured to fail its own acceptance test at the first hard-blocking phase (H1), to certify an amenity index (H3), and to hit the blob wall after the work (H6). | **Rejected**, with measurements cited inline above. |
| **D. Delete the Lane-2 score entirely** | Publish the 658 rows unranked; 658 is a list one human can sort by eye. | Throws away a genuinely useful quantity (cohort-relative cheapness) that is already computable from data on disk. | **Rejected** — demotion is the honest middle, deletion overcorrects. |
| **E. 3-signal composite summing to 100** (`per_acre` / `water` / `livability`; discount + distress move to the lane structure) | Keeps a composite but makes every component able to fire. | Better than the status quo, but it still blends a 5-sample slope estimate into the headline number and reintroduces the amenity-index question in weaker form. | **Rejected in favour of A**, which is smaller and answers the same objection. |
| **F. Per-parcel timeout as the primary containment** | Ship the net, skip the geometry fix. | Timeouts fire hardest where hydrography is densest, making `water` **anti-correlated with water** — Plan A's own best judgement, and it is right. | **Rejected.** The net ships in Phase 4 **only after** the ladder, at a measured budget. |
| **G. Confidence-weighting the score, or publishing an extra decimal** | Cheap apparent spread. | Manufactures a spread that is noise; `weights.yaml`'s own vintage ruling forbids the first. | **Rejected**, consistent with both panels. |
| **H. Re-tile NHD to finer cells** | Smaller cells, fewer candidates per parcel. | Invalidates the entire `nhd_cell` cache and shifts cost from CPU to **egress on a 0.5 rps host**. | **Rejected** in favour of clip-at-cache-write; recorded in Phase 7. |

---

## 8. What we are NOT doing, and why

1. **Not ingesting Buncombe / Henderson / Haywood in this sweep.** ~109.95 MB projected blob vs
   GitHub's 100 MiB hard limit, rejected *after* the ingest; the three densest-hydrography counties
   are the enricher's worst possible input; and it forces a second full enrichment pass. Deferred
   behind the writer shard and the >90 MB gate (Phase 7).
2. **Not building a flowline-only prefilter and calling it the fix.** Measured: it leaves ~302 s of
   381.8 s and fails its own "<30 s" acceptance.
3. **Not reproducing "the hang" on one record.** There is no hang — that record **completes in
   381.8 s**. The job is uniformly expensive in dense cells, and a one-record repro teaches the
   wrong lesson.
4. **Not shipping a per-parcel timeout as the primary containment, and not at 20 s.** The flowline
   loop alone is 73.9 s.
5. **Not building Plan A's P4 evidence floor**, and not touching `assertWeightsSumTo100`. **D2**
   deletes the need for both.
6. **Not blending water or slope into the published number.** They are attributes and filters. A
   5-sample slope estimate over hundreds of metres does not belong in a headline ranking, and both
   panels' own reasoning against "one extra decimal" says so.
7. **Not re-tiling the NHD cell grid.** Cache-invalidating and it moves cost onto a 0.5 rps host.
8. **Not running ingest or enrichment on hosted runners.** `ingest-parcels.yml` commits the ledger
   and discards the warehouse; the TERMS cadence justification covers *refresh*, not backfill, and
   that workflow's own header already forbids unbounded historical backfill on hosted runners.
9. **Not re-litigating settled exclusions:** North GA parcel sourcing (qPublic bot wall), FEMA flood
   joins (`/arcgis` robots-blocked), GBP prefill (Maps ToS §3.2.3(a), 60-day clock), the Resend
   sending domain (owner-only), the noindex/robots posture, the PII strip, the local-only mirror.
10. **Not moving the map payload to `public/data/deals-<hash>.json`.** Measured at 260 KB inline,
    not the 2.4 MB the prior handoff assumed.
11. **Not re-doing this session's shipped map/filter fixes** (`6cfcb90`) or the CI control fixture
    (`b37082a`). Both deployed and verified live.
12. **Not treating C6's remedy clause as settled** ("saturation is by SELECTION, not by broken
    normalization"). Withdrawn — it is both, and the normalization half is the cheap half.

---

## 9. How this plan proves it worked

**The success signal, restated against what is actually shipping.**
`site/src/data/listings.json` carries **≥ 50 distinct** published values across 0–100 (today: 1);
every published row's number is derivable from its own breakdown and its cohort; cheaper raw
`$/acre` **strictly outranks** dearer within a cohort; the frontage sentence on every card is either
a **correct** metre figure or carries no figure at all; the 8 Lane-1 rows carry a price, a resolving
source, and a distress component that is a number rather than a NaN-serialised null; and there
exists, on disk, a dated Spearman ρ against 20 rows a human ranked by eye.

**The honest second branch, which survives from Plan A and should not be edited out:** if the
measured outcome is that the corpus does not yet support a ranking, the right result is *N rows
published without a number, each carrying a stated reason* — not a manufactured distribution. Every
gate in this plan is built so that outcome is reachable and legible, and so that a phase which
silently did nothing goes red rather than green.
