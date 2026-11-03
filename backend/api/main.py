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

Job artifacts live on local disk under the repo root's existing `jobs/`
directory (unchanged from app.py) rather than Palette Data Rooms: this pass
targets local-dev (`pltt dev`) parity with static/index.html, not hosted
multi-tenant storage. Every route app.py exposes is ported here, 1:1.
"""

import asyncio
import io
import json
import re
import shutil
import sys
import uuid
from collections import deque
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from fastapi import Depends, File, Form, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from palette_sdk import PluginContext, PluginRouter, get_plugin_context, require_permission
from PIL import Image

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

JOB_QUEUES: dict[str, asyncio.Queue] = {}
# Jobs whose generate pipeline (sketch -> redraw -> variations -> classify) is
# still running. Parts SVG and the pattern must not start before it ends: they
# trace effective_sketch(), and mid-run that is still the raw flat -- the redraw
# (the "Default" image the job shows) lands a few seconds later, so the SVG and
# pattern came out of a different image than the one on screen.
GENERATING: set[str] = set()
JOB_PROCS: dict[str, asyncio.subprocess.Process] = {}
CANCELLED: set[str] = set()


def job_slot(job_id: str, stage: str | None) -> str:
    return f"{job_id}:{stage}" if stage else job_id


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


async def stream_subprocess(cmd: list[str], cwd: Path, queue: asyncio.Queue, stage: str,
                            slot: str | None = None, env: dict | None = None):
    proc = await asyncio.create_subprocess_exec(
        *cmd, cwd=str(cwd), env=env if env is not None else SUBPROCESS_ENV,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
    )
    if slot:
        JOB_PROCS[slot] = proc
    try:
        # Keep a tail of output, not just the last line — a failing subprocess
        # is often itself wrapping a child subprocess (flat2svg_auto.py calling
        # seg_parts.py), so the final line is a generic "CalledProcessError:
        # exit status 1" while the real cause (e.g. a traceback's exception
        # line) sits a dozen lines earlier and would otherwise be discarded.
        tail: deque[str] = deque(maxlen=25)
        while True:
            line = await proc.stdout.readline()
            if not line:
                break
            text = line.decode(errors="replace").rstrip()
            if text:
                tail.append(text)
                await queue.put(f"[{stage}] {text}")
        code = await proc.wait()
    finally:
        if slot:
            JOB_PROCS.pop(slot, None)
    if slot and slot in CANCELLED:
        raise JobCancelled()
    if code != 0:
        raise RuntimeError("\n".join(tail) if tail else f"{stage} exited {code}")


async def run_multi_stage(slot: str, steps: list[tuple[str, list[str]]], on_success, env: dict | None = None,
                          generating: bool = False):
    queue = JOB_QUEUES[slot]
    total = len(steps)
    if generating:
        GENERATING.add(slot)
    try:
        for i, (stage_name, cmd) in enumerate(steps):
            await queue.put(json.dumps({
                "event": "stage_progress", "stage": stage_name,
                "completed": i, "total": total,
                "percent": round(i / total * 100),
            }))
            await queue.put(f"[{stage_name}] starting")
            await stream_subprocess(cmd, REPO_ROOT, queue, stage_name, slot, env)
        await queue.put(json.dumps(on_success()))
        await queue.put(json.dumps({"event": "done"}))
    except JobCancelled:
        await queue.put(json.dumps({"event": "cancelled"}))
    except Exception as e:
        await queue.put(json.dumps({"event": "error", "message": str(e)}))
    finally:
        GENERATING.discard(slot)
        CANCELLED.discard(slot)
        llm_bridge.release(env)
        await queue.put("__END__")


async def run_stage(slot: str, stage_name: str, cmd: list[str], on_success, env: dict | None = None):
    await run_multi_stage(slot, [(stage_name, cmd)], on_success, env)


async def run_node_stage(slot: str, stage_name: str, cmd: list[str], on_success, env: dict | None = None):
    """Like run_stage, but for a cmd whose [0] is the literal string "node" --
    bootstraps a real node binary + this stage's npm packages first (off-thread,
    so it doesn't block the route that scheduled this as a background task),
    reporting failure through the same queue/SSE contract instead of leaving
    the listener hanging on a task that never signals it."""
    queue = JOB_QUEUES[slot]
    try:
        await queue.put(json.dumps({
            "event": "stage_progress", "stage": stage_name,
            "completed": 0, "total": 1, "percent": 0,
        }))
        await queue.put(f"[{stage_name}] preparing Node.js runtime and packages...")
        await asyncio.to_thread(ensure_npm_packages, PIPELINE_DIR, NODE_PACKAGES)
        cmd[0] = ensure_node(PIPELINE_DIR)
    except Exception as e:
        llm_bridge.release(env)
        await queue.put(json.dumps({"event": "error", "message": str(e)}))
        await queue.put("__END__")
        return
    await run_stage(slot, stage_name, cmd, on_success, env)


async def run_node_multi(slot: str, steps: list[tuple[str, list[str]]], on_success, env: dict | None = None):
    """run_multi_stage for a mix of python + node steps: node is bootstrapped once first."""
    queue = JOB_QUEUES[slot]
    try:
        await queue.put(f"[{steps[0][0]}] preparing Node.js runtime and packages...")
        await asyncio.to_thread(ensure_npm_packages, PIPELINE_DIR, NODE_PACKAGES)
        node = ensure_node(PIPELINE_DIR)
        steps = [(name, [node if c == "node" else c for c in cmd]) for name, cmd in steps]
    except Exception as e:
        llm_bridge.release(env)
        await queue.put(json.dumps({"event": "error", "message": str(e)}))
        await queue.put("__END__")
        return
    await run_multi_stage(slot, steps, on_success, env)


def _default_sketch_name(paths) -> str:
    return effective_sketch(paths).name


def _file_url(job_id: str, rel: str) -> str:
    # Versioned by the file's own mtime: job files are rewritten in place
    # (redrafts, the white-background pass on realistic.png), and an <img>
    # keeps showing whatever copy the browser cached under the bare URL --
    # copies cached before job_file sent Cache-Control never revalidate.
    url = f"/api/v1/plugins/techpack/jobs/{job_id}/file/{rel}"
    try:
        return f"{url}?v={int((JOBS_DIR / job_id / rel).stat().st_mtime)}"
    except OSError:
        return url


def _variations_response(job_id: str, paths) -> list[dict]:
    manifest_path = paths["variations_dir"] / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.is_file() else []
    variations = [{
        "id": "default", "label": "Default",
        "sketch": _file_url(job_id, _default_sketch_name(paths)),
        "realistic": None,
    }]
    for v in manifest:
        variations.append({
            "id": v["id"], "label": v["label"],
            "sketch": _file_url(job_id, f"variations/{v['sketch']}") if v.get("sketch") else None,
            "realistic": _file_url(job_id, f"variations/{v['realistic']}") if v.get("realistic") else None,
        })
    return variations


def _outputs_response(job_id: str, paths) -> dict:
    def url(key: str, name: str) -> str | None:
        return _file_url(job_id, name) if paths[key].is_file() else None

    measurements = url("measure_out", "measurements.json") or url("classification", "classification.json")
    return {
        "parts_svg": url("parts_svg", "parts.svg"),
        "pattern_svg": url("pattern_svg", "pattern.svg"),
        "pattern_pages": url("pattern_pages_pdf", "pattern-pages.pdf"),
        "design": url("pattern_design", "pattern-design.json"),
        "pattern_pieces": url("pattern_pieces_json", "pattern-pieces.json"),
        "measurements": measurements,
        "redraw": url("regen_out", "sketch_regen.png"),
    }


def _reference_images_response(job_id: str, paths) -> list[str]:
    ref_dir = paths["variations_dir"] / "references"
    if not ref_dir.is_dir():
        return []
    return [_file_url(job_id, f"variations/references/{p.name}") for p in sorted(ref_dir.glob("*.png"))]


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


@router.post("/run", dependencies=[require_permission("resources:write")])
async def run(photo: UploadFile = File(...), ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    if not photo.filename:
        return JSONResponse({"error": "no photo uploaded"}, status_code=400)
    data = await photo.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"photo {err}"}, status_code=400)

    job_id = uuid.uuid4().hex[:12]
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True)
    paths["input"].write_bytes(data)

    JOB_QUEUES[job_id] = asyncio.Queue()
    asyncio.create_task(run_stage(
        job_id, "stage 1",
        [sys.executable, str(PIPELINE_DIR / "warp_pattern.py"), str(paths["input"]), str(paths["sketch"])],
        lambda: {"event": "stage_done", "stage": 1, "file": _file_url(job_id, "flat_sketch.png")},
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"job_id": job_id}), media_type="application/json")


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

    job_id = uuid.uuid4().hex[:12]
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True)
    paths["measure_input"].write_bytes(data)

    def on_success():
        result = json.loads(paths["measure_out"].read_text())
        return {"event": "stage_done", "stage": "measure", "result": result}

    JOB_QUEUES[job_id] = asyncio.Queue()
    asyncio.create_task(run_stage(
        job_id, "measure",
        [sys.executable, str(PIPELINE_DIR / "measure_garment.py"),
         str(paths["measure_input"]), str(paths["measure_out"]), "--size", size],
        on_success,
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"job_id": job_id}), media_type="application/json")


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
    ctx: PluginContext = Depends(get_plugin_context),
) -> Response:
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

    job_id = uuid.uuid4().hex[:12]
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True)
    paths["input"].write_bytes(data)
    if user_measurements:
        paths["user_measurements"].write_text(json.dumps(user_measurements, indent=2))

    ref_paths = []
    named_refs = [r for r in references if r.filename]
    if named_refs:
        ref_dir = paths["variations_dir"] / "references"
        ref_dir.mkdir(parents=True, exist_ok=True)
        for i, ref in enumerate(named_refs[:5]):
            rdata = await ref.read()
            rerr = image_error(rdata)
            if rerr:
                return JSONResponse({"error": f"reference image {rerr}"}, status_code=400)
            p = ref_dir / f"ref_{i + 1}.png"
            save_reference_png(rdata, p)
            ref_paths.append(str(p))

    var_cmd = [sys.executable, str(PIPELINE_DIR / "variations.py"),
               str(paths["regen_out"]), str(paths["variations_dir"])]
    if mode == "sketch":
        var_cmd += ["--variants", str(variants)]
    else:
        if colors:
            var_cmd += ["--colors", ",".join(colors)]
        if season:
            var_cmd += ["--season", season]
    if prompt:
        var_cmd += ["--prompt", prompt]
    if ref_paths:
        var_cmd += ["--references", ",".join(ref_paths)]
    var_cmd += ["--mode", mode]

    sketch_cmd = [sys.executable, str(PIPELINE_DIR / "warp_pattern.py"), str(paths["input"]), str(paths["sketch"])]
    if ref_paths:
        sketch_cmd += ["--references", ",".join(ref_paths)]

    steps = [
        ("stage 1", sketch_cmd),
        ("redraw", [sys.executable, str(PIPELINE_DIR / "regen_sketch.py"),
                    str(paths["sketch"]), str(paths["regen_out"])]),
    ]
    steps.append(("stage 2", var_cmd))
    steps.append(("classify", [sys.executable, str(PIPELINE_DIR / "measure_garment.py"),
                               str(paths["regen_out"]), str(paths["classification"]), "--size", "M"]))

    def on_success():
        classification = (
            json.loads(paths["classification"].read_text()) if paths["classification"].is_file() else None
        )
        return {
            "event": "stage_done", "job_id": job_id,
            "variations": _variations_response(job_id, paths),
            "references": _reference_images_response(job_id, paths),
            "classification": classification,
        }

    JOB_QUEUES[job_id] = asyncio.Queue()
    GENERATING.add(job_id)  # before the task starts: a list refresh can land first
    asyncio.create_task(run_multi_stage(job_id, steps, on_success, subprocess_env(ctx), generating=True))
    return Response(content=json.dumps({"job_id": job_id}), media_type="application/json")


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
    job_id = uuid.uuid4().hex[:12]
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True)
    sheet = paths["dir"] / "pattern-sheet.png"
    save_reference_png(data, sheet)

    def on_success():
        return {
            "event": "stage_done", "job_id": job_id, "stage": "pattern-image",
            "pattern_pieces": _file_url(job_id, "pattern-pieces.json"),
            "design": _file_url(job_id, "pattern-design.json"),
        }

    steps = [
        ("segment", [sys.executable, str(PIPELINE_DIR / "pattern_segment.py"), str(sheet), str(paths["dir"]),
                     "--longest-cm", str(longest_cm)]),
        ("classify", ["node", str(PIPELINE_DIR / "pattern-image.mjs"), str(paths["dir"]), size, str(sheet)]),
    ]
    JOB_QUEUES[job_id] = asyncio.Queue()
    asyncio.create_task(run_node_multi(job_id, steps, on_success, subprocess_env(ctx)))
    return Response(content=json.dumps({"job_id": job_id}), media_type="application/json")


@router.post("/jobs/new-with-sketch", dependencies=[require_permission("resources:write")])
async def new_with_sketch(sketch: UploadFile = File(...)) -> Response:
    if not sketch.filename:
        return JSONResponse({"error": "no sketch uploaded"}, status_code=400)
    data = await sketch.read()
    err = image_error(data)
    if err:
        return JSONResponse({"error": f"sketch {err}"}, status_code=400)

    job_id = uuid.uuid4().hex[:12]
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True)
    paths["sketch"].write_bytes(data)
    return Response(content=json.dumps({"job_id": job_id}), media_type="application/json")


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

    job_id = uuid.uuid4().hex[:12]
    paths = job_paths(job_id)
    paths["dir"].mkdir(parents=True)
    paths["regen_input"].write_bytes(data)

    cmd = [sys.executable, str(PIPELINE_DIR / "regen_sketch.py"),
           str(paths["regen_input"]), str(paths["regen_out"])]
    if seed.strip():
        cmd += ["--seed", seed.strip()]

    JOB_QUEUES[job_id] = asyncio.Queue()
    asyncio.create_task(run_stage(
        job_id, "regen", cmd,
        lambda: {
            "event": "stage_done", "stage": "regen", "job_id": job_id,
            "file": _file_url(job_id, "sketch_regen.png"),
            "input": _file_url(job_id, "regen_input.png"),
        },
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"job_id": job_id}), media_type="application/json")


@router.get("/jobs/list", dependencies=[require_permission("resources:read")])
async def jobs_list() -> Response:
    jobs = []
    for job_dir in JOBS_DIR.iterdir():
        if not job_dir.is_dir():
            continue
        job_id = job_dir.name
        paths = job_paths(job_id)
        if paths["sketch"].is_file():
            display_name = _default_sketch_name(paths)
        elif paths["regen_out"].is_file():
            display_name = "sketch_regen.png"
        else:
            continue
        display = job_dir / display_name
        # The dashboard card shows the clean redraw the SVG and pattern are built
        # from (not the raw upload). Variations stay inside the job page.
        card = display
        classification_path = job_dir / "classification.json"
        classification = json.loads(classification_path.read_text()) if classification_path.is_file() else None
        jobs.append({
            "job_id": job_id,
            "sketch": _file_url(job_id, display_name),
            "thumb": (f"/api/v1/plugins/techpack/jobs/{job_id}/thumb/{card.name}"
                      f"?v={int(card.stat().st_mtime)}"),
            "input": _file_url(job_id, "input.jpg") if paths["input"].is_file() else None,
            "size_kb": round(display.stat().st_size / 1024, 1),
            "mtime": display.stat().st_mtime,
            "classification": classification,
            "has_sketch": paths["sketch"].is_file(),
            "generating": job_id in GENERATING,
            "variations": _variations_response(job_id, paths) if paths["sketch"].is_file() else [],
            "references": _reference_images_response(job_id, paths),
            "outputs": _outputs_response(job_id, paths),
        })
    jobs.sort(key=lambda j: j["mtime"], reverse=True)
    return Response(content=json.dumps({"jobs": jobs[:50]}), media_type="application/json")


@router.post("/jobs/{job_id}/cancel", dependencies=[require_permission("resources:write")])
async def cancel_job(job_id: str, stage: str | None = None) -> Response:
    slot = job_slot(job_id, stage)
    proc = JOB_PROCS.get(slot)
    if proc is None:
        return JSONResponse({"error": "no running stage for this job"}, status_code=404)
    CANCELLED.add(slot)
    try:
        proc.kill()
    except ProcessLookupError:
        pass
    return Response(content=json.dumps({"cancelled": job_id}), media_type="application/json")


@router.delete("/jobs/{job_id}", dependencies=[require_permission("resources:write")])
async def delete_job(job_id: str) -> Response:
    job_dir = (JOBS_DIR / job_id).resolve()
    if JOBS_DIR.resolve() not in job_dir.parents or not job_dir.is_dir():
        return JSONResponse({"error": "unknown job_id"}, status_code=404)
    try:
        shutil.rmtree(job_dir)
    except OSError:
        shutil.rmtree(job_dir, ignore_errors=True)
        if job_dir.is_dir():
            return JSONResponse({"error": "delete failed, try again"}, status_code=500)
    for key in [job_id] + [k for k in JOB_QUEUES if k.startswith(f"{job_id}:")]:
        JOB_QUEUES.pop(key, None)
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


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
    paths = job_paths(job_id)
    if not paths["sketch"].is_file():
        return JSONResponse({"error": "stage 1 output missing — run stage 1 first"}, status_code=400)

    ref_paths = []
    named_refs = [r for r in references if r.filename]
    if named_refs:
        ref_dir = paths["variations_dir"] / "references"
        ref_dir.mkdir(parents=True, exist_ok=True)
        for i, ref in enumerate(named_refs[:5]):
            data = await ref.read()
            err = image_error(data)
            if err:
                return JSONResponse({"error": f"reference image {err}"}, status_code=400)
            p = ref_dir / f"ref_{i + 1}.png"
            save_reference_png(data, p)
            ref_paths.append(str(p))

    def on_success():
        return {"event": "stage_done", "stage": 2, "variations": _variations_response(job_id, paths)}

    cmd = [sys.executable, str(PIPELINE_DIR / "variations.py"), str(paths["sketch"]), str(paths["variations_dir"])]
    if mode == "sketch":
        cmd += ["--variants", str(variants)]
    else:
        if colors:
            cmd += ["--colors", ",".join(colors)]
        if season:
            cmd += ["--season", season]
    if prompt:
        cmd += ["--prompt", prompt]
    if ref_paths:
        cmd += ["--references", ",".join(ref_paths)]
    cmd += ["--mode", mode]

    slot = job_slot(job_id, "stage2")
    JOB_QUEUES[slot] = asyncio.Queue()
    asyncio.create_task(run_stage(slot, "stage 2", cmd, on_success, subprocess_env(ctx)))
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


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
    paths = job_paths(job_id)
    # Redraw from the raw stage-1 flat, not from effective_sketch() -- that now
    # resolves to the redraw itself, so redrawing twice would reconstruct a
    # reconstruction and drift further from the photo each time.
    source = paths["sketch"] if paths["sketch"].is_file() else effective_sketch(paths)
    if not source.is_file():
        return JSONResponse({"error": "this job has no sketch to redraw"}, status_code=400)

    cmd = [sys.executable, str(PIPELINE_DIR / "regen_sketch.py"), str(source), str(paths["regen_out"])]
    if seed.strip():
        cmd += ["--seed", seed.strip()]

    slot = job_slot(job_id, "redraw")
    JOB_QUEUES[slot] = asyncio.Queue()
    asyncio.create_task(run_stage(
        slot, "redraw", cmd,
        lambda: {
            "event": "stage_done", "stage": "redraw",
            "file": _file_url(job_id, "sketch_regen.png"),
            "input": _file_url(job_id, source.name),
        },
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


@router.post("/jobs/{job_id}/stage4", dependencies=[require_permission("resources:write")])
async def stage4(job_id: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    paths = job_paths(job_id)
    if job_id in GENERATING:
        return JSONResponse({"error": "still generating this techpack's sketch -- try again when it finishes",
                             "generating": True}, status_code=409)
    if not paths["sketch"].is_file():
        return JSONResponse({"error": "stage 1 output missing — run stage 1 first"}, status_code=400)

    def on_success():
        return {"event": "stage_done", "stage": 4, "file": _file_url(job_id, "parts.svg")}

    slot = job_slot(job_id, "stage4")
    # The frontend re-attaches to whatever's already running for a job after
    # a page reload (its in-memory live-stage tracking doesn't survive one) --
    # without this check, that re-attach would start a SECOND subprocess
    # racing the first one over the same parts.svg output file.
    if slot in JOB_PROCS:
        return Response(content=json.dumps({"ok": True}), media_type="application/json")
    JOB_QUEUES[slot] = asyncio.Queue()
    asyncio.create_task(run_stage(
        slot, "stage 4",
        [sys.executable, str(PIPELINE_DIR / "flat2svg_auto.py"),
         str(effective_sketch(paths)), str(paths["parts_svg"])],
        on_success,
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


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
    paths = job_paths(job_id)
    if job_id in GENERATING:
        return JSONResponse({"error": "still generating this techpack's sketch -- try again when it finishes",
                             "generating": True}, status_code=409)
    if not paths["sketch"].is_file():
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
        if job_slot(job_id, "stage5") not in JOB_PROCS:
            paths["user_measurements"].write_text(json.dumps(payload, indent=2))

    cmd = ["node", str(PIPELINE_DIR / "photo-draft.mjs"), str(effective_sketch(paths))]
    if paths["user_measurements"].is_file():
        cmd.append(str(paths["user_measurements"]))
    cmd.append(str(paths["pattern_svg"]))
    # No cover-photo argument: the pattern pages' cover then shows the same clean
    # flat the pattern was drafted from (photo-draft falls back to it), not the
    # raw upload -- a rough hand drawing on the cover read as the deliverable.

    slot = job_slot(job_id, "stage5")
    # See the matching check in stage4() above: without it, a post-reload
    # re-attach would race a second subprocess against an already-running one
    # over the same pattern.svg/pattern-pages.pdf output files.
    if slot in JOB_PROCS:
        return Response(content=json.dumps({"ok": True}), media_type="application/json")
    JOB_QUEUES[slot] = asyncio.Queue()
    asyncio.create_task(run_node_stage(
        slot, "stage 5", cmd,
        lambda: {
            "event": "stage_done", "stage": 5,
            "file": _file_url(job_id, "pattern.svg"),
            "pages_file": _file_url(job_id, "pattern-pages.pdf"),
            "pieces_file": _file_url(job_id, "pattern-pieces.json"),
            "design_file": _file_url(job_id, "pattern-design.json"),
        },
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


DATA_ROOM_NAME = "Techpack"


@router.post("/jobs/{job_id}/save-to-dataroom", dependencies=[require_permission("data_rooms:write")])
async def save_to_dataroom(job_id: str, ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    """Copies the job's big deliverables -- the pattern pages PDF and the 3D
    garment -- into the organisation's "Techpack" Data Room, one folder per job,
    where users find them as documents and they outlive the job folder on the
    hosted machine's local disk. The frontend calls it right after a pattern
    draft or a 3D build finishes: this needs a live request's ctx (a background
    stage's would be gone by then). Files already there are left alone, and a
    runtime without the Data Room service (pltt dev) just reports skipped."""
    paths = job_paths(job_id)
    if not paths["dir"].is_dir():
        return JSONResponse({"error": "unknown job_id"}, status_code=404)
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
    paths = job_paths(job_id)
    sketch = effective_sketch(paths)
    photo = paths["input"]
    if not photo.is_file() and not sketch.is_file():
        return JSONResponse({"error": "this techpack has no input image yet"}, status_code=400)
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", colour):
        return JSONResponse({"error": "colour must be #rrggbb"}, status_code=400)
    if region not in ("upper", "lower"):
        return JSONResponse({"error": "region must be upper or lower"}, status_code=400)
    slot = job_slot(job_id, "garment3d")
    if slot in JOB_PROCS:
        return Response(content=json.dumps({"ok": True}), media_type="application/json")
    cmd = [sys.executable, str(PIPELINE_DIR / "garment3d.py"), str(sketch if sketch.is_file() else photo),
           str(paths["dir"]), "--colour", colour, "--desc", desc[:200], "--region", region]
    if photo.is_file() and not input_is_drawing(photo):
        cmd += ["--photo", str(photo)]
    JOB_QUEUES[slot] = asyncio.Queue()
    asyncio.create_task(run_stage(
        slot, "garment3d", cmd,
        lambda: {
            "event": "stage_done", "stage": "garment3d",
            "file": _file_url(job_id, "garment3d.glb"),
            "meta": _file_url(job_id, "garment3d.json"),
        },
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


@router.post("/jobs/{job_id}/measure", dependencies=[require_permission("resources:write")])
async def job_measure(
    job_id: str, size: str = Form("M"), ctx: PluginContext = Depends(get_plugin_context)
) -> Response:
    paths = job_paths(job_id)
    source = paths["input"]
    if not source.is_file() or input_is_drawing(source):
        source = effective_sketch(paths)
    if not source.is_file():
        return JSONResponse({"error": "this job has no image to measure"}, status_code=400)

    def on_success():
        return {
            "event": "stage_done", "stage": "measure",
            "result": json.loads(paths["measure_out"].read_text()),
            "file": _file_url(job_id, "measurements.json"),
        }

    slot = job_slot(job_id, "measure")
    JOB_QUEUES[slot] = asyncio.Queue()
    asyncio.create_task(run_stage(
        slot, "measure",
        [sys.executable, str(PIPELINE_DIR / "measure_garment.py"),
         str(source), str(paths["measure_out"]), "--size", size],
        on_success,
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"ok": True}), media_type="application/json")


def _blender_bin() -> str | None:
    """Blender for the high-quality garment simulation, if this host has it."""
    import shutil
    for cand in (_os.environ.get("BLENDER_PATH"), shutil.which("blender"),
                 "/Applications/Blender.app/Contents/MacOS/Blender"):
        if cand and Path(cand).is_file():
            return cand
    return None


@router.get("/simulate/available", dependencies=[require_permission("resources:read")])
async def simulate_available() -> Response:
    return Response(content=json.dumps({"available": bool(_blender_bin())}), media_type="application/json")


@router.post("/jobs/{job_id}/simulate", dependencies=[require_permission("resources:write")])
async def simulate_garment(job_id: str, payload: UploadFile = File(...), ctx: PluginContext = Depends(get_plugin_context)) -> Response:
    """High-quality cloth simulation in Blender: the workspace sends the fitted body +
    assembled pieces + stitches; the result is garment-sim.json (positions) +
    garment.glb. Async: progress on the job's "simulate" event stream."""
    blender = _blender_bin()
    if not blender:
        return JSONResponse({"available": False, "error": "Blender is not installed on this server"}, status_code=501)
    paths = job_paths(job_id)
    if not paths["dir"].is_dir():
        return JSONResponse({"error": "no such job"}, status_code=404)
    raw = await payload.read()
    try:
        json.loads(raw)
    except ValueError:
        return JSONResponse({"error": "payload is not valid JSON"}, status_code=400)
    sim_in = paths["dir"] / "garment-sim-input.json"
    sim_in.write_bytes(raw)
    slot = job_slot(job_id, "simulate")
    if slot in JOB_PROCS:
        return Response(content=json.dumps({"job_id": job_id, "status": "running"}), media_type="application/json")

    def on_success():
        return {
            "event": "stage_done", "stage": "simulate",
            "result": _file_url(job_id, "garment-sim.json"),
            "glb": _file_url(job_id, "garment.glb"),
        }

    JOB_QUEUES[slot] = asyncio.Queue()
    asyncio.create_task(run_stage(
        slot, "simulate",
        [blender, "-b", "--factory-startup", "--python", str(PIPELINE_DIR / "blender_sim.py"), "--",
         str(sim_in), str(paths["dir"] / "garment-sim.json"), str(paths["dir"] / "garment.glb")],
        on_success,
        subprocess_env(ctx),
    ))
    return Response(content=json.dumps({"job_id": job_id, "status": "queued"}), media_type="application/json")


@router.get("/jobs/{job_id}/parts", dependencies=[require_permission("resources:read")])
async def job_parts(job_id: str) -> Response:
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


@router.get("/jobs/{job_id}/events", dependencies=[require_permission("resources:read")])
async def job_events(job_id: str, stage: str | None = None) -> Response:
    queue = JOB_QUEUES.get(job_slot(job_id, stage))
    if queue is None:
        return JSONResponse({"error": "unknown job_id"}, status_code=404)

    async def gen():
        while True:
            line = await queue.get()
            if line == "__END__":
                break
            yield f"data: {line}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


@router.get("/jobs/{job_id}/file/{path:path}", dependencies=[require_permission("resources:read")])
async def job_file(job_id: str, path: str, dl: int = 0) -> Response:
    file_path = (JOBS_DIR / job_id / path).resolve()
    if JOBS_DIR.resolve() not in file_path.parents or not file_path.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    # This same URL is used two ways: an <a download> link that wants a real
    # save-as, and an <object>/<img> embed that wants the file rendered in
    # place. Content-Disposition: attachment satisfies the former but makes
    # Chrome download an <object>'s SVG instead of displaying it (blank pane,
    # no click needed to trigger it) -- so default to inline and only force
    # attachment when the caller passes dl=1 (see downloadUrl() in api.ts).
    # Chrome still needs a Content-Disposition header to honor <a download>
    # cross-origin at all (frontend and this backend run on different ports),
    # which is why this passes filename= either way instead of omitting the
    # header for the inline case.
    disposition = "attachment" if dl else "inline"
    # Job files are rewritten in place by every redraft, while the frontend's
    # ?v= cache-buster is the job's SKETCH mtime -- unchanged by a redraft. With
    # no Cache-Control the browser kept heuristically serving stale copies
    # (measured: a shorts job's pattern-pieces.json came back as its old
    # 3-piece, polygon-less version, so the try-on's pattern view stayed off).
    # no-cache = always revalidate; FileResponse's ETag/Last-Modified make an
    # unchanged file a cheap 304.
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
async def job_thumb(job_id: str, path: str) -> Response:
    src = (JOBS_DIR / job_id / path).resolve()
    if JOBS_DIR.resolve() not in src.parents or not src.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    cache = JOBS_DIR / job_id / ".thumbs" / (path.replace("/", "__") + ".png")
    try:
        if not cache.is_file() or cache.stat().st_mtime < src.stat().st_mtime:
            await asyncio.to_thread(_build_thumb, src, cache)
    except Exception:
        return FileResponse(src)
    return FileResponse(cache)
