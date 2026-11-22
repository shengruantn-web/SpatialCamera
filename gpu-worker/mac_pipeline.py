"""CPU COLMAP alignment for Brush. Invoked in a subprocess so leases can expire safely."""
import argparse
import json
import math
from pathlib import Path


def align(photos, output, max_resolution):
    import pycolmap

    output.mkdir(parents=True, exist_ok=True)
    database = str(output / "database.db")
    sparse = output / "sparse"
    sparse.mkdir()
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.max_image_size = max_resolution
    extraction.num_threads = 4
    extraction.sift.max_num_features = 8192
    pycolmap.extract_features(database, str(photos), extraction_options=extraction,
                             device=pycolmap.Device.cpu)
    matching = pycolmap.FeatureMatchingOptions()
    matching.num_threads = 4
    pycolmap.match_exhaustive(database, matching_options=matching, device=pycolmap.Device.cpu)
    options = pycolmap.IncrementalPipelineOptions()
    options.num_threads = 4
    options.min_model_size = 8
    models = pycolmap.incremental_mapping(database, str(photos), str(sparse), options=options)
    if not models:
        raise RuntimeError("No cameras could be aligned. Use sharp, overlapping photos of a still subject.")
    model_id, model = max(models.items(), key=lambda pair: pair[1].num_reg_images())
    total = sum(p.suffix.lower() in (".jpg", ".jpeg", ".png") for p in photos.iterdir())
    registered = model.num_reg_images()
    if registered < max(8, math.ceil(total * 0.6)):
        raise RuntimeError(f"Only {registered}/{total} photos aligned. Add overlapping views and avoid blur.")
    if model.num_points3D() == 0:
        raise RuntimeError("Alignment produced no 3D points.")
    undistort = pycolmap.UndistortCameraOptions()
    undistort.max_image_size = max_resolution
    dataset = output / "undistorted"
    pycolmap.undistort_images(str(dataset), str(sparse / str(model_id)), str(photos),
                             undistort_options=undistort)
    (output / "alignment.json").write_text(json.dumps({
        "registered": registered, "total": total, "points": model.num_points3D(),
    }))
    print(f"Aligned {registered}/{total} photos with {model.num_points3D()} points.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("photos", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--max-resolution", type=int, default=1200)
    args = parser.parse_args()
    align(args.photos, args.output, args.max_resolution)
