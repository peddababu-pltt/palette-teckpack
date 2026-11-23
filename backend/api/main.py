"""Techpack plugin backend — runs the garment-techpack pipeline (photo -> flat
sketch -> variations -> parts SVG -> sewing pattern -> spec) directly, as a
Palette OS plugin backend. Ported from the standalone `app.py` FastAPI service
that used to live at the repo root: same job model, same subprocess-driven
pipeline scripts, same SSE event contract — just reachable at
/api/v1/plugins/techpack/* instead of a bare host, and gated by Palette
permissions instead of a shared bearer token.

The pipeline scripts themselves (warp_pattern.py, variations.py,
flat2svg_auto.py, measure_garment.py, regen_sketch.py, and their own
subprocess children) are vendored as copies under backend/pipeline/ and
invoked by absolute path — the repo-root originals are untouched, still used
by the standalone app.py service, so the two copies can drift and need
updating together. Node-based stages (analyze-upload.mjs, photo-draft.mjs)
are vendored the same way; they still resolve their ~50 @freesewing/*
design packages, pdf-lib, @resvg/resvg-js, @google/genai etc. from the repo
root's node_modules, since Node's module resolution walks up from each
script's own path regardless of where under the repo it lives.

Job state is not tied to one server. Ownership/sharing (Job), files (JobFile)
and run progress/cancel (JobRun) are rows in this plugin's database
(techpack_models.py), and the pipeline runs as a Palette durable job
(run_pipeline) on whichever worker picks it up. The `jobs/` directory is only
each server's cache of those files. So any server can list, serve, follow or
cancel any job, and restarts lose nothing.
"""

import asyncio
import io
import json
import mimetypes
import os
import re
import shutil
import sys
import time
import uuid
from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from fastapi import Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from palette_sdk import JobExecution, PluginContext, PluginRouter, get_plugin_context, job, require_permission
from PIL import Image
from pydantic import BaseModel, Field
from sqlalchemy import delete as sa_delete
from sqlalchemy import select

# backend/api/main.py -> backend/api -> backend -> palette-app
PLUGIN_ROOT = Path(__file__).resolve().parents[2]

# Secrets (LLM_ROUTER_API_KEY, PALETTE_API_KEY, ...) live in this plugin's
# own .palette/.env.local -- the same file `pltt publish` reads to sync
# staging/production plugin secrets -- not in any directory above palette-app.
# Loading it explicitly (rather than a bare load_dotenv() upward search)
# keeps this plugin's backend fully self-contained: it never reads env vars
# from an unrelated parent project's .env.
load_dotenv(PLUGIN_ROOT / ".palette" / ".env.local")

router = PluginRouter(tags=["techpack"])

REPO_ROOT = PLUGIN_ROOT.parent
JOBS_DIR = REPO_ROOT / "jobs"
# The directory above the plugin isn't always writable (the appstore review
# sandbox mounts it read-only), so fall back to a private temp dir rather than
# crashing at import time.
try:
    JOBS_DIR.mkdir(exist_ok=True)
except OSError:
    import tempfile

    JOBS_DIR = Path(tempfile.gettempdir()) / "techpack-jobs"
    JOBS_DIR.mkdir(parents=True, exist_ok=True)

# backend/api/main.py -> backend/api -> backend -> pipeline
# Copies of the pipeline scripts, vendored here so this plugin doesn't reach
# outside its own backend/ dir. cwd for subprocesses stays REPO_ROOT below --
# load_dotenv() in the copied scripts finds repo root's .env by walking up
# from cwd, and node's module resolution for the .mjs copies walks up from
# their own file path to repo root's node_modules regardless of cwd.
PIPELINE_DIR = Path(__file__).resolve().parents[1] / "pipeline"

# The hosted runtime has neither Node.js nor these npm packages -- see
# backend/pipeline/_bootstrap_node.py. Locally this list is a no-op: the repo
# already sits inside the older standalone project's node_modules.
#
# This module gets imported into the long-lived FastAPI process itself, so
# once cached in sys.modules under this bare name it would otherwise survive
# every later publish for that process's lifetime -- the platform's hot-reload
# refreshes this entry module (main.py) but doesn't walk its own sub-imports.
# Evicting it first forces Python to re-read the file fresh off THIS publish's
# own PIPELINE_DIR every time main.py itself is freshly (re)executed.
sys.modules.pop("_bootstrap_node", None)
sys.path.insert(0, str(PIPELINE_DIR))
from _bootstrap_node import ensure_node, ensure_npm_packages  # noqa: E402

# Same eviction for the ctx.llm bridge, which lives next to this file.
sys.modules.pop("llm_bridge", None)
sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_bridge  # noqa: E402

# Not evicted like the modules above: re-executing a mapped SQLAlchemy class
# re-registers its table on PluginBase.metadata and fails on hot reload.
from techpack_models import Job, JobFile, JobRun  # noqa: E402

NODE_PACKAGES = [
    "@freesewing/aaron@^4.10.0", "@freesewing/albert@^4.10.0", "@freesewing/ashley@^4.10.0",
    "@freesewing/bee@^4.10.0", "@freesewing/bella@^4.10.0", "@freesewing/benjamin@^4.10.0",
    "@freesewing/bent@^4.10.0", "@freesewing/bibi@^4.10.0", "@freesewing/breanna@^4.10.0",
    "@freesewing/brian@^4.10.0", "@freesewing/bruce@^4.10.0", "@freesewing/carlita@^4.10.0",
    "@freesewing/carlton@^4.10.0", "@freesewing/charlie@^4.10.0", "@freesewing/config@^4.10.0",
    "@freesewing/core@^4.10.0", "@freesewing/core-plugins@^4.10.0", "@freesewing/cornelius@^4.10.0",
    "@freesewing/devon@^4.10.0", "@freesewing/diana@^4.10.0", "@freesewing/hannah@^4.10.0",
    "@freesewing/huey@^4.10.0", "@freesewing/hugo@^4.10.0", "@freesewing/i18n@^4.10.0",
    "@freesewing/jett@^4.10.0", "@freesewing/lumina@^4.10.0", "@freesewing/lumira@^4.10.0",
    "@freesewing/noble@^4.10.0", "@freesewing/onyx@^4.10.0", "@freesewing/otis@^4.10.0",
    "@freesewing/penelope@^4.10.0", "@freesewing/plugin-annotations@^4.10.0",
    "@freesewing/plugin-theme@^4.10.0", "@freesewing/plugin-transform@^4.10.0",
    "@freesewing/sandy@^4.10.0", "@freesewing/sarah@^4.10.0", "@freesewing/shale@^4.10.0",
    "@freesewing/shin@^4.10.0", "@freesewing/simon@^4.10.0", "@freesewing/simone@^4.10.0",
    "@freesewing/snapseries@^4.10.0", "@freesewing/sven@^4.10.0", "@freesewing/teagan@^4.10.0",
    "@freesewing/tina@^4.10.0", "@freesewing/titan@^4.10.0", "@freesewing/toni@^4.10.0",
    "@freesewing/tristan@^4.10.0", "@freesewing/uma@^4.10.0", "@freesewing/umbra@^4.10.0",
    "@freesewing/wahid@^4.10.0", "@freesewing/yuri@^4.10.0",
    "@google/genai@^2.16.0", "pdf-lib@^1.17.1", "@resvg/resvg-js@^2.6.2",
]

# cairosvg-adjacent native libs some pipeline stages load via ctypes; on
# macOS/Homebrew that lib isn't on the default dlopen search path.
import os as _os  # noqa: E402

SUBPROCESS_ENV = dict(_os.environ)
SUBPROCESS_ENV["DYLD_LIBRARY_PATH"] = "/opt/homebrew/lib:" + SUBPROCESS_ENV.get("DYLD_LIBRARY_PATH", "")

# Every pipeline script under backend/pipeline/ reads these via plain
# os.getenv() -- ported straight from the old standalone app.py, which ran
# with a real .env file on disk. On the actual Palette platform (hosted
# preview/production, not `pltt dev`'s local simulator), plugin secrets are
# never written into this process's OS environment: they only ever reach a
# request as `ctx.secret(key)` (backed by request.state.plugin_config,
# injected by platform middleware). So every route that spawns one of these
# scripts has to pull the secrets out of its own request's PluginContext and
# layer them onto SUBPROCESS_ENV per call -- there's no way to load them once
# at import time the way SUBPROCESS_ENV itself is built above.
PLUGIN_SECRET_KEYS = (
    "LLM_ROUTER_API_KEY", "LLM_ROUTER_BASE_URL", "LLM_ROUTER_UPSCALE_URL", "LLM_ROUTER_IMAGE_MODEL",
    "PALETTE_API_KEY", "PALETTE_LLM_BASE_URL",
    # `pltt publish` skips every PALETTE_* key as reserved, so the hosted app
    # only ever sees the gateway key under these names.
    "TECHPACK_LLM_API_KEY", "TECHPACK_LLM_BASE_URL",
)


def subprocess_env(ctx: PluginContext) -> dict:
    env = dict(SUBPROCESS_ENV)
    for key in PLUGIN_SECRET_KEYS:
        value = ctx.secret(key, "")
        if value:
            env[key] = value
    # Every Claude / Gemini call in the pipeline goes through the loopback
    # bridge (llm_bridge.py) to the Palette LLM gateway, authenticated with
    # PALETTE_API_KEY -- no Anthropic / Google key is used. Without that key
    # the bridge falls back to ctx.llm, which is request-scoped: called from
    # the bridge minutes later it fails with `billing_context_missing`.
    # LLM_ROUTER_* (image edit / upscale) is untouched by this.
    env.update(llm_bridge.env_for(ctx, llm_bridge.gateway_from(env)))
    return env


# --- Durable job state ---------------------------------------------------------
# Nothing about a job lives only in one server's memory or on its disk:
#   - files: techpack__job_files (JobFile). JOBS_DIR is a per-server cache that
#     pull_files() fills from the database and push_files() writes back from;
#   - runs: techpack__job_runs (JobRun) holds status, the event log the page
#     polls (GET /jobs/{id}/run), and the cancel request;
#   - the pipeline itself runs as a Palette durable job (RUN_HANDLER), on
#     whichever worker picks it up, not as a subprocess of the request's server.
# So a follow-up request that lands on another server, or after a restart,
# finds the same files, progress and cancel flag.
RUN_HANDLER = "techpack.run"
RUN_ACTIVE = ("queued", "running")
RUN_EVENTS_KEPT = 400
# A running job's row is touched at least every FLUSH_EVERY seconds; a row this
# old belongs to a worker that died or was timed out, and no longer blocks
# a rerun or keeps the page waiting.
RUN_STALE_AFTER = timedelta(seconds=150)
FLUSH_EVERY = 1.0
SYNC_SKIP_DIRS = {".thumbs", "__pycache__"}
PUSH_BATCH_BYTES = 32 * 1024 * 1024


def job_slot(job_id: str, stage: str | None) -> str:
    return f"{job_id}:{stage}" if stage else job_id


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime | None) -> datetime | None:
    # SQLite hands timezone-aware columns back naive
    return dt.replace(tzinfo=UTC) if dt is not None and dt.tzinfo is None else dt


def _version(mtime: float) -> float:
    # Rounded so a cached copy (os.utime) reads back exactly the stored version.
    return round(float(mtime), 3)


async def _commit(ctx: PluginContext) -> None:
    try:
        await ctx.db.commit()
    except Exception:
        await ctx.db.rollback()
        raise


async def _fresh(ctx: PluginContext, model, row_id: str):
    """The row as committed right now (not a copy cached in this session)."""
    stmt = (select(model).where(model.id == row_id, model.organization_id == ctx.organization_id)
            .execution_options(populate_existing=True))
    return (await ctx.db.execute(stmt)).scalar_one_or_none()


def run_is_active(run: JobRun | None) -> bool:
    if run is None or run.status not in RUN_ACTIVE:
        return False
    return _utcnow() - _aware(run.updated_at) < RUN_STALE_AFTER


async def get_run(ctx: PluginContext, slot: str) -> JobRun | None:
    return await _fresh(ctx, JobRun, slot)


async def is_generating(ctx: PluginContext, job_id: str) -> bool:
    # The generate pipeline (sketch -> redraw -> variations -> classify) is still
    # running. Parts SVG and the pattern must not start before it ends: they
    # trace effective_sketch(), and mid-run that is still the raw flat.
    run = await get_run(ctx, job_id)
    return bool(run and run.generating and run_is_active(run))


def _append_events(run: JobRun, items: list[str]) -> None:
    if not items:
        return
    run.events = ((run.events or []) + items)[-RUN_EVENTS_KEPT:]
    run.events_total = (run.events_total or 0) + len(items)


async def start_run(ctx: PluginContext, job_id: str, stage: str | None, spec: dict, *,
                    generating: bool = False) -> JobRun:
    """(Re)start one pipeline slot of a job as a durable job. A slot that is
    already running is returned as-is -- the page re-attaches to it after a
    reload, and a second worker racing the first over the same output files
    would corrupt them."""
    slot = job_slot(job_id, stage)
    run = await get_run(ctx, slot)
    if run_is_active(run):
        return run
    now = _utcnow()
    values = {
        "job_id": job_id, "stage": stage or "", "run_id": uuid.uuid4().hex, "handle_id": None,
        "status": "queued", "generating": generating, "cancel_requested": False,
        "events": [], "events_total": 0, "error": None, "created_at": now, "updated_at": now,
    }
    if run is None:
        run = JobRun(id=slot, organization_id=ctx.organization_id, **values)
        ctx.db.add(run)
    else:
        for key, value in values.items():
            setattr(run, key, value)
    await _commit(ctx)
    try:
        handle = await ctx.jobs.enqueue(
            RUN_HANDLER,
            {"job_id": job_id, "slot": slot, "run_id": run.run_id, "spec": spec},
            idempotency_key=f"{slot}:{run.run_id}",
        )
    except Exception as exc:  # no durable job service, or the platform refused
        run.status = "error"
        run.error = f"couldn't queue the job: {exc}"[:2000]
        _append_events(run, [json.dumps({"event": "error", "message": run.error})])
        await _commit(ctx)
        return run
    run.handle_id = handle.id
    await _commit(ctx)
    return run


# --- Job files: database is the source, JOBS_DIR a cache --------------------------
def _sync_skip(rel_parts: tuple[str, ...], name: str) -> bool:
    return bool(SYNC_SKIP_DIRS.intersection(rel_parts)) or name.endswith(".part")


def _local_files(job_dir: Path) -> dict[str, tuple[int, float]]:
    out: dict[str, tuple[int, float]] = {}
    if not job_dir.is_dir():
        return out
    for p in job_dir.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(job_dir)
        if _sync_skip(rel.parts, p.name):
            continue
        st = p.stat()
        out[rel.as_posix()] = (st.st_size, _version(st.st_mtime))
    return out


async def _db_file_meta(ctx: PluginContext, job_ids: list[str]) -> dict[str, dict[str, tuple[int, float]]]:
    out: dict[str, dict[str, tuple[int, float]]] = {j: {} for j in job_ids}
    if not job_ids:
        return out
    stmt = select(JobFile.job_id, JobFile.path, JobFile.size, JobFile.mtime).where(
        JobFile.organization_id == ctx.organization_id, JobFile.job_id.in_(job_ids))
    for job_id, path, size, mtime in (await ctx.db.execute(stmt)).all():
        out.setdefault(job_id, {})[path] = (size, _version(mtime))
    return out


def _safe_job_file(job_id: str, rel: str) -> Path | None:
    """JOBS_DIR/<job_id>/<rel>, or None if rel climbs out of the job folder."""
    job_dir = (JOBS_DIR / job_id).resolve()
    target = (job_dir / rel).resolve()
    if job_dir not in target.parents:
        return None
    return target


def _write_cached(target: Path, data: bytes, mtime: float) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.name}.{uuid.uuid4().hex[:6]}.part")
    tmp.write_bytes(data)
    os.utime(tmp, (mtime, mtime))
    tmp.replace(target)


async def _fetch_into_cache(ctx: PluginContext, job_id: str, wanted: dict[str, float]) -> None:
    ids = [f"{job_id}/{rel}" for rel in wanted]
    for i in range(0, len(ids), 20):
        stmt = select(JobFile.path, JobFile.content, JobFile.mtime).where(
            JobFile.organization_id == ctx.organization_id, JobFile.id.in_(ids[i:i + 20]))
        for rel, content, mtime in (await ctx.db.execute(stmt)).all():
            target = _safe_job_file(job_id, rel)
            if target is not None:
                await asyncio.to_thread(_write_cached, target, content, _version(mtime))


async def pull_files(ctx: PluginContext, job_id: str, only: list[str] | None = None) -> None:
    """Bring this server's cached copy of the job up to date with the database."""
    meta = (await _db_file_meta(ctx, [job_id]))[job_id]
    local = _local_files(JOBS_DIR / job_id)
    wanted = {rel: m[1] for rel, m in meta.items()
              if (only is None or rel in only) and local.get(rel) != m}
    if wanted:
        await _fetch_into_cache(ctx, job_id, wanted)


async def pull_one(ctx: PluginContext, job_id: str, rel: str) -> Path | None:
    """One job file in this server's cache, fetched if missing or stale; None if
    the job has no such file."""
    target = _safe_job_file(job_id, rel)
    if target is None:
        return None
    row = (await ctx.db.execute(select(JobFile.size, JobFile.mtime).where(
        JobFile.organization_id == ctx.organization_id, JobFile.id == f"{job_id}/{rel}"))).first()
    if row is None:
        return None
    size, mtime = row[0], _version(row[1])
    try:
        st = target.stat()
        fresh = st.st_size == size and _version(st.st_mtime) == mtime
    except OSError:
        fresh = False
    if not fresh:
        await _fetch_into_cache(ctx, job_id, {rel: mtime})
    return target if target.is_file() else None


async def push_files(ctx: PluginContext, job_id: str, only: list[str] | None = None) -> None:
    """Store every new or changed file of the job's local folder in the database."""
    job_dir = JOBS_DIR / job_id
    local = _local_files(job_dir)
    stored = (await _db_file_meta(ctx, [job_id]))[job_id]
    changed = [rel for rel, m in local.items() if (only is None or rel in only) and stored.get(rel) != m]
    pending = 0
    for rel in changed:
        size, mtime = local[rel]
        data = await asyncio.to_thread((job_dir / rel).read_bytes)
        file_id = f"{job_id}/{rel}"
        row = await _fresh(ctx, JobFile, file_id) if rel in stored else None
        if row is None:
            ctx.db.add(JobFile(
                id=file_id, organization_id=ctx.organization_id, job_id=job_id, path=rel, content=data,
                content_type=mimetypes.guess_type(rel)[0], size=len(data), mtime=mtime,
            ))
        else:
            row.content, row.size, row.mtime = data, len(data), mtime
        pending += len(data)
        if pending >= PUSH_BATCH_BYTES:
            await _commit(ctx)
            pending = 0
    if changed:
        await _commit(ctx)


async def delete_job_data(ctx: PluginContext, job_id: str) -> None:
    for model in (JobFile, JobRun):
        await ctx.db.execute(sa_delete(model).where(
            model.organization_id == ctx.organization_id, model.job_id == job_id))
    await ctx.db.execute(sa_delete(Job).where(Job.organization_id == ctx.organization_id, Job.id == job_id))
    await _commit(ctx)


class FileView:
    """Which files a job has, and their versions, from the database or this
    server's cache -- the job list and the stage-done payloads read this
    instead of stat()-ing files that may not be on this server at all."""

    def __init__(self, job_id: str, meta: dict[str, tuple[int, float]], json_files: dict[str, bytes]):
        self.job_id = job_id
        self.meta = meta
        self._json = json_files

    @classmethod
    def local(cls, job_id: str) -> "FileView":
        job_dir = JOBS_DIR / job_id
        meta = _local_files(job_dir)
        json_files = {rel: (job_dir / rel).read_bytes() for rel in LIST_JSON_FILES if rel in meta}
        return cls(job_id, meta, json_files)

    def is_file(self, rel: str) -> bool:
        return rel in self.meta

    def mtime(self, rel: str) -> float | None:
        m = self.meta.get(rel)
        return m[1] if m else None

    def size(self, rel: str) -> int:
        m = self.meta.get(rel)
        return m[0] if m else 0

    def json(self, rel: str):
        raw = self._json.get(rel)
        if raw is None:
            return None
        try:
            return json.loads(raw)
        except ValueError:
            return None

    def names_in(self, folder: str, suffix: str) -> list[str]:
        prefix = folder.rstrip("/") + "/"
        return sorted(rel[len(prefix):] for rel in self.meta
                      if rel.startswith(prefix) and "/" not in rel[len(prefix):] and rel.endswith(suffix))


LIST_JSON_FILES = ("variations/manifest.json", "classification.json")


async def db_views(ctx: PluginContext, job_ids: list[str]) -> dict[str, FileView]:
    meta = await _db_file_meta(ctx, job_ids)
    json_files: dict[str, dict[str, bytes]] = {j: {} for j in job_ids}
    if job_ids:
        stmt = select(JobFile.job_id, JobFile.path, JobFile.content).where(
            JobFile.organization_id == ctx.organization_id, JobFile.job_id.in_(job_ids),
            JobFile.path.in_(LIST_JSON_FILES))
        for job_id, path, content in (await ctx.db.execute(stmt)).all():
            json_files.setdefault(job_id, {})[path] = content
    return {j: FileView(j, meta.get(j, {}), json_files.get(j, {})) for j in job_ids}


async def db_view(ctx: PluginContext, job_id: str) -> FileView:
    return (await db_views(ctx, [job_id]))[job_id]


def _sketch_name(view: FileView) -> str:
    """effective_sketch() by name, for a job whose files may not be on this server."""
    for rel in ("sketch_regen.png", "flat_sketch_upscaled.png", "flat_sketch.png"):
        if view.is_file(rel):
            return rel
    return "flat_sketch.png"


def image_error(data: bytes) -> str | None:
    try:
        Image.open(io.BytesIO(data)).verify()
        return None
    except Exception:
        return "not a valid raster image (PNG/JPEG/WEBP) — SVG and other formats aren't supported here"


def save_reference_png(data: bytes, dest: Path) -> None:
    """Normalize an uploaded reference image to real PNG bytes before saving.

    Uploads arrive as PNG, JPEG, or WEBP (image_error() above accepts all
    three), but every reference gets written to a hardcoded "ref_N.png" path
    that downstream code (the image-edit request, _reference_images_response's
    *.png glob) assumes is genuinely PNG. Writing the original JPEG bytes
    under that name left the file readable by anything that sniffs real image
    bytes, but broke strict media-type validation elsewhere (observed:
    Anthropic's vision API rejected a JPEG-labeled-as-PNG reference outright
    with an image/png-vs-image/jpeg mismatch), and left the image-edit
    router's own handling of the same mismatch unverified. Re-encoding to
    real PNG here makes the extension truthful for every consumer, not just
    the tolerant ones.
    """
    img = Image.open(io.BytesIO(data))
    if img.mode == "CMYK":
        img = img.convert("RGB")
    img.save(dest, format="PNG")


def job_paths(job_id: str):
    job_dir = JOBS_DIR / job_id
    return {
        "dir": job_dir,
        "input": job_dir / "input.jpg",
        "sketch": job_dir / "flat_sketch.png",
        "variations_dir": job_dir / "variations",
        "sketch_upscaled": job_dir / "flat_sketch_upscaled.png",
        "parts_svg": job_dir / "parts.svg",
        "pattern_svg": job_dir / "pattern.svg",
        "pattern_pages_pdf": job_dir / "pattern-pages.pdf",
        "pattern_design": job_dir / "pattern-design.json",
        "pattern_pieces_json": job_dir / "pattern-pieces.json",
        "measure_input": job_dir / "measure_input.jpg",
        "measure_out": job_dir / "measurements.json",
        "user_measurements": job_dir / "user-measurements.json",
        "classification": job_dir / "classification.json",
        "regen_input": job_dir / "regen_input.png",
        "regen_out": job_dir / "sketch_regen.png",
    }


# --- Job access control -----------------------------------------------------
# Every job has a row in techpack__jobs (techpack_models.Job): its organisation
# (row-level security keeps other organisations' rows out of every query), the
# user who created it, and who it is shared with. Every /jobs/{job_id}/* route
# loads that row first and refuses with 404 -- never 403, so a probe can't tell
# "exists but not yours" from "doesn't exist" -- when the caller is not the
# owner, not a listed teammate, and the job isn't shared with the whole org.
# Job folders created before this table existed have no row, so they stay on
# disk untouched but are unreachable through the API.
JOB_ID_RE = re.compile(r"[0-9a-f]{12}")


def _job_not_found() -> HTTPException:
    return HTTPException(status_code=404, detail="unknown job_id")


def can_view(job: Job, ctx: PluginContext) -> bool:
    return (
        job.owner_user_id == ctx.user_id
        or bool(job.shared_org)
        or ctx.user_id in (job.shared_user_ids or [])
    )


def is_owner(job: Job, ctx: PluginContext) -> bool:
    return job.owner_user_id == ctx.user_id


async def create_job_row(ctx: PluginContext, job_id: str, kind: str) -> Job:
    return await ctx.repo(Job).create(
        id=job_id, owner_user_id=ctx.user_id, kind=kind, shared_org=False, shared_user_ids=[],
    )


async def authorize_job(ctx: PluginContext, job_id: str, *, owner_only: bool = False) -> Job:
    """The caller's Job row for job_id, or 404. Also the only gate between a
    caller-supplied job_id and JOBS_DIR / job_id, hence the strict format check."""
    if not JOB_ID_RE.fullmatch(job_id or ""):
        raise _job_not_found()
    job = await ctx.repo(Job).get(job_id)
    if job is None or not (is_owner(job, ctx) if owner_only else can_view(job, ctx)):
        raise _job_not_found()
    return job


def _share_payload(job: Job) -> dict:
    return {"org": bool(job.shared_org), "users": list(job.shared_user_ids or [])}


def _new_job_id() -> str:
    return uuid.uuid4().hex[:12]


_DRAWING_CACHE: dict[tuple[str, float], bool] = {}


def input_is_drawing(path: Path) -> bool:
    """True when an upload is a drawing (sketch / flat / hand drawing), not a
    photo of the garment: mostly blank paper and almost no colour. A drawing is
    never used as-is downstream -- the clean flat made from it is -- while a
    real photo still gives the 3D garment its fabric. Cached per file version:
    the dashboard asks for every job on each refresh."""
    try:
        key = (str(path), path.stat().st_mtime)
    except OSError:
        return False
    if key not in _DRAWING_CACHE:
        _DRAWING_CACHE[key] = _looks_like_drawing(path)
    return _DRAWING_CACHE[key]


def _looks_like_drawing(path: Path) -> bool:
    try:
        im = Image.open(path).convert("RGB")
        im.thumbnail((256, 256))
        px = np.asarray(im, dtype=np.int16)
    except (OSError, ValueError):
        return False
    paper = (px.min(axis=2) > 225).mean()
    chroma = float((px.max(axis=2) - px.min(axis=2)).mean())
    return paper > 0.6 and chroma < 12


def effective_sketch(paths) -> Path:
    """The flat everything downstream is built from (parts SVG, pattern, 3D):
    the clean redraw (sketch_regen.png) first. Tracing the stage-1 flat
    directly was tried and reverted -- it carries the input's stitch dashes
    into the SVG, where the redraw keeps the same garment with clean neckline,
    waistband, cuff and sleeve lines and no dashes."""
    for key in ("regen_out", "sketch_upscaled", "sketch"):
        if paths[key].is_file():
            return paths[key]
    return paths["sketch"]



class JobCancelled(Exception):
    pass


class RunReporter:
    """Writes a running job's events, heartbeat and cancel check to its JobRun
    row -- at most every FLUSH_EVERY seconds, from the one coroutine that owns
    this job's session (an AsyncSession isn't safe to share across tasks)."""

    def __init__(self, ctx: PluginContext, run: JobRun, execution: JobExecution):
        self.ctx = ctx
        self.slot = run.id
        self.run_id = run.run_id
        self.execution = execution
        self.pending: list[str] = []
        self.last_flush = 0.0
        self.cancel = False

    def emit(self, item: str | dict) -> None:
        self.pending.append(item if isinstance(item, str) else json.dumps(item))

    async def flush(self, force: bool = False) -> JobRun | None:
        now = time.monotonic()
        if not force and now - self.last_flush < FLUSH_EVERY:
            return None
        self.last_flush = now
        run = await _fresh(self.ctx, JobRun, self.slot)
        if run is None or run.run_id != self.run_id:
            # the job was deleted, or a newer run replaced this one
            self.cancel = True
            self.pending.clear()
            return None
        _append_events(run, self.pending)
        self.pending = []
        run.updated_at = _utcnow()
        if run.cancel_requested:
            self.cancel = True
        await _commit(self.ctx)
        try:
            if await self.execution.cancelled():
                self.cancel = True
            await self.execution.heartbeat()
        except Exception:
            pass
        return run

    async def finish(self, status: str, error: str | None = None) -> None:
        run = await self.flush(force=True)
        if run is None:
            return
        run.status = status
        run.error = error
        run.updated_at = _utcnow()
        await _commit(self.ctx)

    async def wait(self, coro):
        """Await coro while keeping the row's heartbeat and cancel check going."""
        task = asyncio.ensure_future(coro)
        try:
            while True:
                done, _ = await asyncio.wait({task}, timeout=FLUSH_EVERY)
                if done:
                    return task.result()
                await self.flush()
                if self.cancel:
                    raise JobCancelled()
        finally:
            if not task.done():
                task.cancel()


async def run_command(cmd: list[str], stage: str, reporter: RunReporter, env: dict) -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=str(REPO_ROOT), env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
    )
    # Keep a tail of output, not just the last line — a failing subprocess
    # is often itself wrapping a child subprocess (flat2svg_auto.py calling
    # seg_parts.py), so the final line is a generic "CalledProcessError:
    # exit status 1" while the real cause (e.g. a traceback's exception
    # line) sits a dozen lines earlier and would otherwise be discarded.
    tail: deque[str] = deque(maxlen=25)
    read = None
    try:
        while True:
            if read is None:
                read = asyncio.ensure_future(proc.stdout.readline())
            done, _ = await asyncio.wait({read}, timeout=FLUSH_EVERY)
            if done:
                line = read.result()
                read = None
                if not line:
                    break
                text = line.decode(errors="replace").rstrip()
                if text:
                    tail.append(text)
                    reporter.emit(f"[{stage}] {text}")
            await reporter.flush()
            if reporter.cancel:
                raise JobCancelled()
        code = await proc.wait()
    finally:
        if read is not None and not read.done():
            read.cancel()
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            await proc.wait()
    if code != 0:
        raise RuntimeError("\n".join(tail) if tail else f"{stage} exited {code}")


def _variation_args(spec: dict) -> list[str]:
    args = []
    mode = spec.get("mode") or "both"
    if mode == "sketch":
        args += ["--variants", str(int(spec.get("variants") or 2))]
    else:
        if spec.get("colors"):
            args += ["--colors", ",".join(spec["colors"])]
        if spec.get("season"):
            args += ["--season", spec["season"]]
    if spec.get("prompt"):
        args += ["--prompt", spec["prompt"]]
    return args


def _reference_paths(paths) -> list[str]:
    ref_dir = paths["variations_dir"] / "references"
    return [str(p) for p in sorted(ref_dir.glob("ref_*.png"))[:5]] if ref_dir.is_dir() else []


def _url(job_id: str, rel: str) -> str:
    return _file_url(job_id, rel, FileView.local(job_id))


def build_steps(job_id: str, spec: dict):
    """The subprocess steps of one durable run, built on the worker against its
    own cached copy of the job, plus the stage_done payload to send after."""
    paths = job_paths(job_id)
    kind = spec["kind"]
    py = sys.executable

    if kind == "stage1":
        cmd = [py, str(PIPELINE_DIR / "warp_pattern.py"), str(paths["input"]), str(paths["sketch"])]
        return ([("stage 1", cmd)],
                lambda: {"event": "stage_done", "stage": 1, "file": _url(job_id, "flat_sketch.png")})

    if kind == "measure_upload":
        return ([("measure", [py, str(PIPELINE_DIR / "measure_garment.py"), str(paths["measure_input"]),
                              str(paths["measure_out"]), "--size", spec.get("size") or "M"])],
                lambda: {"event": "stage_done", "stage": "measure",
                         "result": json.loads(paths["measure_out"].read_text())})

    if kind == "generate":
        refs = _reference_paths(paths)
        var_cmd = [py, str(PIPELINE_DIR / "variations.py"), str(paths["regen_out"]),
                   str(paths["variations_dir"])] + _variation_args(spec)
        sketch_cmd = [py, str(PIPELINE_DIR / "warp_pattern.py"), str(paths["input"]), str(paths["sketch"])]
        if refs:
            var_cmd += ["--references", ",".join(refs)]
            sketch_cmd += ["--references", ",".join(refs)]
        var_cmd += ["--mode", spec.get("mode") or "both"]
        steps = [
            ("stage 1", sketch_cmd),
            ("redraw", [py, str(PIPELINE_DIR / "regen_sketch.py"), str(paths["sketch"]), str(paths["regen_out"])]),
            ("stage 2", var_cmd),
            ("classify", [py, str(PIPELINE_DIR / "measure_garment.py"), str(paths["regen_out"]),
                          str(paths["classification"]), "--size", "M"]),
        ]

        def on_success():
            view = FileView.local(job_id)
            return {
                "event": "stage_done", "job_id": job_id,
                "variations": _variations_response(job_id, view),
                "references": _reference_images_response(job_id, view),
                "classification": view.json("classification.json"),
            }
        return steps, on_success

    if kind == "pattern_image":
        sheet = paths["dir"] / "pattern-sheet.png"
        steps = [
            ("segment", [py, str(PIPELINE_DIR / "pattern_segment.py"), str(sheet), str(paths["dir"]),
                         "--longest-cm", str(float(spec.get("longest_cm") or 70.0))]),
            ("classify", ["node", str(PIPELINE_DIR / "pattern-image.mjs"), str(paths["dir"]),
                          spec.get("size") or "M", str(sheet)]),
        ]
        return steps, lambda: {
            "event": "stage_done", "job_id": job_id, "stage": "pattern-image",
            "pattern_pieces": _url(job_id, "pattern-pieces.json"),
            "design": _url(job_id, "pattern-design.json"),
        }

    if kind == "regen":
        cmd = [py, str(PIPELINE_DIR / "regen_sketch.py"), str(paths["regen_input"]), str(paths["regen_out"])]
        if spec.get("seed"):
            cmd += ["--seed", spec["seed"]]
        return [("regen", cmd)], lambda: {
            "event": "stage_done", "stage": "regen", "job_id": job_id,
            "file": _url(job_id, "sketch_regen.png"), "input": _url(job_id, "regen_input.png"),
        }

    if kind == "stage2":
        cmd = [py, str(PIPELINE_DIR / "variations.py"), str(paths["sketch"]),
               str(paths["variations_dir"])] + _variation_args(spec)
        refs = _reference_paths(paths) if spec.get("use_refs") else []
        if refs:
            cmd += ["--references", ",".join(refs)]
        cmd += ["--mode", spec.get("mode") or "both"]
        return [("stage 2", cmd)], lambda: {
            "event": "stage_done", "stage": 2, "variations": _variations_response(job_id, FileView.local(job_id)),
        }

    if kind == "redraw":
        # Redraw from the raw stage-1 flat, not from effective_sketch() -- that
        # resolves to the redraw itself, so redrawing twice would reconstruct a
        # reconstruction and drift further from the photo each time.
        source = paths["sketch"] if paths["sketch"].is_file() else effective_sketch(paths)
        cmd = [py, str(PIPELINE_DIR / "regen_sketch.py"), str(source), str(paths["regen_out"])]
        if spec.get("seed"):
            cmd += ["--seed", spec["seed"]]
        return [("redraw", cmd)], lambda: {
            "event": "stage_done", "stage": "redraw",
            "file": _url(job_id, "sketch_regen.png"), "input": _url(job_id, source.name),
        }

    if kind == "stage4":
        return ([("stage 4", [py, str(PIPELINE_DIR / "flat2svg_auto.py"), str(effective_sketch(paths)),
                              str(paths["parts_svg"])])],
                lambda: {"event": "stage_done", "stage": 4, "file": _url(job_id, "parts.svg")})

    if kind == "stage5":
        cmd = ["node", str(PIPELINE_DIR / "photo-draft.mjs"), str(effective_sketch(paths))]
        if paths["user_measurements"].is_file():
            cmd.append(str(paths["user_measurements"]))
        cmd.append(str(paths["pattern_svg"]))
        # No cover-photo argument: the pattern pages' cover then shows the same
        # clean flat the pattern was drafted from (photo-draft falls back to it).
        return [("stage 5", cmd)], lambda: {
            "event": "stage_done", "stage": 5,
            "file": _url(job_id, "pattern.svg"),
            "pages_file": _url(job_id, "pattern-pages.pdf"),
            "pieces_file": _url(job_id, "pattern-pieces.json"),
            "design_file": _url(job_id, "pattern-design.json"),
        }

    if kind == "garment3d":
        sketch, photo = effective_sketch(paths), paths["input"]
        cmd = [py, str(PIPELINE_DIR / "garment3d.py"), str(sketch if sketch.is_file() else photo),
               str(paths["dir"]), "--colour", spec["colour"], "--desc", (spec.get("desc") or "")[:200],
               "--region", spec.get("region") or "upper"]
        if photo.is_file() and not input_is_drawing(photo):
            cmd += ["--photo", str(photo)]
        return [("garment3d", cmd)], lambda: {
            "event": "stage_done", "stage": "garment3d",
            "file": _url(job_id, "garment3d.glb"), "meta": _url(job_id, "garment3d.json"),
        }

    if kind == "job_measure":
        source = paths["input"]
        if not source.is_file() or input_is_drawing(source):
            source = effective_sketch(paths)
        return ([("measure", [py, str(PIPELINE_DIR / "measure_garment.py"), str(source),
                              str(paths["measure_out"]), "--size", spec.get("size") or "M"])],
                lambda: {"event": "stage_done", "stage": "measure",
                         "result": json.loads(paths["measure_out"].read_text()),
                         "file": _url(job_id, "measurements.json")})

    if kind == "simulate":
        blender = _blender_bin()
        if not blender:
            raise RuntimeError("Blender is not installed on the server running this job")
        sim_in = paths["dir"] / "garment-sim-input.json"
        cmd = [blender, "-b", "--factory-startup", "--python", str(PIPELINE_DIR / "blender_sim.py"), "--",
               str(sim_in), str(paths["dir"] / "garment-sim.json"), str(paths["dir"] / "garment.glb")]
        return ([("simulate", cmd)],
                lambda: {"event": "stage_done", "stage": "simulate",
                         "result": _url(job_id, "garment-sim.json"), "glb": _url(job_id, "garment.glb")})

    raise ValueError(f"unknown run kind {kind!r}")


async def _prepare_node(steps, reporter: RunReporter):
    if not any(cmd and cmd[0] == "node" for _, cmd in steps):
        return steps
    reporter.emit(f"[{steps[0][0]}] preparing Node.js runtime and packages...")
    await reporter.flush(force=True)
    await reporter.wait(asyncio.to_thread(ensure_npm_packages, PIPELINE_DIR, NODE_PACKAGES))
    node = await reporter.wait(asyncio.to_thread(ensure_node, PIPELINE_DIR))
    return [(name, [node if c == "node" else c for c in cmd]) for name, cmd in steps]


@job(RUN_HANDLER, timeout_seconds=7200, max_attempts=2)
async def run_pipeline(ctx: PluginContext, execution: JobExecution, payload: dict) -> dict:
    """One pipeline slot of one job, on whichever worker picks it up: fetch the
    job's files from the database, run the steps, store the outputs back, and
    keep the JobRun row (progress, log, cancel) current throughout. Expected
    failures end the run as `error` on the row rather than raising -- a retry
    would only redo paid model calls; the second attempt is for a worker that
    died mid-run."""
    job_id, slot, run_id = payload.get("job_id", ""), payload.get("slot", ""), payload.get("run_id", "")
    spec = payload.get("spec") or {}
    if not JOB_ID_RE.fullmatch(job_id or ""):
        return {"skipped": True, "reason": "bad job id"}
    run = await _fresh(ctx, JobRun, slot)
    if run is None or run.run_id != run_id or run.status not in RUN_ACTIVE:
        return {"skipped": True}
    reporter = RunReporter(ctx, run, execution)
    if run.cancel_requested:
        reporter.emit({"event": "cancelled"})
        await reporter.finish("cancelled")
        return {"status": "cancelled"}
    if await _fresh(ctx, Job, job_id) is None:
        await reporter.finish("error", "this techpack was deleted")
        return {"status": "error"}
    run.status = "running"
    run.updated_at = _utcnow()
    await _commit(ctx)
    if execution.attempt > 1:
        reporter.emit(f"[{spec.get('kind', 'job')}] restarting after the previous worker stopped")

    env = None
    try:
        await reporter.wait(pull_files(ctx, job_id))
        steps, on_success = build_steps(job_id, spec)
        steps = await _prepare_node(steps, reporter)
        env = subprocess_env(ctx)
        total = len(steps)
        for i, (name, cmd) in enumerate(steps):
            reporter.emit({"event": "stage_progress", "stage": name, "completed": i, "total": total,
                           "percent": round(i / total * 100)})
            reporter.emit(f"[{name}] starting")
            try:
                await execution.progress(round(i / total * 100), name)
            except Exception:
                pass
            await reporter.flush(force=True)
            if reporter.cancel:
                raise JobCancelled()
            await run_command(cmd, name, reporter, env)
        await push_files(ctx, job_id)
        reporter.emit(on_success())
        reporter.emit({"event": "done"})
        await reporter.finish("done")
        return {"status": "done"}
    except JobCancelled:
        reporter.emit({"event": "cancelled"})
        await reporter.finish("cancelled")
        return {"status": "cancelled"}
    except Exception as exc:
        message = str(exc) or type(exc).__name__
        reporter.emit({"event": "error", "message": message})
        await reporter.finish("error", message[:4000])
        return {"status": "error"}
    finally:
        llm_bridge.release(env)


def _file_url(job_id: str, rel: str, view: FileView | None = None) -> str:
    # Versioned by the file's own mtime: job files are rewritten in place
    # (redrafts, the white-background pass on realistic.png), and an <img>
    # keeps showing whatever copy the browser cached under the bare URL.
    # The version comes from the database (or this server's cache, which
    # carries the same mtime), so every server hands out the same URL.
    url = f"/api/v1/plugins/techpack/jobs/{job_id}/file/{rel}"
    mtime = (view or FileView.local(job_id)).mtime(rel)
    return f"{url}?v={int(mtime)}" if mtime is not None else url


def _variations_response(job_id: str, view: FileView) -> list[dict]:
    manifest = view.json("variations/manifest.json") or []
    variations = [{
        "id": "default", "label": "Default",
        "sketch": _file_url(job_id, _sketch_name(view), view),
        "realistic": None,
    }]
    for v in manifest:
        variations.append({
            "id": v["id"], "label": v["label"],
            "sketch": _file_url(job_id, f"variations/{v['sketch']}", view) if v.get("sketch") else None,
            "realistic": _file_url(job_id, f"variations/{v['realistic']}", view) if v.get("realistic") else None,
        })
    return variations


def _outputs_response(job_id: str, view: FileView) -> dict:
    def url(name: str) -> str | None:
        return _file_url(job_id, name, view) if view.is_file(name) else None

    return {
        "parts_svg": url("parts.svg"),
        "pattern_svg": url("pattern.svg"),
        "pattern_pages": url("pattern-pages.pdf"),
        "design": url("pattern-design.json"),
        "pattern_pieces": url("pattern-pieces.json"),
        "measurements": url("measurements.json") or url("classification.json"),
        "redraw": url("sketch_regen.png"),
    }


def _reference_images_response(job_id: str, view: FileView) -> list[str]:
    return [_file_url(job_id, f"variations/references/{name}", view)
            for name in view.names_in("variations/references", ".png")]


@router.get("/health")
async def health() -> Response:
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


# Shipped inside backend/ (the repo's node_modules is not part of the hosted
# bundle, so the worker 500'd there and no pattern PDF could load). Copy it
# again from node_modules/pdfjs-dist/build/ whenever pdfjs-dist is upgraded --
# pdf.js refuses a worker from a different version than its own.
PDF_WORKER_PATHS = (
    Path(__file__).resolve().parents[1] / "assets" / "pdf.worker.min.mjs",
    Path(__file__).resolve().parents[2] / "node_modules" / "pdfjs-dist" / "build" / "pdf.worker.min.mjs",
)


@router.get("/assets/pdf.worker.min.mjs")
async def pdfjs_worker() -> Response:
    worker_path = next((p for p in PDF_WORKER_PATHS if p.is_file()), None)
    if worker_path is None:
        return JSONResponse({"error": "pdf.js worker missing"}, status_code=404)
    return FileResponse(str(worker_path), media_type="application/javascript")


# Optional realistic body for the sewing pattern's 3D preview: drop a CC0 / licensed
# A-pose human model at backend/assets/mannequin.glb and the viewer uses it instead
# of its built-in sized mannequin (404 = use the built-in one).
MANNEQUIN_GLB = Path(__file__).resolve().parents[1] / "assets" / "mannequin.glb"


@router.get("/assets/mannequin.glb", dependencies=[require_permission("resources:read")])
async def mannequin_model() -> Response:
    if not MANNEQUIN_GLB.is_file():
        return JSONResponse({"error": "no mannequin model installed"}, status_code=404)
    return FileResponse(str(MANNEQUIN_GLB), media_type="model/gltf-binary")


# 3D virtual try-on assets (scanned body + pre-fitted garment scans), extracted by
# scripts/extract-vton-assets.py into backend/assets/vton/.
VTON_DIR = Path(__file__).resolve().parents[1] / "assets" / "vton"
VTON_TYPES = {".json": "application/json", ".bin": "application/octet-stream", ".jpg": "image/jpeg"}


@router.get("/assets/vton/{name}", dependencies=[require_permission("resources:read")])
async def vton_asset(name: str) -> Response:
    path = VTON_DIR / name
    if not re.fullmatch(r"[a-z0-9_]+\.(json|bin|jpg)", name) or not path.is_file():
        return JSONResponse({"error": "no such try-on asset"}, status_code=404)
    return FileResponse(str(path), media_type=VTON_TYPES[path.suffix], headers={"Cache-Control": "public, max-age=86400"})


def _ok(body: dict | None = None) -> Response:
    return Response(content=json.dumps(body or {"ok": True}), media_type="application/json")


async def _new_job(ctx: PluginContext, kind: str, job_id: str | None = None) -> tuple[str, dict]:
    job_id = job_id or _new_job_id()
    await create_job_row(ctx, job_id, kind)
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True, exist_ok=True)
    return job_id, paths


@router.post("/run", dependencies=[require_permission("resources:write")])
async def run(photo: UploadFile = File(...), ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    if not photo.filename:
        return JSONResponse({"error": "no photo uploaded"}, status_code=400)
    data = await photo.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"photo {err}"}, status_code=400)
    job_id, paths = await _new_job(ctx, "run")
    paths["input"].write_bytes(data)
    await push_files(ctx, job_id)
    await start_run(ctx, job_id, None, {"kind": "stage1"})
    return _ok({"job_id": job_id})


@router.post("/measure", dependencies=[require_permission("resources:write")])
async def measure(
    photo: UploadFile = File(...), size: str = Form(...), ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    if not photo.filename:
        return JSONResponse({"error": "no photo uploaded"}, status_code=400)
    data = await photo.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"photo {err}"}, status_code=400)
    job_id, paths = await _new_job(ctx, "measure")
    paths["measure_input"].write_bytes(data)
    await push_files(ctx, job_id)
    await start_run(ctx, job_id, None, {"kind": "measure_upload", "size": size})
    return _ok({"job_id": job_id})


async def _save_references(references: list[UploadFile], paths) -> str | None:
    """Writes up to 5 reference uploads as variations/references/ref_N.png;
    returns an error message for a bad one."""
    named = [r for r in references if r.filename]
    if not named:
        return None
    ref_dir = paths["variations_dir"] / "references"
    ref_dir.mkdir(parents=True, exist_ok=True)
    for old in ref_dir.glob("ref_*.png"):
        old.unlink()
    for i, ref in enumerate(named[:5]):
        rdata = await ref.read()
        rerr = image_error(rdata)
        if rerr:
            return f"reference image {rerr}"
        save_reference_png(rdata, ref_dir / f"ref_{i + 1}.png")
    return None


@router.post("/jobs/generate", dependencies=[require_permission("resources:write")])
async def generate(
    photo: UploadFile = File(...),
    mode: str = Form("both"),
    variants: int = Form(2),
    colors: list[str] = Form([]),
    season: str = Form(""),
    prompt: str = Form(""),
    measurements: str = Form(""),
    references: list[UploadFile] = File([]),
    request_id: str = Form(""),
    ctx: PluginContext = Depends(get_plugin_context),
) -> Response:
    # One Generate click = one techpack. The browser sends the same request_id
    # on its retry after a gateway 502/503/504 -- and that gateway error can
    # come back AFTER this route already created the job (it uploads the files
    # and queues the run before answering), so the retry used to create a
    # second techpack from the same input. The id becomes the job id; a repeat
    # of it returns the job that already exists.
    request_id = request_id.strip().lower()
    if not JOB_ID_RE.fullmatch(request_id):
        request_id = ""
    if request_id:
        existing = await ctx.repo(Job).get(request_id)
        if existing is not None:
            if is_owner(existing, ctx):
                return _ok({"job_id": request_id, "duplicate": True})
            request_id = ""  # someone else's id (never in practice): mint a fresh one
    if not photo.filename:
        return JSONResponse({"error": "no image uploaded"}, status_code=400)
    data = await photo.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"image {err}"}, status_code=400)

    user_measurements = None
    if measurements.strip():
        try:
            parsed = json.loads(measurements)
        except ValueError:
            return JSONResponse({"error": "measurements is not valid JSON"}, status_code=400)
        if not isinstance(parsed, dict):
            return JSONResponse({"error": "measurements must be an object"}, status_code=400)
        numeric = {k: v for k, v in parsed.items() if isinstance(v, (int, float))}
        if numeric:
            user_measurements = {"measurements": numeric}

    job_id, paths = await _new_job(ctx, "generate", request_id or None)
    paths["input"].write_bytes(data)
    if user_measurements:
        paths["user_measurements"].write_text(json.dumps(user_measurements, indent=2))
    ref_err = await _save_references(references, paths)
    if ref_err:
        return JSONResponse({"error": ref_err}, status_code=400)
    await push_files(ctx, job_id)
    await start_run(ctx, job_id, None, {
        "kind": "generate", "mode": mode, "variants": variants, "colors": colors,
        "season": season, "prompt": prompt,
    }, generating=True)
    return _ok({"job_id": job_id})


@router.post("/jobs/pattern-image", dependencies=[require_permission("resources:write")])
async def pattern_image(
    image: UploadFile = File(...),
    longest_cm: float = Form(70.0),
    size: str = Form("M"),
    ctx: PluginContext = Depends(get_plugin_context),
) -> Response:
    """An image of sewing-pattern pieces -> a job with pattern-pieces.json (segmented +
    classified) and pattern-design.json, ready for the 3D garment workspace."""
    data = await image.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"image {err}"}, status_code=400)
    if not (5 <= longest_cm <= 300):
        return JSONResponse({"error": "longest_cm must be between 5 and 300"}, status_code=400)
    size = size.strip().upper()
    if size not in PATTERN_SIZES:
        size = "M"
    job_id, paths = await _new_job(ctx, "pattern-image")
    save_reference_png(data, paths["dir"] / "pattern-sheet.png")
    await push_files(ctx, job_id)
    await start_run(ctx, job_id, None, {"kind": "pattern_image", "longest_cm": longest_cm, "size": size})
    return _ok({"job_id": job_id})


@router.post("/jobs/new-with-sketch", dependencies=[require_permission("resources:write")])
async def new_with_sketch(
    sketch: UploadFile = File(...), ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    if not sketch.filename:
        return JSONResponse({"error": "no sketch uploaded"}, status_code=400)
    data = await sketch.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"sketch {err}"}, status_code=400)
    job_id, paths = await _new_job(ctx, "new-with-sketch")
    paths["sketch"].write_bytes(data)
    await push_files(ctx, job_id)
    return _ok({"job_id": job_id})


@router.post("/jobs/regen", dependencies=[require_permission("resources:write")])
async def regen(
    sketch: UploadFile = File(...), seed: str = Form(""), ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    """Single-stage: low-quality technical flat -> clean vector-style flat,
    reconstructed by regen_sketch.py (router image-edit alias = nano-banana)."""
    if not sketch.filename:
        return JSONResponse({"error": "no sketch uploaded"}, status_code=400)
    data = await sketch.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"sketch {err}"}, status_code=400)
    job_id, paths = await _new_job(ctx, "regen")
    paths["regen_input"].write_bytes(data)
    await push_files(ctx, job_id)
    await start_run(ctx, job_id, None, {"kind": "regen", "seed": seed.strip()})
    return _ok({"job_id": job_id})


@router.post("/analyze", dependencies=[require_permission("resources:write")])
async def analyze(image: UploadFile = File(...), ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    if not image.filename:
        return JSONResponse({"error": "no image uploaded"}, status_code=400)
    data = await image.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"image {err}"}, status_code=400)

    suffix = Path(image.filename).suffix.lower()
    if suffix not in (".jpg", ".jpeg", ".png", ".webp"):
        suffix = ".png"

    import tempfile

    await asyncio.to_thread(ensure_npm_packages, PIPELINE_DIR, NODE_PACKAGES)
    with tempfile.TemporaryDirectory() as tmp:
        tmp_image = Path(tmp) / f"upload{suffix}"
        tmp_image.write_bytes(data)
        env = subprocess_env(ctx)
        try:
            proc = await asyncio.create_subprocess_exec(
                ensure_node(PIPELINE_DIR), str(PIPELINE_DIR / "analyze-upload.mjs"), str(tmp_image),
                cwd=str(REPO_ROOT), env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await proc.communicate()
        finally:
            llm_bridge.release(env)

    if proc.returncode != 0:
        try:
            message = json.loads(stdout.decode()).get("error", "")
        except (ValueError, UnicodeDecodeError):
            message = ""
        message = message or (stderr.decode(errors="replace").strip().splitlines()[-1:] or ["analysis failed"])
        return JSONResponse(
            {"error": message if isinstance(message, str) else message[0]}, status_code=502
        )

    try:
        return Response(content=stdout.decode(), media_type="application/json")
    except ValueError:
        return JSONResponse({"error": "analysis returned malformed JSON"}, status_code=502)


@router.get("/jobs/list", dependencies=[require_permission("resources:read")])
async def jobs_list(ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    # Built from the caller's visible Job rows and the database's file list,
    # never from JOBS_DIR: that folder is one server's cache, shared by every
    # organisation on it.
    repo = ctx.repo(Job)
    rows = {r.id: r for r in await repo.list(filters={"owner_user_id": ctx.user_id},
                                              order_by="-created_at", limit=500)}
    for r in await repo.list(order_by="-created_at", limit=500):
        if r.id not in rows and can_view(r, ctx):
            rows[r.id] = r
    ids = [j for j in rows if JOB_ID_RE.fullmatch(j)]
    views = await db_views(ctx, ids)
    generating = set()
    if ids:
        stmt = select(JobRun).where(JobRun.organization_id == ctx.organization_id, JobRun.job_id.in_(ids),
                                    JobRun.generating.is_(True))
        generating = {r.job_id for r in (await ctx.db.execute(stmt)).scalars() if run_is_active(r)}
    jobs = []
    for job_id in ids:
        row, view = rows[job_id], views[job_id]
        has_sketch = view.is_file("flat_sketch.png")
        if has_sketch:
            display_name = _sketch_name(view)
        elif view.is_file("sketch_regen.png"):
            display_name = "sketch_regen.png"
        else:
            continue
        owner = is_owner(row, ctx)
        jobs.append({
            "job_id": job_id,
            "sketch": _file_url(job_id, display_name, view),
            # The dashboard card shows the clean redraw the SVG and pattern are
            # built from (not the raw upload). Variations stay inside the job page.
            "thumb": (f"/api/v1/plugins/techpack/jobs/{job_id}/thumb/{display_name}"
                      f"?v={int(view.mtime(display_name))}"),
            "input": _file_url(job_id, "input.jpg", view) if view.is_file("input.jpg") else None,
            "size_kb": round(view.size(display_name) / 1024, 1),
            "mtime": view.mtime(display_name),
            "classification": view.json("classification.json"),
            "has_sketch": has_sketch,
            "generating": job_id in generating,
            "variations": _variations_response(job_id, view) if has_sketch else [],
            "references": _reference_images_response(job_id, view),
            "outputs": _outputs_response(job_id, view),
            "owner": owner,
            # who else can see it -- only the owner is told
            "shared": _share_payload(row) if owner else None,
        })
    jobs.sort(key=lambda j: j["mtime"], reverse=True)
    return _ok({"jobs": jobs[:50]})


@router.get("/jobs/{job_id}/run", dependencies=[require_permission("resources:read")])
async def job_run_status(
    job_id: str, stage: str | None = None, after: int = 0, ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    """A run's state and its events after the first `after` -- what the page
    polls in place of the old per-server SSE stream. Events are the same
    strings that stream carried: a JSON event (stage_progress, stage_done,
    error, cancelled, done) or a "[stage] log line"."""
    await authorize_job(ctx, job_id)
    run = await get_run(ctx, job_slot(job_id, stage))
    if run is None:
        return JSONResponse({"error": "unknown job_id"}, status_code=404)
    first = (run.events_total or 0) - len(run.events or [])
    events = (run.events or [])[max(0, after - first):]
    status, error = run.status, run.error
    if status in RUN_ACTIVE and not run_is_active(run):
        status = "error"
        error = "the job stopped responding (its worker restarted or timed out) -- run it again"
        events = events + [json.dumps({"event": "error", "message": error})]
    return _ok({"status": status, "total": run.events_total or 0, "events": events, "error": error})


@router.post("/jobs/{job_id}/cancel", dependencies=[require_permission("resources:write")])
async def cancel_job(
    job_id: str, stage: str | None = None, ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    await authorize_job(ctx, job_id)
    run = await get_run(ctx, job_slot(job_id, stage))
    if not run_is_active(run):
        return JSONResponse({"error": "no running stage for this job"}, status_code=404)
    # Recorded on the row, so it reaches the worker wherever it runs; the worker
    # checks it every second and kills its subprocess.
    run.cancel_requested = True
    await _commit(ctx)
    if run.handle_id:
        try:
            await ctx.jobs.cancel(run.handle_id)
        except Exception:
            pass
    return _ok({"cancelled": job_id})


@router.delete("/jobs/{job_id}", dependencies=[require_permission("resources:write")])
async def delete_job(job_id: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    await authorize_job(ctx, job_id, owner_only=True)
    stmt = select(JobRun).where(JobRun.organization_id == ctx.organization_id, JobRun.job_id == job_id)
    for r in (await ctx.db.execute(stmt)).scalars():
        if run_is_active(r) and r.handle_id:
            try:
                await ctx.jobs.cancel(r.handle_id)
            except Exception:
                pass
    # Deleting the rows also stops a running worker: its next check finds no run.
    await delete_job_data(ctx, job_id)
    shutil.rmtree(JOBS_DIR / job_id, ignore_errors=True)
    return _ok()


class ShareIn(BaseModel):
    users: list[str] = Field(default_factory=list, max_length=200)
    org: bool = False


def _member_entry(m) -> dict | None:
    if not isinstance(m, dict):
        return None
    uid = m.get("user_id") or m.get("id")
    if uid is None:
        return None
    return {"id": str(uid), "name": m.get("name") or m.get("full_name") or m.get("display_name"),
            "email": m.get("email")}


async def _org_members(ctx: PluginContext) -> list[dict] | None:
    """This organisation's members, or None where the runtime has no member
    service (pltt dev) or the grant is missing."""
    try:
        raw = await ctx.members.list()
    except (RuntimeError, PermissionError):
        return None
    return [e for e in (_member_entry(m) for m in raw or []) if e]


@router.get("/members", dependencies=[require_permission("resources:read")])
async def list_members(ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    """Teammates a job can be shared with (everyone in the org except the caller)."""
    members = await _org_members(ctx)
    if members is None:
        return JSONResponse({"available": False, "members": []})
    return JSONResponse({"available": True, "members": [m for m in members if m["id"] != ctx.user_id]})


@router.get("/jobs/{job_id}/share", dependencies=[require_permission("resources:read")])
async def get_share(job_id: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    job = await authorize_job(ctx, job_id, owner_only=True)
    return JSONResponse(_share_payload(job))


@router.put("/jobs/{job_id}/share", dependencies=[require_permission("resources:write")])
async def set_share(job_id: str, body: ShareIn, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    """Owner only: replaces who the job is shared with -- chosen teammates,
    the whole organisation, or both. Only members of the caller's own
    organisation can be added."""
    await authorize_job(ctx, job_id, owner_only=True)
    users = list(dict.fromkeys(u.strip() for u in body.users if u and u.strip() and u.strip() != ctx.user_id))
    if users:
        members = await _org_members(ctx)
        # No member service on this runtime: the ids came from the platform's own
        # member list in the browser. They're kept as given -- every job row is
        # scoped to this organisation, so an id from outside it never matches anyone.
        known = {m["id"] for m in members} if members is not None else set(users)
        unknown = [u for u in users if u not in known]
        if unknown:
            return JSONResponse({"error": "not a member of this organisation", "users": unknown},
                                status_code=400)
    job = await ctx.repo(Job).update(job_id, shared_user_ids=users, shared_org=bool(body.org))
    return JSONResponse(_share_payload(job))


def _generating_conflict() -> Response:
    return JSONResponse({"error": "still generating this techpack's sketch -- try again when it finishes",
                         "generating": True}, status_code=409)


@router.post("/jobs/{job_id}/stage2", dependencies=[require_permission("resources:write")])
async def stage2(
    job_id: str,
    mode: str = Form("both"),
    variants: int = Form(2),
    colors: list[str] = Form([]),
    season: str = Form(""),
    prompt: str = Form(""),
    references: list[UploadFile] = File([]),
    ctx: PluginContext = Depends(get_plugin_context),
) -> Response:
    await authorize_job(ctx, job_id)
    if not (await db_view(ctx, job_id)).is_file("flat_sketch.png"):
        return JSONResponse({"error": "stage 1 output missing — run stage 1 first"}, status_code=400)
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True, exist_ok=True)
    use_refs = any(r.filename for r in references)
    ref_err = await _save_references(references, paths)
    if ref_err:
        return JSONResponse({"error": ref_err}, status_code=400)
    if use_refs:
        await push_files(ctx, job_id)
    await start_run(ctx, job_id, "stage2", {
        "kind": "stage2", "mode": mode, "variants": variants, "colors": colors, "season": season,
        "prompt": prompt, "use_refs": use_refs,
    })
    return _ok()


# Stage 3 (warp_pattern.py --upscale-only) is gone: the generate pipeline chains
# regen_sketch.py instead, which reconstructs the flat rather than enlarging it,
# and nothing in the UI ever called the standalone upscale. /jobs/{id}/redraw is
# the endpoint that re-runs that reconstruction on demand.


@router.post("/jobs/{job_id}/redraw", dependencies=[require_permission("resources:write")])
async def job_redraw(
    job_id: str, seed: str = Form(""), ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    """Redraw this card's flat: same regen_sketch.py pass as an uploaded
    redraw, but reading the sketch already in the job instead of an upload."""
    await authorize_job(ctx, job_id)
    view = await db_view(ctx, job_id)
    if not any(view.is_file(n) for n in ("flat_sketch.png", "flat_sketch_upscaled.png", "sketch_regen.png")):
        return JSONResponse({"error": "this job has no sketch to redraw"}, status_code=400)
    await start_run(ctx, job_id, "redraw", {"kind": "redraw", "seed": seed.strip()})
    return _ok()


@router.post("/jobs/{job_id}/stage4", dependencies=[require_permission("resources:write")])
async def stage4(job_id: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    await authorize_job(ctx, job_id)
    if await is_generating(ctx, job_id):
        return _generating_conflict()
    if not (await db_view(ctx, job_id)).is_file("flat_sketch.png"):
        return JSONResponse({"error": "stage 1 output missing — run stage 1 first"}, status_code=400)
    # Already running: start_run hands back that run, so the page re-attaching
    # after a reload doesn't start a second one racing it over parts.svg.
    await start_run(ctx, job_id, "stage4", {"kind": "stage4"})
    return _ok()


PATTERN_SIZES = {"XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"}


@router.post("/jobs/{job_id}/stage5", dependencies=[require_permission("resources:write")])
async def stage5(
    job_id: str,
    size: str = Form(""),
    measurements: str = Form(""),
    ctx: PluginContext = Depends(get_plugin_context),
) -> Response:
    """Drafts (or redrafts) the sewing pattern. `size` + `measurements` come from the
    pattern tab's size/measurement editor: when either is sent, they replace the
    job's user-measurements.json so the redraft uses exactly what's on screen."""
    await authorize_job(ctx, job_id)
    if await is_generating(ctx, job_id):
        return _generating_conflict()
    if not (await db_view(ctx, job_id)).is_file("flat_sketch.png"):
        return JSONResponse({"error": "stage 1 output missing — run stage 1 first"}, status_code=400)

    size = size.strip().upper()
    if size and size not in PATTERN_SIZES:
        return JSONResponse({"error": f"unknown size {size}"}, status_code=400)
    if size or measurements.strip():
        numeric = {}
        if measurements.strip():
            try:
                parsed = json.loads(measurements)
            except ValueError:
                return JSONResponse({"error": "measurements is not valid JSON"}, status_code=400)
            if not isinstance(parsed, dict):
                return JSONResponse({"error": "measurements must be an object"}, status_code=400)
            numeric = {
                k: v for k, v in parsed.items()
                if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 < v < 400
            }
        payload: dict = {"measurements": numeric}
        if size:
            payload["size"] = size
        # A redraft must not race a draft still reading the old file.
        if not run_is_active(await get_run(ctx, job_slot(job_id, "stage5"))):
            paths = job_paths(job_id)
            paths["dir"].mkdir(parents=True, exist_ok=True)
            paths["user_measurements"].write_text(json.dumps(payload, indent=2))
            await push_files(ctx, job_id, only=["user-measurements.json"])
    await start_run(ctx, job_id, "stage5", {"kind": "stage5"})
    return _ok()


DATA_ROOM_NAME = "Techpack"


@router.post("/jobs/{job_id}/save-to-dataroom", dependencies=[require_permission("data_rooms:write")])
async def save_to_dataroom(job_id: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    """Copies the job's big deliverables -- the pattern pages PDF and the 3D
    garment -- into the organisation's "Techpack" Data Room, one folder per job,
    where users find them as documents. The frontend calls it right after a
    pattern draft or a 3D build finishes. Files already there are left alone,
    and a runtime without the Data Room service (pltt dev) just reports skipped."""
    await authorize_job(ctx, job_id)
    paths = job_paths(job_id)
    await pull_files(ctx, job_id, only=["pattern-pages.pdf", "garment3d.glb", "pattern-design.json",
                                        "classification.json"])
    rooms = getattr(ctx, "data_rooms", None)
    design = {}
    try:
        design = json.loads(paths["pattern_design"].read_text())
    except (OSError, ValueError):
        pass
    files = []
    if paths["pattern_pages_pdf"].is_file():
        files.append((f"pattern-{design.get('size') or 'M'}.pdf", paths["pattern_pages_pdf"], "application/pdf"))
    glb = paths["dir"] / "garment3d.glb"
    if glb.is_file():
        files.append(("garment3d.glb", glb, "model/gltf-binary"))
    if not files:
        return JSONResponse({"ok": True, "saved": [], "note": "nothing to save yet"})
    try:
        cls = json.loads(paths["classification"].read_text()) if paths["classification"].is_file() else {}
        label = cls.get("subcategory") or cls.get("category") or "techpack"
        room = await rooms.ensure_room(DATA_ROOM_NAME, "Sewing patterns and 3D garments from Techpack Studio")
        folder = await rooms.resolve_folder_path(room["id"], f"{label} · {job_id}", create=True)
        folder_id = folder["id"] if folder else None
        saved, kept = [], []
        for name, path, mime in files:
            if await rooms.find_file_by_name(room["id"], name, folder_id=folder_id):
                kept.append(name)
                continue
            await rooms.upload_file(room["id"], name, path.read_bytes(), folder_id=folder_id, content_type=mime)
            saved.append(name)
    except Exception as exc:  # no Data Room service locally, or the platform refused
        return JSONResponse({"ok": False, "skipped": True, "reason": str(exc)[:300]})
    return JSONResponse({"ok": True, "room": DATA_ROOM_NAME, "saved": saved, "already_there": kept})


@router.post("/jobs/{job_id}/garment3d", dependencies=[require_permission("resources:write")])
async def garment3d(
    job_id: str,
    colour: str = Form("#2f3b4d"),
    desc: str = Form(""),
    region: str = Form("upper"),
    ctx: PluginContext = Depends(get_plugin_context),
) -> Response:
    """Real 3D garment for the try-on: the uploaded cloth photo (else the flat
    sketch) laid out in a T-pose by nano-banana, front + back, and reconstructed
    into a GLB by three.ws Forge (garment3d.py). The photos are uploaded to
    three.ws for this."""
    await authorize_job(ctx, job_id)
    view = await db_view(ctx, job_id)
    if not view.is_file("input.jpg") and not view.is_file(_sketch_name(view)):
        return JSONResponse({"error": "this techpack has no input image yet"}, status_code=400)
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", colour):
        return JSONResponse({"error": "colour must be #rrggbb"}, status_code=400)
    if region not in ("upper", "lower"):
        return JSONResponse({"error": "region must be upper or lower"}, status_code=400)
    await start_run(ctx, job_id, "garment3d", {"kind": "garment3d", "colour": colour, "desc": desc[:200],
                                               "region": region})
    return _ok()


@router.post("/jobs/{job_id}/measure", dependencies=[require_permission("resources:write")])
async def job_measure(
    job_id: str, size: str = Form("M"), ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    await authorize_job(ctx, job_id)
    view = await db_view(ctx, job_id)
    if not view.is_file("input.jpg") and not view.is_file(_sketch_name(view)):
        return JSONResponse({"error": "this job has no image to measure"}, status_code=400)
    await start_run(ctx, job_id, "measure", {"kind": "job_measure", "size": size})
    return _ok()


def _blender_bin() -> str | None:
    """Blender for the high-quality garment simulation, if this host has it."""
    for cand in (_os.environ.get("BLENDER_PATH"), shutil.which("blender"),
                 "/Applications/Blender.app/Contents/MacOS/Blender"):
        if cand and Path(cand).is_file():
            return cand
    return None


@router.get("/simulate/available", dependencies=[require_permission("resources:read")])
async def simulate_available() -> Response:
    return _ok({"available": bool(_blender_bin())})


@router.post("/jobs/{job_id}/simulate", dependencies=[require_permission("resources:write")])
async def simulate_garment(
    job_id: str, payload: UploadFile = File(...), ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    """High-quality cloth simulation in Blender: the workspace sends the fitted body +
    assembled pieces + stitches; the result is garment-sim.json (positions) +
    garment.glb. Async: progress on the job's "simulate" run."""
    await authorize_job(ctx, job_id)
    if not _blender_bin():
        return JSONResponse({"available": False, "error": "Blender is not installed on this server"},
                            status_code=501)
    raw = await payload.read()
    try:
        json.loads(raw)
    except ValueError:
        return JSONResponse({"error": "payload is not valid JSON"}, status_code=400)
    slot = job_slot(job_id, "simulate")
    if run_is_active(await get_run(ctx, slot)):
        return _ok({"job_id": job_id, "status": "running"})
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True, exist_ok=True)
    (paths["dir"] / "garment-sim-input.json").write_bytes(raw)
    await push_files(ctx, job_id, only=["garment-sim-input.json"])
    await start_run(ctx, job_id, "simulate", {"kind": "simulate"})
    return _ok({"job_id": job_id, "status": "queued"})


@router.get("/jobs/{job_id}/parts", dependencies=[require_permission("resources:read")])
async def job_parts(job_id: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    await authorize_job(ctx, job_id)
    await pull_files(ctx, job_id)
    paths = job_paths(job_id)
    # Every flat a job may have been traced from: jobs traced before the switch
    # to the input's own flat keep their parts under sketch_regen_seg/, and
    # looking only at the current source lost their parts list. The newest wins.
    sources = (effective_sketch(paths), paths["sketch"], paths["sketch_upscaled"], paths["regen_out"])
    candidates = [d for d in {paths["dir"] / f"{s.stem}_seg" for s in sources} if (d / "parts_png").is_dir()]
    seg_dir = max(candidates, key=lambda d: (d / "parts_png").stat().st_mtime, default=None)
    if seg_dir is None:
        return JSONResponse({"error": "no traced parts for this job"}, status_code=404)

    parts_dir = seg_dir / "parts_png"
    groups_path = seg_dir / "groups.json"
    groups = json.loads(groups_path.read_text()) if groups_path.is_file() else {}
    rel = parts_dir.relative_to(paths["dir"])

    available = {p.stem: p for p in sorted(parts_dir.glob("*.png"))}
    ordered = [n for n in groups.get("z_order", []) if n in available]
    ordered += [n for n in available if n not in ordered and not n.startswith("_")]

    def bbox_of(path: Path):
        try:
            with Image.open(path) as im:
                box = im.convert("RGBA").getbbox()
                if not box:
                    return None
                return {"x": box[0], "y": box[1], "w": box[2] - box[0], "h": box[3] - box[1],
                        "cw": im.width, "ch": im.height}
        except Exception:
            return None

    payload = {
        "garment_type": groups.get("garment_type"),
        "recombined": (_file_url(job_id, f"{rel}/_recombined.png") if "_recombined" in available else None),
        "parts": [{
            "name": n,
            "label": n.replace("_", " "),
            "image": _file_url(job_id, f"{rel}/{n}.png"),
            # the part as it sits in parts.svg, for stacking into the full view;
            # jobs traced before _layers/ existed fall back to `image`
            "layer": (_file_url(job_id, f"{rel}/_layers/{n}.png")
                      if (parts_dir / "_layers" / f"{n}.png").is_file() else None),
            "bbox": bbox_of(available[n]),
        } for n in ordered],
    }
    return Response(content=json.dumps(payload), media_type="application/json")



@router.get("/jobs/{job_id}/file/{path:path}", dependencies=[require_permission("resources:read")])
async def job_file(
    job_id: str, path: str, dl: int = 0, ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    await authorize_job(ctx, job_id)
    # From the database through this server's cache: the file may have been
    # written by a worker, or by a request that landed on another server.
    file_path = await pull_one(ctx, job_id, path)
    if file_path is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    # This same URL is used two ways: an <a download> link that wants a real
    # save-as, and an <object>/<img> embed that wants the file rendered in
    # place. Content-Disposition: attachment satisfies the former but makes
    # Chrome download an <object>'s SVG instead of displaying it -- so default
    # to inline and only force attachment when the caller passes dl=1 (see
    # downloadUrl() in api.ts). Chrome still needs a Content-Disposition header
    # to honor <a download> cross-origin at all, which is why this passes
    # filename= either way.
    disposition = "attachment" if dl else "inline"
    # Job files are rewritten in place by every redraft; no-cache = always
    # revalidate, and FileResponse's ETag/Last-Modified make an unchanged file
    # a cheap 304.
    return FileResponse(file_path, filename=file_path.name, content_disposition_type=disposition,
                        headers={"Cache-Control": "no-cache"})


THUMB_SIZE = (800, 600)
THUMB_PAD = 0.04


def _ink_bbox(im: Image.Image):
    a = np.array(im.convert("RGBA"))
    ink = (a[..., 3] > 10) & (a[..., :3].min(axis=2) < 240)
    ys, xs = np.nonzero(ink)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _build_thumb(src: Path, dest: Path) -> None:
    with Image.open(src) as im:
        im.load()
        box = _ink_bbox(im)
        art = im.convert("RGBA")
    if box:
        art = art.crop(box)
    tw, th = THUMB_SIZE
    art.thumbnail((round(tw * (1 - 2 * THUMB_PAD)), round(th * (1 - 2 * THUMB_PAD))), Image.LANCZOS)
    canvas = Image.new("RGBA", THUMB_SIZE, (255, 255, 255, 0))
    canvas.paste(art, ((tw - art.width) // 2, (th - art.height) // 2), art)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    canvas.save(tmp, "PNG")
    tmp.replace(dest)


@router.get("/jobs/{job_id}/thumb/{path:path}", dependencies=[require_permission("resources:read")])
async def job_thumb(job_id: str, path: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    await authorize_job(ctx, job_id)
    src = await pull_one(ctx, job_id, path)
    if src is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    cache = JOBS_DIR / job_id / ".thumbs" / (path.replace("/", "__") + ".png")
    try:
        if not cache.is_file() or cache.stat().st_mtime < src.stat().st_mtime:
            await asyncio.to_thread(_build_thumb, src, cache)
    except Exception:
        return FileResponse(src)
    return FileResponse(cache)
