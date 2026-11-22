# Spec: Capture state machine and worker protocol

**Status**: draft — documents behaviour at commit `5d136af` plus the uncommitted Brush backend. §5 lists known defects; §6 lists the target changes.
**Related**: PRD R2–R3, ADR-0001, ADR-0003, ADR-0005

## 1. Capture states

```
uploading ──submit──▶ queued ──claim──▶ aligning ──▶ training ──▶ exporting ──result──▶ ready
    ▲                   ▲                  │             │             │
    │                   └──── submit ──── failed ◀───────┴─────────────┘
    │                                      ▲   (worker reports failure, or no update for 10 min)
    └── (new capture)
```

| State | Entered when | Left when |
|---|---|---|
| `uploading` | `POST /api/captures` creates manifest | All images uploaded and owner submits |
| `queued` | Owner submits (from `uploading` or `failed`) | A worker claims it (oldest `created_at` first) |
| `aligning` / `training` / `exporting` | Worker claim / `PATCH status` (forward by exactly one step, or same step as heartbeat) | Next stage, `failed`, or lease expiry |
| `ready` | Worker `PUT result` while `exporting` with a valid lease | Terminal |
| `failed` | Worker reports `failed`, or `updated_at` older than 10 min in an active state | Owner resubmits |

Invariants:
- I1. A capture in an active state has exactly one non-null `lease`; `ready` and `failed` have none.
- I2. A capture is never `queued` unless every manifest image has `uploaded=1`.
- I3. `ready` implies `result_bytes > 0` and `{id}/result.ply` exists in R2.
- I4. Progress shown to the user is derived only from these states (ADR-0005).

## 2. Owner API (browser)

All routes require the `oai-authenticated-user-email` header (or `LOCAL_DEV` on localhost). Mutations reject cross-origin requests.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | `{ storage, processor }`; processor = worker seen in last 90 s |
| GET | `/api/captures` | Owner's latest 100 captures |
| POST | `/api/captures` | Create manifest `{ name, images[{name,bytes,mime}] }` → `{ id, images[{id,…}] }` |
| GET | `/api/captures/:id` | Capture + image upload flags |
| PUT | `/api/captures/:id/images/:imageId` | Upload bytes; must match manifest size and JPEG/PNG signature |
| POST | `/api/captures/:id/submit` | `uploading`/`failed` → `queued` |
| GET | `/api/captures/:id/result.ply[?download]` | Result when `ready` |

## 3. Worker API

All routes require `Authorization: Bearer <WORKER_TOKEN>` (≥ 32 chars, compared via SHA-256 digests). After claim, every call sends `X-Job-Lease`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/worker/claim` | Atomically claim oldest `queued` → `{ job: { id, image_count, lease, images[] } \| null }` |
| GET | `/api/worker/:id/images/:imageId` | Download a source photo |
| PATCH | `/api/worker/:id/status` | `{ status, error? }` — heartbeat (same stage), advance one stage, or `failed` |
| PUT | `/api/worker/:id/result` | Gaussian PLY, `Content-Length` 1 B–90 MB, streamed to R2; completes the job |

Worker behaviour: heartbeat every 25 s; stage timeout 2 h; poll every 10 s when idle; abort the stage after 5 consecutive heartbeat failures or any 401/403/409.

## 4. Reconstruction backends

| Backend | Align | Train | Export |
|---|---|---|---|
| `nerfstudio` (CUDA) | `ns-process-data images` (COLMAP); require ≥ max(8, 60%) frames registered | `ns-train splatfacto`, 7000 iterations | `ns-export gaussian-splat` |
| `brush` (Apple Silicon) | `mac_pipeline.py`: pycolmap CPU SIFT (8192 features), exhaustive matching, incremental mapping, undistort; same 60% rule | `brush_app`, 7000 steps, ≤ 300k splats, SH degree 2 | Brush exports PLY at final step |

## 5. Known defects (2026-11-16 review)

| # | Defect | Location | Severity |
|---|---|---|---|
| D1 | Heartbeat stops before result upload; a > 10 min upload expires the job and the splat is lost | `worker.py:148-151`, `api.ts:112` | High |
| D2 | Any error deletes the temp dir; the result upload is never retried | `worker.py:106,153` | High |
| D3 | All attempts write the same `result.ply` key; a stale attempt can overwrite the winner (breaks I3) | `api.ts:141` | High |
| D4 | An image PUT that started before submit can land after claim, mutating inputs | `api.ts:182-186` | Medium |
| D5 | Only the direct child is killed; COLMAP grandchildren survive | `worker.py:94-101` | Medium |
| D6 | Only the PLY header is validated; truncated payloads can become `ready` | `validation.ts:29` | Medium |
| D7 | Brush results may render tilted (viewer assumes Nerfstudio Z-up) — **unverified** | `SplatViewer.tsx:50` | Medium |
| D8 | DDL + global stale-lease UPDATE run on every request, including polls | `api.ts:108-112` | Medium (perf) |

## 6. Target changes

- **T1 (D1, D2)** Heartbeat continues through upload; result upload retried with backoff before cleanup; finalisation idempotent (a repeated `PUT result` for an already-`ready` attempt returns 200).
- **T2 (D3)** Results written to `{id}/attempts/{lease}/result.{ply,spz}`; `captures.result_key` set in the same conditional UPDATE that marks `ready`; unpublished attempt objects garbage-collected.
- **T3 (D4)** Submit freezes the manifest; image PUT re-checks `status='uploading'` in a conditional UPDATE after the R2 write and deletes the object if it lost.
- **T4 (D5)** Start stage processes with `start_new_session=True`; terminate with `os.killpg`.
- **T5 (D6)** Worker validates vertex count × stride == payload length and finite values before upload.
- **T6 (D8)** DDL moves to Drizzle migrations; stale-lease sweep moves to a Cron Trigger; add indexes `images(capture_id,uploaded)`, `captures(owner,created_at)`, `captures(status,created_at)`, `captures(status,updated_at)`.
- **T7** Record per-stage timestamps and alignment ratio on the capture row (PRD X2).
