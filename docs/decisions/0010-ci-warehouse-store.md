# ADR 0010 — Restoring the warehouse-release fix, closing the publish gap, and Lane 1's own cadence

**Status:** accepted · **Date:** 2026-09-10 · **Claims:** unsticks Ingest parcels + Freshness
heartbeat + Lane 1 freshness · **Owner action required (one-time bootstrap, unchanged from before)**

## Where this picks up

[PR #3](https://github.com/mcorbett51090/blue-ridge-deal-finder/pull/3) already correctly diagnosed
why `ingest-parcels.yml` had never once succeeded and why `freshness.yml` had never once passed, and
its first commit (`7bae785`) built the right fix: `scripts/warehouse-remote.mjs`, a `restore`/`publish`
pair over a GitHub Release (`warehouse-current`), wired into the workflow together with the `npm run
publish` step the pipeline had never run anywhere. That commit's own message states the reasoning
this ADR would otherwise have to restate: **not `actions/cache`**, because cache entries evict after
7 days unused and the ingest cadence is 7 days, so the only copy of the corpus would ride a coin flip.

The PR's *second* commit (`0c4f808`) then replaced that working design with exactly the mechanism
its predecessor had just argued against — `actions/cache` as the primary store, a Release named
`warehouse-ci` (not `warehouse-current`) as a "soft" fallback that nothing ever seeds, and a new
`scripts/ci-preflight-warehouse.mjs` that fails closed if both come up empty. It also dropped the
`npm run publish` step and the `publish/out` + `site/src/data` + `site/public/data` commit paths
entirely. Nothing in `0c4f808`'s own commit message engages with why `7bae785`'s reasoning against
cache was wrong — it reads as a second, independent pass at the same problem that was not aware the
first pass had already solved it. `scripts/warehouse-remote.mjs` itself survived, untouched and
unused: a fully-built, working module with no caller.

**This PR reverts that regression and finishes the job.**

## What was verified before touching anything

- `scripts/warehouse-remote.mjs` had no test file despite `7bae785`'s commit message claiming "the
  restore/publish round trip is exercised against a simulated release" — no such test was ever
  committed. `tests/warehouse-remote.test.ts` (new) exercises it against a fake `gh` binary: genuine
  first run, lost-state refusal, publish→restore round-trip with sha256 verification, churn discipline
  (unchanged content is not re-uploaded), retention (a superseded asset is deleted), and refusal on a
  corrupted or disagreeing asset. All seven pass on the first run against the unmodified module — it
  was correct; it was simply never called.
- The `pipeline/ingest-parcels.ts` fix from `7bae785` (removing the ingest's own second,
  ledger-blind `writeCoverage()` — the "false demotion" bug that would have wiped out eleven NC
  counties' published coverage the moment `--counties=Macon` ran) and its pinning test in
  `tests/publish.test.ts` were **not** touched by `0c4f808` and remain intact on `main`. Nothing to
  redo there.
- `data/runs/` still holds the same 6 manifests from 2026-08-19 — `Ingest parcels` has not succeeded
  even once since either commit, and no `warehouse-current` (or `warehouse-ci`) Release exists
  (`gh api repos/.../releases` returns `[]`). The one-time bootstrap this ADR documents below has not
  happened yet, under either design.

## What this PR changes

1. **`.github/workflows/ingest-parcels.yml`** — reverted to `7bae785`'s design: restore via
   `scripts/warehouse-remote.mjs restore`, ingest, `scripts/warehouse-remote.mjs publish`, `npm run
   publish`, then commit `data/events data/runs data/coverage.json publish/out site/src/data
   site/public/data`. Removed the `actions/cache` steps, the `warehouse-ci` soft-seed, and the
   artifact upload — all now redundant with a mechanism that does not have their expiry problem.
2. **`scripts/ci-preflight-warehouse.mjs` and its `npm run ci:preflight-warehouse` entry — deleted.**
   `warehouse-remote.mjs restore()` already fails closed with an equivalent (and more specific, since
   it also verifies sha256) message when state is lost or absent; keeping both was two overlapping
   "is the warehouse there" checks with different wording, which is exactly the kind of
   separately-maintained duplicate this project's own `verify-ledger-reconciles.mjs` exists to catch
   in the data layer. One producer, here too.
3. **`scripts/check-freshness.mjs`** — independently broken, regardless of which warehouse mechanism
   ships: it required `status: 'complete'` on a manifest, and manifest.status is `'complete'` only
   when a single run attempts the FULL 12-county sweep with zero failures. Every manifest this
   project has ever produced is `'partial'`. `publish/status.ts` already treats `partial` as a real
   (if `degraded`) `last_success` for the exact same manifests; this gate now agrees with it. A
   `failed` manifest (zero successful counties) still counts for nothing. Two new fixtures prove
   both directions; see `scripts/gate-fixtures.json`.
4. **`scripts/lib/scratch.mjs` / `verify-controls.mjs` / `tests/gates.test.ts`** — added an optional
   `clear` list to the fixture-planting harness. Without it, `check-freshness.mjs`'s own fixtures were
   silently contaminated by the REAL `data/runs/` the skeleton copies wholesale — harmless while only
   `complete` counted (no real manifest ever was), but the moment `partial` counts too, a fixture
   meant to prove an all-`failed` run stays UNKNOWN would instead read GREEN off the real repo's
   unrelated `partial` history. The existing `stale-run` control gets the same isolation, because once
   real scheduled runs start landing fresh `partial` manifests in `data/runs/`, that control would
   otherwise stop proving anything the week the rest of this fix starts working.
5. **`.github/workflows/ingest-distress.yml`** (new, daily) — Lane 1 ("on market / in distress") has
   never had a scheduled ingest at all, on either design. It depends on the same warehouse (for the
   Jackson REO PIN → parcel join) but only reads it, so it restores read-only and never publishes to
   the store. It runs `npm run publish` too — the same missing step, independently required here,
   since Lane 1's freshness badge (`data_observed_at`, `site/src/config/site.ts`'s 48-hour bar) is
   computed from `data/distress/evidence.json` via that exact step, and nothing else produces it on a
   schedule.
6. **`pipeline/ingest-distress.ts`** — a small, added guard: it reads `data/warehouse/warehouse-pointer.json`
   directly with no existence check, so a missing warehouse crashed as a bare `ENOENT` stack trace.
   Now it names the actual cause and points at this ADR.

## Why a Release, not `actions/cache` (restated, since `0c4f808` re-opened the question)

Cache entries are evicted after 7 days without a hit. The parcel ingest's own cadence — a documented
terms requirement, not a knob — is exactly 7 days. Persisting the only copy of a multi-hundred-MB
corpus in a store whose eviction clock and whose write cadence are the same number means one delayed
Sunday cron (GitHub documents scheduled runs as delayed or dropped under load — why this workflow's
own cron is already off `:00`), one skipped week, or one failed run, and the cache is gone before the
next run can touch it — silently reintroducing the exact lost-state failure this ADR fixes, with no
new error message pointing anywhere useful. A Release asset does not expire. `warehouse-remote.mjs`
also verifies the restored asset's sha256 against the pointer before trusting it, which the cache-only
design never did — a truncated download is a valid SQLite prefix surprisingly often, and it opens,
queries, and returns *fewer* rows rather than failing, which is a delta that marks the missing rows
`stale` and publishes a change feed that is false in the other direction.

## Why this does not contradict ADR 0008

Same argument as always: ADR 0008's mirror is disaster recovery — surviving a GitHub-level penalty
that takes the whole GitHub-hosted copy of this project down with it. The `warehouse-current` Release
is operational state-passing between two runs of a workflow that already lives on GitHub and already
has push access to this repo; if GitHub disables the repo, this Release is exactly as unreachable as
`data/runs/` or the workflow file itself, which is the same single point every other GitHub-hosted
artifact here already has — not a new one. `scripts/warehouse-remote.mjs`'s own header says as much:
"THIS IS NOT THE OFF-PLATFORM MIRROR AND DOES NOT REPLACE IT... Both."

## ⚠️ One-time operator bootstrap still required — unchanged by this PR

Neither this PR nor `7bae785` before it could complete this step: it requires write access to create
a GitHub Release, and it requires the REAL production warehouse, which lives only on the owner's
machine or `~/blue-ridge-archive` (ADR 0008). This agent has neither. `warehouse-remote.mjs restore()`
already prints the exact command when it detects lost state; it is repeated here for the same reason
the module states its own bootstrap message rather than only logging it: a procedure worth running
once is worth being able to find later.

**On the machine that holds the real warehouse** (the one that produced the six manifests already in
`data/runs/` — if that machine's copy is gone, restore it first from `~/blue-ridge-archive/RECOVERY.md`):

```bash
cd <repo, with a healthy data/warehouse/ present, gh authenticated with push access>
gh release create warehouse-current \
  --title "Warehouse (current)" \
  --notes "Tier-1 SQLite corpus. Written by scripts/warehouse-remote.mjs; do not hand-edit."
node scripts/warehouse-remote.mjs publish
```

After that one command, the next scheduled `Ingest parcels` run restores this exact state, diffs
correctly against it, and republishes the result; `Ingest distress evidence` restores it read-only for
the Jackson PIN join; `check-freshness.mjs` starts reading a manifest with `finished_at` from that
week instead of 2026-08-19. **If the real warehouse is unrecoverable** (RT-4 fired for real — ADR
0005's DR path), rebuild from Tier 0 first per `~/blue-ridge-archive/RECOVERY.md`, then run the
command above.

## Residual risk, stated rather than hidden

- **The bootstrap is a manual, one-time step neither this PR nor its predecessor could complete**,
  for the reasons above. Until it runs, both scheduled ingest workflows fail exactly as they do
  today — loudly, at `warehouse-remote.mjs restore()`'s own "GENUINE FIRST RUN" vs. "LOST STATE"
  branch, never silently.
- **A full 12-county sweep's timing has not been measured against the real 45-minute job timeout**
  with a real warehouse restored, because no CI run has ever gotten past the restore step to try. The
  rate math (~105 requests at 0.5 req/s ≈ 3.5 minutes of pure wait, well under 45 minutes) says it
  should fit. If a sweep ever does time out mid-county, the existing per-county try/catch degrades
  that manifest to `status: 'partial'` with the interrupted county `failed` and the rest carried —
  loud, not silent, and now correctly counted as fresh by the loosened `check-freshness.mjs` as long
  as at least one county completed.
- **`ingest-distress.ts` exits 1 when Jackson's REO list matches zero parcels.** That is almost
  certainly a broken join rather than a real empty list (the county has held REO parcels every time
  this has been measured), so failing loudly is the right default — but if the county's list ever
  legitimately empties to zero, the daily workflow will fail until someone confirms that by hand. Not
  changed here; it is a pre-existing, deliberate design choice in a file this PR only adds one guard
  to, not a new risk this PR introduces.
- **Two workflows now restore from the same Release on different schedules** (`ingest-distress.yml`
  daily, `ingest-parcels.yml` weekly). Only `ingest-parcels.yml` ever publishes back to it; a
  same-day overlap is a read racing a read-then-write, not a write racing a write, and
  `scripts/warehouse-remote.mjs restore()` only ever reads. A genuine git-push collision between the
  two workflows' own commit steps (different paths: `data/distress/*` vs. `data/events` /
  `data/runs` / `data/coverage.json`, both also touching the shared `publish/out` /
  `site/src/data` / `site/public/data`) would surface as an ordinary non-fast-forward `git push`
  rejection — loud CI failure, never silent corruption — and the schedules (11:05 UTC daily vs.
  04:17 UTC Sundays) overlap for at most a few minutes once a week, which is not enough to justify
  more machinery than that.
