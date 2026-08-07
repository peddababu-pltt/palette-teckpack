# Vendored potrace

`potrace` (linux/amd64) + `libpotrace.so.0` extracted from Debian's official
`potrace_1.16-2+b3_amd64.deb` / `libpotrace0_1.16-2+b3_amd64.deb`
(https://deb.debian.org/debian/pool/main/p/potrace/). Fallback for the
Palette hosted runtime, which has no apt/Docker hook to install a system
`potrace` binary (see `_resolve_potrace()` in `../layered_trace_v4.py`) — the
plugin ships pip-only deps per `pyproject.toml`. A system `potrace` on PATH
(e.g. via Homebrew locally) always takes priority over this fallback.

potrace is GPL-2+ licensed (https://potrace.sourceforge.net/); these binaries
are used as an unmodified external tool invoked via subprocess, not linked
into this project's own code.

Verified 2026-08-07 by running both files in a `python:3.12-slim` (Debian
bookworm/trixie) container — matches the Debian-based images most Python
PaaS runtimes use — with no system potrace installed.
