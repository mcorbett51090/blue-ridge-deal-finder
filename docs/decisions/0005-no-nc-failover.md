# ADR 0005 — There is no NC failover, and that is recorded rather than faked

**Status:** accepted (P1) · **Claims:** E7.1–E7.3, CE-2, A1 · **Binding**

## Decision

The NC anchor is a **single point of failure**, documented as one. The
previously-registered mirror
`services8.arcgis.com/eJ9GuQwMsO1iIOw1/.../parcels/FeatureServer/0` is **deleted
from the registry** and will not be re-added.

## Why the mirror was worse than nothing

Measured:

```
where=1=1              → {"count": 866}
cntyname='Watauga'     → {"count": 0}
cntyname='Zzzznotacounty' → {"count": 0}     ← byte-identical to the above
```

866 rows cannot cover 100 counties when NC's 11 mountain counties alone hold
503,674 (E2.7). Claim A1, tier BLOCK, is **false as written**.

The failure mode is the important part. Had the anchor gone down, the pipeline
would have failed over to a source that returns `0` for every target county —
and `0` is a *number*, so every count-based gate would have compared it, found
it small, and reported... a small county. The run would have completed. The site
would have deployed. The freshness badge would have been green. **A fake
failover converts a loud outage into a silent one**, and this system's entire
gate family is built to make outages loud.

## What the DR path actually is

1. **Rebuild from Tier 0 raw-redacted snapshots.** Tested at P9 with a real
   restore drill, not asserted.
2. **The off-GitHub mirror (RT-4)** guarantees Tier 0 survives a repo-level
   penalty.
3. Records absent from a gate-passing complete pull are marked `stale`, **never
   hard-deleted**, so a failed run degrades to visibly-old data rather than to
   missing data.

## The gate that would have caught it

`sources.yaml` carries **measured** per-county row floors (Watauga 45000,
Buncombe 128000, …) — E2.7's counts minus ~5%. Guessed floors would not have
caught an 866-row mirror; measured ones catch it on the first batch.

And `control_block` carries a positive control (`Watauga → 47388`) **and** a
negative one (`Zzzznotacounty → 0`) whose bodies must **differ**.
`assertControlBlock` fails when they agree, because an endpoint answering a
constant makes a passing positive control meaningless.
`fixtures/gates/control-block-indistinguishable.json` is that exact mirror
response, and it is proven to make the gate exit non-zero.
