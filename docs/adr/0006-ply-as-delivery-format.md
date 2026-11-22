# ADR-0006: Deliver results as uncompressed Gaussian PLY

**Date**: 2026-10-01 (backfilled 2026-11-16 from code at `5d136af`)
**Status**: accepted — expected to be superseded by ADR-0007
**Deciders**: project owner (inferred from code)

## Context

Both trainers export Gaussian PLY natively. Spark can render PLY, and users may want the raw file for other tools. Getting the loop working mattered more than file size.

## Decision

The worker uploads the trainer's PLY as-is, up to 90 MB. The browser downloads the whole file and renders it after the full load. The same file is offered for download.

## Alternatives Considered

### Convert to SPZ on the worker
- **Pros**: about 10× smaller files.
- **Cons**: an extra conversion step and dependency.
- **Why not**: deferred until the core loop is proven; see ADR-0007.

## Consequences

### Positive
- Zero conversion; lossless; works with every splat tool.

### Negative
- 50–90 MB downloads before the first frame; slow on mobile; R2 storage grows quickly.
- Only the header is validated (spec D6).

### Risks
- Larger scenes will exceed the 90 MB cap. Mitigation: ADR-0007.
