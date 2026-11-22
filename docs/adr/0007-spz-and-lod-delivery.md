# ADR-0007: Deliver compressed SPZ with progressive LOD; keep PLY as an optional download

**Date**: 2026-11-16
**Status**: proposed
**Deciders**: project owner (pending)

## Context

ADR-0006 makes the viewer download 50–90 MB before showing anything. Splat viewing is bandwidth-bound, and time to first view is the headline metric (PRD §5). Spark 2.x can load SPZ, report load progress, and page level-of-detail data.

## Decision

The worker validates the PLY (spec T5) and converts it to SPZ, optionally also building an LOD set. It uploads `result.spz` as the primary file and `result.ply` as an archive. The viewer loads SPZ with `onProgress`, starts on a coarse LOD, and refines as more loads. The 90 MB cap applies to the PLY only.

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
