# Preview-tier model licences and feasibility (ADR-0008 gate)

Date: 2026-11-22
Status: research, decision-ready
Gate: PRD §9 Q2. "Before shipping, the chosen model's licence must be checked and permit our use. A model that fails the check is not shipped."
Our use: a self-hosted web product that may go commercial later. Users run `gpu-worker` on their own machine ("bring your own compute", PRD principle 3). The worker downloads and runs model weights on the user's hardware, so we distribute or direct users to the weights. A licence therefore has to permit both commercial use and that redistribution or download.

> This is engineering research, not legal advice. Before a commercial launch, counsel should confirm the licence verdicts, especially the "derivative weights" and training-data points.

## TL;DR

- **No end-to-end pose-free feed-forward 3DGS model passes a clean commercial gate today.** Every strong one has a non-commercial (NC) link somewhere in the chain:
  - AnySplat, YoNoSplat, NoPoSplat, FLARE, Splatt3R, SPFSplat, DA3's GS head, VGGT-X, GradSplat and Apple SHARP all fail.
  - The failure comes from NC upstream weights (VGGT-1B, MASt3R, Pi3, VGGT-Ω), from vendored CroCo code (CC BY-NC-SA), from the Inria rasterizer (NC), or from the repo licence itself.
- **Hugging Face licence tags are not reliable.**
  - AnySplat and YoNoSplat are tagged MIT but are fine-tuned from CC BY-NC weights. AnySplat's code even downloads `facebook/VGGT-1B` (CC BY-NC 4.0) at model construction.
  - FLARE is tagged apache-2.0 on HF, but its repo licence is CC BY-NC-SA 4.0.
  - Pi3 is tagged bsd-2-clause on HF, but its README says its weights are CC BY-NC 4.0.
- **One commercial-capable feed-forward 3DGS model exists, but it is geo-restricted.** Tencent HunyuanWorld-Mirror / WorldMirror 2.0 is under a community licence that does not apply in the EU, UK or South Korea and caps use at 1M MAU. It does not fit a global BYO-compute product.
- **Commercially clean building blocks do exist**:
  - Pose and geometry:
    - VGGT-1B-Commercial (gated; acceptable-use policy)
    - MapAnything `map-anything-apache` (Apache-2.0)
    - Depth Anything 3 BASE/SMALL (Apache-2.0)
  - Gaussians:
    - Brush (Apache-2.0)
    - gsplat (Apache-2.0)
    - DepthSplat-small (MIT weights and an Apache backbone; it needs posed input and a rasterizer swap)
- **Recommendation: build a "fast preview" from a clean chain, not from a feed-forward splat model.**
  1. A commercially clean pose model produces poses and COLMAP output.
  2. A short, low-step Brush/gsplat run produces `preview.spz`.
  3. AnySplat serves as an NC-only internal quality benchmark and is never shipped.

## Method

- Every licence claim below comes from the primary source: the repo `LICENSE` file, the README licence section, or the Hugging Face model card / `cardData.license`. These were fetched on 2026-11-22.
- Where a model's weights are initialised from another model's weights, the upstream licence is treated as binding. CC BY-NC and CC BY-NC-SA cover adaptations, and fine-tuned weights are an adaptation.
- Performance numbers come from the papers or READMEs. None were measured by us.

## 1. Per-model findings

Abbreviations:
- **NC**: non-commercial.
- **Dep**: the dependency or backbone that sets the effective licence.
- **MPS**: whether the model runs on Apple Silicon GPUs. "Unverified" means there is no official support.

### 1.1 Feed-forward 3DGS models (the candidates ADR-0008 had in mind)

| Model | Code licence | Weights licence (as published) | Effective licence via dependencies | Commercial? | Views | Speed / memory (reported) | MPS | Output | Maintenance |
|---|---|---|---|---|---|---|---|---|---|
| **AnySplat** | MIT ([LICENSE](https://github.com/InternRobotics/AnySplat/blob/main/LICENSE)) | HF tag MIT ([lhjiang/anysplat](https://huggingface.co/lhjiang/anysplat)) | **NC**. See note A1. | **No** | Unposed, 3 to 200+ (paper evaluates up to 200) | 16 views 0.77 s, 32 views 1.4 s, 64 views 4.1 s, 200 views 33 s ([paper](https://arxiv.org/html/2505.23716)). Long side 448 px. No memory figure given. | No. Needs the gsplat cu121 wheel, xformers, pytorch3d and torch_scatter. | 3DGS tensors, PLY export | Last push 2025-12-22, ~970 stars |
| **YoNoSplat** | MIT 2026 ([repo](https://github.com/cvg/YoNoSplat)) | HF tag MIT ([botaoye/YoNoSplat](https://huggingface.co/botaoye/YoNoSplat)) | **NC**. Initialised from Pi3 weights (CC BY-NC 4.0, [Pi3 README](https://github.com/yyfz/Pi3)). Vendors CroCo code. Uses the Inria-licence rasterizer fork. | **No** | 2 to 32 trained, "arbitrary" claimed, 224² | ~2.7 s for 100 views on a GH200 at 280×518 ([arXiv 2511.07321](https://arxiv.org/abs/2511.07321)) | No (CUDA rasterizer) | PLY | Active, last push 2026-11-09 |
| **NoPoSplat** | MIT ([repo](https://github.com/cvg/NoPoSplat)) | No tag ([botaoye/NoPoSplat](https://huggingface.co/botaoye/NoPoSplat)) | **NC**. Trained from MASt3R weights (CC BY-NC-SA, [naver/mast3r](https://github.com/naver/mast3r)). Includes CroCo. The rasterizer `diff-gaussian-rasterization-w-pose` is under the Inria NC licence. | **No** | 2 to 3, at 256² or 512² | Sub-second for 2 views | No | PLY | Last push 2026-02-25 |
| **FLARE** | **CC BY-NC-SA 4.0** ([LICENSE.txt](https://github.com/ant-research/FLARE/blob/main/LICENSE.txt)) | HF says apache-2.0 ([AntResearch/FLARE](https://huggingface.co/AntResearch/FLARE)). This conflicts with the repo licence. | **NC**. Built on DUSt3R/MASt3R. | **No** | 2 to 8 (example: 7 views at 512×384) | < 0.5 s | No | 3DGS / PLY | Stale, last push 2025-05 |
| **Splatt3R** | **CC BY-NC 4.0** ([repo](https://github.com/btsmart/splatt3r)) | [brandonsmart/splatt3r_v1.0](https://huggingface.co/brandonsmart/splatt3r_v1.0) | **NC**. MASt3R-based. | **No** | Image pairs only | ~0.1 s per pair | No | PLY | Stale, last push 2024-11 |
| **SPFSplat / SPFSplatV2** | MIT ([repo](https://github.com/ranrhuang/SPFSplatV2)) | Initialised from MASt3R or VGGT-1B | **NC** (upstream weights) | **No** | 2 to 10 | Sub-second | No | PLY | Research code |
| **NAS3R** | MIT 2026 ([repo](https://github.com/ranrhuang/NAS3R)) | Random-init checkpoints (`re10k_nas3r*.ckpt`) on HF [RanranHuang/NAS3R](https://huggingface.co/RanranHuang/NAS3R), no card | Possibly clean, since there are no pretrained priors. It vendors CroCo *code* (NC), which would have to be removed. It is trained only on RE10K, so the dataset terms apply. | **Unclear; do not rely on it** | 2 to 10, at 224² | Sub-second | No | PLY | Research-grade; real-estate domain only |
| **Depth Anything 3 (GS head)** | Apache-2.0 ([repo](https://github.com/ByteDance-Seed/Depth-Anything-3)) | The GS head ships **only** on DA3-GIANT(-1.1) and DA3NESTED-GIANT-LARGE(-1.1), both **CC BY-NC 4.0** (model table in the README) | **NC** for anything that outputs Gaussians | **No** (GS) | Any number; NVS evaluated with 12 context views at 270×480 | DA3-Giant: 37.6 FPS on an A100 for 32 images at 504×336. About 900 to 1000 images fit on 80 GB ([paper](https://arxiv.org/html/2511.10647)). | No | glb, ply, 3DGS video | Active, last push 2026-07-27 |
| **HunyuanWorld-Mirror / WorldMirror 2.0** | Tencent community licence ([repo 1](https://github.com/Tencent-Hunyuan/HunyuanWorld-Mirror), [repo 2](https://github.com/Tencent-Hunyuan/HY-World-2.0)) | `tencent-hunyuanworld-mirror-community` ([HF](https://huggingface.co/tencent/HunyuanWorld-Mirror)) | **Conditional.** See note W1. | **Yes, outside the EU, UK and South Korea**, below 1M MAU | Any number; ~48 views at training (WM 2.0, [arXiv 2604.14268](https://arxiv.org/abs/2604.14268)); 50K to 500K pixels per view | ~1.2B parameters; seconds per scene. Needs a large CUDA GPU (no official memory table; plan on 24 to 48 GB). | No (CUDA 12.4/12.8) | `gaussians.ply` plus `--save_colmap` | Active (WM 2.0 released 2026-04-16) |
| **GradSplat** (VGGT-Ω-based) | MIT ([repo](https://github.com/Jingong-Chen/GradSplat)) | Under the VGGT-Ω FAIR **Noncommercial** Research License | **NC** | **No** | Many | n/a | No | PLY | New |
| **VGGT-X** | **CC BY-NC 4.0** ([repo](https://github.com/Linketic/VGGT-X)) | Uses VGGT weights | **NC** | **No** | Dense (100s) | Minutes (COLMAP output, then 3DGS optimisation) | No | COLMAP, then 3DGS | Research |
| **InstantSplat** (MASt3R + optimisation, not feed-forward) | Apache-2.0 ([LICENSE](https://github.com/NVlabs/InstantSplat/blob/main/LICENSE)) | Uses MASt3R weights (CC BY-NC-SA) | **NC**. Its `.gitmodules` pulls naver/croco (NC-SA) and graphdeco-inria/diff-gaussian-rasterization and simple-knn (Inria NC). | **No** | 3 to 12 sparse views | ~10 s to 1 min | No | PLY | Stale, last push 2025-05 |
| **Apple SHARP** (single image) | Apple sample-code licence ([repo](https://github.com/apple/ml-sharp)) | `LICENSE_MODEL`: Apple ML Research Model licence, "Research Purposes … does not include any commercial exploitation, product development or use in any commercial product or service" | **NC** | **No** | 1 | < 1 s | **Yes** (CPU, CUDA or MPS) | 3DGS PLY | Active |
| **DepthSplat** (needs posed views) | MIT ([repo](https://github.com/cvg/depthsplat)) | MIT ([haofeixu/depthsplat](https://huggingface.co/haofeixu/depthsplat)) | **Small: clean except the rasterizer.** See note D1. **Base/Large: NC.** | **Small: likely yes**, after the rasterizer swap and a training-data review | 2 to 12+ *posed* views | 12 views at 512×960 in 0.6 s on an A100. Small model 37M parameters, base 117M, large 360M. | No (CUDA rasterizer) | PLY (`test.save_gaussian`) | Last push 2026-04-01 |

**Notes**

- **A1. AnySplat licence.**
  - The paper says it initialises "the geometry transformer and depth DPT head with weights from VGGT".
  - [`src/model/encoder/anysplat.py`](https://github.com/InternRobotics/AnySplat/blob/main/src/model/encoder/anysplat.py) (around line 133) calls `VGGT.from_pretrained("facebook/VGGT-1B")` inside `EncoderAnySplat.__init__`. So the code downloads CC BY-NC 4.0 weights ([facebook/VGGT-1B](https://huggingface.co/facebook/VGGT-1B)) every time the model is constructed.
  - The repo also vendors CroCo code (`src/model/encoder/backbone/croco`, CC BY-NC-SA, [naver/croco](https://github.com/naver/croco)).
  - The "MIT" tag on HF does not change any of this.
  - A commercial AnySplat would mean re-training from `VGGT-1B-Commercial` with CroCo removed. The authors trained on 16 A800 GPUs using nine datasets, each of which needs its own licence review. That is out of scope for us.
- **W1. Tencent community licence.**
  - The licence text says it "DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA".
  - Commercial use is allowed below 1M monthly active users.
  - Outputs may not be used to improve other AI models.
  - Tencent claims no rights in outputs.
  - With BYO compute we cannot control where the worker runs. Shipping it would mean geo-gating the download and the feature and adding territory terms to our own ToS.
- **D1. DepthSplat-small.**
  - The small variant's monocular backbone is Depth Anything V2-Small, which is Apache-2.0 ([HF](https://huggingface.co/depth-anything/Depth-Anything-V2-Small)). Base and Large are CC BY-NC 4.0.
  - Its multi-view branch comes from UniMatch, which is MIT ([repo](https://github.com/autonomousvision/unimatch)).
  - Its `requirements.txt` pulls `dcharatan/diff-gaussian-rasterization-modified`, which is under the Inria Gaussian-Splatting licence ("used 'non-commercially', i.e., for research and/or evaluation purposes only", [Inria LICENSE](https://github.com/graphdeco-inria/diff-gaussian-rasterization/blob/main/LICENSE.md)). The rasterizer is used for rendering only, so it would need to be replaced with gsplat (Apache-2.0).
  - Its training sets (RealEstate10K, DL3DV) need review. The DL3DV README says "the latest license is open to the usage of the dataset" ([DL3DV-10K](https://github.com/DL3DV-10K/Dataset), [terms](https://github.com/DL3DV-10K/Dataset/blob/main/DL3DV-10K_term_of_use.pdf)).

### 1.2 Pose and geometry foundation models (no Gaussians, but they can seed COLMAP/Brush)

| Model | Code licence | Weights licence | Commercial? | Views / memory / speed | MPS | Pose export | Maintenance |
|---|---|---|---|---|---|---|---|
| **VGGT (VGGT-1B-Commercial)** | "VGGT License" v1, 2025-07-29 ([LICENSE.txt](https://github.com/facebookresearch/vggt/blob/main/LICENSE.txt)). See note V1. | [`facebook/VGGT-1B-Commercial`](https://huggingface.co/facebook/VGGT-1B-Commercial): `vggt-aup-license`, gated with manual approval. The default [`facebook/VGGT-1B`](https://huggingface.co/facebook/VGGT-1B) is **CC BY-NC 4.0**. | **Yes**, with the Commercial checkpoint only and subject to the AUP. The README states similar accuracy to the NC checkpoint (Co3D AUC@30 90.37 vs 89.98). | Peak memory and time on an H100 at 336×518 ([paper Table 9](https://arxiv.org/html/2503.11651)): 10 frames 3.6 GB / 0.14 s; 20 frames 5.6 GB / 0.31 s; 50 frames 11.4 GB / 1.0 s; 100 frames 21.2 GB / 3.1 s; 200 frames 40.6 GB / 8.8 s. A May 2026 memory fix allows about 2 to 3× more frames. | Unofficial only (community port `jmanhype/vggt-mps`) | `demo_colmap.py` writes COLMAP output, with optional bundle adjustment, for gsplat/Brush | Active, last push 2026-05-19, 14.6k stars |
| **MapAnything** | Apache-2.0 ([repo](https://github.com/facebookresearch/map-anything)) | [`facebook/map-anything-apache`](https://huggingface.co/facebook/map-anything-apache): **Apache-2.0** ("licensing based on the underlying training datasets"). The default [`facebook/map-anything`](https://huggingface.co/facebook/map-anything) is CC BY-NC 4.0. | **Yes** (the apache variant) | Memory-efficient mode handles up to 2000 views on 140 GB. Uses CUDA, otherwise falls back to CPU. | CPU fallback; MPS unverified | `--save_colmap` | Active, last push 2026-08-07 |
| **Depth Anything 3 BASE / SMALL** | Apache-2.0 | DA3-BASE (0.12B) and DA3-SMALL (0.08B) are **Apache-2.0** ([README model table](https://github.com/ByteDance-Seed/Depth-Anything-3)). DA3-LARGE and GIANT are CC BY-NC. | **Yes** (BASE and SMALL; no GS head) | Small models; DA3-Streaming uses < 12 GB | Unverified | Extrinsics in COLMAP format | Active |
| **Pi3 / Pi3X** | BSD-3-Clause ([repo](https://github.com/yyfz/Pi3)) | README: CC BY-NC 4.0, "Strictly Non-Commercial … due to the nature of the training datasets". HF tag bsd-2-clause ([yyfz233/Pi3](https://huggingface.co/yyfz233/Pi3)), which conflicts. | **No** | n/a | n/a | n/a | Active |
| **MASt3R / DUSt3R / CroCo** | CC BY-NC-SA 4.0 ([mast3r](https://github.com/naver/mast3r), [dust3r](https://github.com/naver/dust3r), [croco](https://github.com/naver/croco)) | Same (NC) | **No** | n/a | n/a | n/a | Maintained |
| **VGGT-Ω (Omega)** | FAIR Noncommercial Research License ([repo](https://github.com/facebookresearch/vggt-omega)) | NC | **No** | n/a | n/a | n/a | New |

**V1. VGGT License v1.**
- Commercial use is permitted.
- Redistribution is allowed if a copy of the Agreement is included.
- The Acceptable Use Policy prohibits military, warfare, nuclear and ITAR-controlled uses, among others.
- Meta may modify the terms.
- The Commercial checkpoint is gated on HF. The form asks for name, date of birth, country and affiliation, and approval is manual. In a BYO setup there are two options:
  - Each user accepts the gate and supplies their own HF token. This is the safest option.
  - We redistribute the weights with the Agreement attached and pass the AUP on in our ToS.

### 1.3 Commercially clean infrastructure we would build on

| Component | Licence | Notes |
|---|---|---|
| Brush | Apache-2.0 ([repo](https://github.com/ArthurBrussee/brush)) | WGPU, runs on Metal and CUDA. Takes COLMAP or Nerfstudio-format data. Already our Mac backend (ADR-0003). Last push 2026-11-22. |
| gsplat | Apache-2.0 ([repo](https://github.com/nerfstudio-project/gsplat)) | CUDA only. Drop-in replacement for the Inria rasterizer. |
| SPZ | MIT ([nianticlabs/spz](https://github.com/nianticlabs/spz)) | PLY → SPZ conversion (S5 already plans SPZ output). |
| DINOv2 | Apache-2.0 ([repo](https://github.com/facebookresearch/dinov2)) | The backbone of VGGT, AnySplat and others. Not the blocker. |
| Depth Anything V2 code | Apache-2.0; weights: Small Apache, Base/Large NC | Relevant to DepthSplat. |
| pycolmap / COLMAP | BSD | Already in use. |
| **Inria diff-gaussian-rasterization / simple-knn** | **Inria NC licence** ([LICENSE.md](https://github.com/graphdeco-inria/diff-gaussian-rasterization/blob/main/LICENSE.md)) | Must not ship. NoPoSplat, YoNoSplat, DepthSplat and InstantSplat all pull it or a fork of it. |

## 2. Can predicted poses seed COLMAP or Brush?

Yes. This is the most useful licence-clean piece of the ADR-0008 idea.

- **Tools that export COLMAP output directly:**
  - VGGT: `demo_colmap.py`, with optional bundle adjustment
  - MapAnything: `--save_colmap`
  - DA3: extrinsics in COLMAP format
  - WorldMirror: `--save_colmap`
- **How Brush uses it:** Brush ingests a COLMAP `sparse/0` folder plus images. The `brush` branch of `gpu-worker/worker.py` already passes `dataset/undistorted` (from `mac_pipeline.align`) to `brush_app`. A VGGT or MapAnything export can replace pycolmap's output at that point with no Brush changes.
- **Quality check (ADR-0008 "after a quality check"):**
  - Accept predicted poses only if all of these hold:
    - the bundle-adjusted reprojection error is below a threshold (e.g. < 2 px median)
    - at least 60% of frames are registered (the same rule as ADR-0003)
    - confidence-filtered points number at least N (e.g. 5k)
  - Report the ratio through the existing `metrics: { alignment_ratio }` field.
- **Pose sources are uneven.** For a commercial path, only VGGT-1B-Commercial, MapAnything-apache and DA3-BASE/SMALL are usable. MASt3R, Pi3 and DUSt3R poses are NC.

## 3. Recommendation

### 3.1 Licence gate result

**For commercial use, no pose-free feed-forward 3DGS model passes.** Ranked by how close each comes to shipping:

| Rank | Option | Gate | Why |
|---|---|---|---|
| **1** | **"Fast preview" chain: MapAnything-apache or VGGT-1B-Commercial poses (COLMAP), then a low-step Brush (Mac) / gsplat (CUDA) run, then `preview.spz`** | **Pass** (Apache, VGGT licence + AUP, Apache, MIT) | Every link is commercial-clean. It reuses our Brush backend. On CUDA it should fit the PRD's < 2 min preview target (to be validated). It also gives the COLMAP-failure fallback that ADR-0008 wanted. MapAnything-apache is preferred because it is ungated and Apache. VGGT-Commercial is the alternative if its quality is clearly better. |
| 2 | Same chain plus **DepthSplat-small** fed with those poses, for a ~1 s splat | Conditional pass | Weights are MIT and the backbone is Apache. It requires swapping the Inria rasterizer for gsplat and a sign-off on the training data (RE10K/DL3DV). It is CUDA only and its quality on handheld phone captures is unproven. Treat it as a follow-up. |
| 3 | WorldMirror 2.0 | Conditional, **not recommended** | Commercial use is allowed but the licence excludes the EU, UK and South Korea, and caps use at 1M MAU. We cannot enforce territory with BYO compute. |
| — | AnySplat, YoNoSplat, NoPoSplat, FLARE, Splatt3R, SPFSplat, DA3-GS, VGGT-X, InstantSplat, SHARP, GradSplat | **Fail** | NC weights, NC code or NC dependencies (see §1). |

**Best non-commercial option for internal evaluation only: AnySplat.**
- Why: it is the best fit for 16 to 64 unposed phone frames, at about 1 to 4 s per scene.
- Use: as a quality ceiling, to measure how far the clean chain is from "true" feed-forward quality.
- Runner-up: YoNoSplat, which handles more views.
- Guardrail: never bundle either with the worker and never wire either to a production flag. If the preview stage needs an "experimental" backend for research, keep it out of the release artefacts.

### 3.2 Integration shape for `gpu-worker`

This follows ADR-0008 and plan item S11.

1. **Protocol (server).**
   - Add `previewing` to the state machine between `queued` and `aligning`: `queued → previewing → aligning → training → exporting → ready`. This keeps the "advance forward exactly one step" rule in `docs/specs/capture-pipeline.md`.
   - The preview result goes to `{id}/attempts/{lease}/preview.spz`, a per-attempt key like `result.*`.
   - Add a status PATCH field such as `preview: true` / `metrics.preview_seconds`.
   - The UI labels the preview "Preview" (ADR-0005). A preview failure is not fatal: the worker logs it, skips ahead and refine continues.
2. **Worker flag.** Add `--preview off|fast` (default `off` until validated) and a `--preview-frames N` option (default 24).
3. **Stage steps in `Worker.process(job)`.** After the download and before alignment:
   - **Subsample.** Pick N evenly spaced frames from `photos/`, dropping the blurriest (variance of Laplacian) within each window. Resize to a long side of 518 px (VGGT/MapAnything native).
   - **Poses.** Run the pose model, then export to COLMAP (`preview/sparse/0`). Compute the quality metrics from §2.
   - **Splat.**
     - Mac: `brush_app preview/ --total-steps 1500 --max-resolution 512 --max-splats 200k --sh-degree 0 --export-name preview.ply`.
     - CUDA: an equivalent short gsplat `simple_trainer`.
   - **Convert and upload.**
     - Convert PLY → SPZ with `nianticlabs/spz`.
     - Run `validate_ply`, then upload `preview.spz`.
     - PATCH `previewing → aligning`.
   - **Refine.** Run the existing alignment, training and export as today.
   - **Seeding.** If pycolmap alignment registers fewer than 60% of frames and the preview poses passed the quality check, re-run pose prediction on *all* frames (memory permitting) and feed that COLMAP output to Brush/ns-train instead of failing.
4. **Licence hygiene.**
   - Pin the exact HF repo ID (`facebook/map-anything-apache`, never `facebook/map-anything`).
   - Add a startup assertion that refuses NC model IDs.
   - Ship a `THIRD_PARTY_LICENSES` entry for every model.
   - If using VGGT-Commercial, require the user's own HF token (gated) and show the AUP once.
5. **Tests (S11's "protocol tests").**
   - State-machine transitions including `previewing`.
   - The preview failure → continue path.
   - Seeding acceptance thresholds.
   - A deny-list check for NC model IDs.

### 3.3 Hardware needed to validate

| Path | Minimum | Comfortable | Notes |
|---|---|---|---|
| Clean chain, CUDA (MapAnything or VGGT-Commercial + gsplat), 24 to 32 frames | 12 GB CUDA (RTX 3060 12 GB / 4070) | **24 GB** (RTX 3090/4090, or a cloud L4/A10G) | Per paper Table 9, VGGT uses about 5.6 GB at 20 frames and about 11.4 GB at 50. gsplat with 1 to 2k steps at 512 px fits easily. This matches the PRD's 24 GB reference GPU. |
| Clean chain, Mac (Brush low-step + pycolmap; pose model on MPS) | Apple Silicon, 16 GB unified | 32 GB+ M-series | Brush runs on Metal today. VGGT/MapAnything on MPS is **unverified** and must be measured. If MPS fails, use pycolmap poses on Mac, so the preview is only "low-step Brush" (still useful, but COLMAP-bound and not < 2 min on large captures). |
| NC evaluation (AnySplat / YoNoSplat) | 24 GB CUDA | 48 GB (A6000/L40S) for 64+ views | Linux with CUDA 12.x only; the dependencies are CUDA wheels. |
| WorldMirror 2.0 (if ever reconsidered) | 24 GB | 48 to 80 GB | ~1.2B parameters, CUDA 12.4/12.8. |

On the current Mac-only setup, only the Brush low-step preview can be validated end to end. All CUDA paths fall under S11's wording: "shipped behind a worker flag with protocol tests and the gap stated".

### 3.4 Decision requested

1. Accept that ADR-0008's "feed-forward model" becomes a **"fast preview" built from licence-clean parts**. Amend ADR-0008 to name MapAnything-apache (default) or VGGT-1B-Commercial, plus Brush/gsplat low-step and SPZ.
2. Allow AnySplat for **internal NC evaluation only**, outside the release artefacts.
3. Revisit in 6 months. The strongest licence trend is labs releasing commercial or Apache variants (VGGT-Commercial, map-anything-apache, DA3-BASE/SMALL). A clean feed-forward 3DGS head trained on those is plausible, and DA3 or MapAnything adding a GS head to an Apache checkpoint would change the answer.

## 4. Caveats

- This is not legal advice. The "fine-tuned from NC weights → NC" reading follows the CC BY-NC "Adapted Material" definition. Licensors can and do see it differently, so counsel should confirm it.
- Training-data licences (RE10K, DL3DV, ScanNet++, CO3D, Objaverse and others) can bind weights even when the model licence is permissive. Meta and ByteDance cite this as the reason for their split NC/Apache releases. Our "Pass" for MapAnything-apache relies on Meta's own dataset filtering.
- HF tags were wrong or in conflict for AnySplat, YoNoSplat, FLARE and Pi3. Always read the repo `LICENSE`, the README licence section and the upstream initialisation.
- The VGGT licence lets Meta modify its terms. Re-check at each release, and pin the licence text with the weights hash.
- No numbers here were measured by us. Every timing comes from a paper on A100, H100 or GH200 hardware.
