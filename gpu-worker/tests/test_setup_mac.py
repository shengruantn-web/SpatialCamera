import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("setup_mac", Path(__file__).parents[1] / "setup_mac.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)


class EnsureBrushTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.binary = Path(self.directory.name, "bin/brush_app")
        self.binary.parent.mkdir()

    def test_pinned_binary_is_kept_without_downloading(self):
        self.binary.write_bytes(b"pinned build")
        with mock.patch.object(setup, "BRUSH_APP_SHA256", hashlib.sha256(b"pinned build").hexdigest()), \
                mock.patch.object(setup, "install_brush") as install:
            setup.ensure_brush(self.binary)
        install.assert_not_called()
        self.assertEqual(self.binary.read_bytes(), b"pinned build")

    def test_mismatched_binary_is_removed_and_reinstalled(self):
        self.binary.write_bytes(b"something else")
        seen = []
        with mock.patch.object(setup, "install_brush", side_effect=lambda path: seen.append(path.exists())), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            setup.ensure_brush(self.binary)
        self.assertEqual(seen, [False])
        self.assertIn("does not match the pinned Brush", output.getvalue())

    def test_missing_binary_is_installed(self):
        with mock.patch.object(setup, "install_brush") as install:
            setup.ensure_brush(self.binary)
        install.assert_called_once_with(self.binary)

    def test_download_with_wrong_archive_checksum_fails_and_cleans_up(self):
        with mock.patch.object(setup, "LOCAL", Path(self.directory.name)), \
                mock.patch.object(setup.urllib.request, "urlretrieve",
                                  side_effect=lambda url, path: Path(path).write_bytes(b"tampered")), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(SystemExit, "checksum mismatch"):
                setup.install_brush(self.binary)
        self.assertFalse(self.binary.exists())
        self.assertEqual(list(Path(self.directory.name).glob("*.tar.xz")), [])

    def test_interrupted_download_removes_the_partial_archive(self):
        def partial_download(url, path):
            Path(path).write_bytes(b"first few megabytes")
            raise OSError("connection reset")

        with mock.patch.object(setup, "LOCAL", Path(self.directory.name)), \
                mock.patch.object(setup.urllib.request, "urlretrieve", side_effect=partial_download), \
                contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(OSError, "connection reset"):
                setup.install_brush(self.binary)
        self.assertEqual(list(Path(self.directory.name).glob("*.tar.xz")), [])
        self.assertEqual(list(self.binary.parent.iterdir()), [])

    def make_release(self, brush_app=b"brush binary"):
        """A tar.xz laid out like the Brush release; returns (path, sha256)."""
        staging = Path(self.directory.name, "staging/brush-app-aarch64-apple-darwin")
        staging.mkdir(parents=True)
        for name, data in (("brush_app", brush_app), ("LICENSE", b"license"), ("README.md", b"readme")):
            (staging / name).write_bytes(data)
        release = Path(self.directory.name, "release.tar.xz")
        with tarfile.open(release, "w:xz") as bundle:
            bundle.add(staging, arcname=staging.name)
        shutil.rmtree(staging.parent)
        return release, hashlib.sha256(release.read_bytes()).hexdigest()

    def install_from(self, release, archive_sha, app_sha):
        local = Path(self.directory.name, "local")
        local.mkdir()
        with mock.patch.object(setup, "LOCAL", local), \
                mock.patch.object(setup, "BRUSH_SHA256", archive_sha), \
                mock.patch.object(setup, "BRUSH_APP_SHA256", app_sha), \
                mock.patch.object(setup.urllib.request, "urlretrieve",
                                  side_effect=lambda url, path: shutil.copyfile(release, path)), \
                contextlib.redirect_stdout(io.StringIO()):
            try:
                setup.install_brush(self.binary)
            finally:
                self.assertEqual(list(local.iterdir()), [])  # the archive is always removed

    def test_brush_app_checksum_failure_removes_every_extracted_file(self):
        release, archive_sha = self.make_release()
        with self.assertRaisesRegex(SystemExit, "checksum mismatch after extraction"):
            self.install_from(release, archive_sha, "0" * 64)
        self.assertEqual(list(self.binary.parent.iterdir()), [])

    def test_verified_release_is_installed_executable(self):
        release, archive_sha = self.make_release()
        self.install_from(release, archive_sha, hashlib.sha256(b"brush binary").hexdigest())
        self.assertEqual(sorted(path.name for path in self.binary.parent.iterdir()),
                         ["LICENSE", "README.md", "brush_app"])
        self.assertEqual(stat.S_IMODE(self.binary.stat().st_mode), 0o755)


@contextlib.contextmanager
def token_fixture(directory):
    """Exercise token permissions without opening any real dotenv filenames."""
    root = mock.MagicMock()
    root.__truediv__.return_value = Path(directory, "token-fixture")
    mkstemp = tempfile.mkstemp
    def temporary(**kwargs):
        return mkstemp(**{**kwargs, "prefix": "token-fixture."})
    with mock.patch.object(setup, "ROOT", root), \
            mock.patch.object(setup.tempfile, "mkstemp", side_effect=temporary):
        yield


class ConfigureTokenTest(unittest.TestCase):
    def test_existing_valid_token_file_is_made_private(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory, "token-fixture")
            content = 'LOCAL_DEV="true"\nWORKER_TOKEN="' + "x" * 40 + '"\n'
            env_file.write_text(content)
            os.chmod(env_file, 0o644)
            with token_fixture(directory), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                setup.configure_token()
            self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
            self.assertEqual(env_file.read_text(), content)
            self.assertEqual(output.getvalue(), "")

    def test_new_token_file_is_created_private(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory, "token-fixture")
            with token_fixture(directory), contextlib.redirect_stdout(io.StringIO()):
                setup.configure_token()
            self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
            text = env_file.read_text()
            self.assertIn('LOCAL_DEV="true"', text)
            self.assertRegex(text, r'WORKER_TOKEN="[A-Za-z0-9_-]{32,}"')

    def test_short_token_in_readable_file_is_replaced_through_a_private_temp_file(self):
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory, "token-fixture")
            env_file.write_text('LOCAL_DEV="true"\nWORKER_TOKEN="short"\nOTHER="kept"\n')
            os.chmod(env_file, 0o644)
            original_inode = env_file.stat().st_ino
            replaced = []
            real_replace = os.replace

            def record_replace(source, target):
                # At the moment of the swap the token exists only in the temp file.
                replaced.append((Path(source).parent, stat.S_IMODE(os.stat(source).st_mode), Path(target)))
                self.assertNotIn('WORKER_TOKEN="short"', Path(source).read_text())
                self.assertIn('WORKER_TOKEN="short"', env_file.read_text())
                real_replace(source, target)

            with token_fixture(directory), \
                    mock.patch.object(setup.os, "replace", side_effect=record_replace), \
                    contextlib.redirect_stdout(io.StringIO()):
                setup.configure_token()

            self.assertEqual(replaced, [(Path(directory), 0o600, env_file)])
            self.assertNotEqual(env_file.stat().st_ino, original_inode)
            self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
            text = env_file.read_text()
            self.assertRegex(text, r'WORKER_TOKEN="[A-Za-z0-9_-]{32,}"')
            self.assertIn('OTHER="kept"', text)
            self.assertEqual(sorted(path.name for path in Path(directory).iterdir()), ["token-fixture"])


if __name__ == "__main__":
    unittest.main()
