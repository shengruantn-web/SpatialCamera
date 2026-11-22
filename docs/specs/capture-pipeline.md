# Spec: Capture state machine and worker protocol

**Status**: draft — documents behaviour at commit `5d136af` plus the Brush backend, updated for shipment S2 (API integrity + hot path: T2, T3, T6, T7 and the API half of T1) S5 (SPZ delivery, §7.6) and S7 (rename, delete and retention, §7.9). §5 lists known defects; §6 lists the target changes; §7 describes storage and concurrency as implemented.
**Related**: PRD R2–R3, ADR-0001, ADR-0003, ADR-0005, ADR-0007

## 1. Capture states

```
uploading ──submit──▶ queued ──claim──▶ aligning ──▶ training ──▶ exporting ──result──▶ ready
    ▲                   ▲                  │             │             │
    │                   └──── submit ──── failed ◀───────┴─────────────┘
    │                                      ▲   (worker reports failure, or no update for 10 min)
    └── (new capture)

uploading / queued / ready / failed ──owner DELETE──▶ deleting ──purge──▶ (rows removed)     [S7, §7.9]
```

| State | Entered when | Left when |
|---|---|---|
| `uploading` | `POST /api/captures` creates manifest | All images uploaded and owner submits |
| `queued` | Owner submits (from `uploading` or `failed`) | A worker claims it (oldest `created_at` first) |
| `aligning` / `training` / `exporting` | Worker claim / `PATCH status` (forward by exactly one step, or same step as heartbeat) | Next stage, `failed`, or lease expiry |
| `ready` | Worker `PUT result` while `exporting` with a valid lease; the same conditional UPDATE sets `result_key` and, if the attempt stored an SPZ, `spz_bytes` | Terminal |
| `failed` | Worker reports `failed`, or `updated_at` older than 10 min in an active state (lease expiry, see §7.4) | Owner resubmits |
| `deleting` (S7) | Owner `DELETE` on a capture with no live lease (`uploading`, `queued`, `ready`, `failed`) | Its objects are purged and its rows removed, by the same request or by the cron (§7.9). Hidden from the owner (404 everywhere), never claimed, resubmitted, renamed or uploaded to |

Each transition records its entry time in `queued_at`, `aligning_at`, `training_at`, `exporting_at`, `ready_at` or `failed_at` (ms). A same-stage heartbeat does not move the timestamp. Resubmitting resets `aligning_at`…`failed_at` and `alignment_ratio`, so the columns always describe the current attempt (PRD X2).

Invariants:
- I1. A capture in an active state has exactly one non-null `lease`; `uploading`, `queued`, `ready` and `failed` have none. (Before S2 a worker-reported `failed` kept its lease until resubmit; it is now cleared in the same UPDATE, and the stale-lease sweep clears any lease left on a `failed` row by older code, §7.4.)
- I2. A capture is never `queued` unless every manifest image has `uploaded=1`. Submit enforces this in a single conditional UPDATE.
- I3. `ready` implies `result_bytes > 0` and the object at `result_key` exists in R2 (rows finished before S2 have a NULL `result_key`, which is read as the legacy key `{id}/result.ply`; no migration backfills it). A non-null `spz_bytes` implies the SPZ beside `result_key` exists, from the same attempt (§7.6).
- I4. Progress shown to the user is derived only from these states (ADR-0005).
- I5. From submit onwards, the image objects a capture references (`images.object_key`) never change (§7.2).
- I6. The published result object is written only by the attempt that published it; a stale or losing attempt can never overwrite it (§7.3).
- I7. (S7) A capture's rows outlive its objects: the `captures` and `images` rows are removed only after a listing of `{id}/` came back empty while the row was `deleting`, and no write stored after the status flip is ever committed (§7.9).

## 2. Owner API (browser)

All routes require the `oai-authenticated-user-email` header (or `LOCAL_DEV` on localhost). Mutations reject cross-origin requests.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/health` | `{ storage, processor }`; processor = worker seen in last 90 s |
| GET | `/api/captures` | Owner's latest 100 captures |
| POST | `/api/captures` | Create manifest `{ name, images[{name,bytes,mime}] }` → `{ id, images[{id,…}] }` |
| GET | `/api/captures/:id` | Capture + image upload flags. The capture includes `uploaded_count` (the stored counter while `uploading`; `image_count` in every later state, which I2 and I5 make exact), the stage timestamps (`queued_at` … `failed_at`, ms or null), `alignment_ratio` (0–1 or null), `result_bytes` (the PLY) and `spz_bytes` (the SPZ, or null when the result is PLY-only). Never includes `lease`, `result_key` or object keys |
| PUT | `/api/captures/:id/images/:imageId` | Upload bytes; must match manifest size and JPEG/PNG signature. Only while `uploading`; a PUT that loses a race with submit returns 409 and changes nothing (§7.2) |
| POST | `/api/captures/:id/submit` | `uploading`/`failed` → `queued` |
| GET | `/api/captures/:id/scene?v=<ready_at>` | What the viewer loads when `ready`: the SPZ if the attempt published one, otherwise the PLY. `X-Splat-Format: spz\|ply`. Cached `private, max-age=31536000, immutable` only when `v` equals the capture's `ready_at` (a resubmit changes it, so the URL changes); otherwise `private, no-store` (§7.6) |
| GET | `/api/captures/:id/result.ply[?download]` | The PLY archive (full precision) when `ready`, read from `result_key`; `?download` adds `Content-Disposition: attachment` |
| PATCH | `/api/captures/:id` | (S7) Rename: `{ name }`, trimmed, 1–80 characters (the create rule, `validateName`), else 400 → `{ capture }`. Any state but `deleting`; `updated_at` is not changed (it is the lease clock) |
| DELETE | `/api/captures/:id` | (S7) Delete the capture, its photos and its results (§7.9). 409 while `aligning`/`training`/`exporting` hold a live lease; 200 `{ deleted: true }` when everything is gone; 202 `{ deleted: true, pending: true }` when the cron finishes a large capture (it is already hidden) |

## 3. Worker API

All routes require `Authorization: Bearer <WORKER_TOKEN>` (≥ 32 chars, compared via SHA-256 digests). After claim, every call sends `X-Job-Lease`.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/worker/claim` | Atomically claim oldest `queued` → `{ job: { id, image_count, lease, images[] } \| null }` |
| GET | `/api/worker/:id/images/:imageId` | Download a source photo |
| PATCH | `/api/worker/:id/status` | `{ status, error?, metrics? }` — heartbeat (same stage), advance one stage, or `failed`. Optional `metrics: { alignment_ratio }` (number 0–1, else 400; unknown keys ignored; a missing value keeps the stored one) |
| PUT | `/api/worker/:id/result.spz` | Optional, before `result`: SPZ, `Content-Length` 1 B–48 MB, stored under its own key in the attempt's folder and recorded on the row, but **not** published. Same lease, freshness and 409 rules as `result`; a repeat after `ready` returns 200 and changes nothing; 400 for a body that is not a complete, valid SPZ (§7.6) |
| PUT | `/api/worker/:id/result` | Gaussian PLY, `Content-Length` 1 B–90 MB, streamed to R2; completes the job and publishes the attempt's SPZ, if stored, in the same UPDATE. Idempotent: a repeat from the lease that already made the capture `ready` returns 200 and changes nothing (its upload is deleted); any other lease gets 409 |

Any job request whose lease is stale (`updated_at` older than 10 min) expires the capture and gets 409. Freshness is checked again when the write lands, not only when the request starts: the status PATCH and the result publication both carry `updated_at >= now - 10 min` in their conditional UPDATE, with `now` taken after the body has been read (§7.3). A worker that stops heartbeating while it uploads therefore loses the job (D1 / T1 worker side), even if no sweep has run yet.

`updated_at` only moves forward (`updated_at = MAX(updated_at, ?)`), so a delayed heartbeat cannot make a live job look older than it is and get it swept.

Worker behaviour: heartbeat every 25 s, kept running through the result upload; stage timeout 2 h; poll every 10 s when idle; abort the stage after 5 consecutive heartbeat failures or any 401/403/409. Since S1:

- Each stage runs in its own session/process group (`start_new_session=True`); stop, timeout or worker exit terminates the whole group (`os.killpg` SIGTERM, then SIGKILL after 10 s), so COLMAP/Brush grandchildren cannot survive. SIGTERM/SIGHUP are deferred while a stage's group is live and raised only at safe points (poll sleep, or after the group is reaped), so a signal can't orphan a stage or deadlock `Popen`'s wait lock.
- The PLY is validated in full before upload: header, vertex count × stride equals the payload length, and finite x/y/z.
- The result upload is streamed and retried with backoff (5, 15, 45, 120 s) on network errors, 429 and 5xx (the server returns 503 for transient failures). A 2xx PUT wins over a concurrent heartbeat 409. If an attempt's outcome is unknown (timeout mid-response), one confirming PUT is sent; the server's idempotent finalisation makes that safe.
- Since S5, after validation the worker converts the PLY to SPZ (`gpu-worker/spz.py`, numpy) and uploads it to `result.spz` (same backoff, but only the first two retries, since the PLY alone is still a complete delivery), then uploads the PLY to `result`. SPZ is best effort: a conversion error (including missing numpy), an SPZ over 48 MB, or any SPZ upload failure other than a lost lease (e.g. 404 from a server that predates SPZ, or a 400 rejection) is logged and the job delivers the PLY alone. Workers that predate S5 never call `result.spz` and keep working unchanged.
- If the upload finally fails, the validated PLY is moved to a recovery folder (`--recovery-dir`, default `~/.cache/spatial-camera/recovered`, newest 10 kept) and its path is logged before the temp dir is removed.

## 4. Reconstruction backends

| Backend | Align | Train | Export |
|---|---|---|---|
| `nerfstudio` (CUDA) | `ns-process-data images` (COLMAP); require ≥ max(8, 60%) frames registered | `ns-train splatfacto`, 7000 iterations | `ns-export gaussian-splat` |
| `brush` (Apple Silicon) | `mac_pipeline.py`: EXIF orientation applied, pycolmap CPU SIFT (8192 features, all cores), exhaustive matching ≤ 100 photos else sequential with exhaustive fallback (≤ 300 photos), incremental mapping, same 60% rule, gravity alignment to +Z, undistort | `brush_app`, 7000 steps, ≤ 300k splats, SH degree 2 | Brush exports PLY at final step |

Mac backend notes (S4; measured in `docs/plan/runs/2026-11-22-mac-dryrun.md` and `2026-11-22-s4-e2e.md`):

- **Frames.** Brush writes the PLY in the COLMAP world frame unchanged. COLMAP's frame is arbitrary (usually the first camera's: up = −Y), but the viewer rotates server results by −π/2 about X, which assumes Nerfstudio's Z-up. `mac_pipeline.py` therefore rotates the sparse model before undistortion so world up is +Z (D7). The rows of `cam_from_world` are the camera's right, down and forward axes. Methods, in order: (1) `camera-right`: photos are held without roll, so each camera's right axis is horizontal whatever its pitch; up is the smallest singular vector of the stacked right axes, signed to agree with the mean camera up. It needs the right axes to span a plane (cameras facing more than one way) and to lie close to it (thinnest singular value < 30% of the middle one, i.e. consistent rolls). (2) `camera-up`: the normalised mean camera up, if |mean| ≥ 0.5. This is biased by the mean pitch on paths that are not a closed orbit (about 20° for a half arc pitched 30° down), so it is only the fallback for sets where every camera faces the same way. (3) `centre-plane`: the normal of the plane through the camera centres, signed by the mean up (rolls disagree, e.g. mixed sideways shots). Otherwise the model is left unrotated and the alignment log warns. The method and tilt are recorded in `alignment.json`. On the South Building set (a near-full orbit looking up about 16°) `camera-right` and the earlier mean-up estimate differ by 1.9°.
- **EXIF orientation.** COLMAP ignores the orientation tag. Photos with orientation ≠ 1 are re-encoded upright (JPEG q95, source chroma subsampling kept) with the tag removed and other EXIF kept for the focal-length prior (including FocalLengthIn35mmFilm); upright photos are hard-linked unchanged. `images/` is cleared first. Files Pillow cannot open are skipped with a warning and counted in `alignment.json` (`skipped`). Because COLMAP groups images into cameras by image size and EXIF focal length, a mixed portrait/landscape set now produces two COLMAP cameras (expected; not yet exercised end to end with Brush).
- **Matching.** Exhaustive matching is O(n²). Up to 100 photos it is used directly (64 photos: 156 s at 8 threads). Above that, sequential matching (overlap 20, quadratic) runs in upload order, with an exhaustive retry if fewer than 90% of photos register. The retry maps into `sparse-exhaustive/`, and whichever model registered more photos is kept (`alignment.json`: `matcher`, `retry_registered`). Above 300 photos the retry is skipped, because quadratic matching would outlast the job. Threads default to `os.cpu_count()`; override with `SPATIAL_COLMAP_THREADS`.
- **Working directory.** Brush writes a Burn autotune cache to `<cwd>/target/`; `/target/` is gitignored. Running Brush with its cwd in the job's temp dir (worker.py) is deferred until after S5.
- **Setup.** `setup_mac.py` checks an existing `brush_app` against the pinned sha256 and reinstalls on mismatch, and always sets `.dev.vars` to mode 0600. A new token is written to a 0600 temp file in the same directory and moved into place with `os.replace`, so an existing 0644 file never holds it. The Brush archive is deleted on every path (including an interrupted download), and the extracted files are removed if `brush_app` fails its checksum.
- **Sleep.** macOS idle sleep suspends the worker and its heartbeat. A sleep longer than `LEASE_TTL_MS` (10 min) expires the lease. The S4 e2e first attempt failed this way after 17 min asleep mid-training. Run the worker under `caffeinate -i` (README). Proposed for worker.py: hold a sleep assertion while a job is active.
- **Signals (open, worker.py).** The preflight `import pycolmap` in `worker.py` `main()` runs after `EXIT_SIGNALS.install()`. pycolmap's glog then installs its failure handler for SIGTERM at the C level, replacing the worker's handler. A `kill`/SIGTERM to a brush worker aborts it with a glog stack trace instead of the graceful path, which stops the stage's process group and reports failure. During a job that can orphan `brush_app`. SIGINT (Ctrl-C) is unaffected. Fix: check with `importlib.util.find_spec("pycolmap")` instead of importing it, or install the signal handlers after the import.

## 5. Known defects (2026-11-16 review)

| # | Defect | Location | Severity |
|---|---|---|---|
| D1 | Heartbeat stops before result upload; a > 10 min upload expires the job and the splat is lost | `worker.py:148-151`, `api.ts:112` | High — **fixed in S1** (T1) |
| D2 | Any error deletes the temp dir; the result upload is never retried | `worker.py:106,153` | High — **fixed in S1** (retry + recovery folder) |
| D3 | All attempts write the same `result.ply` key; a stale attempt can overwrite the winner (breaks I3) | `api.ts:141` | High — **fixed in S2** (T2) |
| D4 | An image PUT that started before submit can land after claim, mutating inputs | `api.ts:182-186` | Medium — **fixed in S2** (T3) |
| D5 | Only the direct child is killed; COLMAP grandchildren survive | `worker.py:94-101` | Medium — **fixed in S1** (T4) |
| D6 | Only the PLY header is validated; truncated payloads can become `ready` | `validation.ts:29` | Medium — **fixed worker-side in S1** (T5); the server still checks header + declared size |
| D7 | Brush results rendered tilted: the PLY is in COLMAP's frame (−Y up on the dry-run set, 72° off after the viewer's −π/2) while the viewer assumes Z-up | `SplatViewer.tsx:50`, `mac_pipeline.py` | Medium — **fixed in S4** (gravity alignment to +Z in `mac_pipeline.py`; no viewer change; §4) |
| D8 | DDL + global stale-lease UPDATE run on every request, including polls | `api.ts:108-112` | Medium (perf) — **fixed in S2** (T6) |
| D9 | Worker-reported `failed` left the lease set (breaks I1); list/detail reads ran a COUNT subquery per row | `api.ts:135`, `api.ts:12` | Low — **fixed in S2** |

## 6. Target changes

- **T1 (D1, D2)** Heartbeat continues through upload; result upload retried with backoff before cleanup; finalisation idempotent (a repeated `PUT result` for an already-`ready` attempt returns 200).
- **T2 (D3)** Results written to `{id}/attempts/{lease}/result.{ply,spz}`; `captures.result_key` set in the same conditional UPDATE that marks `ready`; unpublished attempt objects garbage-collected. *Done in S2 for PLY:* the key segment is a digest of the lease, not the lease (§7.3); losing attempts delete their object immediately (best effort, no background GC yet). *SPZ done in S5* (§7.6): the attempt's `result.spz` sits beside its PLY, is published by the same UPDATE, and is deleted with it when the attempt loses.
- **T3 (D4)** Submit freezes the manifest; image PUT re-checks `status='uploading'` in a conditional UPDATE after the R2 write and deletes the object if it lost. *Done in S2*, with each upload written to a fresh key so the R2 write itself can't mutate frozen inputs (§7.2).
- **T4 (D5)** Start stage processes with `start_new_session=True`; terminate with `os.killpg`.
- **T5 (D6)** Worker validates vertex count × stride == payload length and finite values before upload.
- **T6 (D8)** DDL moves to Drizzle migrations; stale-lease sweep moves to a Cron Trigger; add indexes `images(capture_id,uploaded)`, `captures(owner,created_at)`, `captures(status,created_at)`, `captures(status,updated_at)`. *Done in S2* (migration `0001_api_integrity_hot_path`; §7.4–7.5).
- **T7** Record per-stage timestamps and alignment ratio on the capture row (PRD X2). *Done in S2 (server side)*: columns and the optional `metrics.alignment_ratio` PATCH field (§3). Sending it is worker work.
- **T1 (server half)** *Done in S2*: repeated `PUT result` from the publishing lease returns 200.

## 7. Storage and concurrency (as of S5)

### 7.1 R2 layout

| Key | Written by | Read via |
|---|---|---|
| `{id}/uploads/{imageId}/{uuid}` | Owner image PUT, a fresh key per request | `images.object_key` |
| `{id}/images/{imageId}` | Pre-S2 uploads only | Fallback when `object_key` is NULL |
| `{id}/attempts/{attempt}/result.{uuid}.ply` | Worker result PUT, a fresh key per request; `attempt` = first 32 hex chars of SHA-256(lease) | `captures.result_key` |
| `{id}/attempts/{attempt}/result.{uuid}.spz` | Worker `result.spz` PUT, a fresh key per request | `captures.spz_key`, served only when the capture is `ready` and `spz_bytes` is non-null |
| `{id}/attempts/{attempt}/result.ply`, `result.spz` | Results published before per-request keys | `result_key`; the SPZ beside it when `spz_key` is NULL and `spz_bytes` is not |
| `{id}/result.ply` | Pre-S2 results only | Fallback when `result_key` is NULL |

Leases are bearer secrets, so they never appear in object keys. No key under `attempts/` is ever written twice, so a key, once referenced by the row, names fixed bytes (C2). Unreferenced keys left by failed or superseded attempts are collected (§7.7).

### 7.2 Image upload (I5, T3)

Overwriting one shared key would itself be the mutation: a late PUT could replace bytes a worker is already reading. So:

1. Reject unless the capture is `uploading` (fast path), then validate size and signature.
2. Write the bytes to a new key `{id}/uploads/{imageId}/{uuid}`. Nothing reads this key yet.
3. In one D1 batch: `UPDATE images SET uploaded=1, object_key=? … WHERE … AND EXISTS (capture is 'uploading')`, then set `captures.uploaded_count` to a fresh indexed `COUNT(*)` of uploaded images (not `+1`), so a counter left stale by pre-S2 code corrects itself on the next upload. Submit never trusts the counter: it compares `image_count` with the same `COUNT(*)` (I2).
4. If step 3 changed no row, submit got there first: delete the new object and return 409. Otherwise delete the object this upload replaced, if any.

Submit and step 3 serialise in D1, so after submit `object_key` can't change, and the objects it points to are never written again. Re-upload is still allowed only while `uploading`. A `failed` capture keeps its inputs, and resubmitting reuses them.

### 7.3 Result publication (I3, I6, T1, T2)

1. The lease must match and the capture must be `exporting` and not stale; otherwise 409 before any write.
2. Stream the PLY to a new key `{id}/attempts/{attempt}/result.{uuid}.ply` (R2 puts are atomic, and `FixedLengthStream` rejects short bodies). Nothing reads that key until step 3 records it.
3. Take `done = now` after the upload completes, then `UPDATE captures SET status='ready', result_key=?, result_bytes=?, ready_at=done, updated_at=MAX(updated_at,done), lease=NULL … WHERE id=? AND lease=? AND status='exporting' AND updated_at >= done - 10 min`. `spz_key`/`spz_bytes` were recorded earlier by this attempt's own `result.spz` PUT (claim clears them), so the same UPDATE publishes the SPZ too. The freshness clause means an attempt whose lease expired during the upload cannot publish even if no sweep has failed it yet. The worker heartbeats throughout the upload, so a live long upload stays fresh.
4. If it changed no row: when the row is already `ready` with a `result_key` in this attempt's folder (a duplicate or late PUT from the attempt that published), delete the object just written and return 200; the published bytes are untouched. Otherwise delete everything under the attempt's folder (it can no longer publish), expire the capture if it is stale, and return 409 (the same code as any lost lease).
5. On success, collect the capture's other attempts at once (§7.7); a failure there is logged and left to the cron.

Status codes: 400 means the payload itself is invalid (bad PLY header, wrong size) and must not be retried. A broken request stream, short body or R2 write error returns **503**, which the worker retries; the row is untouched, so a retry under the same lease simply publishes. Image PUT uses the same split: a failed R2 put returns 503, and the image stays not uploaded.

A stale attempt writes only under its own `attempt` prefix, so it can't touch the published object. A repeated PUT after `ready` is recognised by comparing the folder of `result_key` with the one derived from the presented lease, so no lease needs to stay on the row (I1). Two *concurrent* PUTs from the same attempt write different keys; the conditional UPDATE lets exactly one publish, and the other is deleted as a duplicate.

### 7.4 Lease expiry (D8)

No global sweep runs per request. A capture is expired (`failed`, lease cleared, `failed_at` set) when its `updated_at` is more than 10 min old in an active state, at one of these points:
- the Cron Trigger every 5 min (`scheduled` in `worker/index.ts`, `triggers.crons` in `vite.config.ts`);
- the claim path, before it picks a job;
- lazily on read: owner detail and job requests expire just that row. The owner list runs the sweep only when a returned row is stale, so ordinary polling does no writes.

The same sweep also clears `lease` on up to 100 `failed` rows that still hold one (left by pre-S2 code, I1), using the `status` index. This replaces a data backfill. `ready` rows never kept a lease, so they are not scanned.

### 7.5 Schema and migrations (T6)

The API runs no DDL. The schema lives in `db/schema.ts`; `npm run db:generate` emits SQL into `drizzle/`, which the build packages into `dist/.openai/drizzle` for the host to apply. Locally, `node db/migrate.mjs` (run automatically as `predev`, or as `npm run db:migrate:local`) applies pending migrations to the `vinext dev` database (`.wrangler/state/v3`), recording them in `d1_migrations` (the table `wrangler d1 migrations apply` uses). Before applying a pending migration it checks whether the tables, columns and indexes it creates already exist (`sqlite_master`, `PRAGMA table_info`). If all of them do, as in a pre-migration database whose tables came from the old runtime DDL, or one where the SQL was run with `wrangler d1 execute --file`, it records the migration as applied without running it. If only some exist, it stops with a message that lists what is present and what is missing. Migration `0001_api_integrity_hot_path` adds `uploaded_count`, `result_key`, the stage timestamps, `alignment_ratio`, `images.object_key` and the four indexes.

Migrations are schema-only, as the host requires: no `UPDATE` backfills or seed data, and an added column's default is a constant. The code is correct on un-backfilled legacy rows instead: a NULL `result_key` on a `ready` row reads `{id}/result.ply` (§7.1); `uploaded_count` is recounted on every image upload (§7.2) and reported as `image_count` once past `uploading`; and the sweep clears leftover leases (§7.4). `uploaded_count` is maintained on upload, so list and detail reads need no per-row COUNT. Migration `0002_spz_result` (S5) adds the nullable `captures.spz_bytes`; existing rows read NULL, meaning "PLY only", which is exactly what they are. Migration `0003_attempt_keys_gc` (S5 review) adds the nullable `captures.spz_key` (NULL on older rows, which then read the SPZ beside their PLY, §7.1), `gc_pending` (integer, default 0) and the index `captures_gc_pending_idx (gc_pending, updated_at)`. Rows that predate it are never marked, so their leftover attempts, if any, stay until a later claim of the same capture.

### 7.6 SPZ delivery (S5, ADR-0007)

**Format.** The worker writes the gzip "legacy" SPZ container that Spark and Niantic's reference library read, version 3 by default (v2 supported). It starts with a 16-byte little-endian header `<IIIBBBB>`: magic `NGSP` (0x5053474e), version, point count, SH degree, fractional bits, flags (0), reserved (0). Then come the attribute streams: 24-bit fixed-point positions (12 fractional bits, fewer for scenes too large to fit), 8-bit opacity, 8-bit colour (scale 0.15), 8-bit log scale (stored range −10…5.94), rotation (v3 smallest-three in 32 bits: a 2-bit index plus three signed 9-bit components; v2 three bytes, w rebuilt) and SH coefficients (degree 1 keeps 5 bits, higher degrees 4). Quantisation follows the reference encoder (`packGaussians`). On the S4 Brush scene the SPZ is 7.1× smaller than the PLY (35.5 MB → 5.0 MB; [run log](../plan/runs/2026-11-22-s5-spz-size.md)).

**Frame.** The SPZ keeps the PLY's own coordinate frame; positions and rotations are copied, not converted. The SPZ specification defines its axes as RUB and the reference tools convert from PLY's RDF on save, but this encoder deliberately does not. The viewer applies one orientation to every captured result regardless of format, so a scene must have identical axes as PLY and as SPZ. Whether that orientation is right for Brush results is D7, which owns any frame change; if D7 adopts RUB, the conversion and the viewer rotation must change together.

**Server validation.** `result.spz` is checked in two passes. Before anything is stored: a gzip signature, then the first 16 KB are inflated to read the header. Version must be 2–3, points 1–10,000,000, SH degree ≤ 3, fractional bits ≤ 23, reserved 0, and no flag other than antialiasing (0x1; 0x2 would announce unvetted extensions). The declared `Content-Length` must also be plausible for the header's decompressed size, which is fixed by the point count and SH degree (at most 1032:1 gzip expansion, and no bigger than the raw payload plus 1%). Then, while the body streams to R2, the whole upload is inflated as it passes through (C1): it must decompress to **exactly** the size the header implies. A truncated stream, a bad CRC or length trailer, bytes after the gzip member, or a stream that decompresses to more or less than that size is rejected with 400 and the object is deleted, so nothing referenced is ever an SPZ Spark cannot read in full. Decompressed bytes are counted and dropped, never held, and counting stops past the expected size, so a zip bomb costs no memory. The server does not decode splats beyond that; the worker validates the PLY in full before converting it (S1, T5).

**Publication.** `result.spz` is stored under a fresh key in the attempt's folder, then recorded with `UPDATE captures SET spz_key=?, spz_bytes=? WHERE id=? AND lease=? AND status='exporting' AND updated_at >= now - 10 min`, batched with a read of the `spz_key` it replaces (a retry of the same attempt), which is then deleted. Because the UPDATE requires `exporting`, nothing can change `spz_key` once the capture is `ready`: **the published SPZ is immutable** (C2). A late or duplicate `result.spz` PUT from the publishing lease returns 200 and its own new object is deleted; from any other lease, or after the lease lapsed, the attempt's folder is deleted and 409 is returned. The PLY `result` PUT publishes both formats in its one conditional UPDATE (§7.3), so a capture is never `ready` with the PLY of one attempt and the SPZ of another, and an SPZ never becomes visible without its PLY archive.

**Serving.** `GET /scene` returns the SPZ when `spz_bytes` is non-null, otherwise the PLY (pre-S5 results and PLY-only deliveries), with `Content-Type: application/x-spz` or `application/octet-stream` and the bytes as stored (an SPZ's gzip is its own container, not a `Content-Encoding`). Spark identifies the format from the content, so the extension-less URL works for both. The `v=<ready_at>` cache key makes the response immutable for its URL: a resubmitted capture gets a new `ready_at`, and a request without the matching `v` is `no-store`. The PLY stays at `result.ply` as the full-precision archive and download.

**Viewer.** `SplatViewer` fetches the scene on the main thread (`lib/scene.ts`, `openScene`) with an `AbortController` that the effect's cleanup aborts, so leaving the page or switching scenes stops the download. The body is handed to Spark as `new SplatMesh({ stream, streamLength, fileName })`; `fileName` (`scene.spz` or `scene.ply`, from the `X-Splat-Format` header or the URL) tells Spark's decoder the format. Progress counts the bytes as they pass through that stream: real bytes and, when `Content-Length` is present and the body is not content-encoded, the total, with no estimated or fake progress (ADR-0005). A stream that breaks, ends short or is aborted is closed cleanly (an erroring stream would hang Spark's worker) and recorded as a download failure, which the viewer reports as such, with a "Reload scene" button, never as a bad file and never as a partial scene. Screen readers hear a static loading line or 25% steps, not every byte update; the canvas is `role="img"`.

**PLY fallback.** When a `ready` capture has an SPZ, the viewer is also given `result.ply`. If the SPZ downloads in full but Spark cannot decode it, the viewer discards that mesh, says "The compact SPZ could not be decoded, so the full PLY is loading instead (a larger download)", loads the PLY once, and notes under the scene that the PLY is shown. If the PLY fails too, or there is no PLY to fall back to, it reports that the scene could not be decoded. The decision is `sceneOutcome` in `lib/scene.ts`.

**Context loss.** One WebGL renderer, Spark renderer, camera and controls live for the component's lifetime. A scene change disposes only the old `SplatMesh`, and unmount disposes the renderer and releases its context. On `webglcontextlost` the viewer calls `preventDefault` (so the browser may restore the context), stops rendering and shows a recoverable error with a "Reload scene" button. Either that button or `webglcontextrestored` bumps a generation counter that rebuilds the whole engine and reloads the scene; GPU state from before the loss is never reused.

### 7.7 Attempt garbage collection (C3)

Per-request keys (§7.1) mean an attempt that dies between its SPZ and its PLY, a superseded attempt after a resubmit, or a duplicate PUT that lost can leave objects nothing references. They are collected, not just tolerated:

- **Marking.** Every claim sets `captures.gc_pending = 1` in the same UPDATE that hands out the lease, so any capture that ever had an attempt is marked. The column is 0 when clean, otherwise 1 plus the number of failed collections (it stays truthy wherever it is read as a flag).
- **When.** A successful `result` PUT collects its own capture immediately after publishing (§7.3 step 5). The 5-minute Cron Trigger (`handleScheduled`) runs the lease sweep and then `collectAttemptGarbage`, which takes up to 10 marked captures in a terminal state (`ready` or `failed`) ordered by `gc_pending, updated_at` (those that never failed first, then oldest), using `captures_gc_pending_idx`. Captures still in flight are not touched.
- **Budget.** Every D1 query and R2 call counts against a subrequest budget per run, shared across captures: 40 for the cron, less what that run's deletions used (Workers Free allows 50 per invocation; the sweep uses 1; §7.9) and 12 for the collection inline after a publish, which has already used about 8. A capture is started only with at least 5 left (its row read, a list, a delete, the mark update, one to record a failure), and another page is listed only with at least 4 left. When the budget runs out part-way, the capture keeps its mark and the next cron tick carries on where the listing left off, since what was deleted is gone.
- **What.** Everything under `{id}/attempts/` is deleted except, for a `ready` capture, the published `result_key` and SPZ. For a `failed` capture, objects uploaded after its `updated_at` are kept, because the owner may have resubmitted and a new attempt may be uploading; that attempt's own checks (§7.3 step 4) or a later collection remove them. R2 is listed 100 keys per page, at most 5 pages per capture per run.
- **Clearing the mark.** Only when the listing is exhausted, with `UPDATE captures SET gc_pending=0 WHERE id=? AND status=? AND updated_at=?`. If the row changed meanwhile (resubmitted, claimed again), the mark stays and a later run looks again. A capture with more than 500 leftover keys keeps its mark and is finished over several runs.
- **Errors** are logged per capture and never fail the publish or the cron. A collection that throws (R2 or D1 unavailable) records `gc_pending = gc_pending + 1`, so the capture sinks behind the others instead of filling every batch. After 5 failures (`gc_pending` reaches 6) it is no longer selected, a "gave up" line names its `attempts/` prefix for manual cleanup, and its mark stays truthy. A new claim resets it to 1; a successful collection clears it to 0.

Image uploads (§7.2) are not covered here: they replace their predecessor in the same request, and a 409 after submit deletes its own object.

### 7.8 Platform limits and the 0003 deploy

- Full SPZ inflation on upload (§7.6) and attempt collection assume Workers Paid CPU and subrequest limits: inflating a multi-megabyte SPZ can exceed Workers Free's 10 ms of CPU, and the budgets above fit in 50 subrequests with little to spare. Drain the job queue before deploying migration 0003: a capture that was `exporting` with a legacy fixed `attempts/{attempt}/result.spz` when 0003 ships publishes its PLY only, and that `.spz` is orphaned, since its claim predates `gc_pending` and nothing marks the capture for collection.

### 7.9 Capture deletion and retention (S7, PRD R5.3)

Captures are kept until their owner deletes them; nothing expires on its own. No migration: `deleting` is a new value of the free-text `captures.status`.

**Request.** `DELETE /api/captures/:id`, after the usual owner lookup (which expires a stale lease, §7.4), runs one conditional UPDATE: `SET status='deleting', lease=NULL, gc_pending=0, updated_at=now WHERE id=? AND owner=? AND status IN ('uploading','queued','ready','failed')`. If it changes no row, a capture that is `aligning`/`training`/`exporting` gets 409 and anything else 404. The request then purges inline within a budget of 30 subrequests (it has made at most 4 before); if that finishes it returns 200, otherwise (or if R2/D1 fails) 202, and the cron finishes it.

**Purge** (`purgeCapture`). Repeatedly list `{id}/` with `limit: 1000` and no cursor (what was deleted is gone, so each listing starts at what is left), deleting each page in one call (R2 takes ≤ 1000 keys). When a listing is not truncated, one D1 batch runs `DELETE FROM images WHERE capture_id=? AND EXISTS (capture is 'deleting')` and `DELETE FROM captures WHERE id=? AND status='deleting'`, rows last. A page needs a list and a delete and the final batch one more, so a pass starts only with ≥ 3 calls left. The prefix covers every layout in §7.1, including pre-S2 images and results.

**Cron** (`purgeDeletedCaptures`). Each 5-minute run purges first: up to 5 `deleting` captures, oldest `updated_at` first, within 20 subrequests (1 for the query). Attempt collection (§7.7) gets the rest of the run's 40. A purge that throws is logged and its `updated_at` moved to now, so it goes behind the others. A capture with more objects than one run can delete (about 9,000 at 1000 per page) takes several runs and stays `deleting`, hidden, meanwhile. The 30 inline calls cover about 14,000 objects; a full capture (200 photos plus a few attempts) needs 3.

**Why it is race-free.** Every writer stores its object first and then commits with a conditional UPDATE that `deleting` (or a missing row) fails, and a writer whose UPDATE fails deletes what it stored:
- *Image PUT* (§7.2): `deleting` is not `uploading`, so the batch marks nothing and the new object is deleted (409). After the rows are gone, the image lookup or the UPDATE fails the same way.
- *Worker `result`/`result.spz` PUT and heartbeat*: a `deleting` row is not in an active state, so the job route answers 409 and deletes the attempt's folder before storing anything. A PUT that passed its checks before the flip stores its object, then its conditional UPDATE (lease, `exporting`, freshness) fails, and `unpublished` deletes the attempt's folder (§7.3 step 4). Once the rows are gone, the job lookup finds nothing, no attempt folder is derived, and nothing is stored.
- *Claim vs delete*: a claim moves only `queued` rows and the delete only lease-free states, and both are single conditional UPDATEs, so D1 serialises them: a claimed capture can't be deleted (409), and a deleted one is never claimed.
- *Owner routes*: every owner lookup filters `status != 'deleting'`, so submit, rename, uploads and reads see 404; the list hides it.

So any object that exists when the purge's final listing runs either belongs to a write that committed before the flip (and is listed and deleted) or will be deleted by its own writer. The rows go only after that empty listing (I7). The residual risk is the one §7.2/§7.3 already carry: a writer's own cleanup delete can fail (R2 unavailable), orphaning one object, which is logged with its key.

**Rename** is `UPDATE captures SET name=? WHERE id=? AND owner=? AND status!='deleting' RETURNING …`; it is not progress, so `updated_at` is unchanged and polling picks it up through the name in `pollSignature`.

**UI.** Each library row has rename and delete buttons (`aria-label` naming the capture). While the capture is processed (`aligning`/`training`/`exporting`), or this tab is uploading it, they are `aria-disabled` and say "Available once processing finishes" (or "…the upload finishes"); they stay focusable so the reason is announced. Rename opens a modal dialog with a labelled input (Enter saves, Esc cancels); delete opens a confirmation that names the capture and says it cannot be undone, with Cancel focused. Focus returns to the triggering button, or to the list heading after a delete; outcomes are announced in a polite status region.

## 8. Client-side preparation (S6, R1.3, R1.6)

Everything here runs in the browser before upload. The server contract is unchanged: it accepts JPG/PNG only (§7.2).

### 8.1 HEIC/HEIF → JPEG

1. **Detection** (`lib/capture-prep/heic.ts`): by extension (`.heic`, `.heif`, `.hif`) or MIME type (`image/heic`, `image/heif` and the `-sequence` forms). iPhone files often arrive with an empty `type`; when neither the name nor the type decides, the first 64 bytes are sniffed for an ISO-BMFF `ftyp` box with a HEVC brand (`heic`, `heix`, `heim`, `heis`, `hevc`, `hevx`, …). The generic `mif1`/`msf1` brands count only when a HEVC brand is also listed, so AVIF is not treated as HEIC.
2. **Size check** (`dimensions.ts`): before any decode the worker reads the first 256 KB and takes the largest `ispe` box. Photos over `MAX_DECODE_PIXELS` (50 MP; a 48 MP iPhone photo fits) are refused with their size in the message, so the worker never allocates their pixels. `decodeHeif` repeats the check on libheif's reported size before it allocates the RGBA buffer. When the header has no `ispe` and the browser decodes the file natively, the bitmap's size is checked too (`withinDecodeLimit`): an oversized bitmap is closed and refused rather than drawn to a canvas.
3. **Decode** (`heic.worker.ts`, a module worker; pool of `min(2, cores − 1)`, 60 s watchdog per photo): native `createImageBitmap(file)` first (Safari decodes HEIC itself). If that fails, the worker lazily `import()`s `libheif-loader.ts`, which loads **libheif-js 1.23.5** (libheif 1.23.5 and libde265 1.0.15 compiled to WebAssembly, **LGPL-3.0**). The build emits two files, fetched only when the first HEIC needs them: `assets/libheif-loader-<hash>.js` (~90 KB, the Emscripten glue with its `/*! @license` banner kept) and `assets/libheif-<hash>.wasm` (~1.4 MB), which the loader fetches by URL and passes in as `wasmBinary`. Neither the main bundle nor Studio contains them. The `.wasm` file is the library itself and can be swapped without touching our code; `public/third-party-notices.txt` (linked from the page footer as "Open-source notices") carries the attribution, exact source links, the licence text and replacement steps. libheif applies the `irot`/`imir`/`clap` transforms, so the decoded pixels are already upright, and the JPEG carries no orientation tag.
4. **Encode**: `OffscreenCanvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })` on a white background. If the result exceeds `MAX_IMAGE_BYTES` (20 MB), `nextEncodeAttempt` steps through quality 0.85 → 0.75 → 0.65, then downscales by `min(0.9, √(limit / bytes) × 0.95)` per step. Below 25 % of the original size it gives up with a message. **Name**: the original extension is kept before `.jpg` (`IMG_0001.HEIC` → `IMG_0001.heic.jpg`), so a converted photo never takes the name of a real `IMG_0001.jpg` in the same set. If a *different* photo (other size) already has that name in the selection or the batch, ` (2)`, ` (3)`, … is added (`convertedNames`). The name is deterministic, so adding the same HEIC again is still dropped by Studio's name + size check, and the upload/resume matcher (name, size) finds exactly one file per manifest row. The server does not reject duplicate names within a capture (`validateManifest` has no such check): each image is stored under its own id (`{captureId}/uploads/{imageId}/{nonce}` in R2), and the GPU worker names frames by index, so a clash never overwrites data. It only made the rows ambiguous to people and to the resume prompt.
5. **UI**: one status per file (`queued → loading decoder → decoding → encoding → done/failed/cancelled`), a progress bar, a **Cancel conversion** button, and a note while the decoder downloads. A failure lists the file with a specific action, for example "This HEIC file could not be read; it may be damaged or use an unsupported variant. Export it as JPEG instead (iPhone: Settings › Camera › Formats › Most Compatible …)". A failed file is left out; the others continue. The pool tells apart a worker that failed to load ("the converter could not be downloaded") from one that crashed mid-photo (usually out of memory); either fails only that photo, and a crashed worker is discarded rather than reused. Only as many HEICs as there are free slots under the 200-photo limit are converted; the rest are reported as skipped. A slot is used only by a HEIC that will actually be added (`heicOverLimit`): a repeat of a HEIC earlier in the same add, or one whose converted copy is already selected, takes none. Converted files are cached by the *source* key (name, size and mtime of the HEIC) and store the final, renamed JPEG, so re-picking the same folder does not re-decode. A `WeakMap` links each converted file back to its source; after every selection change the cache keeps only sources whose JPEG is still selected or whose conversion is still running, so the entry goes when the photo leaves the selection.
6. **Lifecycle** (`components/useCapturePrep.ts`): one add at a time. The dropzone and the upload button stay disabled from the drop until conversion *and* validation finish; Studio re-reads the live selection after every await, so a Clear, a thumbnail removal or an upload in the meantime is never undone. Clear, removing a photo and leaving the page abort the queued and running worker jobs for it, and results that arrive afterwards are ignored. Studio checks the add's abort signal again after its validation loop (and on the error path), so a Clear during validation brings back neither photos nor a stale error. While an add runs, a window-level guard (`components/useDropGuard.ts`) cancels the browser's default for file drops anywhere on the page, so a drop cannot navigate the tab away; it shows "Wait for the photos being added to finish." `WorkerPool.run` never rejects: every outcome, including a timeout, a crash or a cancellation, resolves to a typed result.

Not preserved: EXIF (camera model, focal length, GPS) is not copied into the converted JPEG. COLMAP falls back to its default focal-length prior, as it does for any photo without EXIF.

Known limitation, colour: there is no colour management on the libheif path. iPhone HEICs are Display P3 (an nclx and/or ICC `colr` box); libheif's RGB values are drawn to an sRGB canvas and the JPEG carries no ICC profile, so converted photos look slightly desaturated next to Safari's native decode (which is colour-managed). This does not affect geometry: alignment and training use the pixel structure, not absolute colour, and only the splat's colours come out a little duller. libheif-js 1.23.5 has no JS wrapper for the profile; `heif-decode.ts` notes where it would be read and `heic.worker.ts` where it would be applied.

libheif-js internals: `decodeHeif` frees the native context through `decoder.decoder` and `heif_context_free`, which are not public API. The dependency is pinned to exactly 1.23.5, and a test fails if an upgrade removes or retypes them.

### 8.2 Warn-only checks

`lib/capture-prep/analysis.worker.ts` (pool of `min(4, cores − 1)`, idle workers terminated after 20 s) measures each selected photo: the upright size is read from the JPEG/PNG header (SOF + EXIF orientation, or IHDR), then `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality: "high" })` decodes straight to ≤512 px, so a 48 MP photo never becomes a ~190 MB bitmap (a full decode plus a canvas downscale is the fallback when the header is unreadable) → `OffscreenCanvas` on a white background → Rec. 601 grayscale → the pure functions in `lib/capture-prep/metrics.ts`. In Chromium the resized decode is pixel-identical to the previous full decode plus "high" canvas downscale, so the calibration below still holds. Results are batched into React state every 120 ms. Nothing is blocked: the user can remove the flagged photos, or upload anyway. Removal always asks first: it lists how many photos and which ones, with **Remove** and **Keep them** buttons. The confirmation is a focusable group named by its question and takes focus when it opens. **Keep them** or Escape closes it and returns focus to the button that opened it; **Remove** moves focus to the "Photo checks" heading. The open confirmation follows the selection (`standingConfirmation` in `lib/capture-prep/confirm.ts`): photos removed elsewhere drop out of its list, and it closes when none remain, when the checks rerun, or when the panel is disabled; if focus was inside it, focus goes to the heading.

| Check | Metric | Rule | Constant |
|---|---|---|---|
| Blurry or low detail | Variance of the 4-neighbour Laplacian on the ≤512 px grayscale copy | `< 50`, or `< 0.3 ×` the selection median when ≥ 8 photos are measured | `BLUR_VARIANCE_MIN`, `BLUR_RELATIVE_FRACTION`, `BLUR_RELATIVE_MIN_PHOTOS` |
| Near-duplicates | 64-bit dHash (9×8 area-average, horizontal gradient) | Hamming ≤ 6 between *every* pair in a group (greedy complete linkage, in selection order), so a slow pan of distinct photos that differ by ≤ 6 bits from one to the next is not chained into one big group. The sharpest photo of each group is kept; the others count as extra copies (`PrepReport.extraCopies`) | `NEAR_DUPLICATE_MAX_DISTANCE` |
| Too few | Photos minus blurry minus extra copies | `< 30` usable (shown once the 12-photo minimum is met) | `RECOMMENDED_MIN_PHOTOS` |

**Calibration** (headless Chromium, the same browser path):

- Blur score on COLMAP "south-building", 64 photos at 3072×2304:
  - Sharp: 688–2602 (median 1390).
  - With a full-resolution Gaussian blur of σ = 1: 608–1671. σ = 2: 355–988. σ = 4: 97–274. σ = 8: 13–34.
  - Relative to the set median: sharp 0.50–1.87×, σ = 2 0.26–0.71×, σ = 4 0.07–0.20×.
  - Sharp but featureless photos (macOS desert wallpapers) score 24–63, so the absolute floor sits just above the σ = 8 band. The warning therefore reads "low detail or blurry".
  - With these rules the 64 sharp photos produce no warnings. In a 176-photo mix of sharp, blurred, re-encoded and shifted copies, exactly the 32 copies with σ ≥ 4 were flagged. The σ ≤ 2 copies were not: at 512 px a 2 px blur is under a pixel, so it does little harm to alignment either.
- dHash Hamming distance:
  - Half-size re-encode at JPEG quality 60: 0–2 bits.
  - 1 % shift or zoom (hand-shake burst): 0–6. 3 %: 3–12.
  - Consecutive frames of the real walk-around: 12–43 (median 25). The closest of all 2016 distinct pairs is 11.
- Cost:
  - Median ~42 ms per 12 MP photo per worker.
  - 176 photos checked in ~2.6 s with 4 workers, and no main-thread task over 100 ms during the checks.
- The unit tests (`tests/capture-prep.test.mjs`) repeat the separation on a deterministic synthetic scene: sharp 1834, σ = 1 at 512 px 59, σ = 2 7.6.

Not checked: overlap between non-duplicate photos (whether every photo shares features with a neighbour). That needs feature matching, so R1.6 stays partial.

Accessibility: warnings are text that starts "Warning:"; the icons are decorative (`aria-hidden`). A visually hidden `role="status" aria-live="polite"` region announces conversion and check summaries once each, including the names of up to three photos that could not be added and why, and a confirmation after a removal. Link and note colours meet WCAG AA on the panel background (links #a63e1f, 6.0:1; notes #666a5e, 5.3:1; footer links #666a5e, 5.2:1).
