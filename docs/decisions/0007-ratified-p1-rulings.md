# ADR 0007 — Ratifying the three rulings P1 flagged, and one correction

Date: 2026-08-19 · Status: accepted

P1 escalated three decisions rather than making them silently, and surfaced one data
discrepancy it declined to edit because the file belonged to another phase. All four are
settled here.

## 1. `package.json` test glob — RATIFIED

P1 changed `node --test tests/` to `node --test "tests/**/*.test.ts"` after the original threw
`MODULE_NOT_FOUND` on Node 26 (this machine). It flagged this as touching a file it was told not
to touch.

**Ratified.** The change is correct and the reasoning is the important part: CI pins Node 22,
where the original form may well have worked. That would have been *worse* — green in CI, broken
locally, and the phase's own acceptance criterion (do the gates go red?) unable to run at all on
the machine where the work happens. A test command that cannot execute is not a weaker gate, it
is no gate.

## 2. The egress ruling for `site/` — RATIFIED AS WRITTEN

P1's first egress gate forbade network globals anywhere under `site/`. That correctly caught a
build-time `fetch` in another agent's component, but would also have forbidden MapLibre loading
map tiles, which the plan mandates.

Its narrowing is right and is adopted:

- **Astro frontmatter, and every `.ts`/`.mjs` under `site/`, runs at BUILD TIME on our runner.
  That code IS our crawler** — it egresses from our infrastructure, under our IP, on our
  schedule, outside the one permitted client. Forbidden absolutely.
- **A client `<script>` block runs in a visitor's browser.** It is not our crawler; it is the
  page doing what a page does. Permitted.

The distinction is *whose machine makes the request*, not *which directory the file sits in* —
which is why a directory-scoped rule got it wrong in both directions. Rationale lives with the
code in `scripts/egress-permits.json`.

## 3. Floating action tags — FIXED, not merely noted

P1 observed that the workflows (written by the coordinator, not by P1) used floating tags —
`actions/checkout@v7`, `actions/setup-node@v5` — and that the planned `verify-action-pins` gate
would go red the day it was written.

All four actions are now pinned to full commit SHAs with the tag retained as a trailing comment.
On a public repo a floating tag is a mutable dependency executing with `contents: write`; the
cost of pinning is a dependabot annotation, and the cost of not pinning is unbounded.

## 4. Buncombe reappraisal year — CORRECTED

`seeds/counties.csv` carried "REAPPRAISAL 2026 — this year". The NCDOR schedule that P0 actually
fetched says **last 2021, next 2027, six-year cycle**.

**Fetched evidence beats a derived note.** The 2026 claim reached the seed file from a planning
tiebreak's reasoning; the 2027 figure came from the NCDOR table itself, retrieved behind an
abort-on-missing assertion. The note is corrected to match the source.

What does **not** change: Buncombe is 134,741 of 503,674 parcels, so **26.8% of the corpus
repricess in a single refresh** whenever that reappraisal lands. The detector is still required —
it is due in 2027 rather than imminently, which is a scheduling fact, not a reprieve.
