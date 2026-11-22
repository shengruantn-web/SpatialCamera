# Delivery plan: M0–M4

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

## M2–M4 (approved 2026-11-22: ADRs 0008–0010 accepted, PRD §9 resolved)

| Goal | Outcome | Refs |
|---|---|---|
| G6 Easier capture | iPhone photos (HEIC), phone camera capture, and video all work; bad photos flagged before upload | M2, R1.3–R1.6, ADR-0009 |
| G7 Instant preview | A labelled preview appears before the refined result, from a model whose licence permits our use | M3, R3.7, ADR-0008 |
| G8 Keep and share | Rename and delete captures (deleting removes the R2 objects); opt-in, revocable share links and embeds that never expose source photos | M4, R5.3, R5.4, ADR-0010 |

| # | Shipment | Wave | Definition of done |
|---|---|---|---|
| S6 | HEIC + pre-upload checks (R1.3, R1.6) | 1 (now; client only) | HEIC/HEIF converted to JPEG in the browser before upload (lazy-loaded decoder; EXIF orientation kept). Blur check (variance of Laplacian on a downscaled copy) and near-duplicate check (perceptual hash) warn without blocking. Unit tests for the pure functions |
| S7 | Rename/delete + retention (R5.3) | 2 (after S5) | Owner can rename and delete. Delete is refused while leased. It removes D1 rows and every R2 object under the capture prefix (images, attempts, archives), in bounded batches. Miniflare tests |
| S8 | Share links + embed (ADR-0010) | 2 (after S5) | `shares` table (hashed 128-bit token, revoked_at) via a schema-only migration. Owner creates and revokes links. `/s/:token` read-only viewer + SPZ only; `/s/:token/embed` iframe view. Never source photos or PLY unless the owner opts in. Cache headers, rate limit, view count. Miniflare tests, including a revoked token returning 404 immediately |
| S9 | Phone camera capture (R1.4) | 3 | `capture` input plus an in-page guided shooting mode on mobile (shot counter, overlap hint). Works in iOS Safari and Android Chrome (checked with device emulation) |
| S10 | Video input (ADR-0009) | 3 | Upload of one MP4/MOV through R2 multipart, `source_kind` column. Worker extracts frames with ffmpeg and picks the sharpest per window, dropping near-duplicates, 100–200 frames. Video deleted after extraction unless the owner keeps it. Worker + API tests; one real phone-style clip processed end to end on the Mac |
| S11 | Preview tier (ADR-0008) | 3, gated | Licence and feasibility report first. If a model passes: `previewing` stage + `preview.spz` with per-attempt keys, labelled "Preview" in the UI, refine continues after. Validated end to end only where a CUDA GPU is available; otherwise shipped behind a worker flag with protocol tests and the gap stated |

## Not in scope here (needs hardware or owner decision)

- CUDA/Nerfstudio validation and the S11 model run: no NVIDIA GPU on this machine. Needs a Linux GPU or RunPod access.
- WebXR (R5.5) and the v1 metric targets (PRD §5) remain open.

## Status log

| Date | Shipment | Result |
|---|---|---|
| 2026-11-22 | S0 | `372f9be`: branch created, Mac backend + PRD/spec/ADRs committed |
| 2026-11-22 | S2 | `81b799a`: done. typecheck/lint/build pass, 17/17 Miniflare tests. Codex review: 5 findings (1 high: backfills in a hosted migration), all fixed and re-verified. Open: whether Sites honours `triggers.crons` (claim-path and per-row expiry cover it if not) |
| 2026-11-22 | S1 | Done. 55 worker tests pass on Python 3.12/3.13/3.14 (macOS) and 3.12 (Linux container); signal/process-group tests 0 failures in 144 runs at 48-way parallelism (plus 576 by the fixing agent). Four rounds: Codex implemented; python-reviewer found 9 then 4 issues; orchestrator stress testing exposed a signal-inside-`Popen`/`poll` race (orphaned stage, deadlock), fixed with safe-point signal deferral and deterministic regression tests |
| 2026-11-22 | S3 | Done. `.github/workflows/ci.yml` (Node: typecheck, lint, test, build; Python 3.12: py_compile + unittest). Same commands pass locally. Not yet run on GitHub (branch not pushed) |
