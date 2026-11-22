# Spatial Camera — Product Requirements (DRAFT)

**Status**: draft, reconstructed from `README.md`, the code at commit `5d136af`, and the 2026-11-16 progress review. Items marked **[OPEN]** need a product owner decision.
**Last updated**: 2026-11-16

## 1. Problem

People want to keep a place or object "as it felt", not as a flat photo. Gaussian splatting can turn ordinary photos into an explorable 3D scene, but today it needs a CUDA machine, command-line tools, and expertise in capture technique. Most casual captures fail silently at camera alignment.

## 2. Target users **[OPEN]**

| Persona | Need | Priority |
|---|---|---|
| Memory keeper | Capture a room, a garden, or an heirloom and revisit it later | Primary (assumed from UI copy: "Places worth keeping") |
| Creator / hobbyist | Produce splats to share or embed | Secondary |
| Professional (real estate, heritage, e-commerce) | Repeatable quality, sharing, branding | Out of scope for v1 |

## 3. Product principles

1. **Honest progress.** Never fake stages, progress, or results. A capture is either really processing or clearly waiting. (Already enforced; see ADR-0005.)
2. **Private by default.** Captures are owner-scoped; sharing is always explicit and opt-in.
3. **Bring your own compute.** The web app never provisions paid GPUs automatically.
4. **Fail early, explain clearly.** Tell the user why a capture will fail, preferably before upload.

## 4. User journey and requirements

Status key: ✅ done · 🟡 partial · ❌ missing (as of 2026-11-16)

### J1 Capture
| ID | Requirement | Status |
|---|---|---|
| R1.1 | Show capture guidance (move around, overlap, even light) | ✅ |
| R1.2 | Accept 12–200 JPG/PNG photos, ≤20 MB each, ≤1 GB total | ✅ |
| R1.3 | Accept HEIC (iPhone default) and convert automatically | ❌ |
| R1.4 | Capture directly from a phone camera | ❌ |
| R1.5 | Accept video and select sharp, overlapping frames | ❌ |
| R1.6 | Warn about blurry or non-overlapping photos before upload | ❌ |

### J2 Upload
| ID | Requirement | Status |
|---|---|---|
| R2.1 | Per-capture progress and resumable upload | ✅ |
| R2.2 | Concurrent uploads (target: 200 photos in < 2 min on 50 Mbps) | ❌ serial today |

### J3 Reconstruct
| ID | Requirement | Status |
|---|---|---|
| R3.1 | Durable queue, atomic claim, lease, stale-job recovery | ✅ (edge cases: see spec §5) |
| R3.2 | CUDA backend (Nerfstudio splatfacto) | 🟡 not validated end to end |
| R3.3 | Apple Silicon backend (pycolmap + Brush) | 🟡 uncommitted, untested |
| R3.4 | Report real stages: aligning → training → exporting | ✅ |
| R3.5 | Actionable failure messages; one-click retry | ✅ |
| R3.6 | Retries reuse completed stages and never discard a finished splat | ❌ |
| R3.7 | Fast preview tier (feed-forward) before refined result **[OPEN]** | ❌ |

### J4 View
| ID | Requirement | Status |
|---|---|---|
| R4.1 | Orbit / pan / zoom / auto-rotate / reset / fullscreen | ✅ |
| R4.2 | View local PLY / SPZ / SPLAT / KSPLAT without upload | ✅ |
| R4.3 | Compressed (SPZ) and streamed LOD delivery with load progress | ❌ |
| R4.4 | Keyboard navigation and screen-reader labelling | 🟡 |

### J5 Keep and share
| ID | Requirement | Status |
|---|---|---|
| R5.1 | Library of own captures with status | ✅ |
| R5.2 | Download PLY | ✅ |
| R5.3 | Rename / delete capture; retention policy | ❌ |
| R5.4 | Opt-in share link and embed | ❌ |
| R5.5 | WebXR (headset) viewing **[OPEN]** | ❌ |

### Cross-cutting
| ID | Requirement | Status |
|---|---|---|
| X1 | Owner-scoped auth via hosting gateway | ✅ |
| X2 | Stage timing and success metrics recorded per capture | ❌ |
| X3 | CI runs typecheck, lint, API and browser tests | ❌ |

## 5. Success metrics (none instrumented yet)

| Metric | Definition | v1 target **[OPEN]** |
|---|---|---|
| Time to first view | Upload complete → first splats rendered | Preview < 2 min; refined < 20 min on a 24 GB GPU |
| Capture success rate | Captures reaching `ready` ÷ captures submitted | ≥ 80% |
| Alignment ratio | Registered ÷ submitted photos | Median ≥ 90% |
| Delivered size | Bytes the viewer downloads before first render | < 15 MB |
| Cost per capture | GPU-minutes × rate + storage | Measured, then budgeted |

## 6. Non-goals for v1

- Automatic GPU provisioning or billing.
- Editing, segmentation, or relighting of splats.
- Dynamic or time-varying scenes (one capture per visit).
- Public discovery feed.

## 7. Constraints

- Hosting: Cloudflare Workers + D1 + R2 (ADR-0002). Worker request bodies and memory are bounded.
- Reconstruction runs on a separate, user-operated machine (ADR-0001, ADR-0004).
- Limits today: 12–200 photos, 20 MB/photo, 1 GB/capture, 90 MB/result.

## 8. Release plan

| Milestone | Scope | Exit criterion |
|---|---|---|
| M0 Prove the loop | Fix spec §5 issues 1–3; commit Mac backend; CI | 10 real captures reach `ready` on both backends |
| M1 Fast to view | SPZ + LOD delivery (ADR-0007), concurrent uploads, adaptive polling, DB hot-path fixes | Delivered size and time-to-first-view targets met |
| M2 Easier capture | HEIC, camera capture, pre-upload checks, video input | Capture success rate ≥ 80% |
| M3 Instant preview | Feed-forward preview tier (ADR-0008) | Preview < 2 min |
| M4 Share | Delete/rename, share links, embeds | Opt-in sharing live |

## 9. Open questions

1. Who is the primary persona, and is mobile-first capture in scope for v1?
2. Is the feed-forward preview worth a second model to operate and license?
3. Retention: how long are source photos kept after a successful splat?
4. Does sharing require anonymous viewers, or signed-in viewers only?
