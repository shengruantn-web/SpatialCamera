# Spec: Capture state machine and worker protocol

**Status**: draft — documents behaviour at commit `5d136af` plus the Brush backend, updated for shipment S2 (API integrity + hot path: T2, T3, T6, T7 and the API half of T1). §5 lists known defects; §6 lists the target changes; §7 describes storage and concurrency as implemented.
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
| `ready` | Worker `PUT result` while `exporting` with a valid lease; the same conditional UPDATE sets `result_key` | Terminal |
| `failed` | Worker reports `failed`, or `updated_at` older than 10 min in an active state (lease expiry, see §7.4) | Owner resubmits |

Each transition records its entry time in `queued_at`, `aligning_at`, `training_at`, `exporting_at`, `ready_at` or `failed_at` (ms). A same-stage heartbeat does not move the timestamp. Resubmitting resets `aligning_at`…`failed_at` and `alignment_ratio`, so the columns always describe the current attempt (PRD X2).

Invariants:
- I1. A capture in an active state has exactly one non-null `lease`; `uploading`, `queued`, `ready` and `failed` have none. (Before S2 a worker-reported `failed` kept its lease until resubmit; it is now cleared in the same UPDATE, and the stale-lease sweep clears any lease left on a `failed` row by older code, §7.4.)
- I2. A capture is never `queued` unless every manifest image has `uploaded=1`. Submit enforces this in a single conditional UPDATE.
- I3. `ready` implies `result_bytes > 0` and the object at `result_key` exists in R2 (rows finished before S2 have a NULL `result_key`, which is read as the legacy key `{id}/result.ply`; no migration backfills it).
- I4. Progress shown to the user is derived only from these states (ADR-0005).
- I5. From submit onwards, the image objects a capture references (`images.object_key`) never change (§7.2).
- I6. The published result object is written only by the attempt that published it; a stale or losing attempt can never overwrite it (§7.3).

## 2. Owner API (browser)

All routes require the `oai-authenticated-user-email` header (or `LOCAL_DEV` on localhost). Mutations reject cross-origin requests.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | `{ storage, processor }`; processor = worker seen in last 90 s |
| GET | `/api/captures` | Owner's latest 100 captures |
| POST | `/api/captures` | Create manifest `{ name, images[{name,bytes,mime}] }` → `{ id, images[{id,…}] }` |
| GET | `/api/captures/:id` | Capture + image upload flags. The capture includes `uploaded_count` (the stored counter while `uploading`; `image_count` in every later state, which I2 and I5 make exact), the stage timestamps (`queued_at` … `failed_at`, ms or null) and `alignment_ratio` (0–1 or null). Never includes `lease`, `result_key` or object keys |
| PUT | `/api/captures/:id/images/:imageId` | Upload bytes; must match manifest size and JPEG/PNG signature. Only while `uploading`; a PUT that loses a race with submit returns 409 and changes nothing (§7.2) |
| POST | `/api/captures/:id/submit` | `uploading`/`failed` → `queued` |
| GET | `/api/captures/:id/result.ply[?download]` | Result when `ready`, read from `result_key` |

## 3. Worker API

All routes require `Authorization: Bearer <WORKER_TOKEN>` (≥ 32 chars, compared via SHA-256 digests). After claim, every call sends `X-Job-Lease`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/worker/claim` | Atomically claim oldest `queued` → `{ job: { id, image_count, lease, images[] } \| null }` |
| GET | `/api/worker/:id/images/:imageId` | Download a source photo |
| PATCH | `/api/worker/:id/status` | `{ status, error?, metrics? }` — heartbeat (same stage), advance one stage, or `failed`. Optional `metrics: { alignment_ratio }` (number 0–1, else 400; unknown keys ignored; a missing value keeps the stored one) |
| PUT | `/api/worker/:id/result` | Gaussian PLY, `Content-Length` 1 B–90 MB, streamed to R2; completes the job. Idempotent: a repeat from the lease that already made the capture `ready` returns 200 without rewriting; any other lease gets 409 |

Any job request whose lease is stale (`updated_at` older than 10 min) expires the capture and gets 409. Freshness is checked again when the write lands, not only when the request starts: the status PATCH and the result publication both carry `updated_at >= now - 10 min` in their conditional UPDATE, with `now` taken after the body has been read (§7.3). A worker that stops heartbeating while it uploads therefore loses the job (D1 / T1 worker side), even if no sweep has run yet.

`updated_at` only moves forward (`updated_at = MAX(updated_at, ?)`), so a delayed heartbeat cannot make a live job look older than it is and get it swept.

Worker behaviour: heartbeat every 25 s, kept running through the result upload; stage timeout 2 h; poll every 10 s when idle; abort the stage after 5 consecutive heartbeat failures or any 401/403/409. Since S1:

- Each stage runs in its own session/process group (`start_new_session=True`); stop, timeout or worker exit terminates the whole group (`os.killpg` SIGTERM, then SIGKILL after 10 s), so COLMAP/Brush grandchildren cannot survive. SIGTERM/SIGHUP are deferred while a stage's group is live and raised only at safe points (poll sleep, or after the group is reaped), so a signal can't orphan a stage or deadlock `Popen`'s wait lock.
- The PLY is validated in full before upload: header, vertex count × stride equals the payload length, and finite x/y/z.
- The result upload is streamed and retried with backoff (5, 15, 45, 120 s) on network errors, 429 and 5xx (the server returns 503 for transient failures). A 2xx PUT wins over a concurrent heartbeat 409. If an attempt's outcome is unknown (timeout mid-response), one confirming PUT is sent; the server's idempotent finalisation makes that safe.
- If the upload finally fails, the validated PLY is moved to a recovery folder (`--recovery-dir`, default `~/.cache/spatial-camera/recovered`, newest 10 kept) and its path is logged before the temp dir is removed.

## 4. Reconstruction backends

| Backend | Align | Train | Export |
|---|---|---|---|
| `nerfstudio` (CUDA) | `ns-process-data images` (COLMAP); require ≥ max(8, 60%) frames registered | `ns-train splatfacto`, 7000 iterations | `ns-export gaussian-splat` |
| `brush` (Apple Silicon) | `mac_pipeline.py`: pycolmap CPU SIFT (8192 features), exhaustive matching, incremental mapping, undistort; same 60% rule | `brush_app`, 7000 steps, ≤ 300k splats, SH degree 2 | Brush exports PLY at final step |

## 5. Known defects (2026-11-16 review)

| # | Defect | Location | Severity |
|---|---|---|---|
| D1 | Heartbeat stops before result upload; a > 10 min upload expires the job and the splat is lost | `worker.py:148-151`, `api.ts:112` | High — **fixed in S1** (T1) |
| D2 | Any error deletes the temp dir; the result upload is never retried | `worker.py:106,153` | High — **fixed in S1** (retry + recovery folder) |
| D3 | All attempts write the same `result.ply` key; a stale attempt can overwrite the winner (breaks I3) | `api.ts:141` | High — **fixed in S2** (T2) |
| D4 | An image PUT that started before submit can land after claim, mutating inputs | `api.ts:182-186` | Medium — **fixed in S2** (T3) |
| D5 | Only the direct child is killed; COLMAP grandchildren survive | `worker.py:94-101` | Medium — **fixed in S1** (T4) |
| D6 | Only the PLY header is validated; truncated payloads can become `ready` | `validation.ts:29` | Medium — **fixed worker-side in S1** (T5); the server still checks header + declared size |
| D7 | Brush results may render tilted (viewer assumes Nerfstudio Z-up) — **unverified** | `SplatViewer.tsx:50` | Medium |
| D8 | DDL + global stale-lease UPDATE run on every request, including polls | `api.ts:108-112` | Medium (perf) — **fixed in S2** (T6) |
| D9 | Worker-reported `failed` left the lease set (breaks I1); list/detail reads ran a COUNT subquery per row | `api.ts:135`, `api.ts:12` | Low — **fixed in S2** |

## 6. Target changes

- **T1 (D1, D2)** Heartbeat continues through upload; result upload retried with backoff before cleanup; finalisation idempotent (a repeated `PUT result` for an already-`ready` attempt returns 200).
- **T2 (D3)** Results written to `{id}/attempts/{lease}/result.{ply,spz}`; `captures.result_key` set in the same conditional UPDATE that marks `ready`; unpublished attempt objects garbage-collected. *Done in S2 for PLY:* the key segment is a digest of the lease, not the lease (§7.3); losing attempts delete their object immediately (best effort, no background GC yet).
- **T3 (D4)** Submit freezes the manifest; image PUT re-checks `status='uploading'` in a conditional UPDATE after the R2 write and deletes the object if it lost. *Done in S2*, with each upload written to a fresh key so the R2 write itself can't mutate frozen inputs (§7.2).
- **T4 (D5)** Start stage processes with `start_new_session=True`; terminate with `os.killpg`.
- **T5 (D6)** Worker validates vertex count × stride == payload length and finite values before upload.
- **T6 (D8)** DDL moves to Drizzle migrations; stale-lease sweep moves to a Cron Trigger; add indexes `images(capture_id,uploaded)`, `captures(owner,created_at)`, `captures(status,created_at)`, `captures(status,updated_at)`. *Done in S2* (migration `0001_api_integrity_hot_path`; §7.4–7.5).
- **T7** Record per-stage timestamps and alignment ratio on the capture row (PRD X2). *Done in S2 (server side)*: columns and the optional `metrics.alignment_ratio` PATCH field (§3). Sending it is worker work.
- **T1 (server half)** *Done in S2*: repeated `PUT result` from the publishing lease returns 200.

## 7. Storage and concurrency (as of S2)

### 7.1 R2 layout

| Key | Written by | Read via |
|---|---|---|
| `{id}/uploads/{imageId}/{uuid}` | Owner image PUT, a fresh key per request | `images.object_key` |
| `{id}/images/{imageId}` | Pre-S2 uploads only | Fallback when `object_key` is NULL |
| `{id}/attempts/{attempt}/result.ply` | Worker result PUT; `attempt` = first 32 hex chars of SHA-256(lease) | `captures.result_key` |
| `{id}/result.ply` | Pre-S2 results only | Fallback when `result_key` is NULL |

Leases are bearer secrets, so they never appear in object keys.

### 7.2 Image upload (I5, T3)

Overwriting one shared key would itself be the mutation: a late PUT could replace bytes a worker is already reading. So:

1. Reject unless the capture is `uploading` (fast path), then validate size and signature.
2. Write the bytes to a new key `{id}/uploads/{imageId}/{uuid}`. Nothing reads this key yet.
3. In one D1 batch: `UPDATE images SET uploaded=1, object_key=? … WHERE … AND EXISTS (capture is 'uploading')`, then set `captures.uploaded_count` to a fresh indexed `COUNT(*)` of uploaded images (not `+1`), so a counter left stale by pre-S2 code corrects itself on the next upload. Submit never trusts the counter: it compares `image_count` with the same `COUNT(*)` (I2).
4. If step 3 changed no row, submit got there first: delete the new object and return 409. Otherwise delete the object this upload replaced, if any.

Submit and step 3 serialise in D1, so after submit `object_key` can't change, and the objects it points to are never written again. Re-upload is still allowed only while `uploading`. A `failed` capture keeps its inputs, and resubmitting reuses them.

### 7.3 Result publication (I3, I6, T1, T2)

1. The lease must match and the capture must be `exporting` and not stale; otherwise 409 before any write.
2. Stream the PLY to `{id}/attempts/{attempt}/result.ply` (R2 puts are atomic, and `FixedLengthStream` rejects short bodies).
3. Take `done = now` after the upload completes, then `UPDATE captures SET status='ready', result_key=?, result_bytes=?, ready_at=done, updated_at=MAX(updated_at,done), lease=NULL … WHERE id=? AND lease=? AND status='exporting' AND updated_at >= done - 10 min`. The freshness clause means an attempt whose lease expired during the upload cannot publish even if no sweep has failed it yet. The worker heartbeats throughout the upload, so a live long upload stays fresh.
4. If it changed no row: when the row is already `ready` with this same `result_key` (a concurrent duplicate from the same attempt won), return 200. Otherwise delete the object just written, expire the capture if it is stale, and return 409 (the same code as any lost lease).

Status codes: 400 means the payload itself is invalid (bad PLY header, wrong size) and must not be retried. A broken request stream, short body or R2 write error returns **503**, which the worker retries; the row is untouched, so a retry under the same lease simply publishes. Image PUT uses the same split: a failed R2 put returns 503, and the image stays not uploaded.

A stale attempt writes only under its own `attempt` prefix, so it can't touch the published object. A repeated PUT after `ready` is recognised by comparing `result_key` with the key derived from the presented lease, so no lease needs to stay on the row (I1). Accepted limitation: two *concurrent* PUTs from the same attempt write the same key, so the later write replaces the earlier one. Both are complete, header-valid uploads of that attempt's own result, so I6 holds.

### 7.4 Lease expiry (D8)

No global sweep runs per request. A capture is expired (`failed`, lease cleared, `failed_at` set) when its `updated_at` is more than 10 min old in an active state, at one of these points:
- the Cron Trigger every 5 min (`scheduled` in `worker/index.ts`, `triggers.crons` in `vite.config.ts`);
- the claim path, before it picks a job;
- lazily on read: owner detail and job requests expire just that row. The owner list runs the sweep only when a returned row is stale, so ordinary polling does no writes.

The same sweep also clears `lease` on up to 100 `failed` rows that still hold one (left by pre-S2 code, I1), using the `status` index. This replaces a data backfill. `ready` rows never kept a lease, so they are not scanned.

### 7.5 Schema and migrations (T6)

The API runs no DDL. The schema lives in `db/schema.ts`; `npm run db:generate` emits SQL into `drizzle/`, which the build packages into `dist/.openai/drizzle` for the host to apply. Locally, `node db/migrate.mjs` (run automatically as `predev`, or as `npm run db:migrate:local`) applies pending migrations to the `vinext dev` database (`.wrangler/state/v3`), recording them in `d1_migrations` (the table `wrangler d1 migrations apply` uses). Before applying a pending migration it checks whether the tables, columns and indexes it creates already exist (`sqlite_master`, `PRAGMA table_info`). If all of them do, as in a pre-migration database whose tables came from the old runtime DDL, or one where the SQL was run with `wrangler d1 execute --file`, it records the migration as applied without running it. If only some exist, it stops with a message that lists what is present and what is missing. Migration `0001_api_integrity_hot_path` adds `uploaded_count`, `result_key`, the stage timestamps, `alignment_ratio`, `images.object_key` and the four indexes.

Migrations are schema-only, as the host requires: no `UPDATE` backfills or seed data, and an added column's default is a constant. The code is correct on un-backfilled legacy rows instead: a NULL `result_key` on a `ready` row reads `{id}/result.ply` (§7.1); `uploaded_count` is recounted on every image upload (§7.2) and reported as `image_count` once past `uploading`; and the sweep clears leftover leases (§7.4). `uploaded_count` is maintained on upload, so list and detail reads need no per-row COUNT.
