# ADR 0001 — The NC anchor is the POLYGON layer, not the point layer

**Status:** accepted (P1) · **Claims:** E6.1–E6.6 · **Binding**

## Decision

`https://services.nconemap.gov/secure/rest/services/NC1Map_Parcels/MapServer/1`
— `Parcels (polys)`, `esriGeometryPolygon`, 71 fields, `maxRecordCount` 5000.

**Not** `.../NC1Map_Parcels/FeatureServer/0`, which is `Parcels (pts)`,
`esriGeometryPoint`, 68 fields.

## Why this needed a decision at all

The point layer's attribute table **mirrors** the polygon layer's (E6.4). Every
attribute-level probe, every schema fingerprint, every row-count floor and every
value-distribution check passes identically against both. Nothing in the
attribute pipeline can tell them apart — which is exactly why the wrong one was
registered in the first place, and why the error would have survived to P5.

Three of the five deal signals are geometric and **cannot be computed from a
point at all**:

| signal | needs |
|---|---|
| water | does a stream *cross* the parcel; frontage *length* |
| livability | slope *across the extent* |
| flood | floodplain *coverage fraction* |

A point has no extent, so each of these would have returned a null or a
degenerate constant, and `unknown` is excluded from the denominator — so the
scores would have looked *confident and clean* while three of five components
silently never fired.

## Consequences

- `outSR=4326` on **every** geometry request. The extent SR is `wkid 102719 /
  latestWkid 2264` (NC State Plane feet); un-reprojected coordinates render off
  the map or nowhere, with no error.
- Geometry is fetched on a **quarterly** pass, only for parcels with no cached
  `geometry_hash`. This is what keeps the weekly attribute run cheap and
  proportionate under the Actions terms.
- `scripts/verify-sources.mjs` greps the registry for `FeatureServer/0` and
  fails. `fixtures/gates/points-layer-url.yaml` proves it goes red.
