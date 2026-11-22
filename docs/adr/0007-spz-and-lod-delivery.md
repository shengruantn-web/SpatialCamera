# ADR-0007: Deliver compressed SPZ with progressive LOD; keep PLY as an optional download

**Date**: 2026-11-16
**Status**: SPZ delivery **implemented** in S5 (2026-11-22, pending owner acceptance); progressive LOD still **proposed**
**Deciders**: project owner (pending)

## Context

ADR-0006 makes the viewer download 50–90 MB before showing anything. Splat viewing is bandwidth-bound, and time to first view is the headline metric (PRD §5). Spark 2.x can load SPZ, report load progress, and page level-of-detail data.

## Decision

The worker validates the PLY (spec T5) and converts it to SPZ, optionally also building an LOD set. It uploads `result.spz` as the primary file and `result.ply` as an archive. The viewer loads SPZ with `onProgress`, starts on a coarse LOD, and refines as more loads. The 90 MB cap applies to the PLY only.

## Implementation status (S5, 2026-11-22)

Implemented as decided, apart from LOD:

- The worker validates the PLY (S1, T5), converts it to SPZ (`gpu-worker/spz.py`, v3 by default) and uploads `result.spz` before `result.ply`. Conversion is best effort: if it fails, or the server predates SPZ, the PLY alone is delivered. The PLY is always kept as the archive and download.
- The API validates the whole SPZ (full inflation to the exact size its header implies), stores it under a per-request key in the attempt's folder, and publishes it with the PLY in the PLY's conditional UPDATE; once `ready`, neither changes. Leftover attempt objects are garbage-collected (spec §7.3, §7.6, §7.7). `GET /api/captures/:id/scene?v=<ready_at>` serves the SPZ, falling back to the PLY for older results, with immutable caching. The 90 MB cap applies to the PLY; the SPZ has its own 48 MB cap.
- The viewer fetches the scene itself (abortable) and streams it into Spark's `SplatMesh({ stream })`, counting real bytes for progress (ADR-0005). It falls back to the PLY, with a notice, if the SPZ will not decode, survives WebGL context loss with a reload, and reuses one WebGL renderer across scenes.
- Measured on the S4 Brush scene: 35.5 MB PLY → 5.0 MB SPZ (7.1×), converted in 2.4 s ([run log](../plan/runs/2026-11-22-s5-spz-size.md)).

One deliberate deviation: the SPZ keeps the PLY's coordinate frame instead of converting RDF → RUB as the SPZ spec and reference tools do, so PLY and SPZ results render identically under the viewer's single orientation. Frame handling belongs to defect D7.

**Not done: progressive LOD.** The viewer still renders only after the whole (now ~7× smaller) file has loaded. LOD needs an owner decision on the extra worker step and storage, plus a check of Spark's paging APIs at the pinned version. "First pixels within seconds" below relies on LOD; S5 delivers the size reduction only.

## Alternatives Considered

### Stay on PLY, add gzip/brotli transfer encoding
- **Pros**: trivial to add.
- **Cons**: about 2× smaller at best; still renders nothing until the whole file has loaded.
- **Why not**: does not reach the < 15 MB delivered-size target.

### Self-hosted streaming format (e.g. custom octree)
- **Pros**: maximal control.
- **Cons**: large engineering effort; duplicates Spark.
- **Why not**: SPZ is an open format that Spark supports.

## Consequences

### Positive
- Roughly 10× less to download; first pixels within seconds; lower R2 storage when PLY retention is short.

### Negative
- SPZ quantisation is lossy (usually invisible). Conversion adds worker time and a dependency.
- Two result objects per capture, so result-key handling must follow spec T2.

### Risks
- Spark LOD APIs may change. Mitigation: pin the Spark version and cover it in the Playwright test.
