"""Pull-based Gaussian-splat worker: CUDA/Nerfstudio or Apple Silicon/Brush."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


class Worker:
    def __init__(self, base_url, token, iterations, backend="nerfstudio", brush="brush_app",
                 max_resolution=1200, max_splats=300000):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.iterations = iterations
        self.backend = backend
        self.brush = brush
        self.max_resolution = max_resolution
        self.max_splats = max_splats
        # Optional headers supplied by the chosen hosting gateway; never log them.
        self.gateway_headers = json.loads(os.environ.get("SPATIAL_GATEWAY_HEADERS", "{}"))

    def request(self, path, method="GET", payload=None, lease=None, raw=False):
        headers = {**self.gateway_headers, "Authorization": f"Bearer {self.token}"}
        if lease:
            headers["X-Job-Lease"] = lease
        if isinstance(payload, dict):
            payload = json.dumps(payload).encode()
            headers["Content-Type"] = "application/json"
        elif payload is not None:
            headers["Content-Type"] = "application/octet-stream"
        request = urllib.request.Request(self.base_url + "/api/worker/" + path, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=180) as response:
            data = response.read()
            if raw:
                return data
            try:
                return json.loads(data)
            except json.JSONDecodeError as exc:
                raise RuntimeError("The worker endpoint returned a non-JSON response. Check hosting gateway authentication.") from exc

    def process(self, job):
        job_id, lease = job["id"], job["lease"]
        stage = "aligning"
        stop = threading.Event()
        lease_lost = threading.Event()
        lock = threading.Lock()

        def status(value, error=None):
            nonlocal stage
            with lock:
                self.request(f"{job_id}/status", "PATCH", {"status": value, "error": error}, lease)
                stage = value

        def heartbeat():
            failures = 0
            while not stop.wait(25):
                try:
                    with lock:
                        self.request(f"{job_id}/status", "PATCH", {"status": stage}, lease)
                    failures = 0
                except urllib.error.HTTPError as exc:
                    failures += 1
                    if exc.code in (401, 403, 409) or failures >= 5:
                        lease_lost.set()
                        return
                except Exception:
                    failures += 1
                    if failures >= 5:
                        lease_lost.set()
                        return

        def run(command, log_path):
            with log_path.open("wb") as log:
                process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
                print(f"{stage.capitalize()}: {log_path.name}", flush=True)
                deadline = time.monotonic() + 7200
                try:
                    while process.poll() is None:
                        if lease_lost.wait(2):
                            raise RuntimeError("The server connection or processing lease was lost.")
                        if time.monotonic() > deadline:
                            raise RuntimeError("Processing exceeded the two-hour stage limit.")
                    if process.returncode:
                        # Keep detailed logs on this machine; expose an actionable message to users.
                        print(log_path.read_text(errors="replace")[-6000:], flush=True)
                        raise RuntimeError(f"{stage.capitalize()} failed. Try sharper photos with more overlap and a still subject.")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=10)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait()

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="spatial-capture-") as directory:
                root = Path(directory)
                photos = root / "photos"
                photos.mkdir()
                for index, image in enumerate(job["images"]):
                    if lease_lost.is_set():
                        raise RuntimeError("The processing lease was lost.")
                    extension = ".jpg" if image["mime"] == "image/jpeg" else ".png"
                    data = self.request(f"{job_id}/images/{image['id']}", lease=lease, raw=True)
                    (photos / f"frame_{index:05d}{extension}").write_bytes(data)
                dataset, outputs, exported = root / "dataset", root / "outputs", root / "export"
                if self.backend == "brush":
                    run([sys.executable, str(Path(__file__).with_name("mac_pipeline.py")),
                         str(photos), str(dataset), "--max-resolution", str(self.max_resolution)], root / "alignment.log")
                    status("training")
                    exported.mkdir()
                    run([self.brush, str(dataset / "undistorted"),
                         "--total-steps", str(self.iterations), "--max-resolution", str(self.max_resolution),
                         "--max-splats", str(self.max_splats), "--sh-degree", "2",
                         "--export-every", str(self.iterations), "--export-path", str(exported),
                         "--export-name", "result.ply"], root / "training.log")
                    status("exporting")
                else:
                    run(["ns-process-data", "images", "--data", str(photos), "--output-dir", str(dataset)], root / "alignment.log")
                    transforms = json.loads((dataset / "transforms.json").read_text())
                    registered = len(transforms.get("frames", []))
                    if registered < max(8, int(len(job["images"]) * 0.6)):
                        raise RuntimeError("Too few photos could be aligned. Add overlapping views and avoid blur, mirrors, and moving subjects.")
                    status("training")
                    run(["ns-train", "splatfacto", "--data", str(dataset), "--output-dir", str(outputs),
                         "--max-num-iterations", str(self.iterations), "--vis", "tensorboard",
                         "--viewer.quit-on-train-completion", "True"], root / "training.log")
                    configs = list(outputs.rglob("config.yml"))
                    if len(configs) != 1:
                        raise RuntimeError("The trainer did not produce one complete checkpoint.")
                    status("exporting")
                    run(["ns-export", "gaussian-splat", "--load-config", str(configs[0]), "--output-dir", str(exported)], root / "export.log")
                results = list(exported.glob("*.ply"))
                if len(results) != 1:
                    raise RuntimeError("No Gaussian-splat PLY was produced.")
                if results[0].stat().st_size > 90 * 1024 * 1024:
                    raise RuntimeError("This splat exceeds the prototype's 90 MB delivery limit. Try a smaller scene.")
                # Stop heartbeats before finalization; ready jobs no longer accept their lease.
                stop.set()
                thread.join(timeout=185)
                self.request(f"{job_id}/result", "PUT", results[0].read_bytes(), lease)
                print(f"Completed capture {job_id}", flush=True)
        except Exception as exc:
            stop.set()
            thread.join(timeout=185)
            message = str(exc) if isinstance(exc, RuntimeError) else "Processing could not finish. Check the GPU worker and retry your capture."
            try:
                status("failed", message)
            except Exception:
                print("Could not report failure; the server will expire the job lease.", flush=True)
            print(f"Capture {job_id} failed: {message}", flush=True)
        finally:
            stop.set()

    def serve(self, once=False):
        print(f"Worker started ({self.backend}). Waiting for queued captures.", flush=True)
        while True:
            try:
                result = self.request("claim", "POST", {})
                if result.get("job"):
                    print(f"Claimed capture {result['job']['id']}", flush=True)
                    self.process(result["job"])
                    if once:
                        return
                else:
                    if once:
                        print("No queued captures.", flush=True)
                        return
                    time.sleep(10)
            except KeyboardInterrupt:
                return
            except Exception as exc:
                detail = f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
                print(f"Cannot reach job queue ({detail}). Check the URL, WORKER_TOKEN and gateway access.", flush=True)
                if once:
                    raise
                time.sleep(15)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("SPATIAL_URL", "http://localhost:3000"))
    parser.add_argument("--iterations", type=int, default=7000)
    parser.add_argument("--backend", choices=("nerfstudio", "brush"), default="nerfstudio")
    parser.add_argument("--brush", default=str(Path(__file__).resolve().parent.parent / ".local/bin/brush_app"))
    parser.add_argument("--max-resolution", type=int, default=1200)
    parser.add_argument("--max-splats", type=int, default=300000)
    parser.add_argument("--env-file", type=Path, help="Read WORKER_TOKEN from a local dotenv file without executing it")
    parser.add_argument("--once", action="store_true", help="Process at most one queued capture and exit")
    args = parser.parse_args()
    token = os.environ.get("WORKER_TOKEN", "")
    if not token and args.env_file:
        for line in args.env_file.read_text().splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == "WORKER_TOKEN":
                token = value.strip().strip("\"'")
    if len(token) < 32:
        parser.error("WORKER_TOKEN must contain at least 32 characters and match the web server.")
    if args.iterations < 1000 or args.iterations > 30000:
        parser.error("Choose 1000–30000 iterations.")
    if not 256 <= args.max_resolution <= 4096 or not 1000 <= args.max_splats <= 1000000:
        parser.error("Use resolution 256–4096 and 1,000–1,000,000 splats.")
    if args.backend == "brush":
        try:
            import pycolmap
        except ImportError:
            parser.error("Missing pycolmap. Run npm run setup:mac first.")
    binaries = (args.brush,) if args.backend == "brush" else ("ns-process-data", "ns-train", "ns-export", "colmap", "ffmpeg", "nvidia-smi")
    for binary in binaries:
        if not shutil.which(binary):
            parser.error(f"Missing {binary}. Run npm run setup:mac for Brush, or use a CUDA-enabled Nerfstudio environment.")
    Worker(args.url, token, args.iterations, args.backend, args.brush,
           args.max_resolution, args.max_splats).serve(args.once)
