"""S10 (ADR-0009): pick 100–200 sharp, distinct frames from one phone video for the photo pipeline.

Run as a worker stage (a subprocess, so the stage timeout, heartbeat and process-group kill apply):

    video_frames.py VIDEO PHOTOS_DIR --work DIR --report selection.json [--ffmpeg BIN] [--ffprobe BIN]

1. ffprobe reads the duration and frame rate; clips over ten minutes are refused.
2. ffmpeg decodes candidates at min(source fps, MAX_CANDIDATES / duration), auto-rotated and scaled to
   at most MAX_EDGE px on the long edge, as high-quality JPEGs.
3. Each candidate gets a sharpness score (variance of the 4-neighbour Laplacian on a grayscale copy at
   most SCORE_EDGE px wide) and a 64-bit difference hash.
4. The clip is cut into equal windows and the sharpest candidate of each window is kept; picks far
   blurrier than the clip's median are dropped, and so are near-duplicates of the previous pick (the
   camera paused). Stricter passes come first; a lenient pass only runs when fewer than MIN_FRAMES
   survive. Fewer than MIN_USABLE frames fails the job.
5. The picks are written in time order as PHOTOS_DIR/frame_00000.jpg…, which the unchanged photo
   pipeline (COLMAP/Brush or Nerfstudio) then aligns.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

MAX_DURATION_S = 600  # ten minutes
MAX_CANDIDATES = 600  # decoded frames scored per clip
MAX_EDGE = 1920       # long edge of the extracted frames (phones record 4K; alignment uses ≤ 1200)
SCORE_EDGE = 640
TARGET_FRAMES = 150
MIN_FRAMES = 100
MAX_FRAMES = 200
MIN_USABLE = 12       # the photo path's minimum
# (windows, blur floor as a fraction of the median sharpness, max Hamming distance of a duplicate).
PASSES = (
    (TARGET_FRAMES, 0.35, 4),
    (MAX_FRAMES, 0.2, 2),
    (MAX_FRAMES, 0.0, 0),  # identical frames (distance 0) are still dropped
)


class ExtractionError(RuntimeError):
    """A message meant for the capture's owner."""


def probe(video, ffprobe="ffprobe"):
    """Returns (duration_s, fps) of the first video stream."""
    command = [ffprobe, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=avg_frame_rate,r_frame_rate,duration:format=duration",
               "-of", "json", str(video)]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
    if result.returncode != 0:
        raise ExtractionError("This video could not be read. Upload an MP4 or MOV recorded by a phone or camera.")
    info = json.loads(result.stdout or "{}")
    streams = info.get("streams") or []
    if not streams:
        raise ExtractionError("This file has no video track.")
    stream = streams[0]

    def rate(text):
        try:
            num, _, den = str(text).partition("/")
            value = float(num) / float(den or 1)
            return value if 0 < value < 1000 else 0.0
        except (ValueError, ZeroDivisionError):
            return 0.0

    def seconds(text):
        try:
            value = float(text)
            return value if value > 0 else 0.0
        except (TypeError, ValueError):
            return 0.0

    fps = rate(stream.get("avg_frame_rate")) or rate(stream.get("r_frame_rate")) or 30.0
    duration = seconds(stream.get("duration")) or seconds((info.get("format") or {}).get("duration"))
    if not duration:
        raise ExtractionError("This video has no readable duration.")
    return duration, fps


def candidate_fps(duration, fps):
    return min(fps, MAX_CANDIDATES / duration)


def extract(video, work, rate, ffmpeg="ffmpeg"):
    """Decodes candidates into `work`; returns their paths in time order."""
    work.mkdir(parents=True, exist_ok=True)
    scale = (f"scale=w='min(iw,{MAX_EDGE})':h='min(ih,{MAX_EDGE})'"
             ":force_original_aspect_ratio=decrease:force_divisible_by=2")
    command = [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
               "-map", "0:v:0", "-an", "-vf", f"fps={rate:.6f},{scale}", "-q:v", "2",
               str(work / "cand_%05d.jpg")]
    result = subprocess.run(command, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if result.returncode != 0:
        print(result.stderr[-4000:], file=sys.stderr, flush=True)
        raise ExtractionError("Frames could not be extracted from this video. Try an MP4 or MOV in H.264 or HEVC.")
    return sorted(work.glob("cand_*.jpg"))


def score(path):
    """(sharpness, dhash) of one image: Laplacian variance at ≤ SCORE_EDGE px and a 64-bit dHash."""
    import numpy as np
    from PIL import Image

    with Image.open(path) as image:
        gray = image.convert("L")
        gray.thumbnail((SCORE_EDGE, SCORE_EDGE))
        pixels = np.asarray(gray, dtype=np.float32)
        small = np.asarray(gray.resize((9, 8), Image.Resampling.BILINEAR), dtype=np.int16)
    if pixels.shape[0] < 3 or pixels.shape[1] < 3:
        return 0.0, 0
    laplacian = (pixels[:-2, 1:-1] + pixels[2:, 1:-1] + pixels[1:-1, :-2] + pixels[1:-1, 2:]
                 - 4 * pixels[1:-1, 1:-1])
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    dhash = 0
    for bit in bits:
        dhash = (dhash << 1) | int(bit)
    return float(laplacian.var()), dhash


def hamming(a, b):
    return bin(a ^ b).count("1")


def select(scores, windows, blur_ratio, duplicate_distance):
    """Indices kept from `scores` ([(sharpness, dhash)] in time order) for one pass."""
    count = len(scores)
    if not count:
        return []
    windows = max(1, min(windows, count))
    picks = []
    for window in range(windows):
        start, end = window * count // windows, (window + 1) * count // windows
        if end > start:
            picks.append(max(range(start, end), key=lambda index: scores[index][0]))
    ordered = sorted(sharpness for sharpness, _ in scores)
    median = ordered[len(ordered) // 2]
    floor = median * blur_ratio
    kept = []
    for index in picks:
        sharpness, dhash = scores[index]
        if sharpness < floor:
            continue
        if kept and hamming(dhash, scores[kept[-1]][1]) <= duplicate_distance:
            if sharpness <= scores[kept[-1]][0]:
                continue
            kept[-1] = index  # same view: keep the sharper of the two
            continue
        kept.append(index)
    return kept


def choose(scores):
    """Runs the passes from strict to lenient; returns (pass number, kept indices)."""
    best = (0, [])
    for number, (windows, blur_ratio, duplicate_distance) in enumerate(PASSES, 1):
        kept = select(scores, windows, blur_ratio, duplicate_distance)
        if len(kept) >= MIN_FRAMES:
            return number, kept
        if len(kept) > len(best[1]):
            best = (number, kept)
    return best


def run(video, photos, work, report=None, ffmpeg="ffmpeg", ffprobe="ffprobe"):
    duration, fps = probe(video, ffprobe)
    if duration > MAX_DURATION_S:
        raise ExtractionError("This video is longer than ten minutes. Trim it to a slow 20–90 second walk around the subject.")
    rate = candidate_fps(duration, fps)
    candidates = extract(video, work, rate, ffmpeg)
    if not candidates:
        raise ExtractionError("No frames could be decoded from this video.")
    scores = [score(path) for path in candidates]
    number, kept = choose(scores)
    if len(kept) < MIN_USABLE:
        raise ExtractionError("Too few sharp, distinct frames in this video. Record a slower, steadier 20–90 second walk around the subject.")
    photos.mkdir(parents=True, exist_ok=True)
    frames = []
    for order, index in enumerate(kept):
        shutil.move(str(candidates[index]), photos / f"frame_{order:05d}.jpg")
        frames.append({"frame": order, "candidate": index, "time": round(index / rate, 3), "sharpness": round(scores[index][0], 2)})
    shutil.rmtree(work, ignore_errors=True)
    summary = {"duration": round(duration, 3), "fps": round(fps, 3), "candidate_fps": round(rate, 3),
               "candidates": len(candidates), "selected": len(kept), "pass": number, "frames": frames}
    if report is not None:
        Path(report).write_text(json.dumps(summary, indent=1))
    print(f"Selected {len(kept)} of {len(candidates)} candidate frames (pass {number}) from a {duration:.1f} s video.", flush=True)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("video", type=Path)
    parser.add_argument("photos", type=Path)
    parser.add_argument("--work", type=Path, help="Scratch directory for candidates (default: PHOTOS/../candidates)")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    args = parser.parse_args(argv)
    try:
        run(args.video, args.photos, args.work or args.photos.parent / "candidates", args.report, args.ffmpeg, args.ffprobe)
    except ExtractionError as exc:
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        if args.report is not None:  # the worker reports this message to the owner
            args.report.write_text(json.dumps({"error": str(exc)}))
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
