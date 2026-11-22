# ADR-0005: Show only real processing state — never simulate progress

**Date**: 2026-10-01 (backfilled 2026-11-16 from README and code at `5d136af`)
**Status**: accepted
**Deciders**: project owner (inferred from README)

## Context

Reconstruction can wait in the queue for a long time when no worker is online, and then runs for tens of minutes. Many demos animate fake progress bars or show a sample scene as if it were the user's result. That erodes trust once users notice.

## Decision

The UI shows only the stored capture state (spec §1) and whether a worker has been seen in the last 90 s (`/api/health`). When no worker is online, it says so instead of animating. The sample scene is always labelled as a sample.

## Alternatives Considered

### Estimated progress bar
- **Pros**: feels responsive.
- **Cons**: duration depends heavily on photo count and hardware, so the estimates would be wrong.
- **Why not**: violates PRD principle 1.

## Consequences

### Positive
- Users can tell "waiting for a machine" apart from "processing".

### Negative
- Long stages feel static. Real fine-grained progress (training step N/7000) would need the worker to report it. This is a possible extension within this ADR.

### Risks
- None significant. Any future preview tier (ADR-0008) must be labelled as a preview.
