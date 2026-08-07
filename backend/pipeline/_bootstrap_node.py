"""Runtime Node.js + npm-package bootstrap for the hosted Palette OS backend.

The hosted appstore-preview/production runtime has no Node.js installed at
all (confirmed live: a bare `node` exec raises FileNotFoundError), and even if
it did, `bundleBackend()` in @palettelab/cli never ships `node_modules` --
only `backend/`, `pyproject.toml` and `palette-plugin.json` get uploaded. The
~50 @freesewing/* packages photo-draft.mjs/analyze-upload.mjs need were never
going to be there either way.

Locally under `pltt dev`, both happen to already exist because this plugin's
repo sits inside the older standalone `app.py` project one directory up,
which has its own `node_modules` -- so `ensure_node()`/`ensure_npm_packages()`
are no-ops there; they only do anything on the hosted runtime where node (or
a package) is actually missing.

`pipeline_dir` is always passed in by the caller (main.py's own freshly
computed PIPELINE_DIR) rather than derived from this module's own `__file__`:
this module gets `import`ed into the long-lived FastAPI process itself (unlike
the Python pipeline scripts, which each run as a brand new OS subprocess), so
Python caches it in `sys.modules` on first import -- a module-level constant
computed once from `__file__` would stay frozen at whichever publish's
directory happened to be live the first time this process ever imported it,
silently pointing every later publish's calls at that stale, unrelated path.

`ensure_node()` downloads a portable Node.js release straight from
nodejs.org and extracts it into a directory cached alongside this file.
`ensure_npm_packages()` runs that vendored npm to install the given packages
directly into `pipeline_dir`/node_modules, where Node's own module resolution
(walking up from the importing script's own path) finds them without any
extra config (NODE_PATH isn't honored for ES module imports).
"""
import hashlib
import os
import shutil
import subprocess
import tarfile
from pathlib import Path

_NODE_VERSION = "20.18.1"
_NODE_SHA256 = "259e5a8bf2e15ecece65bd2a47153262eda71c0b2c9700d5e703ce4951572784"
_NODE_TARBALL = f"node-v{_NODE_VERSION}-linux-x64"
_NODE_URL = f"https://nodejs.org/dist/v{_NODE_VERSION}/{_NODE_TARBALL}.tar.gz"


def ensure_node(pipeline_dir: Path) -> str:
    """Return a working `node` executable path, downloading one if needed."""
    system_node = shutil.which("node")
    if system_node:
        return system_node

    vendor_node_dir = pipeline_dir / "_vendor_node"
    node_bin = vendor_node_dir / _NODE_TARBALL / "bin" / "node"
    if node_bin.is_file():
        return str(node_bin)

    import requests

    vendor_node_dir.mkdir(exist_ok=True)
    archive = vendor_node_dir / f"{_NODE_TARBALL}.tar.gz"
    resp = requests.get(_NODE_URL, timeout=180)
    resp.raise_for_status()
    digest = hashlib.sha256(resp.content).hexdigest()
    if digest != _NODE_SHA256:
        raise RuntimeError(f"node download checksum mismatch: got {digest}")
    archive.write_bytes(resp.content)
    with tarfile.open(archive) as tf:
        tf.extractall(vendor_node_dir, filter="data")
    archive.unlink()

    if not node_bin.is_file():
        raise RuntimeError(f"node extraction didn't produce {node_bin}")
    return str(node_bin)


def ensure_npm_packages(pipeline_dir: Path, packages: list[str]) -> None:
    """Install `packages` (e.g. "@freesewing/aaron@^4.10.0") into
    `pipeline_dir`/node_modules if any of them don't already resolve."""
    missing = [pkg for pkg in packages if not _resolves(pipeline_dir, pkg)]
    if not missing:
        return

    node_bin = Path(ensure_node(pipeline_dir))
    node_root = node_bin.parent.parent  # .../node-vX.Y.Z-linux-x64
    npm_cli = node_root / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
    node_exe = str(node_bin) if npm_cli.is_file() else "node"

    env = dict(os.environ)
    env["PATH"] = f"{node_bin.parent}{os.pathsep}{env.get('PATH', '')}"
    cmd = ([node_exe, str(npm_cli)] if npm_cli.is_file() else ["npm"]) + [
        "install", "--no-save", "--no-audit", "--no-fund",
        "--prefix", str(pipeline_dir), *missing,
    ]
    result = subprocess.run(cmd, cwd=str(pipeline_dir), env=env,
                             capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"npm install failed for {missing}:\n"
            f"{result.stdout[-2000:]}\n{result.stderr[-2000:]}"
        )

    # Verify by actually importing each package, not just re-checking that its
    # directory exists. `_resolves` above is deliberately cheap (a directory
    # exists check) so the common already-installed path never has to spawn
    # node -- but that same cheapness is blind to a package whose top-level
    # directory landed fine while ITS OWN internal require of something else
    # failed (measured live: `@resvg/resvg-js` installed, but its
    # platform-specific `@resvg/resvg-js-linux-x64-gnu` optional dependency
    # didn't, so requiring it threw MODULE_NOT_FOUND at import time -- a
    # directory-exists check on `@resvg/resvg-js` itself saw nothing wrong).
    # An actual import exercises that whole chain, the same way the real
    # pipeline script's own `import` will moments later.
    still_broken = [pkg for pkg in packages
                    if not _imports(node_exe, env, pipeline_dir, pkg)]
    if still_broken:
        raise RuntimeError(f"npm install ran but {still_broken} still don't import")


def _resolves(pipeline_dir: Path, spec: str) -> bool:
    """Mirror Node's own upward node_modules search from pipeline_dir, so this
    matches "no packages installed" locally (already satisfied by the older
    standalone project's node_modules a few directories up) vs on the hosted
    runtime (no ancestor has them, so they land in pipeline_dir/node_modules,
    which -- being the first directory Node itself checks -- is exactly where
    the real subprocess run will find them too).

    Cheap on purpose (no node spawned) so the common already-satisfied case
    -- true on every call locally -- stays free. Only tells you the package's
    own directory is present, not that requiring it actually works; see
    `_imports` for the real check, run once after a fresh install."""
    if spec.startswith("@"):
        name = "@" + spec[1:].split("@")[0]
    else:
        name = spec.split("@")[0]
    return any((d / "node_modules" / name).is_dir()
               for d in (pipeline_dir, *pipeline_dir.parents))


def _imports(node_exe: str, env: dict, pipeline_dir: Path, spec: str) -> bool:
    """True when `node` can actually import the package `spec` names, run
    with cwd=pipeline_dir so Node's own module resolution walks up from
    exactly where the real pipeline script's import will."""
    name = ("@" + spec[1:].split("@")[0]) if spec.startswith("@") else spec.split("@")[0]
    result = subprocess.run(
        [node_exe, "--input-type=module", "-e",
         f"import({name!r}).then(() => process.exit(0), (e) => {{ "
         f"console.error(String(e && e.message || e)); process.exit(1); }})"],
        cwd=str(pipeline_dir), env=env, capture_output=True, text=True,
    )
    return result.returncode == 0
