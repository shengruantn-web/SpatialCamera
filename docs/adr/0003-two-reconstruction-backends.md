# ADR-0003: Two reconstruction backends — Nerfstudio (CUDA) and pycolmap + Brush (Apple Silicon)

**Date**: 2026-10-01 (backfilled 2026-11-16; the Brush backend is still uncommitted)
**Status**: accepted
**Deciders**: project owner (inferred from code)

## Context

Nerfstudio's `splatfacto` is the reference open-source trainer, but it needs CUDA. The owner develops on a Mac, and without a local backend the end-to-end loop cannot be tested. Brush is a Rust/WGPU trainer that runs on Metal, and pycolmap ships CPU wheels for macOS.

## Decision

`worker.py --backend nerfstudio|brush` selects the pipeline. Both backends report the same stages and the same alignment rule (at least 60% of photos registered), and both produce a Gaussian PLY.

## Alternatives Considered

### CUDA only
- **Pros**: one pipeline; best quality and speed.
- **Cons**: cannot be run or debugged on the owner's machine.
- **Why not**: the loop has never run end to end, and a local backend is the cheapest way to prove it.

### gsplat directly, or a commercial API
- **Pros**: more control (gsplat) or no compute to run (API).
- **Cons**: gsplat is still CUDA-only; an API costs money and the data leaves the user's machine.
- **Why not**: same constraints as ADR-0001.

## Consequences

### Positive
- The pipeline can be developed and demonstrated on a Mac.
- The backend boundary leaves room for a third, feed-forward tier (ADR-0008).

### Negative
- Two toolchains to pin and test; CPU SIFT with exhaustive matching is slow for more than 100 photos.
- Output conventions may differ (spec D7: Brush orientation is unverified).

### Risks
- The backends may drift apart in quality. Mitigation: a shared golden-capture test set, with alignment ratio and timings recorded (spec T7).
