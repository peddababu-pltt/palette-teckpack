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
"""
import importlib
import subprocess
import sys
from pathlib import Path

_VENDOR_DIR = Path(__file__).resolve().parent / "_vendor"
_PIP_READY = _VENDOR_DIR / ".pip-ready"

if str(_VENDOR_DIR) not in sys.path:
    sys.path.insert(0, str(_VENDOR_DIR))


def ensure(modules: list[str], packages: list[str]) -> None:
    """Make each name in `modules` importable, pip-installing `packages` if not.

    Every caller passes its own (modules, packages) pair, so this can't cache
    a single "already bootstrapped" flag across calls for different package
    sets — each call must actually attempt its own install when its modules
    aren't importable yet. `pip install --target` already skips anything it
    finds already satisfied via sys.path, so repeat calls stay cheap.
    """
    if all(_importable(name) for name in modules):
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
    still_missing = [name for name in modules if not _importable(name)]
    if still_missing:
        raise RuntimeError(
            f"runtime dependency bootstrap ran but {still_missing} still can't "
            f"be imported (vendor dir: {_VENDOR_DIR})"
        )


def _importable(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except ImportError:
        return False
