"""S10 (ADR-0009): frame selection from a video."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import random
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("video_frames", Path(__file__).parents[1] / "video_frames.py")
video_frames = importlib.util.module_from_spec(spec)
spec.loader.exec_module(video_frames)

try:
    import numpy  # noqa: F401
    from PIL import Image, ImageFilter
    HAS_IMAGING = True
except ImportError:
    HAS_IMAGING = False


def scene(seed, size=(320, 240)):
    """A textured, sharp frame; different seeds look different to a perceptual hash."""
    rng = random.Random(seed)
    image = Image.new("L", size)
    pixels = image.load()
    blocks = [[rng.randrange(256) for _ in range(size[0] // 16 + 1)] for _ in range(size[1] // 16 + 1)]
    for y in range(size[1]):
        for x in range(size[0]):
            pixels[x, y] = (blocks[y // 16][x // 16] + (x * 7 + y * 3) % 32) % 256
    return image.convert("RGB")


def blurred(image, radius=6):
    return image.filter(ImageFilter.GaussianBlur(radius))


def probe_output(duration=20.0, rate="30000/1001"):
    return json.dumps({"streams": [{"avg_frame_rate": rate, "r_frame_rate": rate, "duration": str(duration)}],
                       "format": {"duration": str(duration)}})


class SelectionTests(unittest.TestCase):
    def test_window_keeps_its_sharpest_candidate(self):
        scores = [(10.0, 0x0), (90.0, 0xFF), (20.0, 0xF0F0), (30.0, 0xFFFF0000), (80.0, 0xFFFFFFFF0000), (5.0, 0x1)]
        self.assertEqual(video_frames.select(scores, 2, 0.0, 0), [1, 4])

    def test_blurry_picks_are_dropped_against_the_median(self):
        # Window 2 is all motion blur: its best is still far below the clip's median.
        scores = [(100.0, 1 << 1), (95.0, 1 << 20), (3.0, 1 << 40), (2.0, 1 << 50), (98.0, 1 << 60), (97.0, 1 << 30)]
        self.assertEqual(video_frames.select(scores, 3, 0.35, 0), [0, 4])

    def test_near_duplicates_of_the_previous_pick_are_dropped_keeping_the_sharper(self):
        same = 0x0123456789ABCDEF
        nearly = same ^ 0b101  # two bits differ: the camera paused
        other = ~same & (2 ** 64 - 1)
        scores = [(50.0, same), (60.0, nearly), (55.0, other)]
        self.assertEqual(video_frames.select(scores, 3, 0.0, 4), [1, 2])
        self.assertEqual(video_frames.select(scores, 3, 0.0, 1), [0, 1, 2], "two bits apart is not a duplicate at distance 1")

    def test_long_clips_end_with_100_to_200_frames(self):
        rng = random.Random(7)
        for count in (150, 300, 600):
            with self.subTest(candidates=count):
                scores = [(rng.uniform(50, 150), rng.getrandbits(64)) for _ in range(count)]
                number, kept = video_frames.choose(scores)
                self.assertEqual(number, 1)
                self.assertGreaterEqual(len(kept), video_frames.MIN_FRAMES)
                self.assertLessEqual(len(kept), video_frames.MAX_FRAMES)
                self.assertEqual(kept, sorted(kept), "frames stay in time order for sequential matching")

    def test_lenient_pass_runs_only_when_too_few_survive(self):
        rng = random.Random(3)
        # Slow footage: every 4 candidates the view drifts by 3 hash bits, a "duplicate" for the strict pass.
        hashes, current = [], rng.getrandbits(64)
        for index in range(600):
            if index and index % 4 == 0:
                group = index // 4
                current ^= sum(1 << ((3 * group + bit) % 64) for bit in range(3))
            hashes.append(current)
        scores = [(rng.uniform(80, 100), dhash) for dhash in hashes]
        strict = video_frames.select(scores, *video_frames.PASSES[0])
        self.assertLess(len(strict), video_frames.MIN_FRAMES)
        number, kept = video_frames.choose(scores)
        self.assertEqual(number, 2)
        self.assertGreaterEqual(len(kept), video_frames.MIN_FRAMES)
        self.assertLessEqual(len(kept), video_frames.MAX_FRAMES)

    def test_static_footage_keeps_too_few_frames(self):
        scores = [(100.0, 0xABCDEF)] * 300
        _, kept = video_frames.choose(scores)
        self.assertLess(len(kept), video_frames.MIN_USABLE)

    def test_candidate_rate(self):
        self.assertAlmostEqual(video_frames.candidate_fps(30, 30), 20)  # 600 candidates
        self.assertAlmostEqual(video_frames.candidate_fps(5, 30), 30)   # short clip: every frame
        self.assertAlmostEqual(video_frames.candidate_fps(600, 60), 1)


@unittest.skipUnless(HAS_IMAGING, "numpy and Pillow are needed")
class ScoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def save(self, image, name):
        path = self.root / name
        image.save(path, quality=95)
        return path

    def test_sharp_beats_blurry_and_duplicates_hash_alike(self):
        sharp = scene(1)
        sharp_score, sharp_hash = video_frames.score(self.save(sharp, "sharp.jpg"))
        blur_score, blur_hash = video_frames.score(self.save(blurred(sharp), "blur.jpg"))
        copy_score, copy_hash = video_frames.score(self.save(sharp, "copy.jpg"))
        _, other_hash = video_frames.score(self.save(scene(2), "other.jpg"))
        self.assertGreater(sharp_score, 5 * blur_score)
        self.assertEqual(copy_hash, sharp_hash)
        self.assertAlmostEqual(copy_score, sharp_score)
        self.assertLessEqual(video_frames.hamming(sharp_hash, blur_hash), 8, "blur barely moves the hash")
        self.assertGreater(video_frames.hamming(sharp_hash, other_hash), 12)

    def test_large_frames_are_scored_on_a_downscaled_copy(self):
        path = self.save(scene(4, size=(1920, 1080)), "large.jpg")
        with mock.patch.object(video_frames, "SCORE_EDGE", 64):
            score, _ = video_frames.score(path)
        self.assertGreater(score, 0)


@unittest.skipUnless(HAS_IMAGING, "numpy and Pillow are needed")
class RunTests(unittest.TestCase):
    """run() with ffprobe and ffmpeg mocked: the mock decodes a scripted list of frames."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.video = self.root / "clip.mov"
        self.video.write_bytes(b"\0\0\0\x20ftypqt  ")
        self.photos = self.root / "photos"
        self.work = self.root / "candidates"
        self.report = self.root / "selection.json"
        self.commands = []
        self.stdout = contextlib.redirect_stdout(io.StringIO())
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)

    def fake(self, frames, duration=30.0, probe_code=0, ffmpeg_code=0):
        def run(command, **kwargs):
            self.commands.append(command)
            self.assertIs(kwargs.get("stdin"), subprocess.DEVNULL)
            if Path(command[0]).name.startswith("ffprobe"):
                return subprocess.CompletedProcess(command, probe_code, probe_output(duration) if not probe_code else "", "bad")
            if not ffmpeg_code:
                pattern = Path(command[-1])
                pattern.parent.mkdir(parents=True, exist_ok=True)
                for index, frame in enumerate(frames, 1):
                    frame.save(pattern.parent / (pattern.name % index), quality=92)
            return subprocess.CompletedProcess(command, ffmpeg_code, "", "decode error")
        return mock.patch.object(video_frames.subprocess, "run", side_effect=run)

    def test_sharp_distinct_frames_are_kept_in_order_and_blur_and_pauses_dropped(self):
        # 40 candidates: every 4th is motion-blurred, and 8–15 are the camera pausing on one view.
        frames, kinds = [], []
        for index in range(40):
            base = scene(8 if 8 <= index < 16 else index)
            if index % 4 == 3:
                frames.append(blurred(base, 8))
                kinds.append("blur")
            else:
                frames.append(base)
                kinds.append("pause" if 8 <= index < 16 else "sharp")
        with self.fake(frames), mock.patch.object(video_frames, "PASSES", ((40, 0.35, 4),)), \
                mock.patch.object(video_frames, "MIN_FRAMES", 20):
            summary = video_frames.run(self.video, self.photos, self.work, self.report, "/opt/ff/ffmpeg", "/opt/ff/ffprobe")
        chosen = [frame["candidate"] for frame in summary["frames"]]
        self.assertTrue(all(kinds[index] != "blur" for index in chosen), chosen)
        self.assertEqual(sum(kinds[index] == "pause" for index in chosen), 1, "one frame of the pause survives")
        self.assertEqual(len(chosen), 25)  # 30 sharp: 24 outside the pause, plus one of its six
        self.assertEqual(chosen, sorted(chosen))
        self.assertEqual(sorted(p.name for p in self.photos.iterdir()), [f"frame_{i:05d}.jpg" for i in range(len(chosen))])
        self.assertFalse(self.work.exists(), "candidates are removed")
        self.assertEqual(json.loads(self.report.read_text())["selected"], len(chosen))
        probe, extract = self.commands
        self.assertEqual(probe[0], "/opt/ff/ffprobe")
        self.assertEqual(extract[:2], ["/opt/ff/ffmpeg", "-nostdin"])
        filters = extract[extract.index("-vf") + 1]
        self.assertTrue(filters.startswith("fps=20.000000,scale="), filters)  # 600 candidates / 30 s cap → 20 fps
        self.assertIn(str(self.video), extract)

    def test_too_long_unreadable_or_static_videos_fail_with_a_message(self):
        static = [scene(1)] * 30
        cases = (
            (dict(frames=[], duration=601), "longer than ten minutes"),
            (dict(frames=[], probe_code=1), "could not be read"),
            (dict(frames=[], ffmpeg_code=1), "could not be extracted"),
            (dict(frames=static), "Too few sharp, distinct frames"),
        )
        for kwargs, message in cases:
            with self.subTest(message=message), self.fake(**kwargs), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(video_frames.main([str(self.video), str(self.photos), "--work", str(self.work), "--report", str(self.report)]), 3)
                self.assertIn(message, json.loads(self.report.read_text())["error"])


@unittest.skipUnless(HAS_IMAGING and shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg, numpy and Pillow")
class RealFfmpegTests(unittest.TestCase):
    def test_a_short_rotated_clip_yields_upright_frames_within_bounds(self):
        with tempfile.TemporaryDirectory() as temp, contextlib.redirect_stdout(io.StringIO()):
            root = Path(temp)
            landscape, clip = root / "landscape.mp4", root / "clip.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", "testsrc2=size=640x360:rate=30:duration=6", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                            str(landscape)], check=True, timeout=120)
            # A phone held upright stores landscape pixels plus a display rotation.
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-display_rotation", "90",
                            "-i", str(landscape), "-c", "copy", str(clip)], check=True, timeout=120)
            summary = video_frames.run(clip, root / "photos", root / "work", root / "report.json")
            self.assertGreaterEqual(summary["selected"], video_frames.MIN_USABLE)
            self.assertLessEqual(summary["selected"], video_frames.MAX_FRAMES)
            self.assertAlmostEqual(summary["candidates"], 180, delta=2)
            with Image.open(root / "photos/frame_00000.jpg") as first:
                self.assertEqual(first.size[0] < first.size[1], True, "phone rotation is applied")


if __name__ == "__main__":
    unittest.main()
