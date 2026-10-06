"""Runtime dependency bootstrap for the hosted Palette OS backend.

The hosted appstore-preview/production runtime executes this plugin's
pipeline scripts inside a shared platform venv that never installs this
plugin's own pyproject.toml dependencies (that file is only read by
`pltt dev`/`pltt test` locally) — and `pip` itself is stripped from that venv.
`pltt dev` and CI already have every package installed normally, so `ensure()`
is a no-op there; it only does anything on the hosted runtime where the
import is actually missing.

`ensure()` restores `pip` via the stdlib `ensurepip` module (bundled wheels,
no network needed for pip itself) and installs the missing packages into a
directory cached alongside this file, shared across every pipeline script's
subprocess invocations within the same container.

That shared venv is exactly what its name says -- shared. An earlier publish
of this same plugin, or an entirely different plugin on the same host, can
have already made e.g. `scipy` importable at whatever version IT happened to
pin, and a plain importability check treats that as satisfied forever. This
pipeline's own behavior (region segmentation, boundary synthesis, connected-
component labeling) leans on exact numeric/algorithmic behavior of scipy/
numpy/scikit-image, which drifts across their own versions -- so "importable"
is not the same guarantee as "pinned version," and only the latter is what
was actually tested locally. `ensure()` therefore checks the installed
version against each package's `==` pin, not just whether the name imports,
and reinstalls into `_VENDOR_DIR` (first on sys.path, so it always wins over
whatever the shared venv already has) on any mismatch.
"""
import importlib
import importlib.metadata
import subprocess
import sys
from pathlib import Path

# Hosted, the plugin's own folder is the one writable place it has. Locally
# (a git checkout) the same installs go outside backend/: `pltt` bundles every
# file under backend/, and a vendored scipy + OpenCV there put the backend
# bundle past its size limit.
_PIPELINE_DIR = Path(__file__).resolve().parent
_REPO_DIR = _PIPELINE_DIR.parents[1]
_VENDOR_DIR = (
    _REPO_DIR / ".palette" / "py-vendor" if (_REPO_DIR / ".git").exists() else _PIPELINE_DIR / "_vendor"
)
_PIP_READY = _VENDOR_DIR / ".pip-ready"

if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))


def ensure(modules: list[str], packages: list[str]) -> None:
    """Make each `modules[i]` importable at exactly `packages[i]`'s pinned
    version (the two lists are 1:1 by position, e.g. modules=["scipy"]
    packages=["scipy==1.18.0"]), pip-installing into _VENDOR_DIR if not.

    Every caller passes its own (modules, packages) pair, so this can't cache
    a single "already bootstrapped" flag across calls for different package
    sets — each call must actually attempt its own install when its modules
    aren't at the pinned version yet. `pip install --target` already skips
    anything it finds already satisfied via sys.path, so repeat calls stay
    cheap once _VENDOR_DIR itself has the right version installed.
    """
    if all(_satisfied(mod, spec) for mod, spec in zip(modules, packages)):
        return

    _VENDOR_DIR.mkdir(exist_ok=True)
    if not _PIP_READY.is_file():
        subprocess.run([sys.executable, "-m", "ensurepip", "--upgrade"],
                        check=False, capture_output=True)
        _PIP_READY.write_text("ok")

    result = subprocess.run(
        [sys.executable, "-m", "pip", "install",
         "--target", str(_VENDOR_DIR), "--no-warn-script-location", *packages],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"runtime dependency bootstrap failed installing {packages}:\n"
            f"{result.stdout[-2000:]}\n{result.stderr[-2000:]}"
        )

    importlib.invalidate_caches()
    still_missing = [mod for mod, spec in zip(modules, packages)
                      if not _satisfied(mod, spec)]
    if still_missing:
        raise RuntimeError(
            f"runtime dependency bootstrap ran but {still_missing} still don't "
            f"match their pinned version (vendor dir: {_VENDOR_DIR})"
        )


def _satisfied(module_name: str, pinned_spec: str) -> bool:
    """True when `module_name` imports AND, if `pinned_spec` carries an `==`
    pin, its installed package version matches that pin exactly."""
    try:
        importlib.import_module(module_name)
    except ImportError:
        return False
    if "==" not in pinned_spec:
        return True
    pip_name, _, wanted = pinned_spec.partition("==")
    try:
        return importlib.metadata.version(pip_name) == wanted
    except importlib.metadata.PackageNotFoundError:
        return False
