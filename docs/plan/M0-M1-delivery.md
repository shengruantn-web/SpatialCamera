# Delivery plan: M0 "Prove the loop" + M1 "Fast to view"

**Owner**: orchestrator (Claude Opus 5.5) · **Started**: 2026-11-22 · **Branch**: `m0-m1-delivery` (local commits only; no push without approval)
**Source of truth**: [PRD](../PRD.md), [capture-pipeline spec](../specs/capture-pipeline.md), [ADRs](../adr/README.md)

## Goals

| Goal | Outcome | PRD/spec refs |
|---|---|---|
| G1 No lost work | A finished splat is never discarded or overwritten by a stale attempt; a capture's inputs can't change after submit | D1–D6, T1–T5, R3.6 |
| G2 Proven loop | A real photo capture goes uploading → ready on the Apple Silicon backend and renders upright in the viewer | R3.3, D7, M0 exit |
| G3 Guarded | Every change is checked automatically (typecheck, lint, API tests, worker tests, build) | X3 |
| G4 Measured | Per-stage timestamps and alignment ratio stored per capture | X2, T7 |
| G5 Fast to view | Results delivered as SPZ with load progress; uploads concurrent; DB hot path fixed; polling adaptive | R2.2, R4.3, D8, T6, ADR-0007 |

## Shipments and definition of done

Every shipment also requires: `npm run typecheck`, `npm run lint`, `npm test` and `npm run build` pass; new behaviour has tests; spec/README updated where behaviour changed; reviewed by a second agent; local commit on the branch.

| # | Shipment | Agent | Definition of done |
|---|---|---|---|
| S0 | Baseline | orchestrator | Branch created; uncommitted Mac backend + docs committed as-is |
| S1 | Worker reliability (D1, D2, D5, T5) | Codex | Heartbeat runs until the result PUT finishes; result upload retried with backoff, temp dir kept until success (or kept on final failure with path logged); stage processes run in their own process group and `os.killpg` on stop/timeout; PLY body validated (vertex count × stride = payload, finite floats) before upload; Python unit tests (`python3 -m unittest`) cover each |
| S2 | API integrity + hot path (D3, D4, D8, T2, T3, T6, T7) | Claude | Per-attempt result keys + `result_key` published atomically; repeated `PUT result` from the winning lease is idempotent; image PUT after submit can't mutate inputs; DDL out of request path (Drizzle migration), stale sweep not on every request, indexes added; stage timestamps + alignment ratio columns; Miniflare tests for each race |
| S3 | CI | Claude (Sonnet) | `.github/workflows/ci.yml` runs Node checks + Python tests on push/PR; validated locally by running the same commands |
| S4 | Mac end-to-end proof (G2) | Claude | `setup:mac` works; a public photo set (≥ 30 photos) reaches `ready` via local dev server + `worker:mac`; screenshot of the result in the viewer; D7 resolved (fixed or confirmed fine); timings recorded in a run log |
| S5 | Fast to view (G5) | Codex + Claude | Worker uploads SPZ (+ PLY archive); viewer loads SPZ with `onProgress`, one renderer reused; uploads 4-way concurrent; polling backs off when idle; size of S4 scene measured before/after |

## Not in scope here (needs owner decision or hardware)

- CUDA/Nerfstudio validation — no NVIDIA GPU on this machine; needs a Linux GPU or RunPod access.
- M2–M4 (HEIC/video/preview tier/sharing) — PRD open questions 1–4 and ADRs 0008–0010 await acceptance.

## Status log

| Date | Shipment | Result |
|---|---|---|
