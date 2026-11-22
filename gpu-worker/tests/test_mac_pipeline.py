import contextlib
import importlib.util
import io
import math
from pathlib import Path
import random
import sys
import tempfile
import types
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("mac_pipeline", Path(__file__).parents[1] / "mac_pipeline.py")
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)

try:
    import numpy as np
except ImportError:
    np = None
try:
    from PIL import Image, JpegImagePlugin
except ImportError:
    Image = None
HAVE_PYCOLMAP = importlib.util.find_spec("pycolmap") is not None


def normalize(vector):
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def mat_vec(matrix, vector):
    return [sum(row[i] * vector[i] for i in range(3)) for row in matrix]


def rotate_about(axis, angle, vector):
    """Rodrigues rotation of `vector` about unit `axis`."""
    c, s = math.cos(angle), math.sin(angle)
    dot = sum(a * v for a, v in zip(axis, vector))
    across = cross(axis, vector)
    return [v * c + w * s + a * dot * (1 - c) for v, w, a in zip(vector, across, axis)]


def look_at(centre, target, up, roll=0.0):
    """COLMAP world-to-camera rotation (rows: right, down, forward) for a camera at `centre`."""
    forward = normalize([t - c for t, c in zip(target, centre)])
    down = [-value for value in up]
    right = normalize(cross(down, forward))
    down = cross(forward, right)
    right, down = rotate_about(forward, roll, right), rotate_about(forward, roll, down)
    return [right, down, forward]


class FakeRotation:
    def __init__(self, matrix):
        self._matrix = matrix

    def matrix(self):
        return np.array(self._matrix)


class FakeImage:
    def __init__(self, rotation, centre):
        self._pose = types.SimpleNamespace(rotation=FakeRotation(rotation))
        self._centre = centre

    def cam_from_world(self):
        return self._pose

    def projection_center(self):
        return np.array(self._centre)


class FakeModel:
    def __init__(self, poses):
        self.images = {index + 1: FakeImage(rotation, centre) for index, (rotation, centre) in enumerate(poses)}
        self.transforms = []

    def transform(self, sim3d):
        self.transforms.append(sim3d)


def fake_pycolmap():
    module = types.ModuleType("pycolmap")
    module.Rotation3d = lambda matrix: matrix
    module.Sim3d = lambda scale, rotation, translation: types.SimpleNamespace(
        scale=scale, rotation=rotation, translation=translation)
    return module


def horizontal_basis(up):
    up = normalize(up)
    helper = [1.0, 0.0, 0.0] if abs(up[0]) < 0.9 else [0.0, 1.0, 0.0]
    first = normalize(cross(up, helper))
    return up, first, cross(up, first)


def orbit(up, count=24, radius=4.0, height=1.0, rolls=None, centre_jitter=0.0, seed=1, span=360.0):
    """Cameras on a horizontal circle (w.r.t. `up`) looking at the origin, covering `span`
    degrees of it. Pitch is atan(height / radius) downward."""
    rng = random.Random(seed)
    up, first, second = horizontal_basis(up)
    poses = []
    for index in range(count):
        angle = math.radians(span) * index / count
        centre = [radius * (math.cos(angle) * a + math.sin(angle) * b) + height * u
                  + rng.uniform(-centre_jitter, centre_jitter)
                  for a, b, u in zip(first, second, up)]
        roll = rolls[index] if rolls else 0.0
        poses.append((look_at(centre, [0.0, 0.0, 0.0], up, roll), centre))
    return poses


def facade_walk(up, count=20, distance=3.0, pitch_degrees=15.0, yaw_degrees=20.0, roll_degrees=2.0,
                same_yaw=False, seed=5):
    """Cameras walking along a wall, aimed at it with some hand-held yaw and roll.
    Positive pitch looks up."""
    rng = random.Random(seed)
    up, along, toward_wall = horizontal_basis(up)
    poses = []
    for index in range(count):
        x = -5.0 + 10.0 * index / (count - 1)
        centre = [x * a + 1.6 * u for a, u in zip(along, up)]
        yaw = 0.0 if same_yaw else math.radians(rng.uniform(-yaw_degrees, yaw_degrees))
        sideways = distance * math.tan(yaw)
        rise = distance * math.tan(math.radians(pitch_degrees)) / math.cos(yaw)
        target = [c + distance * w + sideways * a + rise * u
                  for c, w, a, u in zip(centre, toward_wall, along, up)]
        roll = 0.0 if same_yaw else math.radians(rng.uniform(-roll_degrees, roll_degrees))
        poses.append((look_at(centre, target, up, roll), centre))
    return poses


def axes_and_centres(poses):
    """(camera right axes, camera up axes, centres), as gravity_align extracts them."""
    return ([list(rotation[0]) for rotation, _ in poses], [[-v for v in rotation[1]] for rotation, _ in poses],
            [centre for _, centre in poses])


def mean_up_estimate(poses):
    """The previous estimator: normalised mean camera up."""
    _, ups, _ = axes_and_centres(poses)
    return normalize([sum(column) / len(ups) for column in zip(*ups)])


def angle_between(a, b):
    a, b = normalize(a), normalize(b)
    return math.degrees(math.acos(max(-1.0, min(1.0, sum(x * y for x, y in zip(a, b))))))


class RotationToZTest(unittest.TestCase):
    def test_maps_up_to_z_with_a_proper_rotation(self):
        for up in ([0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 0, 0], normalize([0.3, -0.9, 0.3]),
                   normalize([1e-9, 0, -1])):
            rotation = pipeline.rotation_to_z(up)
            for axis, value in zip(mat_vec(rotation, up), (0, 0, 1)):
                self.assertAlmostEqual(axis, value, places=6, msg=up)
            product = [[sum(rotation[k][i] * rotation[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
            for i in range(3):
                for j in range(3):
                    self.assertAlmostEqual(product[i][j], float(i == j), places=6)
            r = rotation
            determinant = (r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1])
                           - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0])
                           + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]))
            self.assertAlmostEqual(determinant, 1.0, places=6)


@unittest.skipUnless(np is not None, "numpy is not installed")
class GravityAlignTest(unittest.TestCase):
    def align(self, poses):
        model = FakeModel(poses)
        output = io.StringIO()
        with mock.patch.dict(sys.modules, {"pycolmap": fake_pycolmap()}), contextlib.redirect_stdout(output):
            result = pipeline.gravity_align(model)
        return model, result, output.getvalue()

    def assert_world_up_becomes_z(self, model, world_up, tolerance=1.0):
        self.assertEqual(len(model.transforms), 1)
        rotation = model.transforms[0].rotation
        self.assertEqual(model.transforms[0].scale, 1.0)
        self.assertEqual(list(model.transforms[0].translation), [0, 0, 0])
        self.assertLess(angle_between(rotation @ np.array(world_up), [0, 0, 1]), tolerance)
        self.assertAlmostEqual(float(np.linalg.det(rotation)), 1.0, places=6)

    def test_colmap_default_minus_y_up_becomes_plus_z(self):
        # COLMAP's usual frame: first camera's axes, so world up is -Y.
        model, result, _ = self.align(orbit([0, -1, 0], height=0.0))
        self.assertEqual(result["method"], "camera-right")
        self.assertAlmostEqual(result["tilt_degrees"], 90.0, places=1)
        self.assert_world_up_becomes_z(model, [0, -1, 0], tolerance=1e-6)

    def test_tilted_model_with_hand_held_roll(self):
        world_up = normalize([0.022, -0.952, 0.304])  # South Building's measured camera up
        rng = random.Random(7)
        rolls = [math.radians(rng.uniform(-8, 8)) for _ in range(30)]
        poses = orbit(world_up, count=30, height=0.8, rolls=rolls, centre_jitter=0.2)
        model, result, _ = self.align(poses)
        self.assertEqual(result["method"], "camera-right")
        self.assert_world_up_becomes_z(model, world_up, tolerance=2.0)

    def test_half_arc_with_downward_pitch_is_pitch_invariant(self):
        # 180 degrees of arc, every camera pitched 30 degrees down, small hand-held rolls.
        world_up = normalize([0.022, -0.952, 0.304])
        rng = random.Random(11)
        rolls = [math.radians(rng.uniform(-3, 3)) for _ in range(24)]
        poses = orbit(world_up, count=24, radius=4.0, height=4.0 * math.tan(math.radians(30)),
                      rolls=rolls, span=180.0)
        up, method = pipeline.estimate_up(*axes_and_centres(poses))
        self.assertEqual(method, "camera-right")
        self.assertLess(angle_between(up, world_up), 2.0)
        # The mean-up estimator keeps sin(30) of the forward axes that do not cancel.
        self.assertGreater(angle_between(mean_up_estimate(poses), world_up), 15.0)
        model, result, _ = self.align(poses)
        self.assertEqual(result["method"], "camera-right")
        self.assert_world_up_becomes_z(model, world_up, tolerance=2.0)

    def test_full_orbit_with_downward_pitch(self):
        world_up = normalize([0.3, -0.9, 0.2])
        rng = random.Random(13)
        rolls = [math.radians(rng.uniform(-3, 3)) for _ in range(30)]
        poses = orbit(world_up, count=30, height=4.0 * math.tan(math.radians(30)), rolls=rolls,
                      centre_jitter=0.3)
        up, method = pipeline.estimate_up(*axes_and_centres(poses))
        self.assertEqual(method, "camera-right")
        self.assertLess(angle_between(up, world_up), 2.0)

    def test_facade_walk_looking_up(self):
        world_up = normalize([0.1, -1.0, 0.25])
        poses = facade_walk(world_up, pitch_degrees=15.0)
        up, method = pipeline.estimate_up(*axes_and_centres(poses))
        self.assertEqual(method, "camera-right")
        self.assertLess(angle_between(up, world_up), 2.0)
        self.assertGreater(angle_between(mean_up_estimate(poses), world_up), 10.0)

    def test_facade_walk_facing_one_way_falls_back_to_mean_up(self):
        # Every right axis is the same, so they pin down nothing; the centres form a line.
        world_up = normalize([0.1, -1.0, 0.25])
        poses = facade_walk(world_up, pitch_degrees=10.0, same_yaw=True)
        up, method = pipeline.estimate_up(*axes_and_centres(poses))
        self.assertEqual(method, "camera-up")
        self.assertAlmostEqual(angle_between(up, world_up), 10.0, places=3)

    def test_z_up_model_gets_identity_rotation(self):
        model, result, _ = self.align(orbit([0, 0, 1]))
        self.assertAlmostEqual(result["tilt_degrees"], 0.0, places=3)
        np.testing.assert_allclose(model.transforms[0].rotation, np.eye(3), atol=1e-9)

    def test_inconsistent_rolls_fall_back_to_camera_plane_normal(self):
        # Rolls alternate between +75 and -75 degrees (e.g. a mix of sideways shots), so the
        # mean camera up is short (cos 75 = 0.26) but still points upward.
        world_up = normalize([0.2, -1.0, 0.1])
        rolls = [math.radians(75 if index % 2 else -75) for index in range(24)]
        up, method = pipeline.estimate_up(*axes_and_centres(orbit(world_up, rolls=rolls)))
        self.assertEqual(method, "centre-plane")
        self.assertLess(angle_between(up, world_up), 1e-6)
        model, result, _ = self.align(orbit(world_up, rolls=rolls))
        self.assertEqual(result["method"], "centre-plane")
        self.assert_world_up_becomes_z(model, world_up, tolerance=1e-6)

    def test_plane_normal_sign_follows_mean_up(self):
        poses = orbit([0, 0, 1], rolls=[math.radians(75 if i % 2 else -75) for i in range(24)])
        rights, ups, centres = axes_and_centres(poses)
        up, method = pipeline.estimate_up(rights, ups, centres)
        self.assertEqual(method, "centre-plane")
        self.assertGreater(up[2], 0.999)
        flipped, _ = pipeline.estimate_up(rights, [[-v for v in value] for value in ups], centres)
        self.assertLess(flipped[2], -0.999)

    def test_unreliable_up_and_non_planar_cameras_leave_model_unrotated(self):
        rng = random.Random(3)
        poses = []
        for index in range(24):
            centre = [rng.uniform(-3, 3) for _ in range(3)]
            roll = math.pi * index / 12  # rolls spread evenly over 360 degrees: mean up ~ 0
            poses.append((look_at(centre, [0.0, 0.0, 0.0], [0, 0, 1], roll), centre))
        model, result, output = self.align(poses)
        self.assertEqual(result, {"method": "none", "tilt_degrees": None})
        self.assertEqual(model.transforms, [])
        self.assertIn("Warning: could not estimate gravity", output)

    def test_planar_cameras_without_sign_evidence_are_unreliable(self):
        # Rolls cover 360 degrees evenly, in an order unrelated to the orbit position.
        poses = orbit([0, 0, 1], rolls=[2 * math.pi * (5 * index % 24) / 24 for index in range(24)])
        up, method = pipeline.estimate_up(*axes_and_centres(poses))
        self.assertIsNone(up)
        self.assertEqual(method, "none")


@unittest.skipUnless(np is not None and HAVE_PYCOLMAP, "numpy or pycolmap is not installed")
class RealPycolmapTransformTest(unittest.TestCase):
    """Checks the Sim3d / Rotation3d / Reconstruction.transform conventions for real."""

    def test_camera_up_becomes_plus_z_in_a_real_reconstruction(self):
        import pycolmap

        world_up = normalize([0.022, -0.952, 0.304])
        poses = orbit(world_up, count=12, height=1.5)
        reconstruction = pycolmap.Reconstruction()
        camera = pycolmap.Camera.create(1, pycolmap.CameraModelId.SIMPLE_PINHOLE, 100.0, 64, 48)
        reconstruction.add_camera(camera)
        rig = pycolmap.Rig(rig_id=1)
        rig.add_ref_sensor(camera.sensor_id)
        reconstruction.add_rig(rig)
        for index, (rotation, centre) in enumerate(poses, start=1):
            rotation = np.array(rotation)
            frame = pycolmap.Frame(frame_id=index, rig_id=1)
            frame.rig_from_world = pycolmap.Rigid3d(pycolmap.Rotation3d(rotation), -rotation @ np.array(centre))
            image = pycolmap.Image(name=f"{index}.jpg", camera_id=1, image_id=index)
            image.frame_id = index
            frame.add_data_id(image.data_id)
            reconstruction.add_frame(frame)
            reconstruction.add_image(image)
        self.assertEqual(reconstruction.num_reg_images(), 12)
        # World up as each camera sees it; the cameras are pitched down, so it is not -Y.
        seen_before = {image_id: image.cam_from_world().rotation.matrix() @ np.array(world_up)
                       for image_id, image in reconstruction.images.items()}

        with contextlib.redirect_stdout(io.StringIO()):
            result = pipeline.gravity_align(reconstruction)

        self.assertEqual(result["method"], "camera-right")
        for image_id, image in reconstruction.images.items():
            rotation = image.cam_from_world().rotation.matrix()
            # After alignment the same physical direction is world +Z.
            np.testing.assert_allclose(rotation @ np.array([0.0, 0.0, 1.0]), seen_before[image_id], atol=1e-9)
            self.assertAlmostEqual(float(rotation[0][2]), 0.0, places=9)  # right axes are level
            # The orbit sits 1.5 above the origin along world up, which is now +Z.
            self.assertAlmostEqual(float(image.projection_center()[2]), 1.5, places=6)


@unittest.skipUnless(Image is not None, "Pillow is not installed")
class NormalisePhotosTest(unittest.TestCase):
    def test_applies_orientation_six_and_strips_the_tag(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory, "photos"), Path(directory, "images")
            source.mkdir()
            # Stored landscape 64x32 with a red left half; orientation 6 means "rotate 90
            # degrees clockwise to display", so the upright image is 32x64, red on top.
            stored = Image.new("RGB", (64, 32), (0, 0, 255))
            stored.paste((255, 0, 0), (0, 0, 32, 32))
            exif = Image.Exif()
            exif[0x0112] = 6
            exif[0x010F] = "TestMake"
            stored.save(source / "frame_00000.jpg", "JPEG", quality=95, exif=exif.tobytes())
            Image.new("RGB", (16, 8), (0, 255, 0)).save(source / "frame_00001.png")
            (source / "notes.txt").write_text("not a photo")

            rotated, skipped = pipeline.normalise_photos(source, destination)

            self.assertEqual((rotated, skipped), (1, 0))
            self.assertEqual(sorted(path.name for path in destination.iterdir()),
                             ["frame_00000.jpg", "frame_00001.png"])
            with Image.open(destination / "frame_00000.jpg") as upright:
                self.assertEqual(upright.size, (32, 64))
                self.assertNotIn(0x0112, upright.getexif())
                self.assertEqual(upright.getexif().get(0x010F), "TestMake")
                red, _, blue = upright.convert("RGB").getpixel((16, 8))
                self.assertGreater(red, 200)
                self.assertLess(blue, 60)
                _, _, blue = upright.convert("RGB").getpixel((16, 56))
                self.assertGreater(blue, 200)
            self.assertEqual((destination / "frame_00001.png").read_bytes(),
                             (source / "frame_00001.png").read_bytes())

    def test_rotation_keeps_35mm_focal_length_and_chroma_subsampling(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory, "photos"), Path(directory, "images")
            source.mkdir()
            exif = Image.Exif()
            exif[0x0112] = 6
            exif.get_ifd(0x8769)[0xA405] = 26  # FocalLengthIn35mmFilm, in the Exif sub-IFD
            Image.new("RGB", (64, 32), (90, 140, 200)).save(
                source / "frame_00000.jpg", "JPEG", quality=95, subsampling=0, exif=exif.tobytes())

            self.assertEqual(pipeline.normalise_photos(source, destination), (1, 0))

            with Image.open(destination / "frame_00000.jpg") as upright:
                self.assertEqual(upright.size, (32, 64))
                self.assertEqual(upright.getexif().get_ifd(0x8769).get(0xA405), 26)
                self.assertEqual(JpegImagePlugin.get_sampling(upright), 0)  # 4:4:4 kept, not 4:2:0

    def test_unreadable_files_are_skipped_and_stale_output_is_cleared(self):
        with tempfile.TemporaryDirectory() as directory:
            source, destination = Path(directory, "photos"), Path(directory, "images")
            source.mkdir()
            destination.mkdir()
            (destination / "frame_99999.jpg").write_bytes(b"left over from an earlier attempt")
            (source / "frame_00000.jpg").write_bytes(b"this is not a JPEG")
            Image.new("RGB", (16, 8)).save(source / "frame_00001.jpg", "JPEG")

            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(pipeline.normalise_photos(source, destination), (0, 1))

            self.assertEqual([path.name for path in destination.iterdir()], ["frame_00001.jpg"])
            self.assertIn("Warning: skipping frame_00000.jpg", output.getvalue())


class MatcherChoiceTest(unittest.TestCase):
    def test_exhaustive_up_to_one_hundred_photos(self):
        self.assertEqual(pipeline.choose_matcher(8), "exhaustive")
        self.assertEqual(pipeline.choose_matcher(100), "exhaustive")
        self.assertEqual(pipeline.choose_matcher(101), "sequential")
        self.assertEqual(pipeline.choose_matcher(200), "sequential")

    def test_sequential_retries_exhaustively_below_ninety_percent(self):
        self.assertTrue(pipeline.needs_exhaustive_retry("sequential", 179, 200))
        self.assertFalse(pipeline.needs_exhaustive_retry("sequential", 180, 200))
        self.assertTrue(pipeline.needs_exhaustive_retry("sequential", 0, 150))
        self.assertFalse(pipeline.needs_exhaustive_retry("exhaustive", 10, 100))

    def test_no_exhaustive_retry_above_three_hundred_photos(self):
        self.assertTrue(pipeline.needs_exhaustive_retry("sequential", 200, 300))
        self.assertFalse(pipeline.needs_exhaustive_retry("sequential", 200, 301))

    def test_thread_count_uses_all_cores_unless_overridden(self):
        with mock.patch.object(pipeline.os, "cpu_count", return_value=10):
            self.assertEqual(pipeline.thread_count({}), 10)
            self.assertEqual(pipeline.thread_count({"SPATIAL_COLMAP_THREADS": "3"}), 3)
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(pipeline.thread_count({"SPATIAL_COLMAP_THREADS": "zero"}), 10)
                self.assertEqual(pipeline.thread_count({"SPATIAL_COLMAP_THREADS": "0"}), 10)
        with mock.patch.object(pipeline.os, "cpu_count", return_value=None):
            self.assertEqual(pipeline.thread_count({}), 4)


class FakeReconstruction:
    def __init__(self, registered):
        self.registered = registered
        self.written = []

    def num_reg_images(self):
        return self.registered

    def num_points3D(self):
        return 1000

    def write(self, path):
        self.written.append(path)


class AlignOrchestrationTest(unittest.TestCase):
    def run_align(self, count, registered_per_mapping):
        calls = []
        mappings = iter(registered_per_mapping)
        self.models = []
        module = types.ModuleType("pycolmap")
        module.Device = types.SimpleNamespace(cpu="cpu")
        module.FeatureExtractionOptions = lambda: types.SimpleNamespace(sift=types.SimpleNamespace())
        module.FeatureMatchingOptions = types.SimpleNamespace
        module.SequentialPairingOptions = types.SimpleNamespace
        module.IncrementalPipelineOptions = types.SimpleNamespace
        module.UndistortCameraOptions = types.SimpleNamespace
        module.extract_features = lambda *args, **kwargs: calls.append(("extract", kwargs["extraction_options"].num_threads))
        module.match_exhaustive = lambda *args, **kwargs: calls.append(("exhaustive",))
        module.match_sequential = lambda *args, **kwargs: calls.append(
            ("sequential", kwargs["pairing_options"].overlap, kwargs["pairing_options"].loop_detection))

        def incremental_mapping(database, images, sparse, options):
            calls.append(("map", options.num_threads))
            self.models.append(FakeReconstruction(next(mappings)))
            return {0: self.models[-1]}

        module.incremental_mapping = incremental_mapping
        module.undistort_images = lambda output, sparse, *args, **kwargs: calls.append(
            ("undistort", Path(sparse).relative_to(Path(output).parent).as_posix()))

        def normalise(source, destination):
            destination.mkdir(parents=True)
            for index in range(count):
                (destination / f"frame_{index:05d}.jpg").write_bytes(b"jpeg")
            return 0, 0

        with tempfile.TemporaryDirectory() as directory, \
                mock.patch.dict(sys.modules, {"pycolmap": module}), \
                mock.patch.object(pipeline, "normalise_photos", normalise), \
                mock.patch.object(pipeline, "gravity_align", return_value={"method": "camera-up", "tilt_degrees": 5.0}), \
                contextlib.redirect_stdout(io.StringIO()):
            pipeline.align(Path(directory, "photos"), Path(directory, "out"), 1200, threads=6)
            summary = Path(directory, "out/alignment.json").read_text()
        return calls, summary

    def test_small_sets_match_exhaustively_once(self):
        calls, summary = self.run_align(64, [64])
        self.assertEqual(calls, [("extract", 6), ("exhaustive",), ("map", 6), ("undistort", "sparse/0")])
        self.assertIn('"matcher": "exhaustive"', summary)

    def test_large_sets_match_sequentially_when_coverage_is_good(self):
        calls, summary = self.run_align(150, [140])
        self.assertEqual(calls, [("extract", 6), ("sequential", 20, False), ("map", 6), ("undistort", "sparse/0")])
        self.assertIn('"matcher": "sequential"', summary)

    def test_large_sets_fall_back_to_exhaustive_below_ninety_percent(self):
        calls, summary = self.run_align(150, [120, 149])
        self.assertEqual(calls, [("extract", 6), ("sequential", 20, False), ("map", 6),
                                 ("exhaustive",), ("map", 6), ("undistort", "sparse-exhaustive/0")])
        self.assertIn('"matcher": "exhaustive"', summary)
        self.assertIn('"registered": 149', summary)

    def test_exhaustive_retry_that_aligns_fewer_photos_keeps_the_sequential_model(self):
        calls, summary = self.run_align(150, [120, 100])
        self.assertEqual(calls, [("extract", 6), ("sequential", 20, False), ("map", 6),
                                 ("exhaustive",), ("map", 6), ("undistort", "sparse/0")])
        self.assertIn('"matcher": "sequential"', summary)
        self.assertIn('"registered": 120', summary)
        self.assertIn('"retry_registered": 100', summary)
        sequential, exhaustive = self.models
        self.assertEqual(len(sequential.written), 1)
        self.assertTrue(sequential.written[0].endswith("sparse/0"))
        self.assertEqual(exhaustive.written, [])

    def test_large_sets_skip_the_exhaustive_retry(self):
        calls, summary = self.run_align(301, [200])
        self.assertEqual(calls, [("extract", 6), ("sequential", 20, False), ("map", 6), ("undistort", "sparse/0")])
        self.assertIn('"retry_registered": null', summary)

    def test_too_few_registered_photos_fail_clearly(self):
        with self.assertRaisesRegex(RuntimeError, "Only 30/64 photos aligned"):
            self.run_align(64, [30])

    def test_no_readable_photos_fail_clearly(self):
        with self.assertRaisesRegex(RuntimeError, "None of the uploaded files is a readable photo"):
            self.run_align(0, [])


if __name__ == "__main__":
    unittest.main()
