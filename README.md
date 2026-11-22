# Spatial Camera

A web-first photo-to-Gaussian-splat prototype. Capture photos are stored on the server; a separate GPU worker reconstructs the scene. The browser renders the returned splat using Spark and Three.js.

## What works

- JPG/PNG validation, previews, duplicate selection filtering, and upload progress. Photos upload four at a time, and a failed photo is retried on network errors and 5xx before the upload stops.
- HEIC/HEIF photos (the iPhone default) are converted to JPEG in the browser before upload. See "Capture preparation" below.
- Warn-only checks before upload: blurry or low-detail photos, near-duplicates, and fewer than 30 usable photos.
- Persistent capture manifests in D1, image/result storage in R2, and owner-scoped APIs.
- Resumable uploads: reselect the original files from an incomplete capture.
- Rename and delete captures from the library (S7). Delete asks for confirmation, removes the photos, results and records for good, and is refused while a GPU worker holds the capture. Captures are kept until deleted. A very large capture disappears at once and its files are removed by the 5-minute cron; a hidden tombstone record stays for an hour so that late uploads are still refused, then the cron removes it. The cron also sweeps up files left under a capture that no longer exists (see [spec §7.10](docs/specs/capture-pipeline.md)).
- A durable job queue with atomic claims, worker leases, real stage reporting, and stale-job recovery.
- Interactive splat viewing, orbit/pan/zoom, rotation, reset, and fullscreen. Finished captures stream as compressed SPZ (about 7× smaller than the PLY) with real download progress, and the full-precision PLY stays available as a download. One WebGL context is reused across scenes.
- Status polling backs off from 2 s to 20 s while nothing changes, resets on any change or action, and stops once no capture is processing.
- Read-only share links and embeds for finished captures (S8). See "Sharing" below.
- Local PLY/SPZ/SPLAT/KSPLAT viewing without uploading the file.
- A separately attributed Spark sample scene. The sample is not a reconstruction of uploaded photos.

Reconstruction needs an external CUDA GPU worker. Without one, uploads stay queued. There is no fake progress, generated replacement scene, or automatic paid GPU provisioning.

## Capture preparation

Photos are prepared in the browser, in Web Workers, as soon as they are added. The server still accepts only JPG/PNG.

- **HEIC/HEIF** files are recognised by extension, MIME type or file signature, then converted to JPEG at quality 0.92 with the correct orientation.
  - Safari decodes them natively.
  - Other browsers download a WASM decoder the first time: [libheif-js](https://github.com/catdad-experiments/libheif-js) 1.23.5 (libheif + libde265, LGPL-3.0). It is two separate files fetched only when needed, a ~90 KB loader and a ~1.4 MB `.wasm`; the `.wasm` can be replaced without rebuilding our code. Attribution, source links, the licence text and replacement steps are in [`public/third-party-notices.txt`](public/third-party-notices.txt), linked from the page footer.
  - Photos over 50 MP are refused from the file header before decoding, with a message giving their size. A conversion that hangs is stopped after 60 s, and the user can cancel the remaining conversions.
  - A photo that would exceed 20 MB is re-encoded at lower quality, then a smaller size.
  - Each file shows its status. A file that fails shows the reason and what to do; the other files continue.
  - EXIF metadata is not copied into the converted JPEG.
- **Checks** only warn; they never block an upload.
  - Blur uses the variance of the Laplacian on a 512 px grayscale copy.
  - Near-duplicates use a 64-bit difference hash; every photo in a group is within Hamming distance 6 of every other (no chaining).
  - Count guidance appears when fewer than 30 usable photos remain.
  - The low-detail or blurry photos, or the extra copies, can be removed in bulk after a confirmation that lists them.
- Thresholds and how they were calibrated are in [docs/specs/capture-pipeline.md §8](docs/specs/capture-pipeline.md).
- The code is in `lib/capture-prep/`, `components/useCapturePrep.ts` and `components/PrepWarnings.tsx`.

## Sharing

Open **Share** under a finished capture to create a read-only link (ADR-0010, spec [§7.9](docs/specs/capture-pipeline.md)).

- Anyone with the link can view the scene at `/s/<token>`, without signing in. `/s/<token>/embed` is the viewer alone, for an `<iframe>` on any site; the panel gives you the snippet.
- The link is shown **once**. Only a hash of it is stored, so copy it when it is created; if it is lost, create another and revoke the old one.
- Viewers get the compact SPZ (or the PLY if the capture has no SPZ). The full PLY download is off unless you tick "Allow PLY download" for that link. Photos are never shared.
- Each link shows its page views. Revoking a link stops it on the next request, cached scene bytes included. A scene someone already has open stays on their screen until they reload.
- Reprocessing a capture pauses its links (404) until it is `ready` again; then they show the new result. Revoke them first if you do not want that.
- Up to 20 active links per capture. Public routes are rate-limited per IP (best effort, per isolate; `SHARE_RATE_LIMIT`, default 120 per minute). A request without `CF-Connecting-IP` is not limited (logged once per isolate), so one header-less client cannot lock out the others.

Deploy notes for sharing:

- The hosting gateway must let anonymous requests reach `/s/*` **only**. `/api/*` and the owner pages stay behind sign-in.
- The gateway must strip or overwrite `oai-authenticated-user-email` on every request, anonymous `/s/*` requests included, so no visitor can send their own.
- The gateway must forward the real client IP as `CF-Connecting-IP`. If it sends its own address, all visitors share one rate-limit budget.
- The built-in limiter is per isolate. For production, add a Workers Rate Limiting binding or a WAF rate-limiting rule on `/s/*`.

## Local development

Node 22.13+ required (Node 24 recommended).

```sh
npm install
npm run dev -- --host 127.0.0.1 --port 3000   # predev applies pending drizzle/ migrations to the local D1 first
```

The Cloudflare development environment persists D1/R2 data under `.wrangler/`. `.dev.vars` supplies Worker bindings locally; `.env.example` documents the same keys. For a fresh checkout create `.dev.vars` with `LOCAL_DEV="true"` and optionally `WORKER_TOKEN="your-strong-random-token"`. The checked-in example token is empty. Never set LOCAL_DEV on a hosted site. Hosted requests require the trusted Sites `oai-authenticated-user-email` header.

```sh
npm run typecheck
npm run db:generate
npm run build
npm test
```

API integration tests run in an isolated, temporary Miniflare environment. `npm test` also round-trips the worker's SPZ encoder through Spark's decoder; that test needs `python3` with numpy and is skipped without it. Browser tests use `npx playwright test` and automatically start the development server; use `PLAYWRIGHT_CHANNEL=chrome npx playwright test` for an installed Chrome browser. The canonical desktop preview is saved to `public/screenshot.jpeg`, and additional test screenshots go to the ignored test-results directory.

## GPU worker

Use a Linux NVIDIA GPU host with a compatible CUDA/PyTorch environment, Nerfstudio, COLMAP, and FFmpeg. Follow [Nerfstudio installation](https://docs.nerf.studio/quickstart/installation.html). Splatfacto's documentation estimates roughly 6 GB GPU memory for its default model; actual requirements depend on the capture. This repository does not install or rent GPU infrastructure.

Set the same random WORKER_TOKEN (at least 32 characters) in the web app runtime and GPU host environment. Start the runner:

```sh
export SPATIAL_URL=https://your-deployed-site
# Supply WORKER_TOKEN securely through your environment.
python3 gpu-worker/worker.py --iterations 7000
```

The runner claims one job at a time, downloads photos, runs `ns-process-data images`, checks registration coverage, trains `ns-train splatfacto`, exports `ns-export gaussian-splat`, converts the PLY to SPZ (`gpu-worker/spz.py`, needs numpy), and uploads the SPZ and then the PLY. If SPZ conversion or upload fails, the PLY alone is delivered and the viewer loads it instead. After alignment, both backends send `metrics: { alignment_ratio }` on the transition to training: registered photos divided by all input photos (including unreadable inputs). It sends a heartbeat every 25 seconds. Stages time out after two hours. Jobs with no heartbeat for ten minutes become retryable failures. The heartbeat keeps running through the result upload, which is validated, streamed and retried with backoff. If the upload still fails, the PLY is kept in a recovery folder (`--recovery-dir`, newest 10) instead of being deleted. Each stage runs in its own process group, so stopping the worker (Ctrl-C, SIGTERM, SIGHUP) or a stage timeout also stops COLMAP/Brush child processes. Temporary inputs and checkpoints are removed when the job ends; original photos and successful PLYs remain in R2. Worker tests: `python3 -m unittest discover -s gpu-worker/tests`.

### Apple Silicon (local)

On an Apple Silicon Mac (Python 3.10+), the `brush` backend replaces Nerfstudio with CPU COLMAP (pycolmap) and the Metal-based Brush trainer. Nothing leaves the machine.

```sh
npm run setup:mac             # .local/venv (pycolmap, Pillow), pinned Brush v0.3.0, WORKER_TOKEN in .dev.vars
npm run dev -- --port 3000    # terminal 1: migrates the local D1, then serves the app
npm run worker:mac           # terminal 2: claims captures; keeps the Mac awake during each job
```

Setup verifies the Brush download and an existing `.local/bin/brush_app` against pinned SHA-256 checksums, and reinstalls on mismatch. It keeps `.dev.vars` at mode 0600. Alignment (`gpu-worker/mac_pipeline.py`) applies EXIF orientation, skips files it cannot read, matches exhaustively up to 100 photos (sequentially above that, retrying exhaustively below 90% registration for sets of up to 300 photos), and rotates the model so up is +Z for the viewer. COLMAP uses every core; set `SPATIAL_COLMAP_THREADS` to limit it. On an idle M1 Pro (16 GB), 64 photos take about 6 minutes to align and 17 minutes to train 7000 steps; a busy machine can take several times longer (see `docs/plan/runs/`). The worker automatically holds `caffeinate -i -w <worker pid>` throughout each job, including downloads and uploads, and terminates/reaps it when the job ends or the worker stops. This replaces the manual `caffeinate -i` wrapper; idle workers may sleep. If caffeinate cannot start, the worker logs once and continues. Forced sleep can still suspend heartbeats: more than 10 minutes asleep expires the lease. Brush runs in the job’s temporary directory, so its `target/` autotune cache is removed with the job. The startup pycolmap availability check does not import it; only the alignment subprocess imports pycolmap, preserving the worker’s signal handlers.

Private hosting may require gateway authentication in addition to the worker token. Configure your host's supported service access; optional JSON `SPATIAL_GATEWAY_HEADERS` are added to worker requests. A worker token does **not** bypass Sites sign-in. Do not make the site public to work around this. A Linux GPU and a working authenticated connection are required to validate actual reconstruction end to end.

### Worker contract

All endpoints require `Authorization: Bearer <WORKER_TOKEN>`. After claiming, send the returned `X-Job-Lease` on every job request.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/worker/claim` | Atomically claim the oldest queued capture; returns job or null |
| GET | `/api/worker/:id/images/:imageId` | Download a source photo |
| PATCH | `/api/worker/:id/status` | Heartbeat/stage: aligning → training → exporting, or failed. Optional `metrics: { alignment_ratio }` (0–1) |
| PUT | `/api/worker/:id/result.spz` | Optional, before `result`: upload the SPZ conversion. Stored with the attempt, published by the PLY PUT |
| PUT | `/api/worker/:id/result` | Upload a Gaussian PLY; completes the job (and publishes the attempt's SPZ). Safe to retry: a repeat from the lease that completed the job returns 200 |

Each attempt's results are stored under their own keys and published atomically, so a stale attempt can't overwrite a finished scene. Photos can't change after submit. Stale leases are expired by a Cron Trigger every 5 minutes, by the claim path, and when the capture is read. Details are in [the capture pipeline spec](docs/specs/capture-pipeline.md) §7.

The prototype limits captures to 12–200 photos, 20 MB per image, 1 GB total, 90 MB per returned PLY, and 48 MB per SPZ. JPEG/PNG signatures are checked on upload and decoding is checked in the browser; deeper image validation happens in the reconstruction tools. GPU jobs should run in an isolated environment. Large datasets, video extraction, progressive level-of-detail loading (ADR-0007), and camera metadata ingestion are future work.

## Hosting and architecture

The Sites vinext starter produces a Cloudflare Worker. `.openai/hosting.json` declares DB (D1) and BUCKET (R2). `worker/api.ts` handles capture and worker routes; the remainder goes through vinext. The schema comes only from the Drizzle migrations in `drizzle/` (edit `db/schema.ts`, then `npm run db:generate`). The build packages them for the host, and the API never runs DDL. Locally, `npm run dev` applies them first through its `predev` hook (idempotent, and it creates `.wrangler/` on a fresh checkout); `npm run db:migrate:local` runs the same step by itself. The Worker also exports a `scheduled` handler for the 5-minute Cron Trigger (stale leases, finishing capture deletions, then attempt garbage collection), configured in `vite.config.ts`.

Cloudflare hosts the web app, metadata, and files; Gaussian-splat training runs on the separate CUDA host. Browser requests cannot choose worker commands or file paths. User-facing responses never include worker tokens or leases.

Sources: [Spark](https://sparkjs.dev/docs/), [Splatfacto](https://docs.nerf.studio/nerfology/methods/splat.html). The remotely loaded butterfly is Spark's documented viewer sample.
