"""Convert a validated Gaussian-splat PLY to SPZ (Niantic's compressed splat format).

Writes the gzip "legacy" SPZ container (versions 2 and 3) that Spark and the reference
library read: a 16-byte header (magic "NGSP", version, point count, SH degree,
fractional bits, flags, reserved) followed by per-attribute streams — 24-bit fixed-point
positions, alphas, colours, scales, rotations, then spherical-harmonic coefficients — and
the whole payload gzip-compressed. Quantisation follows the reference encoder
(nianticlabs/spz `packGaussians`).

Coordinates are written in the PLY's own frame (no RDF→RUB conversion). The viewer applies
the same orientation to PLY and SPZ results, so both formats must carry identical axes.

Needs numpy (present on both worker hosts: the Mac venv via pycolmap, Nerfstudio itself).
The worker treats any failure here, including a missing numpy, as "deliver the PLY only".

Usage: python3 spz.py input.ply output.spz   (prints JSON stats)
"""
import gzip
import json
import math
import os
from pathlib import Path
import struct
import sys
import time

MAGIC = 0x5053474E  # "NGSP" little-endian
HEADER = struct.Struct("<IIIBBBB")
COLOR_SCALE = 0.15
SH_DIMS = {0: 0, 1: 3, 2: 8, 3: 15}
SH1_BUCKET = 1 << (8 - 5)     # degree-1 coefficients keep 5 bits
SH_REST_BUCKET = 1 << (8 - 4)  # higher degrees keep 4 bits
MAX_FRACTIONAL_BITS = 12
MAX_POINTS = 10_000_000
PLY_TYPES = {
    "char": "i1", "int8": "i1", "uchar": "u1", "uint8": "u1",
    "short": "<i2", "int16": "<i2", "ushort": "<u2", "uint16": "<u2",
    "int": "<i4", "int32": "<i4", "uint": "<u4", "uint32": "<u4",
    "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
}
REQUIRED = ("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
            "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")


class SpzError(ValueError):
    pass


def read_ply_header(path):
    """Returns (header_length, vertex_count, [(name, numpy dtype)]) for a binary little-endian PLY."""
    with Path(path).open("rb") as source:
        if source.readline(80).strip() != b"ply":
            raise SpzError("missing PLY signature")
        count, element, properties = None, None, []
        while True:
            line = source.readline(65537)
            if not line or source.tell() > 1024 * 1024:
                raise SpzError("missing or oversized PLY header")
            fields = line.decode("ascii").split()
            if not fields or fields[0] in ("comment", "obj_info"):
                continue
            if fields == ["end_header"]:
                break
            if fields[0] == "format" and fields[1:] != ["binary_little_endian", "1.0"]:
                raise SpzError("PLY must be binary_little_endian 1.0")
            if fields[0] == "element":
                element = fields[1]
                if element == "vertex":
                    count = int(fields[2])
                elif int(fields[2]) != 0:
                    raise SpzError("only vertex payloads are supported")
            elif fields[0] == "property" and element == "vertex":
                if len(fields) != 3 or fields[1] not in PLY_TYPES:
                    raise SpzError("unsupported PLY property")
                properties.append((fields[2], PLY_TYPES[fields[1]]))
        return source.tell(), count, properties


def read_gaussians(path):
    """Reads the Gaussian attributes by property name (Brush, for one, sorts them alphabetically)."""
    import numpy as np

    header_length, count, properties = read_ply_header(path)
    names = [name for name, _ in properties]
    missing = [name for name in REQUIRED if name not in names]
    if missing:
        raise SpzError("not a Gaussian-splat PLY; missing " + ", ".join(missing))
    if not count or count <= 0 or count > MAX_POINTS:
        raise SpzError(f"vertex count must be 1–{MAX_POINTS}")
    dtype = np.dtype(properties)
    if header_length + count * dtype.itemsize != os.path.getsize(path):
        raise SpzError("file size does not match the PLY header")
    rows = np.memmap(path, dtype=dtype, mode="r", offset=header_length, shape=(count,))

    def columns(*keys):
        return np.stack([np.asarray(rows[key], dtype=np.float32) for key in keys], axis=1)

    rest = sorted((name for name in names if name.startswith("f_rest_")), key=lambda name: int(name[7:]))
    if [int(name[7:]) for name in rest] != list(range(len(rest))) or len(rest) % 3:
        raise SpzError("f_rest_* coefficients must be numbered 0..3k-1")
    return {
        "positions": columns("x", "y", "z"),
        "colors": columns("f_dc_0", "f_dc_1", "f_dc_2"),
        "alphas": columns("opacity")[:, 0],
        "scales": columns("scale_0", "scale_1", "scale_2"),
        # PLY stores w first; SPZ (and the reference library) use x, y, z, w.
        "rotations": columns("rot_1", "rot_2", "rot_3", "rot_0"),
        "sh": columns(*rest) if rest else np.zeros((count, 0), dtype=np.float32),
    }


def sh_degree_for(coefficients):
    per_channel = coefficients // 3
    return max(degree for degree, dims in SH_DIMS.items() if dims <= per_channel)


def to_uint8(values):
    import numpy as np
    # std::round (half away from zero) on clamped non-negative input.
    return np.clip(np.floor(np.nan_to_num(values, nan=0.0) + 0.5), 0, 255).astype(np.uint8)


def fractional_bits_for(positions):
    import numpy as np
    if not np.isfinite(positions).all():
        raise SpzError("positions must be finite")
    extent = float(np.abs(positions).max(initial=0.0))
    for bits in range(MAX_FRACTIONAL_BITS, -1, -1):
        if math.floor(extent * (1 << bits) + 0.5) <= (1 << 23) - 1:
            return bits
    raise SpzError("scene extent exceeds the 24-bit SPZ position range")


def pack_positions(positions, bits):
    import numpy as np
    fixed = np.floor(positions.astype(np.float64) * (1 << bits) + 0.5).astype(np.int32)
    # Little-endian 24-bit two's complement per coordinate, coordinates interleaved x, y, z.
    return (fixed.reshape(-1).astype("<i4").view(np.uint8).reshape(-1, 4)[:, :3]).tobytes()


def pack_rotations(rotations, version):
    import numpy as np
    q = np.nan_to_num(rotations.astype(np.float64))
    norms = np.linalg.norm(q, axis=1, keepdims=True)
    q = np.where(norms > 0, q / np.where(norms > 0, norms, 1), np.array([0.0, 0.0, 0.0, 1.0]))
    if version < 3:
        # "First three": force w >= 0, store x, y, z.
        q = np.where(q[:, 3:4] < 0, -q, q)
        return to_uint8(q[:, :3] * 127.5 + 127.5).tobytes()
    # "Smallest three": 2-bit index of the largest |component|, then the other three as
    # sign bit + 9-bit magnitude scaled by 1/sqrt(1/2), packed into a little-endian uint32.
    largest = np.argmax(np.abs(q), axis=1)
    negate = np.take_along_axis(q, largest[:, None], axis=1)[:, 0] < 0
    packed = largest.astype(np.uint32)
    for i in range(4):
        keep = largest != i
        negbit = ((q[:, i] < 0) ^ negate).astype(np.uint32)
        magnitude = np.minimum(np.floor(511.0 * (np.abs(q[:, i]) / math.sqrt(0.5)) + 0.5), 511).astype(np.uint32)
        packed = np.where(keep, (packed << 10) | (negbit << 9) | magnitude, packed)
    return packed.astype("<u4").tobytes()


def quantize_sh(values, bucket):
    import numpy as np
    q = np.floor(np.nan_to_num(values.astype(np.float64)) * 128.0 + 0.5) + 128.0
    q = np.floor((q + bucket // 2) / bucket) * bucket
    return np.clip(q, 0, 255).astype(np.uint8)


def pack_sh(sh, degree):
    import numpy as np
    dims = SH_DIMS[degree]
    if not dims:
        return b""
    count = sh.shape[0]
    file_dims = sh.shape[1] // 3
    # PLY f_rest is channel-major (all R coefficients, then G, then B); SPZ interleaves
    # R, G, B per coefficient.
    channels = sh.reshape(count, 3, file_dims)[:, :, :dims].transpose(0, 2, 1)
    out = np.empty((count, dims, 3), dtype=np.uint8)
    out[:, :3] = quantize_sh(channels[:, :3], SH1_BUCKET)
    if dims > 3:
        out[:, 3:] = quantize_sh(channels[:, 3:], SH_REST_BUCKET)
    return out.tobytes()


def encode(gaussians, version=3, compresslevel=6):
    import numpy as np
    if version not in (2, 3):
        raise SpzError("only SPZ versions 2 and 3 are written")
    count = gaussians["positions"].shape[0]
    degree = sh_degree_for(gaussians["sh"].shape[1])
    bits = fractional_bits_for(gaussians["positions"])
    alphas = 1.0 / (1.0 + np.exp(-np.clip(gaussians["alphas"].astype(np.float64), -60, 60)))
    payload = b"".join((
        HEADER.pack(MAGIC, version, count, degree, bits, 0, 0),
        pack_positions(gaussians["positions"], bits),
        to_uint8(alphas * 255.0).tobytes(),
        to_uint8(gaussians["colors"].astype(np.float64) * (COLOR_SCALE * 255.0) + 0.5 * 255.0).tobytes(),
        to_uint8((gaussians["scales"].astype(np.float64) + 10.0) * 16.0).tobytes(),
        pack_rotations(gaussians["rotations"], version),
        pack_sh(gaussians["sh"], degree),
    ))
    # mtime=0 keeps the output deterministic for a given PLY.
    return gzip.compress(payload, compresslevel=compresslevel, mtime=0), {
        "points": count, "sh_degree": degree, "fractional_bits": bits, "version": version,
        "uncompressed_bytes": len(payload),
    }


def convert(ply_path, spz_path, version=3):
    """Writes spz_path atomically and returns stats. Raises on any problem (caller falls back to PLY)."""
    started = time.monotonic()
    data, stats = encode(read_gaussians(ply_path), version)
    spz_path = Path(spz_path)
    partial = spz_path.with_name(spz_path.name + ".partial")
    partial.write_bytes(data)
    os.replace(partial, spz_path)
    return {**stats, "ply_bytes": os.path.getsize(ply_path), "spz_bytes": len(data),
            "seconds": round(time.monotonic() - started, 3)}


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        sys.exit("usage: spz.py input.ply output.spz [version]")
    print(json.dumps(convert(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) == 4 else 3)))
