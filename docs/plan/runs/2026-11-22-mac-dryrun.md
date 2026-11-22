# Mac dry run — Apple Silicon reconstruction pipeline (S4-prep)

- **Date:** 2026-11-22
- **Branch:** `m0-m1-delivery` @ `372f9be` (repo sources not modified; `worker.py` was being edited concurrently and was not touched)
- **Machine:** Apple M1 Pro (8-core CPU: 6P + 2E; 14-core GPU, Metal 4), 16 GB, macOS 27.2.1, Python 3.13.7 (universal, ran arm64)
- **Scope:** `npm run setup:mac`, then `mac_pipeline.py` and `brush_app` run standalone with the exact argv that `worker.py --backend brush` uses. The web server, job queue, upload and viewer screenshot were not exercised; they are still open for S4.

## Verdict

**The pipeline works on this machine.** 64 real photos went to a 233,586-splat PLY in **22.9 min wall clock** (5.8 min alignment + 17.1 min training), all on worker defaults and with 100% of photos registered. Peak memory was under 2 GB per stage. **D7 is confirmed:** the Brush PLY uses the COLMAP world frame (≈ −Y up), so the viewer's −π/2 X-rotation renders this scene **tilted 72°**. The fix belongs in the pipeline (gravity-align before undistort; proposed diff below).

## Dataset

| Item | Value |
|---|---|
| Name | COLMAP sample dataset **South Building** (UNC Chapel Hill, J. Schönberger) |
| Source | Listed on <https://colmap.github.io/datasets.html> → <https://demuc.de/colmap/datasets/> → <https://github.com/colmap/colmap/releases/download/3.11.1/south-building.zip> |
| Archive | 419,421,847 bytes, sha256 `d210016bd2de20936a5f02b87fd38a76bf0440c42d045231218372cf9db9a7a1` (also contains COLMAP's own `database.db` and sparse model, which were not used) |
| License | **None stated** on the COLMAP docs page or the dataset page. COLMAP itself is BSD-3, but nothing extends that to the images. Use only for local testing; don't commit or redistribute. |
| Camera | Panasonic DMC-TZ3, 3072×2304 JPEG, EXIF focal 4.6 mm (28 mm equiv.), orientation tag 1 on all frames |
| Full set | 128 photos from a walk around one building |
| Used | **64 photos**: every second frame by filename (`P1180141, …143, …`), which keeps sequential overlap. Originals (112 MB, max 1.9 MB/file) in `.local/datasets/south-building/images/` |
| Downscaled | Long edge 1600 (1600×1200, Lanczos, q92, EXIF kept), 44 MB, in `.local/datasets/south-building/images_1600/`. **This copy was the pipeline input.** The pipeline caps at 1200 px anyway. |

The app limit of 20 MB per JPEG is met by both copies.

## Commands run

```bash
npm run setup:mac                                   # 1 min 14 s; pip-installed pycolmap 3.13.0, Pillow 12.3.0, numpy 2.5.5

# What worker.py --backend brush runs (copied verbatim from worker.py; RUN=.local/runs/20261122-212521):
.local/venv/bin/python gpu-worker/mac_pipeline.py $RUN/photos $RUN/dataset --max-resolution 1200 \
    > $RUN/alignment.log 2>&1
.local/bin/brush_app $RUN/dataset/undistorted \
    --total-steps 7000 --max-resolution 1200 --max-splats 300000 --sh-degree 2 \
    --export-every 7000 --export-path $RUN/export --export-name result.ply \
    > $RUN/training.log 2>&1
```

Each stage was wrapped in `/usr/bin/time -l` for wall clock and memory. The sub-stage times come from the pycolmap glog timers in `alignment.log`. Scratch scripts (run harness, PLY/orientation analysis, matcher benchmark) were kept outside the repo.

## Timings (worker defaults: 4 threads, 8192 SIFT features, exhaustive matching, 7000 steps, 1200 px, 300k splats)

| Stage | Wall clock | Notes |
|---|---:|---|
| Feature extraction (CPU SIFT) | 58.4 s | ~0.9 s/photo |
| Exhaustive matching + geometric verification | 221.3 s | 2,016 pairs; **the largest alignment cost** |
| Incremental mapping | 60.6 s | |
| Undistort | 3.4 s | |
| **Alignment total** | **346 s (5.8 min)** | 724 s CPU user time, so only ~2.1 cores busy on average; peak RSS 1.33 GB |
| **Brush training, 7000 steps** | **1,028 s (17.1 min)** | ≈ 6.8 steps/s; GPU 73–98% busy; peak footprint 1.87 GB |
| **End to end** | **1,374 s (22.9 min)** | well inside the 2 h per-stage limit |

## Metrics

| Metric | Value |
|---|---|
| Photos in | 64 |
| Photos registered | **64 / 64 (100%)**, one model; the 60% gate passed |
| Sparse points | 39,901; mean track length 4.68; mean reprojection error 0.336 px |
| Cameras | 1 shared SIMPLE_RADIAL (focal prior 1294 px from EXIF); `CameraMode.AUTO` grouped all frames |
| Features/image | Logged up to ~11.5k despite `max_num_features = 8192`. COLMAP caps detections before assigning orientations, so the count can exceed the cap. Informational only. |
| Output PLY | `export/result.ply`, **35,506,098 bytes (33.9 MiB)**, **233,586 vertices** (300k cap not reached), SH degree 2, 152 B/splat |
| Size headroom | At the 300k cap: 45.6 MB, under the 90 MB delivery limit. SH degree 3 at 300k would be ~74 MB. |
| Run dir on disk | 258 MB (database.db 128 MB, undistorted 74 MB, export 34 MB) |

## Orientation (D7)

**Question:** `SplatViewer.tsx` gives server results `mesh.rotation.x = -Math.PI/2`, which assumes Nerfstudio Z-up. Is Brush output upright under that rotation?

**Evidence:**

1. **Brush keeps the COLMAP world frame unchanged.** Brush seeds splats from the SfM points, so I compared the PLY means with the COLMAP `points3D` using the median nearest-neighbour distance (3k samples each) under 7 candidate transforms:

   | PLY = T · COLMAP | median NN distance |
   |---|---:|
   | identity | **0.048** |
   | flip Y | 0.399 |
   | Rx(−90°) | 0.416 |
   | flip Z | 0.427 |
   | Rx(+90°) | 0.659 |
   | Rx(180°) / flip Y,Z | 0.666 |

   Brush also writes `comment Vertical axis: y` into the PLY header.

2. **The scene's up vector in the COLMAP/PLY frame is ≈ −Y, plus a capture-dependent tilt.** The mean of the 64 cameras' image-up vectors (−Y row of `cam_from_world`) is **(0.022, −0.952, 0.304)**, with |mean| = 0.96 (consistent cameras: median deviation 15°). The camera centres lie on a flat plane (singular values 23.9 / 17.4 / 0.18) whose normal is within **2.6°** of that up vector, which independently confirms it. COLMAP's world frame follows the initial camera pair, so the extra 18° tilt comes from how those cameras were pitched and will differ on every capture.

3. **How each viewer rotation renders this up vector (three.js up = +Y):**

   | `mesh.rotation.x` | up maps to | tilt from upright |
   |---|---|---:|
   | **−π/2 (current, server results)** | (0.02, 0.30, 0.95) | **72.3°: building lies nearly on its back** |
   | π (current sample path) | (0.02, 0.95, −0.30) | 17.8° |
   | 0 | (0.02, −0.95, 0.30) | 162° (upside down) |

**Finding:** with −π/2, Brush results will **not** render upright. Switching to π only gets within the capture's own pitch (18° here, unbounded in general). Apply the fix in the pipeline: rotate the COLMAP model so the mean camera up becomes **+Z** before undistortion. Brush then trains in a Z-up frame, which matches the Nerfstudio convention the viewer already assumes, so the viewer needs no change. I prototyped this on a scratch copy of this run's model: `Reconstruction.transform(Sim3d(1, Rotation3d(R), 0))` gave a mean up of exactly (0, 0, 1). With that model, −π/2 maps up to +Y, which is 0° tilt. Retraining was not needed to show this, because point 1 shows Brush preserves the input frame.

**Remaining risk (untested):** phone photos often store portrait shots as landscape pixels plus an EXIF Orientation tag (6 or 8). This dataset only has orientation 1. If COLMAP ignores the tag, the camera-up average for a portrait capture points sideways. Normalise orientation first (Pillow `ImageOps.exif_transpose` on the downloaded photos) and test with a real portrait iPhone capture.

## Problems found and proposed fixes

None of these were applied to repo files.

### P1 (D7, High): Brush output is in the COLMAP frame, so the viewer tilts it

Gravity-align before undistort, and use all cores (see P4):

```diff
--- a/gpu-worker/mac_pipeline.py
+++ b/gpu-worker/mac_pipeline.py
@@
 import argparse
 import json
 import math
+import os
 from pathlib import Path
 
+THREADS = os.cpu_count() or 4
+
+
+def gravity_align(model):
+    """Rotate so the mean camera up (-Y in COLMAP camera space) becomes +Z (Nerfstudio Z-up; spec D7)."""
+    import numpy as np
+    import pycolmap
+    up = np.mean([-image.cam_from_world().rotation.matrix()[1] for image in model.images.values()], axis=0)
+    up /= np.linalg.norm(up)
+    z = np.array([0.0, 0.0, 1.0])
+    if up @ z < -0.999999:
+        rotation = np.diag([1.0, -1.0, -1.0])
+    else:
+        v = np.cross(up, z)
+        k = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
+        rotation = np.eye(3) + k + k @ k / (1 + up @ z)
+    model.transform(pycolmap.Sim3d(1.0, pycolmap.Rotation3d(rotation), np.zeros(3)))
+
 
 def align(photos, output, max_resolution):
@@
-    extraction.num_threads = 4
+    extraction.num_threads = THREADS
@@
-    matching.num_threads = 4
+    matching.num_threads = THREADS
@@
-    options.num_threads = 4
+    options.num_threads = THREADS
@@
     if model.num_points3D() == 0:
         raise RuntimeError("Alignment produced no 3D points.")
+    gravity_align(model)
+    model.write(str(sparse / str(model_id)))
     undistort = pycolmap.UndistortCameraOptions()
```

After this, the Brush PLY's `comment Vertical axis: y` will be stale, but that is harmless. Add a regression check that the alignment output's mean camera up is +Z.

### P2 (Low): Brush drops a `target/autotune/` cache into the working directory

Brush (Burn/wgpu) wrote `target/autotune/0.7.0/…` into the repo root, where the run was launched. `npm run worker:mac` also runs from the repo root, so every Mac worker would leave an untracked `target/` dir. I moved this run's cache to `.local/brush-cwd/target`. The minimal fix:

```diff
--- a/.gitignore
+++ b/.gitignore
@@
 /.local/
+/target/
```

A better fix, for whoever owns `worker.py` (Codex is editing it now): give the brush `Popen` a working directory of `cwd=<repo>/.local`. That keeps the autotune cache persistent between jobs and out of the tree.

### P3 (Low, security hygiene): setup trusts a pre-existing `brush_app` without verifying it

`setup_mac.py` only checks the sha256 of the archive it downloads. If `.local/bin/brush_app` already exists, it runs that binary unverified. On this machine the pre-existing binary turned out to be byte-identical to the official v0.3.0 release (I re-downloaded the release and hashed it): archive `65b26313…` matches the pinned value, and the binary is `8380ed40cce870025393e1ea0257e0752351c67a409d827b76dc75ec3a999a71`. Separately, `.dev.vars` was mode 0644 before setup. Setup set it to 0600 only because it wrote a new token, and it would leave an existing file alone.

```diff
--- a/gpu-worker/setup_mac.py
+++ b/gpu-worker/setup_mac.py
@@
 BRUSH_SHA256 = "65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c"
+BRUSH_BIN_SHA256 = "8380ed40cce870025393e1ea0257e0752351c67a409d827b76dc75ec3a999a71"
@@ def configure_token():
         env_file.write_text(content)
-        os.chmod(env_file, 0o600)
         print("Configured a random worker token in .dev.vars (value hidden). Restart the web server.")
+    if env_file.exists():
+        os.chmod(env_file, 0o600)
@@ def main():
         archive.unlink()
+    if hashlib.sha256(binary.read_bytes()).hexdigest() != BRUSH_BIN_SHA256:
+        sys.exit("The installed brush_app is not the pinned v0.3.0 build. Delete .local/bin and rerun setup.")
     subprocess.run([str(binary), "--version"], check=True)
```

### P4 (Medium, performance): alignment is pinned to 4 threads, and exhaustive matching is O(n²)

Benchmarked on the same 64 photos with a separate script (`CameraMode.SINGLE`, 8 threads):

| Variant | Extract | Match | Map | Registered | Points | Reproj. error |
|---|---:|---:|---:|---:|---:|---:|
| Worker default: 4 thr, exhaustive, 8192 | 58 s | **221 s** | 61 s | 64/64 | 39,901 | 0.336 |
| 8 thr, exhaustive, 8192 | 44 s | **156 s** | 63 s | 64/64 | 39,885 | 0.326 |
| 8 thr, sequential (overlap 15, quadratic), 8192 | 56 s | **37 s** | 36 s | 58/64 | 27,982 | 0.294 |
| 8 thr, exhaustive, 4096 | 110 s* | 72 s | 43 s | 64/64 | 17,899 | 0.419 |

\*The extraction times are noisy (thermal throttling or contention from the concurrent background run). Read the 110 s as noise, not as a 4096-feature effect.

- 8 threads cut matching by 30%.
- Exhaustive matching costs about 0.077 s per pair at 8 threads. At the app's `MAX_IMAGES = 200` that is 19,900 pairs, roughly **26 min** (about 36 min at the current 4 threads). That is still inside the 2 h limit, but it would dominate the job.
- Sequential matching is 4× faster but lost 6/64 frames on this dataset. It also relies on upload order matching capture order.
- 4096 features registered everything, but produced 55% fewer points, which gives Brush a weaker starting set.

### P5 (Low, operability): Brush prints nothing when stdout is not a TTY

`training.log` was empty for the whole 17 minutes; only the `/usr/bin/time` footer appeared. As a result the worker cannot report training progress, and a failure log will contain only Brush's final error. Option: set `--export-every` lower (e.g. 2000) so intermediate PLYs serve as progress and a partial result exists. Otherwise, accept stage-level status only.

### Not a problem (verified)

- `npm run setup:mac` ran cleanly on the first try. pycolmap 3.13.0 has a native `cp313 macosx_14_0_arm64` wheel. Brush 0.3.0 reported `brush-cli 0.3.0`.
- All the pycolmap 3.13 APIs that `mac_pipeline.py` uses exist with matching signatures.
- Every `brush_app` flag that `worker.py` passes exists in v0.3.0.
- Brush 0.3.0 reads the COLMAP 3.12+ undistorted model layout (`rigs.bin`/`frames.bin`) without trouble.
- The output is a standard 3DGS binary PLY (x/y/z, f_dc, f_rest, opacity, scale, rot), which Spark can load.

## Recommended worker defaults for M1 Pro (16 GB)

| Setting | Recommendation | Reason |
|---|---|---|
| Threads | `os.cpu_count()` (8) for extraction, matching and mapping | −30% matching time; the current 4 threads leave the CPU mostly idle |
| SIFT features per image | **8192** (keep) | 4096 halves matching time but cuts sparse points by 55% |
| Matcher | **Exhaustive up to ~100 photos.** Above that, sequential (overlap 20, quadratic), falling back to exhaustive if fewer than 60% register | Exhaustive is safe and only 2.6 min at 64 photos, but O(n²) makes it ~26 min at 200 |
| Training steps | **7000** (keep) | 17 min; quality vs. step count was not measured. 5000 steps would be roughly 12 min if time scales linearly (unmeasured). |
| Max resolution / splats / SH | 1200 / 300k / 2 (keep) | 234k splats reached; 45.6 MB at the cap, under the 90 MB limit; under 2 GB peak memory |
| Expected end to end | ~23 min for 64 photos; ~45–50 min for 200 photos (estimate) | |

## Blockers

None for the reconstruction pipeline itself. Before S4 / G2 can be called done:

1. Land the **P1 gravity-align fix** (otherwise the result renders tilted 72°).
2. Run the real loop: `npm run dev` + `npm run worker:mac`, with the result shown upright in the viewer and a screenshot taken.
3. Test a **portrait phone capture** for the EXIF-orientation risk.

## Artifacts (local, gitignored)

- `.local/runs/20261122-212521/`: `alignment.log`, `training.log`, `timings.txt`, `dataset/` (database, sparse/0, undistorted), `export/result.ply`
- `.local/runs/bench/`: matcher benchmark models
- `.local/datasets/south-building/`: `all/` (128 originals), `images/` (64 originals), `images_1600/` (64 downscaled)

## S4 follow-up (same day)

The proposals above landed in the S4 working tree (uncommitted, for review):

- **P1 gravity alignment** (`mac_pipeline.py`). It uses the camera-up mean, falls back to the camera-centre plane normal, and leaves the model unrotated with a warning if neither is reliable. EXIF orientation is normalised first.
- **P2** `/target/` is gitignored. The `worker.py` cwd change is **deferred until after S5 merges**, because S5 is editing `worker.py`.
- **P3** `setup_mac.py` checks an existing `brush_app` against the pinned sha256 and always sets `.dev.vars` to 0600.
- **P4** thread count is `os.cpu_count()` (`SPATIAL_COLMAP_THREADS` overrides). Matching is exhaustive up to 100 photos; above that it is sequential (overlap 20) with an exhaustive retry below **90%** registration. That threshold is stricter than the 60% suggested above.

The real loop (dev server + `worker:mac` + viewer) reached `ready` in 21.9 min with the result upright. See [2026-11-22-s4-e2e.md](2026-11-22-s4-e2e.md). The portrait-phone check is covered by a synthetic unit test only.
