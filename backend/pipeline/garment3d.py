#!/usr/bin/env python3
"""
garment3d.py — the techpack's flat sketch -> a real 3D garment model (GLB).

1. With the uploaded cloth photo (--photo): nano-banana (the LLM router's
   image-edit alias) lays that very garment out in a T-pose on a ghost mannequin,
   front and back, keeping its real colours and fabric.
   Without one: crops the FRONT and BACK views out of the flat sketch, redraws
   each in a T-pose, then makes it a photoreal ghost-mannequin product photo.
3. Sends both photos to three.ws Forge (https://three.ws/api/forge), which
   reconstructs a textured 3D model from them, and saves it as garment3d.glb.
   If three.ws fails or times out, the front photo goes to the LLM router's
   image-to-3D model instead (LLM_ROUTER_3D_MODEL, Hunyuan3D v3 by default).

The photos leave this app: they are uploaded to three.ws's public object storage
for the reconstruction (see docs: three.ws/docs/image-to-3d).

usage: python garment3d.py sketch.png out_dir [--photo input.jpg] [--colour "#2f3b4d"] [--desc "coat_puffer"] [--region upper|lower]
Prints "[garment3d] NN% message" progress lines and "[garment3d] image NAME" as each
picture lands; writes out_dir/garment3d.json (images first, the glb once it's made).
"""

import argparse
import hashlib
import io
import json
import os
import random
import sys
import time
from pathlib import Path

import numpy as np
import requests
from PIL import Image
from warp_pattern import (API_KEY, BASE_URL, RouterBusy, download_output, extract_outputs, iter_sse_events,
                          upload_image, with_router_retry)

FORGE = "https://three.ws"
EDIT_MODEL = os.environ.get("LLM_ROUTER_IMAGE_MODEL", "image-edit-default")
# Tried in order once the configured alias fails with a provider error. On
# 2026-11-03 image-edit-production (nano-banana-pro) was refused ("rejected
# authentication": two of the router's three fal keys were out of balance) while
# image-edit-default (nano-banana-2, fal) kept working. The router's Runware
# alias (palette-runware-fallback-image) is not listed: every request shape was
# refused within a second ("rejected the request parameters").
EDIT_FALLBACK_MODELS = ("image-edit-default",)
POLL_SECONDS = 4
POLL_LIMIT_SECONDS = 15 * 60
# Fallback when three.ws fails. Of the router's image-to-3D aliases only this
# one returned a model on 2026-11-03: image-to-3d-runware sent Runware an
# invalid model id and image-to-3d-fast (SAM 3D) rejected the request.
ROUTER_3D_MODEL = os.environ.get("LLM_ROUTER_3D_MODEL", "image-to-3d-production")
ROUTER_3D_URL = BASE_URL.split("/image/", 1)[0] + "/3d"

PHOTO_PROMPT = (
    "Turn this technical flat sketch ({view} view) into a photorealistic e-commerce product photo of "
    "exactly this garment on an invisible ghost mannequin{pose}, {view} view, centred, filling most of the "
    "frame, on a plain pure white background with soft even studio lighting. Keep the design exactly: "
    "silhouette, length, collar, closures, pockets, seams, panels, quilting, cuffs, trims and details. "
    "Real fabric with natural folds and thickness. Fabric colour: {colour}. Garment: {desc}. "
    "No person, no hanger, no text, no labels, no props, no shadows on the background."
)
# first the flat sketch itself is redrawn in a T-pose (one change at a time keeps
# the design intact), then that T-sketch is made photoreal
TPOSE_PROMPT = (
    "Redraw this technical flat sketch ({view} view) of a garment so the garment is laid out in a T-pose: "
    "both sleeves extended straight out horizontally to the left and right, level with the shoulders, "
    "perfectly symmetric, like a T shape. Keep everything else exactly the same: the same garment, body "
    "length, collar, closures, pockets, seams, panels, quilting, cuffs, hems, trims and details, the same "
    "black line-art style on a plain pure white background. Only the sleeves change angle. Whole garment "
    "in frame with margin. No person, no text, no labels."
)

# the uploaded photo itself, straight to the T-pose product shot: its own colours,
# print and fabric, whatever it was shot on (a hanger, a person, a flat lay)
PHOTO_TPOSE_PROMPT = (
    "Turn this photo of a garment into a photorealistic e-commerce product photo of exactly this garment "
    "on an invisible ghost mannequin{pose}, {view} view, centred, whole garment in frame with margin, on a "
    "plain pure white background with soft even studio lighting. {back}Keep the garment exactly: its "
    "colours, print, fabric, texture, silhouette, length, collar, closures, pockets, seams, cuffs, hems and "
    "trims. If the input is a line drawing, make it real fabric in colour {colour}. Real fabric with natural "
    "folds and thickness. Garment: {desc}. No person, no skin, no hanger, no "
    "text, no labels, no props, no shadows on the background."
)
# The back is made with the finished front photo as a reference. Made on its own
# it drifted: a long-sleeved hanging back with a green hem against a short-sleeved
# front with a black/white striped hem, and three.ws fused the two into torn
# shoulder flaps and a black sleeve.
MATCH_HINT = (" The second image is the FRONT of this exact garment, already photographed: match it "
              "exactly -- the same fabric colour and texture, the same hem and cuff ribbing colours, the "
              "same sleeve length and the same T-pose with the sleeves straight out sideways. ")
BACK_HINT = ("Show the BACK of this same garment as it would look from behind, consistent with the front: "
             "no front-only details such as front closures or chest pockets. ")

# an upper garment is shot in a T-pose: the try-on raises the body's arms to the
# reconstruction's sleeves, so they wrap the arms instead of hanging over them
POSES = {
    "upper": " standing in a T-pose, arms spread straight out to the sides level with the shoulders, "
             "any sleeves extended perfectly horizontally at 90 degrees to the body with the cuffs at shoulder "
             "height, not angled down, fully filled out along the arms, symmetric left and right",
    "lower": "",
}


# nano-banana often hands back the sleeves still hanging, however the prompt
# asks. Each T-pose picture is checked (its widest row up top, where level
# sleeves make it about twice as wide, over its lower body) and redone with a
# firmer prompt until the sleeves really stand out; a hanging-sleeve garment
# cannot be worn on the T-posed figure without tearing it apart.
TPOSE_MIN_RATIO = 1.8  # real T-poses score 2.5-3.2; a half-done one with extra sleeves ~1.4
TPOSE_TRIES = 3
TPOSE_RETRY = (
    " The WHOLE garment, both cuffs included, must fit inside the picture with a clear white margin "
    "on every side; nothing may touch or run off the edges."
    " IMPORTANT: the previous attempt left the sleeves hanging down along the body, which is wrong. "
    "The two sleeves must point straight out sideways, horizontal, like the letter T, with a clear empty "
    "gap between each sleeve's underside and the body below it; the cuffs at the far left and right edges "
    "of the garment at shoulder height."
)


def tpose_ratio(png: bytes) -> float:
    """Widest garment row in its top 40% over the median row width at 65-90%
    of its height (garment = anything not near-white). ~1 hanging, ~2 T-pose."""
    a = np.asarray(Image.open(io.BytesIO(png)).convert("L"))
    fg = a < 235
    rows = np.where(fg.any(axis=1))[0]
    if len(rows) < 10:
        return 0.0
    y0, y1 = rows[0], rows[-1]
    h = y1 - y0
    def width(y: int) -> int:
        xs = np.where(fg[y])[0]
        return int(xs[-1] - xs[0]) if len(xs) else 0
    top = max(width(y) for y in range(y0, y0 + int(h * 0.4) + 1))
    low = np.median([width(y) for y in range(y0 + int(h * 0.65), y0 + int(h * 0.9) + 1)])
    return top / low if low > 0 else 0.0


def cropped(png: bytes) -> bool:
    """The garment runs off the picture (a sleeve cut at the frame): three.ws then
    has nothing to see there and bakes that part of the model near-black."""
    a = np.asarray(Image.open(io.BytesIO(png)).convert("L"))
    fg = a < 235
    edge = 2
    return bool(fg[:, :edge].any() or fg[:, -edge:].any() or fg[:edge, :].any() or fg[-edge:, :].any())


def until_tpose(make, what: str) -> bytes:
    """make(retry) -> png bytes, redone until it is a T-pose. If no try is, the
    first one: a pushed retry that only half complies tends to grow a second
    pair of sleeves, which is worse than sleeves left hanging (the try-on can
    still raise those)."""
    first = b""
    for n in range(TPOSE_TRIES):
        png = make(n > 0)
        first = first or png
        r, cut = tpose_ratio(png), cropped(png)
        if r >= TPOSE_MIN_RATIO and not cut:
            return png
        why = "garment cut off at the frame" if r >= TPOSE_MIN_RATIO else f"sleeves not out (ratio {r:.2f})"
        print(f"[garment3d] {what}: {why}, redoing ({n + 1}/{TPOSE_TRIES})", flush=True)
    NOT_TPOSE.add(what)
    return first


# what's that never passed the T-pose check (until_tpose fell back to its first try)
NOT_TPOSE: set[str] = set()


def progress(pct: int, msg: str) -> None:
    print(f"[garment3d] {pct}% {msg}", flush=True)


def split_views(sketch: Path, out_dir: Path) -> list[Path]:
    """Front (left) and back (right) views as separate padded crops."""
    im = Image.open(sketch).convert("RGB")
    a = np.asarray(im)
    ink = a.min(axis=2) < 200
    h, w = ink.shape
    cols = ink.sum(axis=0).astype(float)
    # a divider is a thin column inked most of the way down
    for x in range(2, w - 2):
        if cols[x] > h * 0.55 and cols[x - 2] < h * 0.2 and cols[x + 2] < h * 0.2:
            cols[x] = 0
    spans = runs(cols > 0, int(w * 0.02))
    spans = sorted(spans, key=lambda s: s[1] - s[0], reverse=True)[:2]
    spans = sorted([s for s in spans if s[1] - s[0] > w * 0.08])
    if not spans:
        spans = [(0, w - 1)]
    crops = []
    for i, (x0, x1) in enumerate(spans):
        rows = ink[:, x0:x1 + 1].any(axis=1)
        y0, y1 = max(runs(rows, int(h * 0.02)), key=lambda s: s[1] - s[0])
        pad = int(max(x1 - x0, y1 - y0) * 0.08)
        box = (max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad + 1), min(h, y1 + pad + 1))
        crop = im.crop(box)
        side = max(crop.size)
        sq = Image.new("RGB", (side, side), "white")
        sq.paste(crop, ((side - crop.width) // 2, (side - crop.height) // 2))
        path = out_dir / f"garment3d-{'front' if i == 0 else 'back'}-sketch.png"
        sq.save(path)
        crops.append(path)
    return crops


def runs(on, gap: int) -> list[tuple[int, int]]:
    out, start, last = [], -1, -1
    for i, v in enumerate(on):
        if not v:
            continue
        if start >= 0 and i - last > gap + 1:
            out.append((start, last))
            start = -1
        if start < 0:
            start = i
        last = i
    if start >= 0:
        out.append((start, last))
    return out


def photoreal(sketch: Path, view: str, colour: str, desc: str, region: str, ref: Path | None = None) -> bytes:
    prompt = PHOTO_PROMPT.format(view=view, colour=colour, desc=desc or "garment", pose=POSES.get(region, ""))
    prompt += MATCH_HINT if ref else ""
    refs = [ref] if ref else []
    if region != "upper":
        return edit_image(sketch, prompt, view, refs)
    return until_tpose(lambda retry: edit_image(sketch, prompt + (TPOSE_RETRY if retry else ""), view, refs),
                       f"{view} photo")


def photo_tpose(photo: Path, view: str, colour: str, desc: str, region: str, ref: Path | None = None) -> bytes:
    prompt = PHOTO_TPOSE_PROMPT.format(view=view, desc=desc or "garment", pose=POSES.get(region, ""), colour=colour,
                                       back=BACK_HINT if view == "back" else "")
    prompt += MATCH_HINT if ref else ""
    refs = [ref] if ref else []
    if region != "upper":
        return edit_image(photo, prompt, view, refs)
    return until_tpose(lambda retry: edit_image(photo, prompt + (TPOSE_RETRY if retry else ""), view, refs),
                       f"{view} photo")


def tpose_sketch(sketch: Path, view: str) -> bytes:
    prompt = TPOSE_PROMPT.format(view=view)
    return until_tpose(lambda retry: edit_image(sketch, prompt + (TPOSE_RETRY if retry else ""), view), f"{view} T-pose sketch")


def edit_image(sketch: Path, prompt: str, view: str, refs: list[Path] = ()) -> bytes:
    global EDIT_MODEL
    while True:
        try:
            return with_router_retry(edit_image_once, sketch, prompt, view, refs)
        except RuntimeError as e:
            # step down the chain, never back up it
            i = EDIT_FALLBACK_MODELS.index(EDIT_MODEL) + 1 if EDIT_MODEL in EDIT_FALLBACK_MODELS else 0
            if "provider_error" not in str(e) or i >= len(EDIT_FALLBACK_MODELS):
                raise
            print(f"[garment3d] {EDIT_MODEL} failed at the router's provider, using {EDIT_FALLBACK_MODELS[i]}",
                  flush=True)
            EDIT_MODEL = EDIT_FALLBACK_MODELS[i]   # the rest of this run too


def edit_image_once(sketch: Path, prompt: str, view: str, refs: list[Path] = ()) -> bytes:
    url = upload_image(str(sketch))
    payload = {
        "prompt": prompt,
        "model": EDIT_MODEL,
        "seed": random.randint(0, 2**31 - 1),
        "inputs": [{"type": "image", "url": url, "role": "subject"}]
                  + [{"type": "image", "url": upload_image(str(r)), "role": "style_reference"} for r in refs],
        "metadata": {"source": "garment3d", "view": view},
    }
    r = requests.post(
        BASE_URL,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json=payload, timeout=300, stream=True,
    )
    r.raise_for_status()
    out = None
    for event in iter_sse_events(r):
        if event.get("event") == "error":
            data = event.get("data", {})
            err = data.get("error", data) if isinstance(data, dict) else data
            if isinstance(err, dict) and err.get("retryable", err.get("status") in (429, 502, 503)):
                raise RouterBusy(err)
            raise RuntimeError(f"image edit failed: {data.get('error', data) if isinstance(data, dict) else data}")
        found = extract_outputs(event.get("data", event))
        if found:
            out = found
    if not out:
        raise RuntimeError("image edit returned no image")
    return download_output(out[0])


def forge_upload(data: bytes, client: str) -> str:
    """Presigned upload to three.ws storage; returns the public URL Forge reads."""
    png = io.BytesIO()
    Image.open(io.BytesIO(data)).convert("RGB").save(png, "JPEG", quality=92)
    body = png.getvalue()
    r = requests.post(f"{FORGE}/api/forge-upload", json={"content_type": "image/jpeg", "size_bytes": len(body)},
                      headers={"x-forge-client": client}, timeout=60)
    if r.status_code != 200:
        raise RuntimeError(f"three.ws upload refused ({r.status_code}): {r.text[:300]}")
    up = r.json()
    put = requests.put(up["upload_url"], data=body, headers=up.get("headers") or {"content-type": "image/jpeg"}, timeout=120)
    if put.status_code >= 300:
        raise RuntimeError(f"three.ws storage upload failed ({put.status_code})")
    return up["public_url"]


def forge_generate(image_urls: list[str], client: str) -> dict:
    r = requests.post(f"{FORGE}/api/forge", json={"image_urls": image_urls, "tier": "standard"},
                      headers={"x-forge-client": client}, timeout=180)
    if r.status_code >= 400:
        raise RuntimeError(f"three.ws forge refused ({r.status_code}): {r.text[:300]}")
    job = r.json()
    if job.get("status") == "done" and glb_of(job):
        return job
    job_id = job.get("job_id")
    if not job_id:
        raise RuntimeError(f"three.ws forge gave no job: {json.dumps(job)[:300]}")
    started = time.time()
    while time.time() - started < POLL_LIMIT_SECONDS:
        time.sleep(POLL_SECONDS)
        pr = requests.get(f"{FORGE}/api/forge", params={"job": job_id}, headers={"x-forge-client": client}, timeout=60)
        if pr.status_code >= 400:
            continue
        job = pr.json()
        status = job.get("status")
        elapsed = int(time.time() - started)
        progress(min(95, 55 + elapsed // 6), f"reconstructing 3D on three.ws ({status or 'queued'}, {elapsed}s)")
        if status == "done" and glb_of(job):
            return job
        if status == "failed":
            raise RuntimeError(f"three.ws reconstruction failed: {job.get('error') or job.get('message') or 'unknown'}")
    raise RuntimeError("three.ws reconstruction timed out")


def router_3d(photo: Path) -> str:
    """Image-to-3D on the LLM router; returns the GLB's URL. Single image: the
    router's 3D aliases take one subject, so this gets the front photo."""
    payload = {
        "model": ROUTER_3D_MODEL,
        "inputs": [{"type": "image", "url": upload_image(str(photo)), "role": "subject"}],
        "metadata": {"source": "garment3d"},
    }
    r = requests.post(ROUTER_3D_URL, json=payload, stream=True, timeout=POLL_LIMIT_SECONDS,
                      headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"})
    r.raise_for_status()
    started = time.time()
    for event in iter_sse_events(r):
        data = event.get("data", event)
        if event.get("event") == "error":
            raise RuntimeError(f"router 3D failed: {data.get('error', data) if isinstance(data, dict) else data}")
        if not isinstance(data, dict):
            continue
        if data.get("type") == "provider_status":
            progress(min(95, 60 + int(time.time() - started) // 6),
                     f"reconstructing 3D on the router ({data.get('status') or 'queued'})")
        # the model arrives as a "video_done" event: data.url, plus every format
        # under output.metadata.assets -- take the GLB
        assets = ((data.get("output") or {}).get("metadata") or {}).get("assets") or []
        for url in [data.get("url")] + [a.get("url") for a in assets if isinstance(a, dict)]:
            if isinstance(url, str) and url.split("?", 1)[0].endswith(".glb"):
                return url
    raise RuntimeError("router 3D returned no GLB")


def glb_of(job: dict) -> str | None:
    return job.get("glb_url") or job.get("glbUrl") or (job.get("result") or {}).get("glb_url")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("sketch")
    ap.add_argument("out_dir")
    ap.add_argument("--photo", default="", help="the uploaded cloth photo: the T-pose is made from it")
    ap.add_argument("--colour", default="#2f3b4d")
    ap.add_argument("--desc", default="")
    ap.add_argument("--region", choices=sorted(POSES), default="upper", help="upper = T-pose, lower = as is")
    args = ap.parse_args()
    if not API_KEY:
        sys.exit("LLM_ROUTER_API_KEY missing")
    out_dir = Path(args.out_dir)
    # one stable, anonymous client handle per job (three.ws scopes uploads by it)
    client = hashlib.sha256(str(out_dir.resolve()).encode()).hexdigest()[:32]

    meta = {"glb": None, "photos": [], "tpose_sketches": [], "colour": args.colour, "region": args.region,
            "pose": "tpose" if args.region == "upper" else "natural",
            "source": "photo" if args.photo else "sketch"}

    def landed(path: Path, kind: str) -> None:
        # each picture shows in the try-on as soon as it's made, not after the 3D
        meta[kind].append(path.name)
        (out_dir / "garment3d.json").write_text(json.dumps(meta, indent=2))
        print(f"[garment3d] image {path.name}", flush=True)

    upper = args.region == "upper"
    photos = []
    if args.photo:
        for i, view in enumerate(("front", "back")):
            progress(5 + i * 22, f"nano-banana: laying the {view} of your garment out in a {'T-pose' if upper else 'product shot'}")
            path = out_dir / f"garment3d-{view}.png"
            path.write_bytes(photo_tpose(Path(args.photo), view, args.colour, args.desc, args.region,
                                         ref=photos[0] if photos else None))
            photos.append(path)
            landed(path, "photos")
    else:
        progress(3, "reading the techpack sketch")
        for i, sketch in enumerate(split_views(Path(args.sketch), out_dir)):
            view = "front" if i == 0 else "back"
            if upper:
                progress(6 + i * 21, f"nano-banana: redrawing the {view} sketch in a T-pose")
                t = out_dir / f"garment3d-{view}-tpose.png"
                t.write_bytes(tpose_sketch(sketch, view))
                landed(t, "tpose_sketches")
                sketch = t
            progress(16 + i * 21 if upper else 8 + i * 20, f"making a realistic {view} photo of the garment")
            path = out_dir / f"garment3d-{view}.png"
            path.write_bytes(photoreal(sketch, view, args.colour, args.desc, args.region,
                                       ref=photos[0] if photos else None))
            photos.append(path)
            landed(path, "photos")

    # A view that never reached a T-pose doesn't match the other one, and three.ws
    # fuses mismatched views into torn flaps; reconstruct from the good view alone.
    good = [p for p, view in zip(photos, ("front", "back")) if f"{view} photo" not in NOT_TPOSE]
    if upper and 0 < len(good) < len(photos):
        print(f"[garment3d] {', '.join(sorted(NOT_TPOSE))} not in a T-pose: 3D from {good[0].name} only", flush=True)
        photos = good
    try:
        progress(48, "uploading photos to three.ws")
        urls = [forge_upload(p.read_bytes(), client) for p in photos]
        progress(55, "reconstructing 3D on three.ws")
        job = forge_generate(urls, client)
        glb_url = glb_of(job)
        made_by = {"backend": job.get("backend"), "tier": job.get("tier"), "path": job.get("path")}
    except Exception as e:
        progress(60, f"three.ws failed ({e}); trying the router's {ROUTER_3D_MODEL}")
        glb_url = router_3d(photos[0])
        made_by = {"backend": ROUTER_3D_MODEL, "tier": None, "path": "router"}

    progress(96, "downloading the 3D model")
    glb = requests.get(glb_url, timeout=300)
    glb.raise_for_status()
    (out_dir / "garment3d.glb").write_bytes(glb.content)
    meta.update({"glb": "garment3d.glb", **made_by, "created": int(time.time())})
    (out_dir / "garment3d.json").write_text(json.dumps(meta, indent=2))
    progress(100, "3D garment ready")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # surface a readable message to the stage log
        sys.exit(f"garment3d: {e}")
