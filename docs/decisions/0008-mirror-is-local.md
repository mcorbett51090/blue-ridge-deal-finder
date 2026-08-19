# ADR 0008 — The off-platform mirror is a LOCAL operation, on purpose

Date: 2026-08-19 · Status: accepted

## The finding

RT-4 is the only item in this project's entire review that is **unrecoverable**
if it fires. GitHub's Additional Product Terms name *"disabling of
repositories"* as a penalty for misusing Actions. Tiers 0 and 1 — the raw
snapshots and the SQLite warehouse — are gitignored and exist only as artifacts
of this repo. The documented rebuild path ("restore from Tier 0") therefore
lived **inside the artifact that gets disabled**.

Everything else here degrades gracefully. A scraper breaks and a county goes
stale; a service refuses and a signal goes unknown. This one does not degrade:
387,742 parcels and every recorded change are gone, and the remedy is
re-fetching the whole corpus from counties that have moved on.

## Why it is not a workflow

The obvious shape is `mirror.yml` on a schedule. **It cannot work**, and saying
so is the point of this ADR:

> A backup of GitHub, running on GitHub, stored on GitHub, does not survive
> losing GitHub.

An Action can only write to somewhere it holds credentials for. Pushing to a
second GitHub repo shares the same account and the same terms exposure. Pushing
to an external store means a long-lived credential in a **public** repo's secret
store, which trades an availability risk for a security one — and the security
one is worse, because it is silent.

So the mirror runs where the data can actually outlive the platform: **the
owner's own machine**, writing to `~/blue-ridge-archive`, outside the repo tree.
A copy inside the repo shares the fate of the repo, which is the failure being
mitigated.

## What it does

`npm run mirror` copies the pointer-named warehouse plus every Tier-0 artifact,
content-addressed so an unchanged file is not recopied, and writes:

- `MANIFEST.json` — sha256 and byte count for every file
- `RECOVERY.md` — **the rebuild procedure, stored in the archive**, because a
  procedure kept inside the disabled artifact is not a procedure

Measured on first run: 19 files, 375 MB, all verified against the manifest.

## The accepted gap, stated plainly

This requires the owner to run it. An unrun backup is not a backup, and nothing
in this repo can make it run — that is the same reason the freshness heartbeat
needs an out-of-band half (ADR 0006). Both gaps have the same shape: **a monitor
that lives inside the thing it monitors cannot report the thing's death.**

Reasonable next step if this matters more later: a cron entry on the owner's
machine, or a self-hosted runner. Neither is something the repo can arrange for
itself.
