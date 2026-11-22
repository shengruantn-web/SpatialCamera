import builtins
import contextlib
import http.client
import http.server
import importlib.util
import io
import json
import os
import runpy
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.error


spec = importlib.util.spec_from_file_location("capture_worker", Path(__file__).parents[1] / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def ply_bytes(vertices=None):
    if vertices is None:
        vertices = [(1.0, 2.0, 3.0, 255, 0.5), (4.0, 5.0, 6.0, 128, 0.25)]
    header = (
        "ply\nformat binary_little_endian 1.0\ncomment test splat\n"
        f"element vertex {len(vertices)}\n"
        "property float x\nproperty double y\nproperty float z\n"
        "property uchar red\nproperty float opacity\nend_header\n"
    ).encode("ascii")
    return header + b"".join(struct.pack("<fdfBf", *vertex) for vertex in vertices)


try:
    import numpy  # noqa: F401  # The SPZ converter needs it; both worker hosts have it.
    HAS_NUMPY = True
except ImportError:
    HAS_NUMPY = False

GAUSSIAN_PROPERTIES = ("x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
                       "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")


def gaussian_ply_bytes(count=64):
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {count}\n"
        + "".join(f"property float {name}\n" for name in GAUSSIAN_PROPERTIES)
        + "end_header\n"
    ).encode("ascii")
    rows = (struct.pack("<14f", i * 0.1, -i * 0.05, 1.5, 0.2, -0.1, 0.3, 1.0,
                        -3.0, -2.5, -4.0, 1.0, 0.0, 0.0, 0.0) for i in range(count))
    return header + b"".join(rows)


class WorkerHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code):
        data = b"{}"
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PATCH(self):
        payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.statuses.append((self.path, dict(self.headers), payload))
        if self.server.uploading.is_set() and payload == {"status": "exporting"}:
            self.server.upload_heartbeats += 1
            if self.server.upload_heartbeats >= 2:
                self.server.heartbeats_received.set()
        if self.server.ready.is_set():
            self.reply(409)
            self.server.ready_heartbeat.set()
        else:
            self.reply(200)

    def do_PUT(self):
        self.server.uploading.set()
        data = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.uploads.append((self.path, dict(self.headers), data))
        if self.server.lose_response and len(self.server.uploads) == 1:
            self.server.ready.set()
            self.server.ready_heartbeat.wait(30)
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        if self.server.slow_upload:
            self.server.heartbeats_received.wait(2)
        code = self.server.codes[min(len(self.server.uploads) - 1, len(self.server.codes) - 1)]
        self.reply(code)
        self.server.uploading.clear()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = mock.patch.dict(os.environ, {"SPATIAL_GATEWAY_HEADERS": "{}"})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = worker.Worker("http://127.0.0.1", "t" * 32, 7000, backend="brush",
                                    heartbeat_interval=0.02, retry_delays=(0.01,) * 4)
        self.client.recovery_dir = self.root / "recovered"
        self.output = io.StringIO()
        self.stdout = contextlib.redirect_stdout(self.output)
        self.stdout.__enter__()
        self.addCleanup(self.stdout.__exit__, None, None, None)

    def server(self, codes=(200,), slow=False, lose_response=False):
        try:
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), WorkerHandler)
        except PermissionError as exc:
            self.skipTest(f"sandbox denies localhost socket binding: {exc}")
        server.lose_response = lose_response
        server.ready = threading.Event()
        server.ready_heartbeat = threading.Event()
        server.codes = codes
        server.slow_upload = slow
        server.uploads = []
        server.statuses = []
        server.uploading = threading.Event()
        server.upload_heartbeats = 0
        server.heartbeats_received = threading.Event()
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()

        def close():
            server.shutdown()
            server.server_close()
            thread.join(2)

        self.addCleanup(close)
        self.client.base_url = f"http://127.0.0.1:{server.server_port}"
        return server

    def process(self, data=None):
        if data is None:
            data = ply_bytes()
        job_root = self.root / "job"

        def directory(**kwargs):
            job_root.mkdir()
            return str(job_root)

        def stage(command, log_path, current_stage, lease_lost, **kwargs):
            if current_stage == "aligning":
                (job_root / "dataset").mkdir()
                (job_root / "dataset/alignment.json").write_text('{"registered": 0}')
            if current_stage == "training":
                (job_root / "export" / "result.ply").write_bytes(data)

        with mock.patch.object(worker.tempfile, "mkdtemp", side_effect=directory), \
                mock.patch.object(self.client, "run", side_effect=stage):
            self.client.process({"id": "capture", "lease": "lease", "images": []})
        return job_root

    def test_heartbeat_continues_during_slow_upload(self):
        server = self.server(slow=True)
        job_root = self.process()
        self.assertGreaterEqual(server.upload_heartbeats, 2)
        self.assertFalse(job_root.exists())
        self.assertIn("Completed capture capture", self.output.getvalue())
        count = len(server.statuses)
        time.sleep(0.06)
        self.assertEqual(len(server.statuses), count, "heartbeat must stop after upload")

    def test_upload_retried_on_503_then_succeeds_and_streams(self):
        server = self.server(codes=(503, 200))
        # Any accidental whole-file read in the worker should fail this test.
        with mock.patch.object(Path, "read_bytes", side_effect=AssertionError("must stream")), \
                mock.patch.object(self.client, "request", wraps=self.client.request) as request:
            job_root = self.process()
        self.assertEqual(len(server.uploads), 2)
        self.assertFalse(job_root.exists())
        for path, headers, data in server.uploads:
            self.assertEqual(path, "/api/worker/capture/result")
            self.assertEqual(headers["Authorization"], "Bearer " + "t" * 32)
            self.assertEqual(headers["X-Job-Lease"], "lease")
            self.assertEqual(headers["Content-Type"], "application/octet-stream")
            self.assertEqual(int(headers["Content-Length"]), len(ply_bytes()))
            self.assertNotIn("Transfer-Encoding", headers)
            self.assertEqual(data, ply_bytes())
        puts = [call for call in request.call_args_list if call.args[1:2] == ("PUT",)]
        self.assertEqual(len(puts), 2)
        self.assertTrue(all(hasattr(call.args[2], "read") for call in puts))

    def test_no_retry_on_409(self):
        server = self.server(codes=(409, 200))
        job_root = self.process()
        self.assertEqual(len(server.uploads), 1)
        self.assertFalse(job_root.exists())
        self.assertEqual(len(list(self.client.recovery_dir.glob("*.ply"))), 1)
        failure = server.statuses[-1][2]
        self.assertEqual(failure["status"], "failed")
        self.assertIn("HTTP 409", failure["error"])

    def test_only_validated_ply_recovered_after_final_upload_failure(self):
        server = self.server(codes=(503,))
        job_root = self.process()
        self.assertEqual(len(server.uploads), 5)
        self.assertFalse(job_root.exists())
        recovered, = self.client.recovery_dir.glob("capture-*.ply")
        self.assertEqual(recovered.read_bytes(), ply_bytes())
        self.assertIn(str(recovered), self.output.getvalue())
        self.assertEqual(server.statuses[-1][2]["status"], "failed")
        self.assertIn("after 5 attempts", server.statuses[-1][2]["error"])

    def test_invalid_result_is_rejected_before_upload(self):
        server = self.server()
        job_root = self.process(ply_bytes()[:-1])
        self.assertFalse(job_root.exists())
        self.assertFalse(self.client.recovery_dir.exists())
        self.assertEqual(server.uploads, [])
        self.assertIn("Invalid Gaussian-splat PLY", server.statuses[-1][2]["error"])

    def test_upload_retries_429(self):
        server = self.server(codes=(429, 200))
        self.process()
        self.assertEqual(len(server.uploads), 2)

    def test_timeout_then_429_preserves_confirmation_after_heartbeat_409(self):
        path = self.root / "result.ply"
        path.write_bytes(ply_bytes())
        lost = threading.Event()
        bodies = []

        def request(route, method, payload, lease, **kwargs):
            if method == "PATCH":
                if len(bodies) == 2:
                    raise urllib.error.HTTPError(route, 409, "ready", {}, None)
                return {}
            bodies.append(payload.read())
            if len(bodies) == 1:
                raise TimeoutError()
            if len(bodies) == 2:
                raise urllib.error.HTTPError(route, 429, "retry later", {}, None)
            return b""

        with mock.patch.object(self.client, "request", side_effect=request):
            self.client.upload_result("capture", "lease", path, lost)
        self.assertTrue(lost.is_set())
        self.assertEqual(bodies, [ply_bytes()] * 3)

    def test_upload_does_not_retry_authorization_or_other_client_errors(self):
        path = self.root / "result.ply"
        path.write_bytes(ply_bytes())
        for code in (401, 403, 400):
            with self.subTest(code=code):
                lost = threading.Event()
                error = urllib.error.HTTPError("http://127.0.0.1", code, "error", {}, None)
                with mock.patch.object(self.client, "request", side_effect=error) as request:
                    with self.assertRaisesRegex(RuntimeError, f"HTTP {code}"):
                        self.client.upload_result("capture", "lease", path, lost)
                self.assertEqual(request.call_count, 1)
                self.assertEqual(lost.is_set(), code in (401, 403))

    def test_network_errors_retry_with_default_backoff_and_rewind(self):
        self.client.retry_delays = worker.Worker("http://127.0.0.1", "t" * 32, 7000).retry_delays
        path = self.root / "result.ply"
        path.write_bytes(ply_bytes())
        lost = mock.Mock()
        lost.is_set.return_value = False
        lost.wait.return_value = False
        errors = [urllib.error.URLError("offline"), ConnectionResetError(),
                  TimeoutError(), http.client.RemoteDisconnected()]
        bodies = []

        def request(route, method, source, lease, **kwargs):
            if method == "PATCH":
                return {}
            bodies.append(source.read())
            if errors:
                raise errors.pop(0)
            return {}

        with mock.patch.object(self.client, "request", side_effect=request):
            self.client.upload_result("capture", "lease", path, lost)
        self.assertEqual(bodies, [ply_bytes()] * 5)
        self.assertEqual(lost.wait.call_args_list, [mock.call(n) for n in (5, 15, 45, 120)])

    def test_lost_committed_response_is_confirmed_after_heartbeat_409(self):
        server = self.server(lose_response=True)
        job_root = self.process()
        self.assertEqual(len(server.uploads), 2)
        self.assertTrue(server.ready_heartbeat.is_set())
        self.assertFalse(job_root.exists())
        self.assertFalse(self.client.recovery_dir.exists())
        self.assertIn("Completed capture capture", self.output.getvalue())
        self.assertFalse(any(row[2]["status"] == "failed" for row in server.statuses))

    def test_successful_put_wins_over_concurrent_heartbeat_409(self):
        committed = threading.Event()
        rejected = threading.Event()

        def request(route, method="GET", payload=None, lease=None, **kwargs):
            if method == "PATCH":
                if committed.is_set():
                    rejected.set()
                    raise urllib.error.HTTPError(route, 409, "ready", {}, None)
                return {}
            self.assertEqual(method, "PUT")
            committed.set()
            self.assertTrue(rejected.wait(30), "heartbeat did not observe ready")
            return b""

        with mock.patch.object(self.client, "request", side_effect=request):
            job_root = self.process()
        self.assertFalse(job_root.exists())
        self.assertIn("Completed capture capture", self.output.getvalue())
        self.assertNotIn("failed:", self.output.getvalue())

    def test_empty_success_response_is_accepted(self):
        path = self.root / "result.ply"
        path.write_bytes(ply_bytes())
        with mock.patch.object(worker.urllib.request, "urlopen", return_value=io.BytesIO(b"")):
            self.client.upload_result("capture", "lease", path, threading.Event())

    def test_unknown_outcome_gets_only_one_confirmation_on_lease_loss(self):
        path = self.root / "result.ply"
        path.write_bytes(ply_bytes())
        for code in (401, 403, 409):
            for outcome in (ConnectionResetError, TimeoutError, "503"):
                with self.subTest(code=code, outcome=outcome):
                    lost = threading.Event()
                    puts = []
                    probes = []

                    def request(route, method, payload, lease, **kwargs):
                        if method == "PATCH":
                            probes.append(payload)
                            raise urllib.error.HTTPError(route, code, "lost", {}, None)
                        puts.append(payload.read())
                        if outcome == "503":
                            raise urllib.error.HTTPError(route, 503, "unknown", {}, None)
                        raise outcome()

                    with mock.patch.object(self.client, "request", side_effect=request):
                        with self.assertRaisesRegex(RuntimeError, "lease was lost"):
                            self.client.upload_result("capture", "lease", path, lost)
                    self.assertEqual(len(puts), 2)
                    self.assertEqual(probes, [{"status": "exporting"}])
                    self.assertTrue(lost.is_set())

    def test_lease_loss_during_backoff_still_confirms(self):
        path = self.root / "result.ply"
        path.write_bytes(ply_bytes())
        lost = threading.Event()
        puts = []

        def request(route, method, payload, lease, **kwargs):
            if method == "PATCH":
                return {}
            puts.append(payload.read())
            if len(puts) == 1:
                raise ConnectionResetError()
            return {}

        def wait(delay):
            lost.set()
            return True

        with mock.patch.object(self.client, "request", side_effect=request), \
                mock.patch.object(lost, "wait", side_effect=wait):
            self.client.upload_result("capture", "lease", path, lost)
        self.assertEqual(len(puts), 2)

    def test_confirmation_allowed_after_final_budgeted_attempt(self):
        self.client.retry_delays = ()
        self.test_lost_committed_response_is_confirmed_after_heartbeat_409()

    def test_startup_and_recovery_prune_to_newest_ten(self):
        recovery = self.client.recovery_dir
        recovery.mkdir()
        for i in range(13):
            path = recovery / f"old-{i}.ply"
            path.write_bytes(ply_bytes())
            os.utime(path, (i + 1, i + 1))
        with mock.patch.object(self.client, "request", return_value={"job": None}):
            self.client.serve(once=True)
        self.assertEqual({p.name for p in recovery.glob("*.ply")},
                         {f"old-{i}.ply" for i in range(3, 13)})
        self.server(codes=(409,))
        self.process()
        self.assertEqual(len(list(recovery.glob("*.ply"))), 10)
        self.assertFalse((recovery / "old-3.ply").exists())

    def test_training_failure_removes_working_directory(self):
        self.server()
        job_root = self.root / "job"
        job_root.mkdir()
        (job_root / "checkpoint").write_bytes(b"large intermediate")
        with mock.patch.object(worker.tempfile, "mkdtemp", return_value=str(job_root)), \
                mock.patch.object(self.client, "run", side_effect=RuntimeError("training failed")):
            self.client.process({"id": "capture", "lease": "lease", "images": []})
        self.assertFalse(job_root.exists())
        self.assertFalse(self.client.recovery_dir.exists())

    def test_cleanup_error_after_upload_does_not_report_failure(self):
        with mock.patch.object(self.client, "request", return_value={}) as request, \
                mock.patch.object(worker.os, "unlink", side_effect=PermissionError("busy")):
            job_root = self.process()
        self.assertTrue(job_root.exists())
        self.assertIn("Completed capture capture", self.output.getvalue())
        self.assertIn("could not remove working directory", self.output.getvalue())
        self.assertFalse(any(call.args[1:2] == ("PATCH",) and
                             call.args[2]["status"] == "failed"
                             for call in request.call_args_list))

    @unittest.skipUnless(HAS_NUMPY, "SPZ conversion needs numpy")
    def test_spz_uploaded_before_the_publishing_ply(self):
        server = self.server()
        job_root = self.process(gaussian_ply_bytes())
        self.assertEqual([path for path, _, _ in server.uploads],
                         ["/api/worker/capture/result.spz", "/api/worker/capture/result"])
        spz_headers, spz = server.uploads[0][1], server.uploads[0][2]
        self.assertEqual(spz[:3], b"\x1f\x8b\x08")
        self.assertEqual(int(spz_headers["Content-Length"]), len(spz))
        self.assertEqual(spz_headers["X-Job-Lease"], "lease")
        self.assertEqual(server.uploads[1][2], gaussian_ply_bytes())
        self.assertIn("SPZ ", self.output.getvalue())
        self.assertIn("Completed capture capture", self.output.getvalue())
        self.assertFalse(job_root.exists())

    @unittest.skipUnless(HAS_NUMPY, "SPZ conversion needs numpy")
    def test_spz_rejected_or_unknown_route_still_delivers_ply(self):
        for code in (404, 400, 413):
            with self.subTest(code=code):
                self.reset_job()
                server = self.server(codes=(code, 200))
                self.process(gaussian_ply_bytes())
                self.assertEqual([path for path, _, _ in server.uploads],
                                 ["/api/worker/capture/result.spz", "/api/worker/capture/result"])
                self.assertIn(f"SPZ upload failed (SPZ upload failed: HTTP {code}.); delivering the PLY only.", self.output.getvalue())
                self.assertIn("Completed capture capture", self.output.getvalue())
                self.assertNotIn("failed", [status[2].get("status") for status in server.statuses])

    @unittest.skipUnless(HAS_NUMPY, "SPZ conversion needs numpy")
    def test_spz_transient_failures_use_a_short_budget_then_ply(self):
        server = self.server(codes=(503, 503, 503, 200))
        self.process(gaussian_ply_bytes())
        self.assertEqual([path for path, _, _ in server.uploads],
                         ["/api/worker/capture/result.spz"] * 3 + ["/api/worker/capture/result"])
        self.assertIn("SPZ upload failed after 3 attempts", self.output.getvalue())
        self.assertIn("Completed capture capture", self.output.getvalue())

    @unittest.skipUnless(HAS_NUMPY, "SPZ conversion needs numpy")
    def test_spz_lease_loss_stops_before_the_ply_and_recovers_it(self):
        server = self.server(codes=(409, 200))
        self.process(gaussian_ply_bytes())
        self.assertEqual([path for path, _, _ in server.uploads], ["/api/worker/capture/result.spz"])
        recovered, = self.client.recovery_dir.glob("capture-*.ply")
        self.assertEqual(recovered.read_bytes(), gaussian_ply_bytes())
        self.assertEqual(server.statuses[-1][2]["status"], "failed")
        self.assertIn("SPZ upload aborted: HTTP 409", server.statuses[-1][2]["error"])

    def test_conversion_failure_or_missing_numpy_delivers_ply_only(self):
        server = self.server()
        with mock.patch.object(worker, "load_spz", side_effect=ImportError("No module named 'numpy'")):
            self.process(gaussian_ply_bytes())
        self.reset_job()
        self.process()  # Valid PLY without Gaussian attributes: the converter refuses it.
        self.assertEqual([path for path, _, _ in server.uploads], ["/api/worker/capture/result"] * 2)
        self.assertIn("SPZ conversion skipped (ImportError", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("delivering the PLY only"), 2)
        self.assertEqual(self.output.getvalue().count("Completed capture capture"), 2)

    def reset_job(self):
        """Lets one test run process() more than once."""
        job_root = self.root / "job"
        if job_root.exists():
            shutil.rmtree(job_root)

    def test_serve_exits_on_system_exit_and_keyboard_interrupt(self):
        for exception in (SystemExit(143), KeyboardInterrupt()):
            with self.subTest(exception=type(exception).__name__), \
                    mock.patch.object(self.client, "request", side_effect=exception) as request:
                if isinstance(exception, SystemExit):
                    with self.assertRaises(SystemExit) as raised:
                        self.client.serve()
                    self.assertEqual(raised.exception.code, 143)
                else:
                    self.client.serve()
                request.assert_called_once()
                self.assertNotIn("Cannot reach job queue", self.output.getvalue())


class WorkerFollowupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.client = worker.Worker("http://localhost", "t" * 32, 7000, backend="brush")
        self.job = {"id": "capture", "lease": "lease", "images": [
            {"id": str(i), "mime": "image/jpeg"} for i in range(10)]}
        self.output = io.StringIO()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(self.output))
        self.stack.enter_context(mock.patch.object(worker.sys, "platform", "linux"))

    def stage(self, command, log_path, stage, lost, **kwargs):
        root = log_path.parent
        if stage == "aligning":
            dataset = root / "dataset"
            dataset.mkdir()
            # One unreadable input is excluded from total by mac_pipeline, but
            # must still count in the metric's denominator (8 / 10, not 8 / 9).
            (dataset / "alignment.json").write_text(json.dumps({"registered": 8, "total": 9, "skipped": 1}))
            (dataset / "transforms.json").write_text(json.dumps({"frames": [{}] * 8}))
        elif stage == "training" and self.client.backend == "nerfstudio":
            (root / "outputs").mkdir()
            (root / "outputs/config.yml").write_text("checkpoint")
        else:
            (root / "export").mkdir(exist_ok=True)
            (root / "export/result.ply").write_bytes(ply_bytes())

    def process(self, stage=None):
        self.root.joinpath("job").mkdir(exist_ok=True)
        with mock.patch.object(worker.tempfile, "mkdtemp", return_value=str(self.root / "job")), \
                mock.patch.object(self.client, "request", return_value=b"photo") as request, \
                mock.patch.object(self.client, "run", side_effect=stage or self.stage) as run:
            self.client.process(self.job)
        return request, run

    def test_brush_startup_checks_availability_without_importing_pycolmap(self):
        imported = []
        original_import = builtins.__import__
        def tracked_import(name, *args, **kwargs):
            if name == "pycolmap":
                imported.append(name)
                return mock.Mock()
            return original_import(name, *args, **kwargs)
        cases = ((True, 0), (False, 0), (True, 1))  # (package found, probe exit code)
        for available, probe_code in cases:
            imported.clear()
            probe = mock.Mock(return_value=subprocess.CompletedProcess([], probe_code, "", "ImportError: dlopen failed"))
            with self.subTest(available=available, probe_code=probe_code), \
                    mock.patch.object(builtins, "__import__", side_effect=tracked_import), \
                    mock.patch.object(worker.importlib.util, "find_spec", return_value=object() if available else None) as find, \
                    mock.patch.object(worker.subprocess, "run", probe), \
                    mock.patch.object(sys, "argv", [worker.__file__, "--backend", "brush", "--once", "--recovery-dir", str(self.root)]), \
                    mock.patch.dict(os.environ, {"WORKER_TOKEN": "t" * 32, "SPATIAL_GATEWAY_HEADERS": "{}"}), \
                    mock.patch.object(worker.signal, "signal"), \
                    mock.patch.object(worker.shutil, "which", return_value="/fake/brush"), \
                    mock.patch.object(worker.urllib.request, "urlopen", return_value=io.BytesIO(b'{"job": null}')), \
                    contextlib.redirect_stderr(io.StringIO()):
                if available and probe_code == 0:
                    runpy.run_path(worker.__file__, run_name="__main__")
                else:
                    with self.assertRaises(SystemExit) as raised:
                        runpy.run_path(worker.__file__, run_name="__main__")
                    self.assertEqual(raised.exception.code, 2)
                self.assertEqual(imported, [])
                find.assert_called_once_with("pycolmap")
                if available:  # the import is probed in a separate interpreter, never in-process
                    self.assertEqual(probe.call_args.args[0], [sys.executable, "-c", "import pycolmap"])
                else:
                    probe.assert_not_called()

    def test_alignment_ratio_is_sent_in_training_request_for_both_backends(self):
        for backend in ("brush", "nerfstudio"):
            with self.subTest(backend=backend):
                self.client.backend = backend
                requests = []
                def urlopen(request, timeout):
                    if request.method == "PATCH":
                        requests.append((request.full_url, request.get_header("X-job-lease"), json.loads(request.data)))
                    return io.BytesIO(b"{}")
                with mock.patch.object(worker.urllib.request, "urlopen", side_effect=urlopen), \
                        mock.patch.object(self.client, "run", side_effect=self.stage):
                    self.client.process(self.job)
                training = [body for _, _, body in requests if body["status"] == "training"]
                self.assertEqual(training, [{"status": "training", "error": None,
                                             "metrics": {"alignment_ratio": 0.8}}])
                self.assertTrue(all(url.endswith("/capture/status") and lease == "lease" for url, lease, _ in requests))
                self.assertEqual(requests[-1][2]["status"], "exporting")

    def test_brush_cwd_and_export_path_are_job_absolute_paths(self):
        _, run = self.process()
        training, = [call for call in run.call_args_list if call.args[2] == "training"]
        self.assertEqual(training.kwargs.get("cwd"), self.root / "job")
        command = training.args[0]
        export = Path(command[command.index("--export-path") + 1])
        self.assertTrue(export.is_absolute())
        self.assertEqual(export, self.root / "job/export")
        self.assertIn("Completed capture", self.output.getvalue())

    def test_relative_brush_binary_still_resolves_from_launch_directory(self):
        self.client = worker.Worker("http://localhost", "t" * 32, 7000,
                                    backend="brush", brush=".local/bin/brush_app")
        _, run = self.process()
        training, = [call for call in run.call_args_list if call.args[2] == "training"]
        self.assertEqual(training.args[0][0], os.path.abspath(".local/bin/brush_app"))

    def test_run_passes_cwd_to_subprocess(self):
        process = mock.Mock(returncode=0)
        process.poll.return_value = 0
        with mock.patch.object(worker.subprocess, "Popen", return_value=process) as popen, \
                mock.patch.object(worker, "terminate_process_group"):
            self.client.run(["brush"], self.root / "stage.log", "training", threading.Event(), cwd=self.root)
        self.assertEqual(popen.call_args.kwargs["cwd"], self.root)
        self.assertTrue(popen.call_args.kwargs["start_new_session"])

    def test_caffeinate_lasts_through_job_and_is_reaped_on_every_exit(self):
        for error in (None, RuntimeError("stage limit"), RuntimeError("lease lost"), SystemExit(143), KeyboardInterrupt()):
            with self.subTest(error=error):
                process = mock.Mock()
                def stage(*args, **kwargs):
                    process.terminate.assert_not_called()
                    if error:
                        raise error
                    self.stage(*args, **kwargs)
                with mock.patch.object(worker.sys, "platform", "darwin"), \
                        mock.patch.object(worker.subprocess, "Popen", return_value=process) as popen:
                    if isinstance(error, (SystemExit, KeyboardInterrupt)):
                        with self.assertRaises(type(error)):
                            self.process(stage)
                    else:
                        self.process(stage)
                popen.assert_called_once_with(["caffeinate", "-i", "-w", str(os.getpid())],
                                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                              start_new_session=True)
                process.terminate.assert_called_once_with()
                process.wait.assert_called_once_with(timeout=5)
                self.assertFalse((self.root / "job").exists())

    def test_missing_caffeinate_logs_once_and_jobs_still_complete(self):
        with mock.patch.object(worker.sys, "platform", "darwin"), \
                mock.patch.object(worker.subprocess, "Popen", side_effect=FileNotFoundError):
            self.process()
            self.process()
        self.assertEqual(self.output.getvalue().count("keep-awake unavailable"), 1)
        self.assertEqual(self.output.getvalue().count("Completed capture"), 2)

    def test_non_macos_does_not_start_caffeinate(self):
        with mock.patch.object(worker.subprocess, "Popen") as popen:
            self.process()
        popen.assert_not_called()

    def test_caffeinate_cleanup_escalates_and_reaps(self):
        process = mock.Mock()
        process.wait.side_effect = [subprocess.TimeoutExpired("caffeinate", 5), 0]
        with mock.patch.object(worker.sys, "platform", "darwin"), \
                mock.patch.object(worker.subprocess, "Popen", return_value=process):
            self.process()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_args_list, [mock.call(timeout=5), mock.call()])

    def test_signal_during_caffeinate_spawn_still_reaps_child(self):
        signals = worker.ExitSignals()
        process = mock.Mock()
        def popen(*args, **kwargs):
            signals.handle(signal.SIGTERM, None)
            return process
        with mock.patch.object(worker, "EXIT_SIGNALS", signals), \
                mock.patch.object(worker.sys, "platform", "darwin"), \
                mock.patch.object(worker.subprocess, "Popen", side_effect=popen), \
                self.assertRaises(SystemExit):
            self.process()
        process.terminate.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)


class MockWorkerTests(WorkerTests):
    """Exercise the same lifecycle cases even in sandboxes without listening sockets."""

    def server(self, codes=(200,), slow=False, lose_response=False):
        server = mock.Mock(uploads=[], statuses=[], upload_heartbeats=0)
        server.ready_heartbeat = threading.Event()
        ready = threading.Event()
        uploading = threading.Event()
        heartbeats_received = threading.Event()

        def request(path, method="GET", payload=None, lease=None, raw=False):
            headers = {"Authorization": "Bearer " + self.client.token, "X-Job-Lease": lease}
            route = "/api/worker/" + path
            if method == "PATCH":
                server.statuses.append((route, headers, payload))
                if ready.is_set():
                    server.ready_heartbeat.set()
                    raise urllib.error.HTTPError(route, 409, "ready", {}, None)
                if uploading.is_set() and payload == {"status": "exporting"}:
                    server.upload_heartbeats += 1
                    if server.upload_heartbeats >= 2:
                        heartbeats_received.set()
                return {}
            if method != "PUT":
                raise AssertionError(f"unexpected request: {method} {path}")
            uploading.set()
            headers["Content-Type"] = "application/octet-stream"
            headers["Content-Length"] = str(os.fstat(payload.fileno()).st_size)
            server.uploads.append((route, headers, payload.read()))
            if lose_response and len(server.uploads) == 1:
                ready.set()
                if not server.ready_heartbeat.wait(30):
                    raise AssertionError("heartbeat did not observe ready")
                raise http.client.RemoteDisconnected("committed response lost")
            if slow:
                heartbeats_received.wait(2)
            uploading.clear()
            code = codes[min(len(server.uploads) - 1, len(codes) - 1)]
            if code != 200:
                raise urllib.error.HTTPError(self.client.base_url + route, code, "error", {}, None)
            return {}

        patch = mock.patch.object(self.client, "request", side_effect=request)
        patch.start()
        self.addCleanup(patch.stop)
        return server

    def test_request_passes_file_to_urllib_with_explicit_content_length(self):
        path = self.root / "result.ply"
        path.write_bytes(ply_bytes())

        def urlopen(request, timeout):
            self.assertEqual(request.full_url, "http://127.0.0.1/api/worker/capture/result")
            self.assertEqual(request.method, "PUT")
            self.assertEqual(request.get_header("Authorization"), "Bearer " + "t" * 32)
            self.assertEqual(request.get_header("X-job-lease"), "lease")
            self.assertEqual(request.get_header("Content-length"), str(len(ply_bytes())))
            self.assertEqual(request.get_header("Content-type"), "application/octet-stream")
            self.assertTrue(hasattr(request.data, "read"))
            self.assertEqual(b"".join(iter(lambda: request.data.read(16), b"")), ply_bytes())
            return io.BytesIO(b"{}")

        with path.open("rb") as source, mock.patch.object(worker.urllib.request, "urlopen", side_effect=urlopen):
            self.assertEqual(self.client.request("capture/result", "PUT", source, "lease"), {})


class PlyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "result.ply"

    def test_valid_binary_ply_with_mixed_scalar_types(self):
        self.path.write_bytes(ply_bytes())
        worker.validate_ply(self.path)
        data = ply_bytes([(1, 2, 3, 255, 0.5)])
        data = data.replace(b"float ", b"float32 ").replace(b"double ", b"float64 ")
        data = data.replace(b"uchar ", b"uint8 ")
        self.path.write_bytes(data)
        worker.validate_ply(self.path)

    def test_rejects_truncation_extra_bytes_ascii_and_bad_headers(self):
        data = ply_bytes()
        invalid = [
            (data[:-1], "file size"),
            (data + b"extra", "file size"),
            (data.replace(b"binary_little_endian", b"ascii"), "format"),
            (data.replace(b"binary_little_endian", b"binary_big_endian"), "format"),
            (ply_bytes([]), "N > 0"),
            (data.replace(b"vertex 2", b"vertex -1"), "N > 0"),
            (data.replace(b"vertex 2", b"vertex nope"), "integer"),
            (data.replace(b"property float x", b"property float a"), "x, y and z"),
            (data.replace(b"property float x", b"property list uchar float x"), "scalar types"),
            (data.replace(b"property uchar red", b"property unknown red"), "scalar types"),
            (data.replace(b"end_header\n", b""), "header"),
        ]
        for content, message in invalid:
            with self.subTest(message=message, content=content[:60]):
                self.path.write_bytes(content)
                with self.assertRaisesRegex(RuntimeError, message):
                    worker.validate_ply(self.path)

    def test_allows_nonfinite_non_position_properties(self):
        for value in (float("-inf"), float("inf"), float("nan")):
            self.path.write_bytes(ply_bytes([(1, 2, 3, 255, value)]))
            worker.validate_ply(self.path)

    def test_rejects_nonfinite_floats_in_first_middle_and_last_samples(self):
        for index, field, value in ((0, 0, float("nan")), (500, 1, float("inf")),
                                    (1000, 2, float("-inf"))):
            with self.subTest(index=index, field=field):
                vertices = [[1, 2, 3, 255, 0.5] for _ in range(1001)]
                vertices[index][field] = value
                self.path.write_bytes(ply_bytes(vertices))
                with self.assertRaisesRegex(RuntimeError, f"non-finite float value at vertex {index}"):
                    worker.validate_ply(self.path)


class ExitSignalsTests(unittest.TestCase):
    def setUp(self):
        self.signals = worker.ExitSignals()

    def test_signals_raise_immediately_outside_a_stage(self):
        with self.assertRaises(SystemExit) as raised:
            self.signals.handle(signal.SIGTERM, None)
        self.assertEqual(raised.exception.code, 128 + signal.SIGTERM)
        with self.assertRaises(KeyboardInterrupt):
            self.signals.handle(signal.SIGINT, None)

    def test_stage_defers_first_signal_to_sleep(self):
        with self.assertRaises(SystemExit) as raised:
            with self.signals.deferred():
                self.signals.handle(signal.SIGHUP, None)
                self.signals.handle(signal.SIGTERM, None)
                self.signals.sleep(0)
                self.fail("sleep must raise the pending signal")
        self.assertEqual(raised.exception.code, 128 + signal.SIGHUP)
        self.assertIsNone(self.signals.pending)
        self.assertFalse(self.signals.interruptible)

    def test_signal_during_sleep_raises_and_later_ones_wait_for_cleanup(self):
        def sleep(seconds):
            self.signals.handle(signal.SIGTERM, None)

        with mock.patch.object(worker.time, "sleep", side_effect=sleep), \
                self.assertRaises(SystemExit) as raised:
            with self.signals.deferred():
                try:
                    self.signals.sleep(1)
                finally:
                    self.assertFalse(self.signals.interruptible)
                    self.signals.handle(signal.SIGHUP, None)  # Deferred during cleanup.
        self.assertEqual(raised.exception.code, 128 + signal.SIGTERM)
        self.assertIsNone(self.signals.pending)

    def test_pending_signal_wins_over_stage_errors_after_cleanup(self):
        with self.assertRaises(SystemExit) as raised:
            with self.signals.deferred():
                self.signals.handle(signal.SIGTERM, None)
                raise RuntimeError("The processing lease was lost.")
        self.assertIsInstance(raised.exception.__context__, RuntimeError)
        with self.assertRaises(KeyboardInterrupt):
            with self.signals.deferred():
                self.signals.handle(signal.SIGINT, None)

    def test_other_threads_do_not_defer_main_thread_signals(self):
        def stage():
            with self.signals.deferred():
                self.signals.sleep(0)
                results.append(self.signals.depth)

        results = []
        thread = threading.Thread(target=stage)
        thread.start()
        thread.join(30)
        self.assertEqual(results, [0])
        with self.assertRaises(SystemExit):
            self.signals.handle(signal.SIGTERM, None)

    def test_install_keeps_an_ignored_sigint(self):
        saved = {signum: signal.getsignal(signum)
                 for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT)}
        try:
            for previous, expected in ((signal.SIG_IGN, signal.SIG_IGN),
                                       (signal.default_int_handler, self.signals.handle)):
                signal.signal(signal.SIGINT, previous)
                self.signals.install()
                self.assertEqual(signal.getsignal(signal.SIGTERM), self.signals.handle)
                self.assertEqual(signal.getsignal(signal.SIGHUP), self.signals.handle)
                self.assertEqual(signal.getsignal(signal.SIGINT), expected)
        finally:
            for signum, handler in saved.items():
                signal.signal(signum, handler)


@unittest.skipUnless(hasattr(os, "killpg"), "requires POSIX process groups")
class ProcessGroupTests(unittest.TestCase):
    def assert_stopped(self, pid, detail=None):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            except PermissionError:
                if sys.platform == "darwin":
                    return
                raise
            # Linux may retain an orphan zombie until init reaps it.
            stat = Path(f"/proc/{pid}/stat")
            try:
                if stat.read_text().rsplit(")", 1)[1].split()[0] == "Z":
                    return
            except FileNotFoundError:
                pass
            if sys.platform == "darwin":
                try:
                    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)],
                                           capture_output=True, text=True, check=False)
                except OSError:
                    pass  # Sandboxes may prohibit ps; keep polling kill instead.
                else:
                    if state.stdout.strip().startswith("Z"):
                        return
            time.sleep(0.02)
        self.fail(f"process {pid} survived group termination" + (f"; {detail}" if detail else ""))

    def test_abort_and_timeout_kill_child_and_grandchild(self):
        for abort in (True, False):
            with self.subTest(abort=abort), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                marker = root / "pids"
                lost = threading.Event()
                client = worker.Worker("http://127.0.0.1", "t" * 32, 7000)
                # The grandchild ignores TERM, exercising the KILL fallback even
                # after the direct child has already exited on TERM.
                grandchild = (
                    "import os, signal, sys, time; "
                    "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
                    "open(sys.argv[1], 'w').write(str(os.getppid()) + ' ' + str(os.getpid())); "
                    "time.sleep(60)"
                )
                parent = (
                    "import subprocess, sys, time; "
                    f"subprocess.Popen([sys.executable, '-c', {grandchild!r}, sys.argv[1]]); "
                    "time.sleep(60)"
                )
                errors = []
                clock = mock.Mock(wraps=time)
                clock.skew = 0
                clock.monotonic.side_effect = lambda: time.monotonic() + clock.skew

                def run():
                    try:
                        client.run([sys.executable, "-c", parent, str(marker)], root / "stage.log",
                                   "training", lost, timeout=3600,
                                   poll_interval=0.01, terminate_timeout=0.15)
                    except Exception as exc:
                        errors.append(exc)

                thread = threading.Thread(target=run, daemon=True)
                clock_patch = mock.patch.object(worker, "time", clock)
                clock_patch.start()
                thread.start()
                try:
                    deadline = time.monotonic() + 30
                    pids = []
                    while time.monotonic() < deadline:
                        if marker.exists():
                            pids = [int(value) for value in marker.read_text().split()]
                            if len(pids) == 2:
                                break
                        time.sleep(0.01)
                    self.assertTrue(marker.exists(), "grandchild failed to start")
                    self.assertEqual(len(pids), 2)
                    try:
                        pgid = os.getpgid(pids[1])
                    except ProcessLookupError:
                        self.fail("grandchild died before the startup handshake")
                    self.assertEqual(pgid, pids[0])
                    if abort:
                        lost.set()
                    else:
                        clock.skew = 7200
                    thread.join(30)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(len(errors), 1)
                    self.assertIsInstance(errors[0], RuntimeError)
                    self.assertIn("lease was lost" if abort else "stage limit", str(errors[0]))
                    for pid in pids:
                        self.assert_stopped(pid)
                finally:
                    lost.set()
                    if marker.exists():
                        values = marker.read_text().split()
                        if values:
                            try:
                                os.killpg(int(values[0]), signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                    thread.join(30)
                    clock_patch.stop()

    # Worker scripts register this so a hung worker's stacks reach the failure.
    script_prelude = f"""
import faulthandler, os, runpy, signal, subprocess, sys, threading, traceback
from pathlib import Path
from unittest import mock
faulthandler.register(signal.SIGUSR1, all_threads=True)
sys.path.insert(0, {str(Path(worker.__file__).parent)!r})
"""

    def run_worker_script(self, script, marker, sig=None):
        """Runs a worker script that must exit with 128 + sig after its stage
        child wrote `marker`, then checks the stage's group was terminated."""
        process = subprocess.Popen([sys.executable, "-c", self.script_prelude + script],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        pid = None
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                fields = marker.read_text().split() if marker.exists() else []
                if fields:
                    pid = int(fields[0])
                    break
                if process.poll() is not None:
                    self.fail(f"worker exited before handshake: {process.communicate()}")
                time.sleep(0.01)
            self.assertIsNotNone(pid, "stage failed to start")
            if sig is not None:
                process.send_signal(sig)
            try:
                output = process.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                process.send_signal(signal.SIGUSR1)
                time.sleep(1)
                process.kill()
                output = process.communicate(timeout=30)
                self.fail(f"worker did not exit; stacks: {output[1].decode(errors='replace')}")
            self.assertEqual(process.returncode, 128 + (sig or signal.SIGHUP), output)
            self.assert_stopped(pid, output)
            return marker.read_text().split()
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=30)
            if pid is not None:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass

    def test_main_signals_unwind_and_terminate_stage_groups(self):
        for sig in (signal.SIGTERM, signal.SIGHUP):
            with self.subTest(signal=sig), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                marker = root / "pid"
                # The child reports how many signals it starts with blocked.
                child = (
                    "import os, signal, sys, time; "
                    "blocked = len(signal.pthread_sigmask(signal.SIG_BLOCK, [])); "
                    "open(sys.argv[1], 'w').write(f'{os.getpid()} {blocked}'); time.sleep(60)"
                )
                script = f"""
def claim(*args, **kwargs):
    # Use the namespace runpy is executing: it installed the signal handlers.
    sys.modules['__main__'].Worker('http://localhost', 't' * 32, 7000).run(
        [sys.executable, '-c', {child!r}, {str(marker)!r}],
        Path({str(root / 'stage.log')!r}), 'training', threading.Event(),
        poll_interval=0.01, terminate_timeout=0.1)
    raise AssertionError('stage must be interrupted')

sys.argv = [{worker.__file__!r}, '--once', '--recovery-dir', {str(root / 'recovered')!r}]
with mock.patch.dict(os.environ, {{'WORKER_TOKEN': 't' * 32, 'SPATIAL_GATEWAY_HEADERS': '{{}}'}}), \\
        mock.patch('shutil.which', return_value='/test/binary'), \\
        mock.patch('urllib.request.urlopen', side_effect=claim):
    try:
        runpy.run_path({worker.__file__!r}, run_name='__main__')
    except BaseException:
        traceback.print_exc()  # Shows where the signal interrupted the worker.
        raise
"""
                fields = self.run_worker_script(script, marker, sig)
                self.assertEqual(fields[1], "0", "stage child must start with no blocked signals")

    def test_job_signal_reaps_caffeinate_outside_stage_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker, awake = root / "stage-pid", root / "awake-pid"
            child = ("import os, sys, time; "
                     "open(sys.argv[1], 'w').write(str(os.getpid())); time.sleep(60)")
            script = f"""
import worker, time
worker.EXIT_SIGNALS.install()
real_popen = subprocess.Popen

def popen(command, **kwargs):
    if command[0] == 'caffeinate':
        process = real_popen([sys.executable, '-c', {child!r}, {str(awake)!r}], **kwargs)
        deadline = time.monotonic() + 10
        while not Path({str(awake)!r}).exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        return process
    return real_popen(command, **kwargs)

class Client(worker.Worker):
    def _process(self, job):
        self.run([sys.executable, '-c', {child!r}, {str(marker)!r}],
                 Path({str(root / 'stage.log')!r}), 'training', threading.Event(),
                 poll_interval=0.01, terminate_timeout=0.1)

with mock.patch.object(worker.sys, 'platform', 'darwin'), \\
        mock.patch.object(worker.subprocess, 'Popen', side_effect=popen):
    Client('http://localhost', 't' * 32, 7000).process({{}})
"""
            try:
                self.run_worker_script(script, marker, signal.SIGTERM)
                self.assertTrue(awake.exists(), "fake caffeinate did not start")
                self.assert_stopped(int(awake.read_text()))
            finally:
                if awake.exists():
                    try:
                        os.kill(int(awake.read_text()), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass

    def test_signal_inside_popen_or_poll_still_terminates_stage_group(self):
        # Deterministically replays two races seen under load: a signal handled
        # inside Popen after fork (child orphaned), and one handled right after
        # Popen.poll() takes its waitpid lock (lock leaked, final wait() hangs).
        for mode in ("popen", "poll"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                marker = root / "pid"
                script = f"""
import worker
worker.EXIT_SIGNALS.install()

class SignalingLock:
    def __init__(self, lock):
        self.lock, self.fired = lock, False
    def acquire(self, blocking=True, timeout=-1):
        acquired = self.lock.acquire(blocking, timeout)
        if acquired and not blocking and not self.fired:
            self.fired = True
            signal.raise_signal(signal.SIGHUP)  # Handled before poll's try.
        return acquired
    def release(self):
        self.lock.release()
    def __enter__(self):
        return self.acquire()
    def __exit__(self, *exc):
        self.release()

class Popen(subprocess.Popen):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        Path({str(marker)!r}).write_text(str(self.pid))
        if {mode!r} == 'popen':
            signal.raise_signal(signal.SIGHUP)  # Child exists; Popen has not returned.
        else:
            self._waitpid_lock = SignalingLock(self._waitpid_lock)

subprocess.Popen = Popen
try:
    worker.Worker('http://localhost', 't' * 32, 7000).run(
        [sys.executable, '-c', 'import time; time.sleep(60)'],
        Path({str(root / 'stage.log')!r}), 'training', threading.Event(),
        poll_interval=0.01, terminate_timeout=0.1)
except BaseException:
    traceback.print_exc()
    raise
raise AssertionError('stage must be interrupted')
"""
                self.run_worker_script(script, marker)

    def test_macos_permission_error_is_harmless_while_leader_exits(self):
        for exit_code in (0, None):
            with self.subTest(exit_code=exit_code):
                process = mock.Mock(pid=1234)
                process.poll.return_value = exit_code
                def killpg(pid, sig):
                    self.assertTrue(process.poll.called, "poll must reap before killpg")
                    raise PermissionError()
                with mock.patch.object(worker.os, "killpg", side_effect=killpg):
                    worker.terminate_process_group(process, timeout=0)
                process.wait.assert_called_once_with()

    def test_permission_error_keeps_polling_until_leader_is_reaped(self):
        process = mock.Mock(pid=1234)
        process.poll.side_effect = [None, None, None, None, None, 0]
        with mock.patch.object(worker.os, "killpg", side_effect=PermissionError()) as killpg, \
                mock.patch.object(worker.time, "sleep"):
            worker.terminate_process_group(process, timeout=30)
        self.assertEqual(killpg.call_args_list,
                         [mock.call(1234, signal.SIGTERM), mock.call(1234, 0), mock.call(1234, 0)])
        process.wait.assert_called_once_with()

    def test_group_already_gone_is_harmless(self):
        process = mock.Mock(pid=1234)
        with mock.patch.object(worker.os, "killpg", side_effect=ProcessLookupError):
            worker.terminate_process_group(process, timeout=0)
        process.wait.assert_called_once_with()


class VideoJobTests(unittest.TestCase):
    """S10 (ADR-0009): a video job extracts frames as a stage, then runs the photo pipeline unchanged."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.client = worker.Worker("http://localhost", "t" * 32, 7000, backend="brush",
                                    ffmpeg="/opt/ff/ffmpeg", ffprobe="/opt/ff/ffprobe")
        self.job = {"id": "capture", "lease": "lease", "images": [], "source_kind": "video",
                    "video": {"bytes": 4, "mime": "video/quicktime"}}
        self.patches = []
        self.stages = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(mock.patch.object(worker.sys, "platform", "linux"))
        self.stack.enter_context(mock.patch.object(worker.tempfile, "mkdtemp", side_effect=self.mkdtemp))

    def mkdtemp(self, **kwargs):
        job = self.root / "job"
        job.mkdir()
        return str(job)

    def urlopen(self, request, timeout):
        if request.method == "PATCH":
            self.patches.append(json.loads(request.data))
        if request.method == "GET" and "/images/" in request.full_url:
            raise AssertionError("a video job has no photos to download")
        return io.BytesIO(b"{}")

    def download(self, path, destination, lease, expected=None):
        self.downloaded = (path, destination, lease, expected)
        destination.write_bytes(b"\0\0\0\x20")

    def stage(self, frames=10, registered=8, extraction_error=None):
        def run(command, log_path, stage, lost, **kwargs):
            root = log_path.parent
            self.stages.append((stage, Path(command[1]).name, kwargs))
            if Path(command[1]).name == "video_frames.py":
                self.assertEqual(stage, "aligning")
                self.assertEqual(command[command.index("--ffmpeg") + 1], "/opt/ff/ffmpeg")
                self.assertEqual(command[command.index("--ffprobe") + 1], "/opt/ff/ffprobe")
                self.assertTrue((root / "source.mov").exists())
                report = Path(command[command.index("--report") + 1])
                if extraction_error:
                    report.write_text(json.dumps({"error": extraction_error}))
                    raise RuntimeError("Aligning failed. Try sharper photos with more overlap and a still subject.")
                photos = Path(command[3])
                for index in range(frames):
                    (photos / f"frame_{index:05d}.jpg").write_bytes(b"jpg")
                report.write_text(json.dumps({"selected": frames}))
            elif stage == "aligning":
                self.assertFalse((root / "source.mov").exists(), "the video is gone once frames are extracted")
                self.assertEqual(len(list((root / "photos").iterdir())), frames)
                (root / "dataset").mkdir()
                (root / "dataset/alignment.json").write_text(json.dumps({"registered": registered}))
                (root / "dataset/transforms.json").write_text(json.dumps({"frames": [{}] * registered}))
            elif stage == "training" and self.client.backend == "nerfstudio":
                (root / "outputs").mkdir()
                (root / "outputs/config.yml").write_text("checkpoint")
            else:
                (root / "export").mkdir(exist_ok=True)
                (root / "export/result.ply").write_bytes(ply_bytes())
        return run

    def process(self, which=lambda name: f"/found/{name}", **stage):
        with mock.patch.object(worker.urllib.request, "urlopen", side_effect=self.urlopen), \
                mock.patch.object(worker.shutil, "which", side_effect=which), \
                mock.patch.object(self.client, "download", side_effect=self.download) as download, \
                mock.patch.object(self.client, "run", side_effect=self.stage(**stage)) as run:
            self.client.process(self.job)
        return download, run

    def test_frames_are_extracted_as_a_stage_and_the_ratio_uses_the_frame_count(self):
        download, _ = self.process(frames=10, registered=8)
        self.assertEqual(self.downloaded[0], "capture/video")
        self.assertEqual(self.downloaded[2:], ("lease", 4))
        self.assertEqual([(stage, name) for stage, name, _ in self.stages],
                         [("aligning", "video_frames.py"), ("aligning", "mac_pipeline.py"), ("training", "undistorted")])
        self.assertEqual(self.stages[0][2].get("timeout"), 3600)
        training = [body for body in self.patches if body["status"] == "training"]
        self.assertEqual(training, [{"status": "training", "error": None, "metrics": {"alignment_ratio": 0.8}}])
        self.assertIn("Completed capture", self.output.getvalue())
        self.assertFalse((self.root / "job").exists())

    def test_missing_ffmpeg_fails_only_the_video_job_with_a_clear_message(self):
        download, run = self.process(which=lambda name: None if "/ff/" in name else name)
        download.assert_not_called()
        run.assert_not_called()
        failed = self.patches[-1]
        self.assertEqual(failed["status"], "failed")
        self.assertIn("ffmpeg and ffprobe are not installed on the GPU worker", failed["error"])

    def test_extraction_errors_reach_the_owner(self):
        self.process(extraction_error="This video is longer than ten minutes. Trim it.")
        self.assertEqual(self.patches[-1], {"status": "failed", "error": "This video is longer than ten minutes. Trim it."})
        self.assertEqual(len(self.stages), 1)

    def test_nerfstudio_threshold_counts_extracted_frames(self):
        self.client.backend = "nerfstudio"
        self.process(frames=20, registered=11)  # 11 < 60% of 20
        self.assertEqual(self.patches[-1]["status"], "failed")
        self.assertIn("Too few photos could be aligned", self.patches[-1]["error"])

    def test_download_streams_to_a_file_and_checks_the_size(self):
        body = b"v" * (3 * 1024 * 1024 + 5)
        seen = []
        def urlopen(request, timeout):
            seen.append(request)
            return io.BytesIO(body)
        destination = self.root / "video.mp4"
        with mock.patch.object(worker.urllib.request, "urlopen", side_effect=urlopen), \
                mock.patch.dict(os.environ, {"SPATIAL_GATEWAY_HEADERS": "{}"}):
            self.client.download("capture/video", destination, "lease", len(body))
            self.assertEqual(destination.read_bytes(), body)
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                self.client.download("capture/video", destination, "lease", len(body) + 1)
        self.assertEqual(seen[0].full_url, "http://localhost/api/worker/capture/video")
        self.assertEqual(seen[0].get_header("X-job-lease"), "lease")
        self.assertEqual(seen[0].get_header("Authorization"), "Bearer " + "t" * 32)

    def test_startup_only_warns_when_ffmpeg_is_missing(self):
        with mock.patch.object(worker.importlib.util, "find_spec", return_value=object()), \
                mock.patch.object(worker.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "", "")), \
                mock.patch.object(sys, "argv", [worker.__file__, "--backend", "brush", "--once", "--recovery-dir", str(self.root)]), \
                mock.patch.dict(os.environ, {"WORKER_TOKEN": "t" * 32, "SPATIAL_GATEWAY_HEADERS": "{}"}), \
                mock.patch.object(worker.signal, "signal"), \
                mock.patch.object(worker.shutil, "which", side_effect=lambda name: None if name.startswith("ff") else "/fake/brush"), \
                mock.patch.object(worker.urllib.request, "urlopen", return_value=io.BytesIO(b'{"job": null}')):
            runpy.run_path(worker.__file__, run_name="__main__")
        self.assertIn("Warning: ffmpeg and ffprobe not found; video captures will fail", self.output.getvalue())
        self.assertIn("No queued captures.", self.output.getvalue())


if __name__ == "__main__":
    unittest.main()
