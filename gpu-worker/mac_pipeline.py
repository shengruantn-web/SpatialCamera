"""CPU COLMAP alignment for Brush. Invoked in a subprocess so leases can expire safely.

Steps: normalise EXIF orientation, SIFT extraction, matching (exhaustive for small
sets, sequential with an exhaustive fallback for mid-sized ones), incremental mapping,
gravity alignment (world up = +Z, the frame the viewer expects), undistortion.
"""
import argparse
import json
import math
import os
from pathlib import Path
import shutil

PHOTO_SUFFIXES = (".jpg", ".jpeg", ".png")
EXIF_ORIENTATION = 0x0112
EXHAUSTIVE_LIMIT = 100
SEQUENTIAL_OVERLAP = 20
MIN_SEQUENTIAL_RATIO = 0.9
# Exhaustive matching is O(N^2); past this many photos a retry would outlast the job.
MAX_EXHAUSTIVE_RETRY = 300
# Mean of unit camera-up vectors: ~1 when photos are held level, ~0 when rolls disagree.
MIN_UP_CONSISTENCY = 0.5
# A set of vectors (camera right axes, or centred camera positions) counts as planar
# when its thinnest spread is < 30% of the middle one.
MAX_PLANE_THICKNESS = 0.3
# A plane normal's sign is taken from the mean up; below this it is a coin toss.
MIN_SIGN_AGREEMENT = 0.05
# Relative singular-value floor below which a spread is treated as degenerate.
DEGENERATE_RATIO = 1e-6


def thread_count(environ=os.environ):
    """COLMAP threads: SPATIAL_COLMAP_THREADS if set to a positive integer, else all cores."""
    value = environ.get("SPATIAL_COLMAP_THREADS", "").strip()
    if value:
        try:
            if int(value) > 0:
                return int(value)
        except ValueError:
            pass
        print(f"Ignoring invalid SPATIAL_COLMAP_THREADS={value!r}.", flush=True)
    return os.cpu_count() or 4


def choose_matcher(count):
    """Exhaustive matching is quadratic; past EXHAUSTIVE_LIMIT photos use sequential pairs."""
    return "exhaustive" if count <= EXHAUSTIVE_LIMIT else "sequential"


def sequential_lost_photos(matcher, registered, total):
    return matcher == "sequential" and registered < MIN_SEQUENTIAL_RATIO * total


def needs_exhaustive_retry(matcher, registered, total):
    """Sequential matching misses loop closures; retry exhaustively if it lost photos,
    unless the set is so large that quadratic matching would outlast the job."""
    return sequential_lost_photos(matcher, registered, total) and total <= MAX_EXHAUSTIVE_RETRY


def list_photos(directory):
    return sorted(path for path in directory.iterdir() if path.suffix.lower() in PHOTO_SUFFIXES)


def normalise_photos(source, destination):
    """Copy photos with EXIF orientation applied to the pixels and the tag removed.

    COLMAP ignores the orientation tag, so a portrait phone shot stored sideways would
    otherwise be matched sideways and skew the camera-up estimate used for gravity.
    Upright photos are linked or copied byte for byte; rotated ones are re-encoded with
    their remaining EXIF (focal length, camera model) kept for COLMAP's intrinsics prior
    and their chroma subsampling kept. Files Pillow cannot read are skipped with a
    warning. Returns (rotated, skipped).
    """
    from PIL import Image, ImageOps, JpegImagePlugin

    if destination.exists():
        shutil.rmtree(destination)  # a retried job must not inherit stale or skipped frames
    destination.mkdir(parents=True)
    rotated = skipped = 0
    for path in list_photos(source):
        target = destination / path.name
        try:
            with Image.open(path) as image:
                exif = image.getexif()
                upright_already = exif.get(EXIF_ORIENTATION, 1) in (0, 1)
                if not upright_already:
                    upright = ImageOps.exif_transpose(image)
                    exif.pop(EXIF_ORIENTATION, None)
                    options = {"exif": exif.tobytes()}
                    if image.info.get("icc_profile"):
                        options["icc_profile"] = image.info["icc_profile"]
                    if image.format == "JPEG" or path.suffix.lower() in (".jpg", ".jpeg"):
                        if upright.mode not in ("RGB", "L"):
                            upright = upright.convert("RGB")
                        # subsampling="keep" only works on the JPEG object itself, not
                        # the transposed copy, so pass the source's sampling explicitly.
                        sampling = JpegImagePlugin.get_sampling(image) if image.format == "JPEG" else -1
                        if sampling != -1:
                            options["subsampling"] = sampling
                        upright.save(target, "JPEG", quality=95, **options)
                    else:
                        upright.save(target, "PNG", **options)
                    rotated += 1
        except (OSError, ValueError, SyntaxError) as error:  # UnidentifiedImageError is an OSError
            target.unlink(missing_ok=True)
            skipped += 1
            print(f"Warning: skipping {path.name}; it is not a readable image ({error}).", flush=True)
            continue
        if upright_already:
            try:
                os.link(path, target)
            except OSError:
                shutil.copy2(path, target)
    return rotated, skipped


def rotation_to_z(up):
    """Rotation matrix (3x3 nested lists) taking unit vector `up` to +Z (Rodrigues)."""
    x, y, z = up
    if z < -0.999999:
        return [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]]
    # v = up x Z = (y, -x, 0); R = I + [v]x + [v]x^2 / (1 + up.Z)
    k = [[0.0, 0.0, -x], [0.0, 0.0, -y], [x, y, 0.0]]
    k2 = [[sum(k[i][m] * k[m][j] for m in range(3)) for j in range(3)] for i in range(3)]
    scale = 1.0 / (1.0 + z)
    return [[(i == j) + k[i][j] + k2[i][j] * scale for j in range(3)] for i in range(3)]


def principal_axes(vectors):
    """Singular values (descending) and right singular vectors (rows) of stacked vectors."""
    import numpy as np

    _, singular, axes = np.linalg.svd(np.asarray(vectors, dtype=float), full_matrices=False)
    return singular, axes


def estimate_up(camera_rights, camera_ups, centres):
    """Estimate world up from per-image camera right/up axes and camera centres.

    Returns (unit vector or None, method), trying in order:
    - "camera-right": photos are held without roll, so every camera's right axis is
      horizontal whatever its pitch. Up is the direction most perpendicular to all of
      them (smallest singular vector of the stacked right axes, minimising the sum of
      (g . right)^2), signed to agree with the mean camera up. Needs the right axes to
      span a plane (cameras facing more than one direction) and to lie close to it
      (rolls consistent).
    - "camera-up": the normalised mean camera up, when the photos agree on it. Biased by
      the mean pitch on paths that are not closed orbits, so only a fallback (e.g. a
      straight facade walk where every camera faces the same way).
    - "centre-plane": the normal of the plane through the camera centres (a walk around
      the subject), signed to agree with the mean up.
    - "none": nothing reliable; the caller leaves the model unrotated.
    """
    import numpy as np

    ups = np.asarray(camera_ups, dtype=float)
    mean_up = ups.mean(axis=0)
    rights = np.asarray(camera_rights, dtype=float)
    if len(rights) >= 3:
        singular, axes = principal_axes(rights)
        normal = axes[-1]
        agreement = float(normal @ mean_up)
        if singular[1] > DEGENERATE_RATIO * singular[0] \
                and singular[2] < MAX_PLANE_THICKNESS * singular[1] \
                and abs(agreement) >= MIN_SIGN_AGREEMENT:
            return normal * math.copysign(1.0, agreement), "camera-right"
    strength = float(np.linalg.norm(mean_up))
    if strength >= MIN_UP_CONSISTENCY:
        return mean_up / strength, "camera-up"
    points = np.asarray(centres, dtype=float)
    if len(points) >= 3:
        singular, axes = principal_axes(points - points.mean(axis=0))
        normal = axes[-1]
        agreement = float(normal @ mean_up)
        if singular[1] > DEGENERATE_RATIO * singular[0] \
                and singular[2] < MAX_PLANE_THICKNESS * singular[1] \
                and abs(agreement) >= MIN_SIGN_AGREEMENT:
            return normal * math.copysign(1.0, agreement), "centre-plane"
    return None, "none"


def gravity_align(model):
    """Rotate a pycolmap Reconstruction in place so the estimated world up is +Z.

    COLMAP's world frame is arbitrary (usually the first camera's: up = -Y), but the
    viewer assumes Z-up results. The rows of a world-to-camera rotation are the camera's
    right, down and forward axes in world coordinates, so right = row 0, up = -row 1.
    """
    import numpy as np
    import pycolmap

    images = list(model.images.values())
    rotations = [image.cam_from_world().rotation.matrix() for image in images]
    rights = [rotation[0] for rotation in rotations]
    ups = [-rotation[1] for rotation in rotations]
    centres = [image.projection_center() for image in images]
    up, method = estimate_up(rights, ups, centres)
    if up is None:
        print("Warning: could not estimate gravity (photo rolls disagree and cameras are not "
              "on a plane); leaving the model unrotated, so it may display tilted.", flush=True)
        return {"method": method, "tilt_degrees": None}
    tilt = math.degrees(math.acos(max(-1.0, min(1.0, float(up[2])))))
    rotation = np.array(rotation_to_z([float(value) for value in up]))
    model.transform(pycolmap.Sim3d(1.0, pycolmap.Rotation3d(rotation), np.zeros(3)))
    print(f"Gravity-aligned the model ({method}, rotated {tilt:.1f} degrees).", flush=True)
    return {"method": method, "tilt_degrees": round(tilt, 1)}


def match(database, matcher, threads):
    import pycolmap

    options = pycolmap.FeatureMatchingOptions()
    options.num_threads = threads
    if matcher == "exhaustive":
        pycolmap.match_exhaustive(database, matching_options=options, device=pycolmap.Device.cpu)
    else:
        pairing = pycolmap.SequentialPairingOptions()
        pairing.overlap = SEQUENTIAL_OVERLAP
        pairing.quadratic_overlap = True
        pairing.loop_detection = False  # needs a vocabulary tree we do not ship
        pycolmap.match_sequential(database, matching_options=options, pairing_options=pairing,
                                  device=pycolmap.Device.cpu)


def reconstruct(database, images, sparse, threads):
    import pycolmap

    if sparse.exists():
        shutil.rmtree(sparse)
    sparse.mkdir()
    options = pycolmap.IncrementalPipelineOptions()
    options.num_threads = threads
    options.min_model_size = 8
    models = pycolmap.incremental_mapping(database, str(images), str(sparse), options=options)
    if not models:
        return None, None
    return max(models.items(), key=lambda pair: pair[1].num_reg_images())


def align(photos, output, max_resolution, threads=None):
    import pycolmap

    threads = threads or thread_count()
    output.mkdir(parents=True, exist_ok=True)
    images = output / "images"
    rotated, skipped = normalise_photos(photos, images)
    total = len(list_photos(images))
    if total == 0:
        raise RuntimeError("None of the uploaded files is a readable photo.")
    database = str(output / "database.db")
    sparse = output / "sparse"
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.max_image_size = max_resolution
    extraction.num_threads = threads
    extraction.sift.max_num_features = 8192
    pycolmap.extract_features(database, str(images), extraction_options=extraction,
                              device=pycolmap.Device.cpu)
    matcher = choose_matcher(total)
    match(database, matcher, threads)
    model_id, model = reconstruct(database, images, sparse, threads)
    registered = model.num_reg_images() if model else 0
    retry_registered = None
    if needs_exhaustive_retry(matcher, registered, total):
        print(f"Sequential matching aligned {registered}/{total} photos; retrying exhaustively.", flush=True)
        match(database, "exhaustive", threads)  # pairs already matched are skipped
        retry_sparse = output / "sparse-exhaustive"
        retry_id, retry = reconstruct(database, images, retry_sparse, threads)
        retry_registered = retry.num_reg_images() if retry else 0
        if retry_registered > registered:
            matcher, sparse, model_id, model, registered = "exhaustive", retry_sparse, retry_id, retry, retry_registered
        else:
            print(f"Exhaustive retry aligned only {retry_registered}/{total} photos; "
                  "keeping the sequential model.", flush=True)
    elif sequential_lost_photos(matcher, registered, total):
        print(f"Sequential matching aligned {registered}/{total} photos; not retrying exhaustively "
              f"above {MAX_EXHAUSTIVE_RETRY} photos.", flush=True)
    if model is None:
        raise RuntimeError("No cameras could be aligned. Use sharp, overlapping photos of a still subject.")
    if registered < max(8, math.ceil(total * 0.6)):
        raise RuntimeError(f"Only {registered}/{total} photos aligned. Add overlapping views and avoid blur.")
    if model.num_points3D() == 0:
        raise RuntimeError("Alignment produced no 3D points.")
    gravity = gravity_align(model)
    model.write(str(sparse / str(model_id)))
    undistort = pycolmap.UndistortCameraOptions()
    undistort.max_image_size = max_resolution
    pycolmap.undistort_images(str(output / "undistorted"), str(sparse / str(model_id)), str(images),
                              undistort_options=undistort)
    (output / "alignment.json").write_text(json.dumps({
        "registered": registered, "total": total, "points": model.num_points3D(),
        "matcher": matcher, "retry_registered": retry_registered, "threads": threads,
        "exif_rotated": rotated, "skipped": skipped, "gravity": gravity,
    }))
    print(f"Aligned {registered}/{total} photos with {model.num_points3D()} points "
          f"({matcher} matching, {threads} threads, {rotated} photos EXIF-rotated, "
          f"{skipped} unreadable files skipped).", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photos", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-resolution", type=int, default=1200)
    args = parser.parse_args()
    align(args.photos, args.output, args.max_resolution)
