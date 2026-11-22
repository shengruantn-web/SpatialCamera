"""Install pinned Apple Silicon tools into .local and configure the local worker."""
import hashlib
import os
from pathlib import Path
import platform
import re
import secrets
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
BRUSH_URL = "https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz"
BRUSH_SHA256 = "65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c"
# sha256 of brush_app inside that archive, used to verify an existing install.
BRUSH_APP_SHA256 = "8380ed40cce870025393e1ea0257e0752351c67a409d827b76dc75ec3a999a71"


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def install_brush(binary):
    """Download the pinned Brush release and install brush_app after verifying both hashes.

    The archive is always deleted; on any failure the files extracted so far are too.
    """
    archive = LOCAL / "brush-v0.3.0.tar.xz"
    created = []
    installed = False
    print("Downloading Brush v0.3.0 (41 MB)…", flush=True)
    try:
        urllib.request.urlretrieve(BRUSH_URL, archive)
        if sha256(archive) != BRUSH_SHA256:
            sys.exit("Brush checksum mismatch; the download was not installed.")
        binary.parent.mkdir(exist_ok=True)
        with tarfile.open(archive) as bundle:
            for name in ("brush_app", "LICENSE", "README.md"):
                source = bundle.extractfile(f"brush-app-aarch64-apple-darwin/{name}")
                target = binary.parent / name
                created.append(target)
                target.write_bytes(source.read())
        if sha256(binary) != BRUSH_APP_SHA256:
            sys.exit("brush_app checksum mismatch after extraction; the extracted files were removed.")
        binary.chmod(0o755)
        installed = True
    finally:
        archive.unlink(missing_ok=True)
        if not installed:
            for path in created:
                path.unlink(missing_ok=True)


def ensure_brush(binary):
    """Install Brush if missing; replace an existing brush_app that is not the pinned build."""
    if binary.exists():
        if sha256(binary) == BRUSH_APP_SHA256:
            return
        print(f"{binary} does not match the pinned Brush v0.3.0 checksum; reinstalling.", flush=True)
        binary.unlink()
    install_brush(binary)


def configure_token():
    env_file = ROOT / ".dev.vars"
    content = env_file.read_text() if env_file.exists() else 'LOCAL_DEV="true"\n'
    match = re.search(r"^WORKER_TOKEN\s*=\s*(.*)$", content, re.M)
    if not match or len(match.group(1).strip().strip("\"'")) < 32:
        entry = f'WORKER_TOKEN="{secrets.token_urlsafe(32)}"'
        content = re.sub(r"^WORKER_TOKEN\s*=.*$", entry, content, flags=re.M) if match else content.rstrip() + "\n" + entry + "\n"
        # mkstemp creates the file 0600; replacing atomically means an existing 0644
        # file never holds the new token, even briefly.
        descriptor, temporary = tempfile.mkstemp(dir=env_file.parent, prefix=".dev.vars.")
        try:
            with os.fdopen(descriptor, "w") as file:
                file.write(content)
            os.replace(temporary, env_file)
        except BaseException:
            Path(temporary).unlink(missing_ok=True)
            raise
        print("Configured a random worker token in .dev.vars (value hidden). Restart the web server.")
    # Always: an older setup or a hand-made file may have left the token world-readable.
    os.chmod(env_file, 0o600)


def main():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        sys.exit("This setup supports Apple Silicon Macs only.")
    if sys.version_info < (3, 10):
        sys.exit("Use Python 3.10 or newer.")
    LOCAL.mkdir(exist_ok=True)
    python = LOCAL / "venv/bin/python"
    if not python.exists():
        venv.create(LOCAL / "venv", with_pip=True)
    subprocess.run([str(python), "-m", "pip", "install", "-r", str(ROOT / "gpu-worker/requirements-mac.txt")], check=True)
    binary = LOCAL / "bin/brush_app"
    ensure_brush(binary)
    subprocess.run([str(binary), "--version"], check=True)
    configure_token()
    print("Ready. Start npm run dev -- --port 3000, then npm run worker:mac in another terminal.")


if __name__ == "__main__":
    main()
