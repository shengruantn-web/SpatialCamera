# ADR-0008: Add a feed-forward preview tier before optimisation-based training

**Date**: 2026-11-16
**Status**: accepted (2026-11-22)
**Deciders**: project owner (accepted 2026-11-22)

## Context

COLMAP plus 7000-step training takes 10–60 minutes, and COLMAP alignment is the most common failure. Pose-free feed-forward models (e.g. the AnySplat family) predict both cameras and Gaussians in seconds on one GPU. Their quality is lower but often good enough to judge a capture.

## Decision

Add a `preview` stage after `queued`. The worker runs a feed-forward model on a subsample of frames and uploads `preview.spz`, which the UI shows labelled "Preview" (ADR-0005). It then runs the refine pipeline (ADR-0003). It may reuse the predicted poses when COLMAP fails, but only after a quality check.

## Alternatives Considered

### Faster training preset only (fewer steps, lower resolution)
- **Pros**: no new model.
- **Cons**: still needs COLMAP; still several minutes.
- **Why not**: worth doing as well, but it does not change the experience.

### Preview-only product
- **Pros**: cheap and fast.
- **Cons**: the quality limit is visible, especially on large scenes.
- **Why not**: users keeping a place expect a crisp result.

## Consequences

### Positive
- Time to first view drops from tens of minutes to about 1–2 minutes; bad captures are caught early.
- A possible fallback when COLMAP alignment fails.

### Negative
- A second model to pin, run and license-check; it needs a CUDA GPU with lots of memory.
- The state machine and UI gain a stage and a second result.

### Risks
- Model licences may restrict commercial use. Mitigation: check the licence before acceptance (PRD open question 2).
