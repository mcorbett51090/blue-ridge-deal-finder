# Handoff — blue-ridge-deal-finder

_Written 2026-08-19T19:04:52Z. Branch: `main`._

> ⛔ **HOST CORRECTION — read this before following any spawn instruction.**
> The origin host is **Claude Code** (`claude-opus-5[1m]`), which the handoff tooling does not model:
> `rc handoff` accepts only `grok|cli|chat`, and other-host adapters are explicitly out of scope for
> the session-handoff skill. `--host chat` was passed because the enum required a value, so the
> generated `handoff-seed.txt` and `chat-resume.md` say "open a Copilot Chat session (Cmd+N)".
> **That instruction is wrong for this work.** The successor is a new **Claude Code** session in
> `~/blue-ridge-deal-finder`. Ignore the Chat/Grok seed files; this document is the brief.

This is a **fresh-window quality reset**, not a compact and not a `/fork`. The successor must **read this file** and continue. Do not re-derive the brief from compacted history you do not have.

## Meter (derived)

- Threshold: 70% (before auto-compact; not a quality-rot percent)
- Measured: (unknown)
- Do **not** treat a missing percent as "plenty of room".

## Git (derived)

- Branch: `main`
- Dirty: yes
- Recent commits:
- `049672b Haywood sale notices — three foreclosure sales TOMORROW, surfaced`
- `475cc39 Off-platform mirror — the one unrecoverable finding, closed`
- `440e6df NC distress ingest — Lane 1 is no longer empty`
- `02a46b9 TN rows get a labelled generic link, not instructions alone`
- `e216d8a East Tennessee: 152,321 parcels, and null scores stop rendering as zero`

## Existing run-dir files (derived)

- `meta.json` (94 bytes)

## Recent events (derived)

- (no events.jsonl)

## Goal

Find under-market Blue Ridge property from FREE public sources and browse it on a
GitHub-Pages site that mimics the Southern Wine Country interface. Personal tool, one user, no auth.
Owner priority regions: **Western NC, East TN, North GA**.

## Done

- **387,742 parcels** warehoused. NC 235,421 (8 of 11 counties) + TN 152,321 (all 5). 100% mappable.
- **Site LIVE with real data**: https://mcorbett51090.github.io/blue-ridge-deal-finder/ — 658 listings,
  699 pages, deploys automatically on push.
- **Lane 1 populated**: 8 buyable Jackson County REO properties, joined by PIN (8/8 matched), $3,360–$10,700.
- **Haywood notices**: 3 tax-foreclosure sales dated 2026-08-20, surfaced in a banner (county-level, not
  parcel-joined — property PDFs are scanned images).
- **Provenance, 3 tiers**: 508 exact record links / 150 labelled generic / instructions. Never a bare
  homepage, never a denied host.
- **Off-platform mirror**: `npm run mirror` → 19 files, 375 MB, manifest-verified, RECOVERY.md inside it.
- 8/8 gates, 159 tests, 20 commits.

## Remaining

1. **Water enrichment** — was RUNNING at handoff (`pipeline/enrich/index.ts --ids-from
   publish/out/listings.json`). Only 19 of 658 rows had measured water. Re-run, then `npx tsx publish/run.ts`.
2. **3 NC counties un-ingested**: Buncombe (134,741), Henderson (75,373), Haywood (53,178).
   `npx tsx pipeline/ingest-parcels.ts --counties=Buncombe,Henderson,Haywood` then the coords pass.
3. **⛔ THE MAP IS UNVERIFIED — this is why the session ended.** See Blockers.

## Decisions + WHY

- **Owner PII never published** (D1). Stripped at normalize, before any tier. TN's fields are
  `OWNER`/`OWNER2` — they were ABSENT from PII_FIELDS entirely until added.
- **Public repo, watchlist local** (D2). Site is world-visible; saved properties stay in localStorage.
- **Unknown is `null`, never 0** — everywhere. This was violated four separate times (value, acreage,
  water, score) and each one put bad rows at the TOP of rankings.
- **Every gate ships a fixture proving it goes RED.** `verify-controls` enforces the pairing; adding a
  gate without one fails the build.
- **Mirror is LOCAL by design** (ADR 0008): a backup of GitHub, on GitHub, doesn't survive losing GitHub.
- **Cadence is a TERMS requirement** — GitHub's Actions terms forbid disproportionate burden; penalty is
  repo disabling. Weekly ingest, justification written beside the cron.

## Paths

- Repo: `~/blue-ridge-deal-finder` → github.com/mcorbett51090/blue-ridge-deal-finder (PUBLIC)
- Live: https://mcorbett51090.github.io/blue-ridge-deal-finder/
- FORGE plan + all 20 gate artifacts: `~/.ravenclaude/runs/forge/blue-ridge-deal-finder/` (plan.md is 138 KB)
- Probe log (every source, with controls): `docs/probe-log.md`
- ADRs: `docs/decisions/0001..0008`
- Mirror: `~/blue-ridge-archive/` (+ RECOVERY.md)
- Memory: `~/.claude/projects/-Users-matthewcorbett/memory/blue-ridge-deal-finder.md`

## Next 3 steps

1. **Debug the map.** Open the live site, confirm markers actually render, clustering works, and
   filters drive `setData()`. Prime suspect: `DealMap.astro` inlines the ENTIRE dataset into a
   `<script type="application/json">` block — now ~2.4 MB. Its own comment says that pattern does not
   survive this scale and should move to a fetched `public/data/deals-<hash>.json`.
2. Finish water enrichment, then republish (`npx tsx publish/run.ts`).
3. Ingest Buncombe / Henderson / Haywood parcels + coords pass.

## Do-not-redo

- **North GA has NO parcel source.** qPublic is a confirmed bot wall (403 from a residential IP,
  both UAs). All 3 ArcGIS "candidates" found were OTHER STATES — Fannin=Texas, Union=Florida. Guarded by
  `pipeline/fetch/geo-identity.ts`. Do not re-search unless something upstream changes.
- **TN has NO assessed value field.** `discount` (w30) + `per_acre` (w20) are permanently unknown there.
- **Yancey NC publishes `parval=0` on 100% of rows** — their data, verified against the API.
- **Jackson's delinquent-accounts PDF is UNJOINABLE** — keyed by tax bill#, no parcel key, `altparno` empty.
- **FEMA flood is robots-BLOCKED** (`Disallow: /arcgis` = the NFHL path). Flood is honestly unknown.
- **LandSearch is Cloudflare-walled**; Craigslist/HUD/GSA/Auction.com are on the denylist.
- Anchor is `MapServer/1` (POLYGONS). `FeatureServer/0` is the points layer, COORDINATES role only.
Do not use `grok -p`, `--single`, `/fork`, or a Grok `SessionStart` injection to continue this work. A Chat or CLI successor must not launch `grok`. Do not replace compact-anchor. Do not treat 40% / 30% / 300K as a trigger.

## Blockers

**⛔ THE MAP'S RENDERED OUTPUT WAS NEVER VERIFIED, and the previous session overstated its checks.**

What was actually checked: MapLibre boots (its gesture hint appears), the console is clean, the fallback
text is hidden. What was NOT checked: whether markers render, whether clustering works at parcel scale,
whether the filter rail actually drives the map, whether map and list stay in sync.

"Zero console errors" is a weak proxy for "the map works" — the same shallow-check class this project
caught four times elsewhere. The user reports "lots of bugs in the map page" and is right to.

Useful for debugging: all 658 listings HAVE coordinates (508 NC / 150 TN), bbox lon -83.70..-81.33,
lat 35.05..36.59 — a sane Blue Ridge envelope, so bad geometry is unlikely to be the cause.

Secondary: `rc artifacts new` is unavailable — `rc-artifacts.py` does not exist in plugin v0.282.0
(`rc` reports a misleading path one level too shallow). The handoff skeleton was written directly with
`context-handoff.py`, which does exist.
