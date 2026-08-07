# Vendored potrace

`potrace` (linux/amd64), built from potrace 1.16's own unmodified upstream
source tarball (https://deb.debian.org/debian/pool/main/p/potrace/potrace_1.16.orig.tar.gz)
with `./configure --disable-shared --enable-static && make LDFLAGS=-all-static`,
then stripped. Fallback for the Palette hosted runtime, which has no
apt/Docker hook to install a system `potrace` binary (see `_resolve_potrace()`
in `../layered_trace_v4.py`) — the plugin ships pip-only deps per
`pyproject.toml`. A system `potrace` on PATH (e.g. via Homebrew locally)
always takes priority over this fallback.

An earlier version of this fallback was extracted from Debian's prebuilt
`potrace_1.16-2+b3_amd64.deb`/`libpotrace0_1.16-2+b3_amd64.deb` and dynamically
linked against the host's `libc.so.6`. That broke on staging with
`/lib/x86_64-linux-gnu/libc.so.6: version 'GLIBC_2.38' not found` — the
Debian release those .debs came from had a newer glibc than the actual hosted
runtime ships. Building `-all-static` instead means this binary carries no
libc dependency at all: verified running on `debian:stretch-slim` (glibc
2.24, 2017) through `python:3.13-slim` (Debian trixie, glibc 2.39+), so it
can't hit this failure mode again regardless of the hosted runtime's base
image.

potrace is GPL-2+ licensed (https://potrace.sourceforge.net/); this binary is
an unmodified build of the upstream source (no patches), invoked via
subprocess, not linked into this project's own code.

Rebuilt 2026-08-07.
