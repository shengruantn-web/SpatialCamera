import gzip
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("spatial_camera_spz_test", Path(__file__).parents[1] / "spz.py")
spz = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spz)

try:
    import numpy  # noqa: F401
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

# Brush writes properties alphabetically; the converter must map them by name.
NAMES = sorted(["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2",
                "rot_0", "rot_1", "rot_2", "rot_3"] + [f"f_rest_{i}" for i in range(9)])


def ply(rows, names=NAMES, types=None):
    types = types or {}
    header = ("ply\nformat binary_little_endian 1.0\n"
              f"element vertex {len(rows)}\n"
              + "".join(f"property {types.get(name, 'float')} {name}\n" for name in names)
              + "end_header\n").encode("ascii")
    codes = "".join({"float": "f", "double": "d", "uchar": "B"}[types.get(name, "float")] for name in names)
    return header + b"".join(struct.pack("<" + codes, *(row.get(name, 0.0) for name in names)) for row in rows)


def row(**values):
    base = {"rot_0": 1.0, "opacity": 0.0, "scale_0": -2.0, "scale_1": -2.0, "scale_2": -2.0}
    return {**base, **values}


@unittest.skipUnless(HAS_NUMPY, "SPZ conversion needs numpy")
class SpzTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def convert(self, data, version=3):
        source, target = self.root / "in.ply", self.root / "out.spz"
        source.write_bytes(data)
        stats = spz.convert(source, target, version)
        return stats, gzip.decompress(target.read_bytes()), target.read_bytes()

    def test_header_layout_and_exact_byte_values(self):
        stats, payload, _ = self.convert(ply([row(x=1.0, y=-2.0, z=0.5, f_dc_0=0.0, opacity=0.0, f_rest_0=0.5,
                                                  f_rest_3=-0.25)]))
        magic, version, count, degree, bits, flags, reserved = struct.unpack_from("<IIIBBBB", payload)
        self.assertEqual((magic, version, count, degree, bits, flags, reserved), (0x5053474E, 3, 1, 1, 12, 0, 0))
        self.assertEqual(stats["uncompressed_bytes"], len(payload))
        self.assertEqual(len(payload), 16 + 9 + 1 + 3 + 3 + 4 + 9)
        position = payload[16:25]
        self.assertEqual([int.from_bytes(position[i:i + 3], "little", signed=True) for i in (0, 3, 6)],
                         [4096, -8192, 2048])
        self.assertEqual(payload[25], 128)  # sigmoid(0) * 255, rounded half away from zero.
        self.assertEqual(payload[26], 128)  # f_dc 0 -> 0.5 * 255.
        self.assertEqual(payload[29], 128)  # log scale -2 -> (−2 + 10) * 16.
        # Identity quaternion (PLY w first) -> largest index 3 (w), other components 0.
        self.assertEqual(struct.unpack_from("<I", payload, 32)[0], 3 << 30)
        # SH is R, G, B per coefficient; PLY f_rest is channel-major (R0 R1 R2, G0 ...), so
        # f_rest_0 is (coeff 0, R) and f_rest_3 is (coeff 0, G).
        self.assertEqual(list(payload[36:45]), [192, 96, 128, 128, 128, 128, 128, 128, 128])

    def test_v2_header_and_rotation_bytes(self):
        _, payload, _ = self.convert(ply([row()]), version=2)
        self.assertEqual(struct.unpack_from("<I", payload, 4)[0], 2)
        self.assertEqual(list(payload[32:35]), [128, 128, 128])

    def test_output_is_deterministic(self):
        data = ply([row(x=i * 0.25, opacity=i * 0.1) for i in range(50)])
        self.assertEqual(self.convert(data)[2], self.convert(data)[2])

    def test_fractional_bits_shrink_for_large_scenes(self):
        stats, payload, _ = self.convert(ply([row(x=5000.0)]))
        self.assertEqual(stats["fractional_bits"], 10)
        self.assertEqual(int.from_bytes(payload[16:19], "little", signed=True), 5000 * 1024)

    def test_doubles_and_missing_sh_are_supported(self):
        names = [name for name in NAMES if not name.startswith("f_rest_")]
        stats, payload, _ = self.convert(ply([row(x=0.5)], names, {"x": "double"}))
        self.assertEqual(stats["sh_degree"], 0)
        self.assertEqual(len(payload), 16 + 20)

    def test_rejects_inputs_the_worker_must_deliver_as_ply_only(self):
        cases = {
            "missing": ply([{"x": 0.0}], ["x", "y", "z"]),
            "non-finite": ply([row(x=float("nan"))]),
            "huge": ply([row(x=1e9)]),
            "truncated": ply([row()])[:-1],
            "ascii": b"ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n",
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(spz.SpzError):
                self.convert(data)
        self.assertFalse((self.root / "out.spz").exists())


if __name__ == "__main__":
    unittest.main()
