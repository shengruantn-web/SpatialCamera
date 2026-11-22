# Spatial Camera

A web-first photo-to-Gaussian-splat prototype. Capture photos are stored on the server; a separate GPU worker reconstructs the scene. The browser renders the returned splat using Spark and Three.js.

## What works

- JPG/PNG validation, previews, duplicate selection filtering, and upload progress. Photos upload four at a time, and a failed photo is retried on network errors and 5xx before the upload stops.
- Persistent capture manifests in D1, image/result storage in R2, and owner-scoped APIs.
- Resumable uploads: reselect the original files from an incomplete capture.
- A durable job queue with atomic claims, worker leases, real stage reporting, and stale-job recovery.
- Interactive splat viewing, orbit/pan/zoom, rotation, reset, and fullscreen. Finished captures stream as compressed SPZ (about 7× smaller than the PLY) with real download progress, and the full-precision PLY stays available as a download. One WebGL context is reused across scenes.
- Status polling backs off from 2 s to 20 s while nothing changes, resets on any change or action, and stops once no capture is processing.
- Local PLY/SPZ/SPLAT/KSPLAT viewing without uploading the file.
- A separately attributed Spark sample scene. The sample is not a reconstruction of uploaded photos.

Reconstruction needs an external CUDA GPU worker. Without one, uploads stay queued. There is no fake progress, generated replacement scene, or automatic paid GPU provisioning.

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

The runner claims one job at a time, downloads photos, runs `ns-process-data images`, checks registration coverage, trains `ns-train splatfacto`, exports `ns-export gaussian-splat`, converts the PLY to SPZ (`gpu-worker/spz.py`, needs numpy), and uploads the SPZ and then the PLY. If SPZ conversion or upload fails, the PLY alone is delivered and the viewer loads it instead. It sends a heartbeat every 25 seconds. Stages time out after two hours. Jobs with no heartbeat for ten minutes become retryable failures. The heartbeat keeps running through the result upload, which is validated, streamed and retried with backoff. If the upload still fails, the PLY is kept in a recovery folder (`--recovery-dir`, newest 10) instead of being deleted. Each stage runs in its own process group, so stopping the worker (Ctrl-C, SIGTERM, SIGHUP) or a stage timeout also stops COLMAP/Brush child processes. Temporary inputs and checkpoints are removed when the job ends; original photos and successful PLYs remain in R2. Worker tests: `python3 -m unittest discover -s gpu-worker/tests`.

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

The prototype limits captures to 12–200 photos, 20 MB per image, 1 GB total, 90 MB per returned PLY, and 48 MB per SPZ. JPEG/PNG signatures are checked on upload and decoding is checked in the browser; deeper image validation happens in the reconstruction tools. GPU jobs should run in an isolated environment. Large datasets, video extraction, progressive level-of-detail loading (ADR-0007), camera metadata ingestion, deletion controls, and public sharing are future work.

## Hosting and architecture

The Sites vinext starter produces a Cloudflare Worker. `.openai/hosting.json` declares DB (D1) and BUCKET (R2). `worker/api.ts` handles capture and worker routes; the remainder goes through vinext. The schema comes only from the Drizzle migrations in `drizzle/` (edit `db/schema.ts`, then `npm run db:generate`). The build packages them for the host, and the API never runs DDL. Locally, `npm run dev` applies them first through its `predev` hook (idempotent, and it creates `.wrangler/` on a fresh checkout); `npm run db:migrate:local` runs the same step by itself. The Worker also exports a `scheduled` handler for the stale-lease Cron Trigger, configured in `vite.config.ts`.

Cloudflare hosts the web app, metadata, and files; Gaussian-splat training runs on the separate CUDA host. Browser requests cannot choose worker commands or file paths. User-facing responses never include worker tokens or leases.

Sources: [Spark](https://sparkjs.dev/docs/), [Splatfacto](https://docs.nerf.studio/nerfology/methods/splat.html). The remotely loaded butterfly is Spark's documented viewer sample.
