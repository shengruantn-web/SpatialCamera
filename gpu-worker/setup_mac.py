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
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / ".local"
BRUSH_URL = "https://github.com/ArthurBrussee/brush/releases/download/v0.3.0/brush-app-aarch64-apple-darwin.tar.xz"
BRUSH_SHA256 = "65b2631398c839be3c1d4d7160fe2326389dec87830aac0710985e6690a1048c"


def configure_token():
    env_file = ROOT / ".dev.vars"
    content = env_file.read_text() if env_file.exists() else 'LOCAL_DEV="true"\n'
    match = re.search(r"^WORKER_TOKEN\s*=\s*(.*)$", content, re.M)
    if not match or len(match.group(1).strip().strip("\"'")) < 32:
        entry = f'WORKER_TOKEN="{secrets.token_urlsafe(32)}"'
        content = re.sub(r"^WORKER_TOKEN\s*=.*$", entry, content, flags=re.M) if match else content.rstrip() + "\n" + entry + "\n"
        env_file.write_text(content)
        os.chmod(env_file, 0o600)
        print("Configured a random worker token in .dev.vars (value hidden). Restart the web server.")


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
    if not binary.exists():
        archive = LOCAL / "brush-v0.3.0.tar.xz"
        print("Downloading Brush v0.3.0 (41 MB)…", flush=True)
        urllib.request.urlretrieve(BRUSH_URL, archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != BRUSH_SHA256:
            sys.exit("Brush checksum mismatch; the download was not installed.")
        binary.parent.mkdir(exist_ok=True)
        with tarfile.open(archive) as bundle:
            for name in ("brush_app", "LICENSE", "README.md"):
                source = bundle.extractfile(f"brush-app-aarch64-apple-darwin/{name}")
                (binary.parent / name).write_bytes(source.read())
        binary.chmod(0o755)
        archive.unlink()
    subprocess.run([str(binary), "--version"], check=True)
    configure_token()
    print("Ready. Start npm run dev -- --port 3000, then npm run worker:mac in another terminal.")


if __name__ == "__main__":
    main()
