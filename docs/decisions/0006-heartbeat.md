# ADR 0006 — The freshness heartbeat is half a mitigation, and the other half is owed

**Status:** accepted with a KNOWN GAP (P1) · **Claims:** E4 · **Owner action required**

## The failure being mitigated

GitHub disables scheduled workflows in a repository after 60 days of no
"repository activity". The definition is undocumented, the notification is a
single email, and the failure is silent: the crons simply stop.

## ⛔ Why `freshness.yml` cannot detect it

**A monitor that runs on the schedule it monitors cannot observe that schedule
being disabled.** When the scheduler stops, the monitor stops with it, reports
nothing, and reports nothing forever — which is byte-identical, from the
outside, to a healthy system with nothing to say. This is the same shape as
every other defect in this repo's catalogue: an absent signal read as a good
signal.

## What the in-band half genuinely buys

1. **It writes the freshness fact onto the published artifact.** `/status/` and
   the freshness badge render "data as of <ts>", computed in the browser from
   the payload's own timestamp. Staleness becomes visible on the page the owner
   actually looks at, whether or not any workflow ran.
2. **`scripts/check-freshness.mjs` fails loudly rather than quietly.** An absent
   `data/runs/`, an empty `data/runs/`, and a directory of manifests where none
   has `status: complete` are each an explicit **UNKNOWN**, not a pass.
   `Math.max()` of an empty list is `-Infinity` and `-Infinity > budget` is
   `false` — the same `undefined < floor` shape that made a total outage read as
   a pass elsewhere in this repo, and it is refused explicitly here.
3. **It resets the 60-day clock** under any reading of "repository activity".

## ⚠️ The out-of-band half is NOT built

A monitor that does **not** live in this repository, and does not run on this
repository's scheduler, must fetch the deployed `/status.json` and alert when
`data_observed_at` exceeds the budget. Candidates: an UptimeRobot keyword check
on the deployed status page, or a cron on the owner's Mac.

**Until that exists, "the crons are running" is an assumption, not an
observation.** This ADR is the record that it is owed. It is not a P1
deliverable and it is not silently deferred.

## Proven

`verify-controls.mjs` runs `check-freshness.mjs` against the same stale manifest
twice — once at `--max-age-days 10` (must be RED) and once at `--max-age-days
100000` (must be GREEN). Identical bytes, opposite verdicts, which is the only
way to show the age comparison is doing work rather than always agreeing.
