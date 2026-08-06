#!/usr/bin/env python3
"""
warp_pattern.py — garment photo → flat technical sketch (front + back view)
usage: python warp_pattern.py input.jpg [output.png] [--seed 42]
"""

import io
import os
import sys
import json
import base64
import random
import argparse
import mimetypes
import requests
from pathlib import Path
from PIL import Image
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("LLM_ROUTER_API_KEY")
BASE_URL = os.getenv("LLM_ROUTER_BASE_URL", "https://api.your-router.com/v1/images/edit")
UPSCALE_URL = os.getenv("LLM_ROUTER_UPSCALE_URL", "https://router-api.pltt.ai/image/upscale")

FLAT_SKETCH_PROMPT = (
    "Redraw THIS EXACT garment as a fashion flat technical sketch. "
    "Do NOT change the design: keep the exact same silhouette, neckline, collar, "
    "sleeve length, pockets, buttons, zips, and proportions as the input image. "
    "MATCH THE PHOTO FEATURE FOR FEATURE. Draw every feature the photo shows and NOT ONE MORE. Count "
    "the pockets, buttons, zips, belt loops, tabs and panels in the photo and reproduce exactly those, "
    "at their real positions. Do not add the hardware or detail a garment of this kind usually carries, "
    "do not resolve a feature you cannot see clearly by inventing a definite one, and do not upgrade a "
    "plain detail into a fancier one (no flap added to a plain pocket, no button added to a plain tab). "
    "An area of the garment the photo shows as empty stays empty. "
    "IGNORE any color, print, plaid, stripes, or fabric pattern in the input — render the fabric "
    "as plain solid white with no texture, no hatching, no gray fill, no pattern of any kind. "
    "Show TWO views side by side: FRONT view on the left, BACK view on the right "
    "(back view inferred from the same garment). "
    "Only pure black outline lines on a pure white background, flat 2D, no body, no mannequin, "
    "no shadows, no shading, no fill of any kind — white fabric with black lines only. "
    "The outer silhouette outline must be solid, fully opaque pure black (#000000) and hold ONE "
    "constant width along its ENTIRE length, all the way around the garment — never tapering from "
    "thick to thin, never fading to gray or low-contrast partway through, never breaking into a "
    "thinner or fainter line at corners, curves, or seam junctions. Every segment of the outline, "
    "front and back, must look like it was drawn with the same pen in a single continuous pass — "
    "that outline is what gets cut/traced, so any variation in its width or darkness along the way "
    "is a defect, not a style choice. "
    "This applies all the way to BOTH ENDPOINTS of every single line and seam, not just its middle: "
    "a line must stay full-width, solid pure black right up to its exact start and end point — never "
    "taper to a point, never fade out, thin down, or lighten toward gray as it approaches its tip. "
    "A line that trails off or loses ink at the end (common at shoulder seams, yoke seams, dart tips, "
    "and other line endpoints) is a defect — cut it off with a blunt, full-strength end instead. "
    "EVERY line in the image — including pleat/fold lines, gather lines, dart lines, and any other "
    "secondary or interior lines — must be drawn in the exact same pure black ink as the main outline. "
    "NEVER render pleat/fold/gather lines (or any other 'secondary' line) in gray or any lighter tone "
    "to suggest depth or softness — there is only ONE ink color in this drawing: pure black. If a line "
    "is thinner or lighter-weight than another, that must come from stroke width alone, never from a "
    "gray/lighter color value. "
    "If the input photo shows the garment being worn by a person, or any person, skin, face, "
    "hands, hair, or body parts elsewhere in the frame, COMPLETELY REMOVE them — extract and "
    "flatten only the garment itself, as if it were laid flat with nothing inside or around it. "
    "The output must contain the garment ONLY: no humans, no mannequins, no body silhouette. "
    "Include all construction details visible in the input: seams, stitching, darts, "
    "collar, cuffs, plackets, pockets, closures, hems. "
    "Detect and draw EVERY garment part as its own clearly separated, closed outline — body panels, "
    "collar, yoke, sleeves, cuffs, plackets, pockets, zips/closures — each one a distinct enclosed "
    "shape with a visible boundary line, so parts can be told apart individually, not merged into one "
    "undifferentiated blob. The collar and the shoulder/yoke are SEPARATE parts — draw the seam line "
    "between the collar and the shoulder/yoke explicitly, all the way across; never let the collar "
    "outline blend directly into the shoulder line with no seam between them. "
    "EXACTLY ONE front closure. The center front carries a zip, OR a button placket, OR a snap "
    "placket — never two of them at once. Do NOT draw a zipper strip and a vertical row of "
    "buttons/snaps stacked on or beside each other down the same center front; that is a defect, not "
    "extra detail. Decide which single closure this garment actually uses and draw only that one, "
    "leaving the rest of the center front clean. The same applies to cuffs and pockets: one closure "
    "type per opening. "
    # The zip rules below run for many sentences, which reads as "draw a zip"
    # even on a garment that has none: a pair of corduroy trousers with a plain
    # concealed fly came back with a full exposed coil zip down the front. The
    # gate has to come before the drawing instructions, not after them.
    "DRAW A ZIP ONLY IF THE PHOTO SHOWS ONE. Look at the garment first and decide: are zipper TEETH "
    "actually visible in the photo? If they are not, this garment has no exposed zip and you must not "
    "draw one. A concealed fly — the ordinary front of jeans, chinos, corduroys and most trousers and "
    "skirts — is drawn as a fly seam with its curved topstitching line and whatever waistband button or "
    "hook the photo shows, and NOTHING else: no rails, no teeth, no slider, no pull. The same holds "
    "everywhere else on the garment: a seam is not a zip, a placket is not a zip, and a pocket opening "
    "with no visible teeth is not a zip. Inventing a zip changes what the factory builds, so when in "
    "doubt draw the plain seam. Everything in the next paragraphs applies only once you have confirmed "
    "the photo really does show an exposed zip. "
    "A zip is its OWN separate closed part, not tick marks stuck onto the body panel's existing center "
    "seam line — draw it as a distinct narrow strip: two parallel vertical rail lines (the zipper tape "
    "edges), offset slightly to either side of the body's center front/back seam so the strip reads as "
    "its own element, with small evenly spaced tick marks (teeth) drawn crossing BOTH rails symmetrically "
    "the entire length — teeth on only one side, or teeth drawn directly on top of the body's own seam "
    "line with no separate rail strip, are NOT acceptable. "
    "The zip's LENGTH/EXTENT — how far down (or up) the body it runs, whether it's a short quarter-zip "
    "stopping partway down the chest or a full zip running all the way to the hem — must exactly match "
    "what the input photo shows. NEVER extend a zip further than the input photo's zip actually goes, and "
    "never shorten one either. Only the TEETH within that same photo-matched length must be drawn TIGHT "
    "and DENSE, like a ladder/herringbone coil zipper: short perpendicular ticks packed close together "
    "with almost no gap between one tick and the next, every tick the exact same length and spacing as "
    "its neighbors, covering that zip's own real length with no interruption — this is a rule about tooth "
    "spacing WITHIN the zip's true length, not a reason to make the zip itself any longer. Sparse, "
    "widely-spaced, or irregular ticks are NOT an acceptable zip texture. Add the pull/slider shape at "
    "the top of the "
    "strip. A single plain or dashed line with no tick marks, or teeth on only one side, is NOT an "
    "acceptable zip, it reads as ordinary topstitching and must not be used for a zip. EVERY line in the "
    "drawing — outer silhouette, seams, darts, topstitching, "
    "AND every closure/hardware piece (zipper rails, zipper pull/slider, snaps, buttons, "
    "hooks) — must be drawn as a single hairline-thin stroke of the SAME light weight, all the way "
    "through. NEVER render any of them as a solid/thick black fill, a bold heavy stroke, or a dense "
    "filled-in shape, no matter how small the part is — a zipper pull is a small thin-outlined shape "
    "with a hollow (white) center, not a solid black blob. If in doubt, draw EVERY line lighter and "
    "thinner rather than darker/thicker — err toward too little ink, never too much. "
    "ONE explicit exception to all of the above: the zipper TEETH themselves (the small tick marks "
    "crossing the rails, not the rails and not the pull/slider) must be drawn as small SOLID filled "
    "black shapes, not hollow hairline outlines — each tooth is a tiny solid black mark, packed tight "
    "and dense as already described. This solid-fill rule applies ONLY to the teeth; the rails on "
    "either side of them and the pull/slider stay hairline-thin outlines as normal. "
    "Technical tech-pack drawing style, uniform hairline-thin line weight throughout the ENTIRE image, "
    "no bold, no thick, no filled lines or shapes anywhere. "
    "To be unambiguous: outline, seams, darts, pleat/fold/gather lines, topstitch dashes, buttons, "
    "snaps, zip rails and pull, badges, patches, and labels — every single mark anywhere in this "
    "drawing, front and back, with no exception besides the zip teeth rule above — is drawn in the "
    "same pure black hairline ink. Nothing in the image is gray, faded, dim, or any color other than "
    "pure black on pure white. "
    "The sketch must be recognizable as the same garment shape as the input photo, but with blank white fabric."
)


def upload_image(path: str) -> str:
    mime = mimetypes.guess_type(path)[0] or "image/png"
    with open(path, "rb") as f:
        r = requests.post(
            "https://router-api.pltt.ai/v1/media/upload",
            headers={"Authorization": f"Bearer {API_KEY}"},
            files={"file": (Path(path).name, f, mime)},
            timeout=60,
        )
    r.raise_for_status()
    return r.json()["url"]


# Reference images are shot for their CONSTRUCTION, not their silhouette — they
# are usually opened-up or inside-out shots showing lining, inner panels, collar
# stands and cuff builds that the main photo simply cannot show. So they get to
# win on the parts they show clearly, while the subject photo stays the authority
# on what garment this is and what shape it has. Without this the references were
# only ever seen by variations.py, and the default flat — the one that gets traced
# into parts and drafted into a pattern — ignored them entirely.
REFERENCE_DETAIL_RULE = (
    "ADDITIONAL REFERENCE IMAGES: the extra images provided alongside the main photo are "
    "construction references for THIS SAME garment, usually shot open or inside-out to show "
    "detail the main photo cannot. Use them as follows. The main subject photo remains the "
    "authority on garment type, overall silhouette, and proportions — never restyle the "
    "garment into a different one. But for any of these specific parts — collar and collar "
    "stand, sleeves and sleeve construction, cuffs, pockets, plackets and closures, lining, "
    "facings, inner panels, yokes and seam placement — if a reference image shows that part "
    "clearly, draw that part the way the REFERENCE shows it, not the way the main photo shows "
    "it. Where no reference shows a given part, follow the main photo as usual. Internal parts "
    "visible only in the references (lining panels, facings, inner seams) should be drawn as "
    "construction detail on the corresponding outer part. "
    "CRITICAL — REPLACE, NEVER ADD: when a reference's version of a part differs from the main "
    "photo's, the reference version REPLACES it. Draw one version only. Never draw both and never "
    "overlay them. If the photo shows a zip at center front and a reference shows a button or snap "
    "placket there (or the reverse), the garment ends up with exactly ONE of those closures — the "
    "reference's — and the other is omitted entirely, not drawn alongside it. Two closures stacked "
    "down the same center front is a defect. Same for every other part: one collar, one cuff "
    "treatment, one pocket per position."
)


def build_payload(image_url: str, seed: int, reference_urls: list[str] | None = None) -> dict:
    prompt = FLAT_SKETCH_PROMPT
    inputs = [{"type": "image", "url": image_url, "role": "subject"}]
    if reference_urls:
        prompt = f"{prompt} {REFERENCE_DETAIL_RULE}"
        inputs += [{"type": "image", "url": u, "role": "style_reference"} for u in reference_urls]
    return {
        "prompt": prompt,
        "model": "image-edit-staging",
        "seed": seed,
        "inputs": inputs,
        "metadata": {"source": "photo2flat", "seed": seed},
    }


def iter_sse_events(resp: requests.Response):
    """yield parsed JSON payload of each `data:` line in an SSE stream"""
    for raw_line in resp.iter_lines(decode_unicode=True):
        if not raw_line or not raw_line.startswith("data:"):
            continue
        payload = raw_line[len("data:"):].strip()
        if payload:
            yield json.loads(payload)


def extract_outputs(data: dict):
    if data.get("type") == "image_done":
        return [{"url": data["url"]}] if data.get("url") else None
    out = data.get("outputs", data.get("images", data.get("output")))
    if out:
        return out if isinstance(out, list) else [out]
    return None


def _generate(image_url: str, seed: int, extra_prompt: str = "",
              reference_urls: list[str] | None = None) -> bytes:
    """One image-gen call: builds the payload (with an optional correction
    appended to the prompt), posts it, and returns the resulting image bytes."""
    payload = build_payload(image_url, seed, reference_urls)
    if extra_prompt:
        payload["prompt"] = payload["prompt"] + " " + extra_prompt

    r = requests.post(
        BASE_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=180,
        stream=True,
    )
    r.raise_for_status()

    out = None
    last_event = None
    for event in iter_sse_events(r):
        last_event = event
        etype = event.get("event")
        if etype == "error":
            msg = event.get("data", {}).get("error", event.get("data", {}))
            sys.exit(f"router error: {msg}")
        found = extract_outputs(event.get("data", event))
        if found:
            out = found

    if not out:
        sys.exit(f"no image in stream; last event: {last_event}")

    return download_output(out[0])


def photo_to_flat(input_path: str, output_path: str, seed: int | None,
                  reference_paths: list[str] | None = None):
    if not API_KEY:
        sys.exit("LLM_ROUTER_API_KEY missing in .env")

    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    print(f"seed: {seed}")

    image_url = upload_image(input_path)
    reference_urls = [upload_image(p) for p in (reference_paths or [])]
    if reference_urls:
        print(f"using {len(reference_urls)} construction reference(s)")
    img_bytes = _generate(image_url, seed, reference_urls=reference_urls)

    Path(output_path).write_bytes(img_bytes)
    print(f"saved → {output_path}")


def download_output(item: dict) -> bytes:
    if item.get("url"):
        return requests.get(item["url"], timeout=60).content
    if item.get("base64") or item.get("b64_json"):
        return base64.b64decode(item.get("base64") or item["b64_json"])
    sys.exit(f"unknown output format: {item}")


def upscale_image(image_url: str) -> bytes | None:
    """POST /image/upscale — sharpen the flat sketch's lines/edges without altering its shape.
    Returns None when the upscale fails, so the caller can keep the original.

    The input has to be an uploaded URL, and the request must carry no
    provider_options: the upscale provider 502s ("rejected the request
    parameters") on inline base64 input and on a provider_options.fal block,
    which is what made every upscale silently fall back to the raw sketch."""
    payload = {
        "prompt": "Preserve the flat sketch's exact shape and lines while sharpening edges and improving "
                  "clarity — especially small fine detail like zipper teeth, buttons, and stitch/topstitch "
                  "dashes, which must come out crisp and individually distinct, not blurred or merged together.",
        "model": "image-upscale-default",
        "inputs": [{"type": "image", "url": image_url}],
        "metadata": {"source": "photo2flat-upscale"},
    }

    r = requests.post(
        UPSCALE_URL,
        headers={
            "Authorization": f"Bearer {API_KEY}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=180,
        stream=True,
    )
    r.raise_for_status()

    out = None
    last_event = None
    for event in iter_sse_events(r):
        last_event = event
        etype = event.get("event")
        if etype == "error":
            msg = event.get("data", {}).get("error", event.get("data", {}))
            print(f"upscale warning: router error {msg} — keeping un-upscaled sketch")
            return None
        found = extract_outputs(event.get("data", event))
        if found:
            out = found

    if not out:
        print(f"upscale warning: no image in stream (last event: {last_event}) — keeping un-upscaled sketch")
        return None

    return download_output(out[0])


def upscale_file(input_path: str, output_path: str):
    if not API_KEY:
        sys.exit("LLM_ROUTER_API_KEY missing in .env")
    try:
        image_url = upload_image(input_path)
    except Exception as e:
        print(f"upscale warning: upload failed ({e}) — keeping un-upscaled sketch")
        image_url = None

    upscaled = upscale_image(image_url) if image_url else None
    if upscaled is None:
        Path(output_path).write_bytes(Path(input_path).read_bytes())
        print(f"saved → {output_path} (un-upscaled)")
        return

    # The provider hands back JPEG and won't take an output_format option, so
    # re-encode: the path says .png, and line art shouldn't collect another
    # generation of JPEG ringing on its way to the tracer.
    im = Image.open(io.BytesIO(upscaled))
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    im.save(output_path, format="PNG")
    print(f"upscaled: {im.width}x{im.height}")
    print(f"saved → {output_path}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("output", nargs="?", default="flat_sketch.png")
    p.add_argument("--seed", type=int, default=None, help="fixed seed for reproducibility")
    p.add_argument("--upscale-only", action="store_true", help="upscale an existing image file instead of generating a sketch from a photo")
    p.add_argument("--references", default="", help="comma-separated local paths to construction reference images, optional")
    a = p.parse_args()
    if a.upscale_only:
        upscale_file(a.input, a.output)
    else:
        photo_to_flat(a.input, a.output, a.seed,
                      [r.strip() for r in a.references.split(",") if r.strip()])