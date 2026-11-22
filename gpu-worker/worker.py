"""Pull-based Gaussian-splat worker: CUDA/Nerfstudio or Apple Silicon/Brush."""
import argparse
import http.client
import importlib.util
import json
import math
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


MAX_SPZ_BYTES = 48 * 1024 * 1024  # Matches the API's cap; SPZ is typically ~1/7 of the PLY.


def load_spz():
    """The sibling spz.py converter, loaded by path so it works however this file is imported.
    It needs numpy (both worker hosts have it); any import failure means PLY-only delivery."""
    module = sys.modules.get("spatial_camera_spz")
    if module is None:
        spec = importlib.util.spec_from_file_location("spatial_camera_spz", Path(__file__).with_name("spz.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sys.modules["spatial_camera_spz"] = module
    return module


def validate_ply(path):
    types = {
        "char": "b", "int8": "b", "uchar": "B", "uint8": "B",
        "short": "h", "int16": "h", "ushort": "H", "uint16": "H",
        "int": "i", "int32": "i", "uint": "I", "uint32": "I",
        "float": "f", "float32": "f", "double": "d", "float64": "d",
    }

    def invalid(reason):
        raise RuntimeError(f"Invalid Gaussian-splat PLY: {reason}")

    with path.open("rb") as source:
        if source.readline(80).strip() != b"ply":
            invalid("missing PLY signature.")
        vertex_count = None
        element = None
        properties = []
        names = set()
        has_format = False
        while True:
            line = source.readline(65537)
            if not line or len(line) > 65536 or source.tell() > 1024 * 1024:
                invalid("missing or oversized ASCII header.")
            try:
                fields = line.decode("ascii").split()
            except UnicodeDecodeError:
                invalid("header must be ASCII.")
            if not fields:
                invalid("empty header directive.")
            if fields[0] in ("comment", "obj_info"):
                continue
            if fields == ["end_header"]:
                break
            if fields[0] == "format":
                if has_format or fields != ["format", "binary_little_endian", "1.0"]:
                    invalid("format must be binary_little_endian 1.0.")
                has_format = True
            elif fields[0] == "element" and len(fields) == 3:
                try:
                    count = int(fields[2])
                except ValueError:
                    invalid("element count must be an integer.")
                element = fields[1]
                if element == "vertex":
                    if vertex_count is not None or count <= 0:
                        invalid("expected one vertex element with N > 0.")
                    vertex_count = count
                elif count != 0:
                    invalid("only vertex payloads are supported.")
            elif fields[0] == "property":
                if element is None or len(fields) != 3 or fields[1] not in types:
                    invalid("properties must use supported scalar types; lists are not supported.")
                if element == "vertex":
                    if fields[2] in names:
                        invalid("duplicate vertex property.")
                    names.add(fields[2])
                    properties.append((fields[2], types[fields[1]]))
            else:
                invalid("unrecognized header directive.")
        if not has_format or vertex_count is None:
            invalid("missing binary format or vertex element.")
        if not all(any(name == axis and kind in "fd" for name, kind in properties)
                   for axis in ("x", "y", "z")):
            invalid("x, y and z must be float or double properties.")
        vertex = struct.Struct("<" + "".join(kind for _, kind in properties))
        header_len = source.tell()
        if header_len + vertex_count * vertex.size != os.fstat(source.fileno()).st_size:
            invalid("file size does not match header length + vertex count × stride.")
        position_indices = [i for i, (name, _) in enumerate(properties) if name in ("x", "y", "z")]
        sample_count = min(vertex_count, 1000)
        for sample in range(sample_count):
            index = sample * (vertex_count - 1) // max(1, sample_count - 1)
            source.seek(header_len + index * vertex.size)
            data = source.read(vertex.size)
            if len(data) != vertex.size:
                invalid("truncated vertex payload.")
            values = vertex.unpack(data)
            if any(not math.isfinite(values[i]) for i in position_indices):
                invalid(f"non-finite float value at vertex {index}.")


def terminate_process_group(process, timeout=10):
    def signal_group(sig):
        process.poll()  # Reap a zombie leader before killpg (required on macOS).
        try:
            os.killpg(process.pid, sig)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            # macOS can deny killpg while the leader is still exiting.
            # Keep waiting if it cannot yet be reaped, including after SIGKILL.
            return process.poll() is None

    if not signal_group(signal.SIGTERM):
        process.wait()
        return
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not signal_group(0):
            process.wait()
            return
        time.sleep(min(0.05, max(0, deadline - time.monotonic())))
    signal_group(signal.SIGKILL)
    process.wait()


class ExitSignals:
    """Turns SIGTERM/SIGHUP (and Ctrl-C) into exceptions only at safe points.

    A handler that raises at an arbitrary bytecode can escape Popen after the
    child exists (orphaning its new session) or leak Popen's waitpid lock
    between acquire() and try (so the final wait() blocks forever). While the
    main thread owns a stage's process group, signals are recorded and raised
    from sleep() or once the group has been terminated.
    """

    def __init__(self):
        self.depth = 0
        self.interruptible = False
        self.pending = None

    def install(self):
        signals = [signal.SIGTERM, signal.SIGHUP]
        if signal.getsignal(signal.SIGINT) is signal.default_int_handler:
            signals.append(signal.SIGINT)
        for signum in signals:
            signal.signal(signum, self.handle)

    @staticmethod
    def error(signum):
        return KeyboardInterrupt() if signum == signal.SIGINT else SystemExit(128 + signum)

    def handle(self, signum, frame):
        if self.depth and not self.interruptible:
            if self.pending is None:
                self.pending = signum
            return
        self.interruptible = False
        raise self.error(signum)

    def raise_pending(self):
        signum, self.pending = self.pending, None
        if signum is not None:
            raise self.error(signum)

    def deferred(self):
        return _SignalDeferral(self)

    def sleep(self, seconds):
        if not self.depth or threading.current_thread() is not threading.main_thread():
            time.sleep(seconds)
            return
        try:
            self.interruptible = True
            if self.pending is not None:
                self.interruptible = False
                self.raise_pending()
            time.sleep(seconds)
        finally:
            self.interruptible = False


class _SignalDeferral:
    def __init__(self, signals):
        self.signals = signals
        self.active = False

    def __enter__(self):
        # Handlers only run on the main thread, so only it may defer them.
        if threading.current_thread() is threading.main_thread():
            self.active = True
            self.signals.depth += 1

    def __exit__(self, exc_type, exc, tb):
        if not self.active:
            return
        self.signals.depth -= 1
        if self.signals.depth:
            return
        if exc_type is not None and issubclass(exc_type, (SystemExit, KeyboardInterrupt)):
            self.signals.pending = None  # Already exiting.
        else:
            self.signals.raise_pending()


EXIT_SIGNALS = ExitSignals()


class Worker:
    def __init__(self, base_url, token, iterations, backend="nerfstudio", brush="brush_app",
                 max_resolution=1200, max_splats=300000, *, heartbeat_interval=25,
                 retry_delays=(5, 15, 45, 120), recovery_dir=None, ffmpeg="ffmpeg", ffprobe="ffprobe"):
        self.base_url = base_url.rstrip("/")
        self.token = token
        self.iterations = iterations
        self.backend = backend
        # Explicit relative binaries are relative to launch, not the job's cwd.
        self.brush = os.path.abspath(brush) if os.path.dirname(brush) else brush  # keep symlinks: argv[0] stays as given
        self.max_resolution = max_resolution
        self.max_splats = max_splats
        self.keep_awake_warned = False
        self.heartbeat_interval = heartbeat_interval
        self.retry_delays = tuple(retry_delays)
        self.recovery_dir = (Path(recovery_dir).expanduser() if recovery_dir is not None
                             else Path.home() / ".cache/spatial-camera/recovered")
        # S10: video captures need both; their absence fails only video jobs, with a clear message.
        self.ffmpeg = ffmpeg
        self.ffprobe = ffprobe
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
            if hasattr(payload, "fileno"):
                headers["Content-Length"] = str(os.fstat(payload.fileno()).st_size)
        request = urllib.request.Request(self.base_url + "/api/worker/" + path, data=payload, headers=headers, method=method)
        with urllib.request.urlopen(request, timeout=180) as response:
            data = response.read()
            if raw:
                return data
            try:
                return json.loads(data)
            except json.JSONDecodeError as exc:
                raise RuntimeError("The worker endpoint returned a non-JSON response. Check hosting gateway authentication.") from exc

    def download(self, path, destination, lease, expected=None):
        """Streams a worker GET to a file: request() buffers, and a source video can be 1 GB."""
        headers = {**self.gateway_headers, "Authorization": f"Bearer {self.token}", "X-Job-Lease": lease}
        request = urllib.request.Request(self.base_url + "/api/worker/" + path, headers=headers)
        with urllib.request.urlopen(request, timeout=180) as response, open(destination, "wb") as output:
            shutil.copyfileobj(response, output, 1024 * 1024)
        if expected is not None and destination.stat().st_size != expected:
            raise RuntimeError("The video download was incomplete. Retry the capture.")

    def extract_frames(self, job, root, photos, run):
        """S10 (ADR-0009): downloads the job's video and selects its frames into `photos` as a stage
        (heartbeat, timeout and process-group kill apply). Returns the number of frames written."""
        missing = [os.path.basename(binary) for binary in (self.ffmpeg, self.ffprobe) if not shutil.which(binary)]
        if missing:
            raise RuntimeError(f"This capture is a video, but {' and '.join(missing)} {'is' if len(missing) == 1 else 'are'} not installed on the GPU worker. "
                               "Install ffmpeg (brew install ffmpeg on a Mac) and retry the capture.")
        video = job.get("video") or {}
        source = root / ("source.mov" if video.get("mime") == "video/quicktime" else "source.mp4")
        report = root / "frames.json"
        try:
            self.download(f"{job['id']}/video", source, job["lease"], video.get("bytes"))
            run([sys.executable, str(Path(__file__).with_name("video_frames.py")), str(source), str(photos),
                 "--work", str(root / "candidates"), "--report", str(report),
                 "--ffmpeg", self.ffmpeg, "--ffprobe", self.ffprobe], root / "frames.log", timeout=3600)
        except RuntimeError as exc:
            try:
                message = json.loads(report.read_text()).get("error")
            except (OSError, ValueError, AttributeError):
                message = None
            if message:
                raise RuntimeError(message) from exc
            raise
        finally:
            source.unlink(missing_ok=True)  # the selected frames are all the later stages read
        return json.loads(report.read_text())["selected"]

    def convert_spz(self, job_id, ply_path, spz_path):
        """Best-effort SPZ conversion of the validated PLY. Returns the SPZ path, or None to deliver the PLY alone."""
        try:
            stats = load_spz().convert(ply_path, spz_path)
        except Exception as exc:  # Never fail a finished capture over the faster format.
            # Any partial file lives in the working directory, which is removed after the job.
            print(f"Capture {job_id}: SPZ conversion skipped ({type(exc).__name__}: {exc}); delivering the PLY only.", flush=True)
            return None
        if stats["spz_bytes"] > MAX_SPZ_BYTES:
            print(f"Capture {job_id}: SPZ is over the {MAX_SPZ_BYTES // (1024 * 1024)} MB limit; delivering the PLY only.", flush=True)
            return None
        print(f"Capture {job_id}: SPZ {stats['ply_bytes']} -> {stats['spz_bytes']} bytes "
              f"({stats['points']} splats, SH {stats['sh_degree']}) in {stats['seconds']:g}s.", flush=True)
        return spz_path

    def upload_spz(self, job_id, lease, path, lease_lost):
        """Uploads the SPZ before the PLY publishes the capture. Only a lost lease is fatal."""
        try:
            # A shorter retry budget: the PLY alone is still a complete delivery.
            self.upload_result(job_id, lease, path, lease_lost, endpoint="result.spz",
                               retry_delays=self.retry_delays[:2])
        except RuntimeError as exc:
            if lease_lost.is_set():
                raise
            # Includes HTTP 404 from a server that predates SPZ, and 400/413 rejections.
            print(f"Capture {job_id}: SPZ upload failed ({exc}); delivering the PLY only.", flush=True)

    def upload_result(self, job_id, lease, path, lease_lost, *, endpoint="result", retry_delays=None):
        label = "Result" if endpoint == "result" else "SPZ"
        retry_delays = self.retry_delays if retry_delays is None else tuple(retry_delays)
        if lease_lost.is_set():
            raise RuntimeError(f"The processing lease was lost before {label.lower()} upload.")
        attempt = 0
        unknown_outcome = False
        while True:
            # A ready capture rejects heartbeats, but accepts an idempotent PUT.
            # After an ambiguous response, allow exactly one confirmation even
            # if the heartbeat lost the lease or the retry budget is exhausted.
            confirming = lease_lost.is_set()
            if confirming and not unknown_outcome:
                raise RuntimeError(f"The processing lease was lost during {label.lower()} upload retries.")
            attempt += 1
            try:
                # Reopen for each attempt so retries stream from byte zero.
                with path.open("rb") as source:
                    self.request(f"{job_id}/{endpoint}", "PUT", source, lease, raw=True)
                return
            except urllib.error.HTTPError as exc:
                code = exc.code
                exc.close()
                if code in (401, 403, 409):
                    lease_lost.set()
                    raise RuntimeError(f"{label} upload aborted: HTTP {code}; authorization or processing lease lost.") from exc
                if code != 429 and not 500 <= code < 600:
                    raise RuntimeError(f"{label} upload failed: HTTP {code}.") from exc
                detail = f"HTTP {code}"
                unknown_outcome = unknown_outcome or 500 <= code < 600
            except (OSError, urllib.error.URLError, http.client.HTTPException) as exc:
                detail = type(exc).__name__
                unknown_outcome = True
            if confirming:
                raise RuntimeError(f"The processing lease was lost; confirming {label.lower()} upload failed ({detail}).")
            if not lease_lost.is_set():
                # Servers may close an unauthorized PUT before reading its body,
                # which urllib exposes as a network error instead of HTTP 409.
                try:
                    self.request(f"{job_id}/status", "PATCH", {"status": "exporting"}, lease)
                except urllib.error.HTTPError as exc:
                    exc.close()
                    if exc.code in (401, 403, 409):
                        lease_lost.set()
                except (OSError, urllib.error.URLError, http.client.HTTPException):
                    pass
            if lease_lost.is_set():
                continue
            if attempt > len(retry_delays):
                raise RuntimeError(f"{label} upload failed after {attempt} attempts ({detail}).")
            delay = retry_delays[attempt - 1]
            print(f"{label} upload failed ({detail}); retrying in {delay:g}s.", flush=True)
            lease_lost.wait(delay)

    def prune_recovery(self):
        files = sorted((path for path in self.recovery_dir.glob("*.ply") if path.is_file()),
                       key=lambda path: path.stat().st_mtime_ns, reverse=True)
        for path in files[10:]:
            path.unlink()

    def recover_result(self, job_id, path):
        self.recovery_dir.mkdir(parents=True, exist_ok=True)
        destination = self.recovery_dir / f"{Path(job_id).name}-{time.time_ns()}.ply"
        shutil.move(str(path), destination)
        print(f"Capture {job_id}: recovered result PLY: {destination}", flush=True)
        self.prune_recovery()

    def run(self, command, log_path, stage, lease_lost, timeout=7200,
            poll_interval=2, terminate_timeout=10, *, cwd=None):
        if lease_lost.is_set():
            raise RuntimeError("The processing lease was lost.")
        print(f"{stage.capitalize()}: {log_path.name}", flush=True)
        # From fork until the group is reaped, signals only raise from
        # EXIT_SIGNALS.sleep() or after terminate_process_group() returns.
        with log_path.open("wb") as log, EXIT_SIGNALS.deferred():
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True, cwd=cwd)
            try:
                deadline = time.monotonic() + timeout
                while process.poll() is None:
                    # Event.wait can replace a signal's SystemExit with a lock
                    # RuntimeError while reacquiring its condition on Python 3.13.
                    EXIT_SIGNALS.sleep(poll_interval)
                    if lease_lost.is_set():
                        raise RuntimeError("The server connection or processing lease was lost.")
                    if time.monotonic() > deadline:
                        raise RuntimeError("Processing exceeded the two-hour stage limit.")
            finally:
                # Descendants can survive even when their direct parent has exited.
                terminate_process_group(process, terminate_timeout)
        if process.returncode:
            print(log_path.read_text(errors="replace")[-6000:], flush=True)
            raise RuntimeError(f"{stage.capitalize()} failed. Try sharper photos with more overlap and a still subject.")

    def process(self, job):
        caffeinate = None
        try:
            # Defer signals across Popen's fork/return gap, just as for stages.
            # The job itself stays interruptible (downloads, uploads, etc.).
            with EXIT_SIGNALS.deferred():
                if sys.platform == "darwin":
                    try:
                        caffeinate = subprocess.Popen(
                            ["caffeinate", "-i", "-w", str(os.getpid())],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            start_new_session=True)
                    except OSError as exc:
                        if not self.keep_awake_warned:
                            print(f"Mac keep-awake unavailable ({type(exc).__name__}); continuing without it.", flush=True)
                            self.keep_awake_warned = True
            self._process(job)
        finally:
            with EXIT_SIGNALS.deferred():
                if caffeinate is not None:
                    # This is our direct child, in a separate session from stages.
                    # -w also releases the assertion if the worker dies abruptly.
                    caffeinate.terminate()
                    try:
                        caffeinate.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        caffeinate.kill()
                        caffeinate.wait()

    def _process(self, job):
        job_id, lease = job["id"], job["lease"]
        stage = "aligning"
        stop = threading.Event()
        lease_lost = threading.Event()
        lock = threading.Lock()
        video = job.get("source_kind") == "video"  # S10: frames come from one video, not uploaded photos
        frame_count = len(job["images"])

        def status(value, error=None, registered=None):
            nonlocal stage
            payload = {"status": value, "error": error}
            if registered is not None and frame_count:
                payload["metrics"] = {"alignment_ratio": registered / frame_count}
            with lock:
                self.request(f"{job_id}/status", "PATCH", payload, lease)
                stage = value

        def heartbeat():
            failures = 0
            while not stop.wait(self.heartbeat_interval):
                try:
                    with lock:
                        self.request(f"{job_id}/status", "PATCH", {"status": stage}, lease)
                    failures = 0
                except urllib.error.HTTPError as exc:
                    exc.close()
                    failures += 1
                    if exc.code in (401, 403, 409) or failures >= 5:
                        lease_lost.set()
                        return
                except Exception:
                    failures += 1
                    if failures >= 5:
                        lease_lost.set()
                        return

        def run(command, log_path, **kwargs):
            self.run(command, log_path, stage, lease_lost, **kwargs)

        thread = threading.Thread(target=heartbeat, daemon=True)
        root = None
        uploaded = False
        validated_result = None
        thread.start()
        try:
            try:
                directory = tempfile.mkdtemp(prefix="spatial-capture-")
                root = Path(directory).resolve()
                photos = root / "photos"
                photos.mkdir()
                if video:
                    frame_count = self.extract_frames(job, root, photos, run)
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
                    alignment = json.loads((dataset / "alignment.json").read_text())
                    status("training", registered=alignment["registered"])
                    exported.mkdir()
                    run([self.brush, str(dataset / "undistorted"),
                         "--total-steps", str(self.iterations), "--max-resolution", str(self.max_resolution),
                         "--max-splats", str(self.max_splats), "--sh-degree", "2",
                         "--export-every", str(self.iterations), "--export-path", str(exported),
                         "--export-name", "result.ply"], root / "training.log", cwd=root)
                    status("exporting")
                else:
                    run(["ns-process-data", "images", "--data", str(photos), "--output-dir", str(dataset)], root / "alignment.log")
                    transforms = json.loads((dataset / "transforms.json").read_text())
                    registered = len(transforms.get("frames", []))
                    if registered < max(8, int(frame_count * 0.6)):
                        raise RuntimeError("Too few photos could be aligned. Add overlapping views and avoid blur, mirrors, and moving subjects.")
                    status("training", registered=registered)
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
                validate_ply(results[0])
                validated_result = results[0]
                # SPZ first: the PLY PUT publishes the capture and attaches this attempt's SPZ.
                spz_path = self.convert_spz(job_id, results[0], root / "result.spz")
                if spz_path is not None:
                    self.upload_spz(job_id, lease, spz_path, lease_lost)
                self.upload_result(job_id, lease, results[0], lease_lost)
                uploaded = True
                print(f"Completed capture {job_id}", flush=True)
            finally:
                stop.set()
                thread.join(timeout=185)
                if root is not None:
                    try:
                        if validated_result is not None and not uploaded:
                            self.recover_result(job_id, validated_result)
                    except OSError as exc:
                        print(f"Capture {job_id}: could not recover result PLY ({type(exc).__name__}).", flush=True)
                    finally:
                        shutil.rmtree(root, ignore_errors=True)
                        if root.exists():
                            print(f"Capture {job_id}: could not remove working directory {root}.", flush=True)
        except Exception as exc:
            message = str(exc) if isinstance(exc, RuntimeError) else "Processing could not finish. Check the GPU worker and retry your capture."
            try:
                status("failed", message)
            except Exception:
                print("Could not report failure; the server will expire the job lease.", flush=True)
            print(f"Capture {job_id} failed: {message}", flush=True)
        finally:
            stop.set()

    def serve(self, once=False):
        self.prune_recovery()
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
    EXIT_SIGNALS.install()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("SPATIAL_URL", "http://localhost:3000"))
    parser.add_argument("--iterations", type=int, default=7000)
    parser.add_argument("--backend", choices=("nerfstudio", "brush"), default="nerfstudio")
    parser.add_argument("--brush", default=str(Path(__file__).resolve().parent.parent / ".local/bin/brush_app"))
    parser.add_argument("--max-resolution", type=int, default=1200)
    parser.add_argument("--max-splats", type=int, default=300000)
    parser.add_argument("--recovery-dir", type=Path, default=Path.home() / ".cache/spatial-camera/recovered",
                        help="Keep the newest 10 validated PLYs whose upload failed")
    parser.add_argument("--env-file", type=Path, help="Read WORKER_TOKEN from a local dotenv file without executing it")
    parser.add_argument("--once", action="store_true", help="Process at most one queued capture and exit")
    parser.add_argument("--ffmpeg", default="ffmpeg", help="ffmpeg for video captures (S10)")
    parser.add_argument("--ffprobe", default="ffprobe", help="ffprobe for video captures (S10)")
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
        # Importing pycolmap installs signal handlers. Only the alignment
        # subprocess may import it; the worker must retain EXIT_SIGNALS.
        # find_spec proves the package exists; a throwaway interpreter proves
        # it imports (wrong-architecture wheels, missing dylibs) without
        # touching this process's signal handlers.
        if importlib.util.find_spec("pycolmap") is None:
            parser.error("Missing pycolmap. Run npm run setup:mac first.")
        try:
            probe = subprocess.run([sys.executable, "-c", "import pycolmap"], capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.TimeoutExpired) as exc:
            parser.error(f"Could not check pycolmap ({exc}). Run npm run setup:mac first.")
        if probe.returncode != 0:
            detail = (probe.stderr.strip().splitlines() or ["no error output"])[-1]
            parser.error(f"pycolmap is installed but fails to import: {detail}. Run npm run setup:mac first.")
    binaries = (args.brush,) if args.backend == "brush" else ("ns-process-data", "ns-train", "ns-export", "colmap", "ffmpeg", "nvidia-smi")
    for binary in binaries:
        if not shutil.which(binary):
            parser.error(f"Missing {binary}. Run npm run setup:mac for Brush, or use a CUDA-enabled Nerfstudio environment.")
    # Photo captures do not need ffmpeg, so its absence is a warning; video jobs then fail with a clear message.
    missing_video = [name for name in (args.ffmpeg, args.ffprobe) if not shutil.which(name)]
    if missing_video:
        print(f"Warning: {' and '.join(missing_video)} not found; video captures will fail until ffmpeg is installed "
              "(brew install ffmpeg).", flush=True)
    Worker(args.url, token, args.iterations, args.backend, args.brush,
           args.max_resolution, args.max_splats, recovery_dir=args.recovery_dir,
           ffmpeg=args.ffmpeg, ffprobe=args.ffprobe).serve(args.once)
