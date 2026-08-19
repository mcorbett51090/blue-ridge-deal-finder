# ADR 0002 — TN value scoring is DISABLED until the TPAD hop is settled

**Status:** accepted (P1) · **Claims:** E3.3, RT-9 · **Revisit:** P6

## Decision

The five TN counties (Sevier, Cocke, Unicoi, Johnson, Carter) ingest **geometry
and acreage only**. `value`, `value_basis` and every score component derived
from them are `unknown` for every TN parcel. They are **not** estimated, not
imputed from neighbours, and not carried across from a TPAD lookup.

## Why

TN's `Property Boundaries` layer carries no assessed value. The value lives in
TPAD, a separate application whose access terms are unsettled and whose join key
to the boundary layer has not been verified end to end. Two unverified hops
(access legality, join correctness) stacked under a number that drives 30 of 100
score points is not a defensible foundation.

There is a second, independent problem even if TPAD were settled: TN's `DEEDAC`
is the **deeded** acreage while NC's `gisacres` is **planimetric polygon area**
(RT-9). On 20–40% slopes these diverge materially. Feeding both into one `$/acre`
column and sorting the result produces a single ranked table in which the two
halves are not comparable — and a 10–15% acreage error on a 40-acre tract is a
five-figure price error discovered *after* the survey, i.e. after earnest money.

## Consequences

- `acreage_basis: 'gis' | 'deeded'` is carried from normalize to the card, and
  rows are **never ranked across bases** without explicit normalisation.
- TN parcels appear in Lane 2 with a visible "value not available" state and a
  low `confidence`, which is the honest rendering: unmeasured, not mediocre.
- Because `unknown` leaves the denominator, a TN parcel does **not** score ~40
  and read as a bad deal. That behaviour is the whole reason the exclusion rule
  exists.
- Revisit at P6 with a settled ToS reading and a verified join key, or leave it
  disabled permanently. Disabled is an acceptable end state.
