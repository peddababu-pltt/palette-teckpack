#!/usr/bin/env python3
"""
regen_sketch.py — low-quality technical flat → clean, high-res vector-style flat.

Reconstruction only: the garment design is preserved exactly, nothing is
redesigned, simplified, or invented. Runs through the LLM router's image-edit
alias, which resolves to nano-banana by default.

usage: python regen_sketch.py input_sketch.png [output.png] [--seed 42] [--model image-edit-default]
"""

import argparse
import base64
import json
import os
import random
import sys
from pathlib import Path

import anthropic
import requests
from warp_pattern import (
    API_KEY,
    BASE_URL,
    download_output,
    extract_outputs,
    iter_sse_events,
    upload_image,
)

# Router alias -> fal-ai/nano-banana-2/edit. Overridable with --model
# (image-edit-production = nano-banana-pro, image-edit-staging = gemini).
DEFAULT_MODEL = "image-edit-default"

# nano-banana obeys the "keep a gap between a dash run and the solid line it
# parallels" instruction inconsistently -- placket, pocket, hem band, and yoke
# seam have all come back with the dash fused onto the solid line despite the
# prompt. A single generation call can't be made to always obey a text
# instruction, so we verify the raster output with a vision check and retry.
OVERLAP_VERIFY_ATTEMPTS = int(os.environ.get("OVERLAP_VERIFY_ATTEMPTS", "3"))

OVERLAP_CHECK_PROMPT = (
    "This is a garment technical flat. Look for ONE specific defect: a dashed "
    "stitch/topstitch line that touches, overlaps, sits on top of, or fuses "
    "with an adjacent SOLID line (outline, seam, panel edge, pocket edge, "
    "placket edge, hem band edge, collar edge) anywhere in the image, so the "
    "two read as one thick or fuzzy compound line instead of two clearly "
    "separated parallel lines. Ignore every other kind of imperfection. "
    "Reply with ONLY a JSON object, no markdown fences, no explanation: "
    '{"defect_found": true or false, "locations": ["short description of '
    'each spot", ...]}. If nothing overlaps, "locations" is an empty list.'
)

# The prompt-only version of the no-dash rule loses: stage 1 keeps emitting a
# dashed outline offset just outside each welt pocket, and the regen pass
# inherits it even with the ban stated as RULE ZERO ahead of everything else.
# Same remedy as the overlap defect -- verify the raster, retry with a note.
STITCH_DASH_CHECK_PROMPT = (
    "This is a garment technical flat. Look for ONE specific defect: a "
    "TOPSTITCH LINE drawn alongside any of these four parts — a pocket (any "
    "edge, flap, opening), a hem (body hem, sleeve hem, rib hem band), a "
    "neckline (neck opening, neckband, neck facing), or a yoke seam (front or "
    "back). Each of these four parts must be ONE single line, with no second "
    "line running beside it. The defect takes two forms, and BOTH count: "
    "(a) a DASHED line tracing the part a short distance from its edge; "
    "(b) a SECOND SOLID line beside the part's edge — a doubled or "
    "double-struck outline, a thin contour hugging the main edge, or a narrow "
    "parallel band, so the edge reads as two closely-spaced lines instead of "
    "one. Zoom in on each pocket in particular and count the lines along its "
    "edge: more than one means the defect is present. "
    "The body's bottom edge has its own dedicated check (see "
    "PHANTOM_HEM_CHECK_PROMPT) — do not report it here. "
    "Ignore dashes and doubled lines anywhere else — quilting/baffle lines "
    "across body panels, princess seams, fly, plackets and sleeve seams are "
    "NOT this defect. Ignore every other kind of imperfection. "
    "Reply with ONLY a JSON object, no markdown fences, no explanation: "
    '{"defect_found": true or false, "locations": ["short description of '
    'each spot", ...]}. If none of the four parts carries a dash, "locations" '
    "is an empty list."
)

# Kept as its own short call on purpose. Folded into the (long) stitch-dash
# prompt as one more clause, this test was answered inconsistently -- the same
# blank two-line bottom edge came back "clean" on one sketch and flagged on
# another. Asked on its own, in the step-by-step form below, the model reads
# the strip correctly every time. The failure it guards is expensive: a blank
# double line at the body's bottom edge is segmented as a thin strip and named
# a hem, so a phantom hem piece gets cut from a garment that has no hem band.
PHANTOM_HEM_CHECK_PROMPT = (
    "Look ONLY at the bottom edge of the garment body — the lowest horizontal "
    "edge of the torso, NOT the sleeves or cuffs. Work through these steps: "
    "(1) How many lines run across there: one line, or two parallel lines "
    "forming a narrow strip? "
    "(2) If two, look inside that strip: does it contain vertical rib ticks "
    "(like a rib-knit band), or is it blank white? "
    "(3) For comparison, do the sleeve cuffs show rib ticks inside them? "
    "Then decide, mechanically and without judging what the feature is meant "
    "to represent: the defect is present if and only if the torso's bottom "
    "edge is TWO parallel lines with a BLANK strip between them (no rib "
    "ticks, no interior marks). One single line = no defect. Two lines with "
    "real rib ticks inside = a genuine rib band = no defect. "
    "A blank two-line bottom edge is a stray topstitch line, not a hem band, "
    "even though it looks like one. "
    "Reply with ONLY a JSON object, no markdown fences, no explanation: "
    '{"defect_found": true or false, "locations": ["short description"]}. '
    'If there is no defect, "locations" is an empty list.'
)


def _image_b64(path: str) -> str:
    return base64.b64encode(Path(path).read_bytes()).decode()


def _extract_json(text: str):
    text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _check_defect(image_path: str, prompt: str, label: str) -> dict:
    """Ask a vision model whether one specific defect is present.

    Returns {"defect_found": bool, "locations": [...]}; fails open (assumes
    no defect) if the check itself errors out, so a flaky verify call can't
    block the whole regen.
    """
    client = anthropic.Anthropic()
    try:
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1000,
            messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64",
                 "media_type": "image/png", "data": _image_b64(image_path)}},
                {"type": "text", "text": prompt},
            ]}],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        result = _extract_json(text)
        if result and "defect_found" in result:
            return result
        print(f"{label} check: unparseable reply, assuming clean: {text[:200]!r}")
    except Exception as e:
        print(f"{label} check: request failed, assuming clean ({e})")
    return {"defect_found": False, "locations": []}


def check_overlap_defect(image_path: str) -> dict:
    """Dash run fused onto an adjacent solid line."""
    return _check_defect(image_path, OVERLAP_CHECK_PROMPT, "overlap")


def check_stitch_dash_defect(image_path: str) -> dict:
    """Stitch dashes on a pocket, hem, neckline or yoke line."""
    return _check_defect(image_path, STITCH_DASH_CHECK_PROMPT, "stitch-dash")


def check_phantom_hem_defect(image_path: str) -> dict:
    """Blank two-line strip at the body's bottom edge (a hem that isn't)."""
    return _check_defect(image_path, PHANTOM_HEM_CHECK_PROMPT, "phantom-hem")

REGEN_PROMPT = (
    "You are an expert Fashion Technical Illustration Reconstruction AI specialized in garment "
    "technical flats and tech pack artwork. "
    "TASK: reconstruct the uploaded low-quality garment technical sketch into a clean, "
    "high-resolution, vector-style technical flat. "

    # Stated first because it is the rule the model breaks most often: buried in
    # the stitching section it lost to "do not remove anything that is in the
    # input", and every puffer came back with a dashed outline tracing each
    # welt pocket about two stroke-widths outside its solid edge.
    "RULE ZERO — NO TOPSTITCH LINE OF ANY KIND ON POCKETS, HEM, NECKLINE OR YOKE LINE. Each of these "
    "four parts is drawn with EXACTLY ONE single solid line and NOTHING beside it. "
    "The defect to eliminate, in both of the forms it takes: "
    "(a) a DASHED line tracing the part a short distance away from its edge; "
    "(b) a SECOND SOLID line — a thin outline hugging the main edge, a doubled or double-struck "
    "outline, a narrow parallel band, an offset contour — running alongside the part's real edge. "
    "Both are topstitch representations and both are FORBIDDEN on these four parts. A pocket edge is "
    "ONE line, not two lines close together. A hem is ONE line. A neckline is ONE line. A yoke seam "
    "is ONE line. "
    "If the input shows either form on any of these four parts, DELETE the extra line ENTIRELY — do "
    "not redraw it, do not convert a dashed one into a solid one, do not move it further away, do not "
    "thin it down. Delete it and keep only the part's own single edge. "
    "THE BOTTOM EDGE, SPECIFICALLY. Unless the garment truly has a rib-knit band there — a real band "
    "carrying visible vertical rib ticks, like the cuffs do — the body simply ENDS at its bottom "
    "edge, drawn as ONE line. If the input shows a second line running parallel a short distance "
    "above the bottom edge, forming a narrow featureless strip with no rib ticks in it, that line is "
    "topstitching, NOT a hem band: DELETE it and let the body end in a single line. Downstream this "
    "strip is read as a hem band the garment does not have, and a phantom hem piece gets cut from it. "
    "This deletion is required even though the rest of this prompt "
    "tells you to preserve the input faithfully. Rule Zero ADDS to the solid-outline-only list given "
    "later in this prompt (waistband, cuffs, collar, placket, fly, zipper tape, rib bands, tabs, "
    "welts, pocket flaps, belt loops) — it does not replace it or make those parts dashable. "

    "REFERENCE QUALITY STANDARD: the output must match professional apparel CAD artwork and be "
    "indistinguishable from a vector illustration drafted in Adobe Illustrator for a commercial "
    "production tech pack — crisp razor-sharp black line art, smooth Bezier-quality curves, perfectly "
    "closed outlines with no gaps at any corner or junction, consistent line hierarchy, clearly "
    "separated body panels, clean sleeve construction, precisely defined collars and cuffs, and "
    "high-contrast pocket outlines. "

    "HARD RULES — preserve the design exactly. Do NOT redesign, restyle, simplify, or invent "
    "features. No new panels, pockets, buttons, seams, or trims that are not in the input. Do not "
    "remove anything that is in the input — with ONE deliberate exception, the stitch-dash removal "
    "rule stated below: dashes on pockets, hem, neckline and yoke line ARE removed on purpose, and "
    "that is a required cleanup, not a violation of this rule. Keep the same garment category, "
    "the same silhouette, the "
    "same proportions, the same symmetry, and the SAME VIEW(S) in the same layout — if the input "
    "shows front and back side by side, the output shows front and back side by side, in the same "
    "order. Pure white background. "

    # The part list below used to read as a to-draw checklist, and the model
    # treated it as one: a jacket with two slim welt pockets came back with the
    # welts PLUS a pair of invented flap patch pockets. It is a naming
    # vocabulary for what is already in the picture, never a list of things to
    # add, so the inventory rule states that before the list is reached.
    "FEATURE INVENTORY — MATCH THE INPUT ONE FOR ONE. Before drawing, count what the input actually "
    "has: how many pockets and of exactly which type, how many buttons, how many zippers, how many "
    "panels and seams, what collar, what cuffs and hem. The output must contain EXACTLY that set — "
    "same count, same type, same position, same relative size, on the same view. If the input has two "
    "narrow welt pockets, the output has two narrow welt pockets and NOTHING else in that area: no "
    "flap added over them, no patch pocket added below them, no extra chest or cargo pocket. If the "
    "input has no pocket in a place, the output has no pocket in that place. The same applies to every "
    "other feature: an empty area of the garment stays empty. Adding a plausible, well-drawn feature "
    "that is not in the input is the single worst failure this task can produce — it is worse than a "
    "rough line, because it silently changes the garment being manufactured. When you are unsure "
    "whether a faint mark is a feature, reproduce it as the same faint mark; never resolve the doubt "
    "by inventing a definite detail. "

    "RECONSTRUCT IN THIS ORDER. The lists below are NAMING VOCABULARY for identifying what is already "
    "in the input — they are NOT a checklist of things to draw. Draw an item ONLY IF IT IS VISIBLY "
    "PRESENT in the input; skip every name that does not apply to this garment. "
    "(1) GARMENT OUTLINE — rebuild the complete outer silhouette with smooth, vector-quality curves. "
    "(2) BODY PATTERN PIECES — whichever of these the input actually shows: front panel, back panel, "
    "side panel, princess panel, center front, center back, yoke, waist panel, hip panel, shoulder "
    "panel, bib, gusset, facing, hem facing, placket, fly, waistband, hem, cuff, pocket bag. "
    "(3) SLEEVES — as built in the input: sleeve cap, long/short sleeve, raglan, kimono, dolman, puff, "
    "bell, cuff, vent, placket, gathering, pleats. "
    "(4) COLLAR AND NECK — whichever the input has: shirt collar, collar stand, mandarin, hood, lapel, "
    "shawl, neckband, facing. "
    "(5) INTERNAL CONSTRUCTION — only the lines the input shows: panel seams, princess seams, darts, "
    "pleats, tucks, gathering, waist seam, fold lines, construction seams, reinforcement seams, "
    "decorative seams, topstitching. "
    "(6) POCKETS — reproduce the pockets the input has, at their type (patch, welt, flap, cargo, coin, "
    "side seam, chest, hidden), count and position, with pocket opening and crisply defined pocket "
    "corners. Do NOT draw any stitching dashes around or along pocket boundaries — pocket outlines are "
    "solid lines only, never dashed. Never add a pocket the input does not have, and never upgrade a "
    "plain welt or patch pocket into a flapped or buttoned one. "
    "(7) FASTENERS — only those present: zipper (tape, teeth, slider, puller, top stop, bottom stop, "
    "zipper stitching), buttons (button, buttonhole, button stitching), snaps, hooks, eyelets, buckles. "
    "Match the button count exactly; do not add a button to a pocket, tab or placket that has none. "
    "(8) TRIMS — only those present: belt, belt loops, drawstring, elastic, tabs, labels, bows, "
    "ribbons, velcro, cordlocks, badges, patches, emblems. A badge or patch (e.g. a circular woven "
    "badge on a sleeve) is a design feature like any pocket or seam: reproduce its outline AND its "
    "interior graphic detail (rings, segments, internal shapes) exactly as drawn in the input, at the "
    "same position and size. Do NOT flatten it into a blank circle or omit its interior marks. "
    "Each garment part is its own clearly separated, closed outline with a visible boundary line, so "
    "parts can be told apart individually instead of merging into one blob. "

    "LINE HIERARCHY: exactly THREE line weights, and every line in the drawing belongs to one of them "
    "— bold for the outer outline, garment shape, and major panels; medium for panel boundaries, "
    "collars, sleeves, waistbands, pockets, plackets, and fly; thin for construction lines, darts, "
    "pleats, and internal details. Within a weight class the stroke width is perfectly uniform "
    "everywhere it is used; there are no in-between or one-off weights. Every line is solid pure black "
    "(#000000) — line weight comes from stroke width alone, never from gray or a lighter tone — and "
    "holds constant width to both of its endpoints, with blunt full-strength ends, never tapering, "
    "fading, or trailing off. "

    "FUR/SHEARLING/FAUX-FUR TRIM: if the input has a fur, shearling, or faux-fur collar, cuff, or hood "
    "trim, reproduce its edge as a gentle, open, evenly-spaced scalloped or wavy border — like a cloud "
    "outline — at the SAME hairline stroke weight as every other line. Do not thicken, densify, or "
    "sharpen the input's fur texture into a dense jagged zigzag or tight spiking: if the input's fur "
    "edge is already dense enough to read as a heavier or darker band than the rest of the outline, "
    "clean it up to the same open, evenly-spaced scallop described above instead of reproducing that "
    "density. A cleaned-up fur edge reads as a construction detail, not a thick black smear. "

    "NEVER FILL A REGION SOLID BLACK. If the input has a contrast-colored or dark-colored trim, panel, "
    "or material — a dark placket, a dark waistband or belt, a contrast collar underside, contrast "
    "pocket welts or flap binding, a two-tone yoke or cuff strap — that contrast is drawn as an outline "
    "only, exactly like every other panel, with its interior left blank white. Do not represent color, "
    "shading, or material contrast by filling the shape solid black. A solid black placket, waistband, "
    "collar facing, belt loop, cuff strap, or pull tab carried over from a dark area of the input is "
    "exactly the defect to avoid — reproduce its outline and internal construction lines (stitching, "
    "edge seams) at the normal line weight, never as a filled block. "

    "SURFACE PATTERN — QUILTING AND DIAGONAL LINES. Diagonal lines, diagonal dashed lines, "
    "quilting grids, diamond quilting, or any repeated geometric pattern running across a body "
    "panel or sleeve are a SURFACE DECORATION stitched onto the fabric — they are NOT construction "
    "seams and must NEVER be drawn as solid lines. "
    "If the input shows these as dashed lines: reproduce them as dashed lines, same weight and "
    "same density as the input, classified as surface stitching. "
    "If you cannot tell whether a diagonal line is a construction seam or a quilting line, "
    "default to treating it as quilting (dashed, lighter weight) not a seam (solid, heavier). "
    "A diagonal line running across the body panel from armhole to hem is always quilting — "
    "never a structural seam. "

    "STITCHING — ACTIVE REMOVAL REQUIRED ON THESE PARTS. "
    "The input sketch may show stitching dashes along pockets, hem, neckline, yoke line, "
    "waistband, cuffs, collar, zipper, placket, or fly. YOU MUST ACTIVELY REMOVE THOSE DASHES "
    "from your output — do NOT reproduce them just because they appear in the input. There is no "
    "exception for any of these parts. "
    "Reconstruction means cleaning up the drawing: replacing dashed edges on these parts with "
    "clean solid outlines. This is a deliberate improvement, not an error. "
    "Parts that must have SOLID OUTLINES ONLY — never dashed, even if the input shows dashes: "
    "  pockets (all edges, flap, opening, sides, bottom) "
    "  hem — EVERY hem, with no exception: a ribbed hem band (rib knit trim), a plain "
    "turned-up/stitched hem, a sleeve hem, and ANY hem on a lower-body garment (pants, shorts, "
    "skirt). Draw the hem as a single clean solid line (and for a rib band, solid edges on both "
    "sides of the band). Never keep or add a dashed hem topstitch line, and never draw a second "
    "dashed line running parallel to the hem. "
    "  neckline — the neck opening edge, neckline seam, neckband/binding edges, and any facing "
    "line at the neck, on both front and back views. "
    "  yoke line — the front yoke seam and the back yoke seam, across their full width. "
    "  waistband (top edge, bottom edge, side edges) "
    "  cuffs (all edges) "
    "  collar (inside and outside edges, collar stand) "
    "  zipper tape and zipper edges "
    "  placket, fly, rib bands, tabs, welt, pocket flap, belt loops. "
    "If you see a dashed line on any of these → draw it as a solid line or omit it. Never keep it dashed. "
    "Draw all other stitching and topstitching in clean vector technical-dashed style. HALVE the "
    "stitch density relative to the input: walking along each stitch line from its start, KEEP the 1st "
    "dash, REMOVE the 2nd, KEEP the 3rd, REMOVE the 4th, and so on — every odd-numbered dash is kept, "
    "every even-numbered dash is deleted, so the finished line has about half as many dashes as the "
    "input. Do NOT lengthen or stretch the kept dashes to fill the space left by the deleted ones: "
    "each kept dash stays exactly as short as before, so the gap between two consecutive dashes ends "
    "up roughly THREE TIMES the dash's own length. The result reads as sparse, widely-spaced stitch "
    "marks with lots of white between them. Dash length is uniform and the gap is uniform along "
    "the entire seam; no two dashes ever touch, merge, blur, or run together into a solid or "
    "near-solid line, and no dash is longer, shorter, or closer to its neighbor than the rest. The "
    "dash run follows the seam's own direction and curvature exactly, staying parallel to the seam it "
    "belongs to. Dashes are high-contrast pure black on white and must stay individually countable "
    "when the drawing is scaled down. Adapt spacing to the run: on short seams and tight curves, "
    "scale the dash and gap down proportionally so the stitch line still reads as a dash sequence "
    "with the same open, uncrowded rhythm — never crammed, never merged. This halving rule applies to "
    "STITCH lines only — zipper teeth and rib knit lines keep their own full density and are never "
    "thinned out. "

    "MACHINE READABILITY — this drawing is consumed by computer vision for garment-part segmentation, "
    "so every component must be independently identifiable. Each garment part is enclosed by its OWN "
    "complete, continuous, closed outline that a fill/flood algorithm could not leak out of: no gap, "
    "break, or missing corner anywhere along a part's own boundary. Where two DIFFERENT lines merely "
    "run near or touch each other (a stitch line beside a seam, two adjacent construction lines, a "
    "detail line meeting a panel edge), hold a small visible white gap between them instead of letting "
    "them collide, overlap, or fuse into one mark — but never break a part's own closed boundary to do "
    "it. STITCH-TO-SEAM OFFSET: a topstitch dash line running alongside a solid seam/panel/pocket "
    "edge must sit a clear fixed distance away from it — roughly 2 to 3 times the stroke width — for "
    "its ENTIRE length, never touching, never coincident, never drifting onto the solid line at any "
    "point along the run. A dash line sitting on top of, right against, or merging with the solid "
    "line it parallels — so the two read as one thick or fuzzy compound line — is exactly the defect "
    "to avoid; redraw it as two clearly separate, evenly-spaced parallel lines instead. Keep the "
    "spacing between adjacent parallel seams consistent along their whole run. Minimize "
    "line crossings: where lines must cross, they cross cleanly at a single point, never smearing into "
    "a blob or a thickened junction. Every panel boundary must be immediately recognizable as a "
    "boundary. "

    "SVG OPTIMIZATION: draw as if the result will be auto-traced to SVG — continuous unbroken paths, "
    "smooth Bezier-quality curves with no polygonal faceting or stair-stepping, closed panel "
    "boundaries, minimal line intersections, uniform stroke width within each weight class, and clean "
    "geometric construction. Each garment part must be convertible into its own SVG layer with "
    "minimal post-processing. "

    "HARDWARE AND CLOSURES: reconstruct EVERY zipper in full — visible zipper tape as two parallel "
    "rails, individual separately drawn teeth crossing both rails, the slider, the puller, and the top "
    "and bottom stops. Every single zipper tooth stays individually visible and separated from its "
    "neighbors — dense, but never fused into a solid bar or a gray smear. A zipper drawn as a plain "
    "line, a dashed line, or a smudge of merged teeth is "
    "not acceptable. Buttons, buttonholes, snaps, eyelets, bartacks, and reinforcement stitches must "
    "each be crisp and easily distinguishable from one another and from the seams around them — never "
    "a blurred dot or a solid black blob. "

    "RIB KNIT: any rib knit section (collar band, cuffs, hem band, waistband) is drawn as evenly "
    "spaced vertical ribs of consistent thickness and consistent spacing, running the full height of "
    "the band and staying parallel throughout. "

    "SYMMETRY: whenever the garment is symmetrical, the left and right halves must mirror each other "
    "exactly — matching panel widths, seam positions, pocket placement, stitch runs, and hardware "
    "positions. Asymmetry is only permitted where the input garment is genuinely asymmetric (e.g. an "
    "offset moto zip or a wrap front). "

    "ENHANCEMENT — REDRAW WHAT IS THERE, DO NOT COMPLETE WHAT IS NOT. Sharpen the outlines, smooth "
    "the curves, close broken lines, and make faint stitching, panel edges, zipper teeth, buttons and "
    "pocket edges crisp. Every one of those marks must already be visible in the input, however faint: "
    "you are cleaning up existing lines, not filling in what a designer 'would' have put there. Do not "
    "complete a feature the input only hints at, do not add the detail a garment of this kind usually "
    "carries, and do not make a sparse area busier. A cleanly drawn garment that is missing nothing "
    "and has gained nothing is the correct result. "

    "FINAL CHECK before you output: compare your drawing against the input side by side and count the "
    "pockets, buttons, zippers, panels, tabs and labels on each view. If any count is higher than the "
    "input's, delete what you added. If any is lower, put it back. Only then output the image. "

    "OUTPUT STYLE: production-ready technical flat, CAD/Illustrator quality, vector-like, high "
    "resolution, crisp clean black lines on a uniform pure white background. White background only. "
    "Engineering-style drafting, not illustration. No shading, no gradients, no fabric texture, no "
    "sketch effects or artifacts, no leftover pencil or scan noise, no blur, no pixelation, no broken "
    "outlines, no artistic interpretation, no redesign or style changes. "

    "DO NOT PRODUCE: photorealistic imagery, a fashion model, body, mannequin, skin or hands, fabric "
    "texture, color fill, painting, watercolor, anime, cartoon, 3D render, shadows, gradients, "
    "background objects, invented brand logos or text not present in the input, watermarks, blur, "
    "low resolution, pixelation, broken lines, "
    "uneven stitching, missing seams, missing zipper teeth, incorrect garment proportions, design "
    "modifications, extra pockets, extra buttons, or extra panels. "

    "The final image must be indistinguishable from a professionally drafted apparel technical flat "
    "used in commercial tech packs, and ready for SVG vectorization, garment layer extraction, "
    "pattern-piece segmentation, AI garment understanding, and manufacturing documentation."
)


def build_payload(image_url: str, seed: int, model: str, extra_note: str = "") -> dict:
    prompt = REGEN_PROMPT if not extra_note else REGEN_PROMPT + "\n\n" + extra_note
    return {
        "prompt": prompt,
        "model": model,
        "seed": seed,
        "inputs": [{"type": "image", "url": image_url, "role": "subject"}],
        "metadata": {"source": "sketch-regen", "seed": seed},
    }


def _generate_once(image_url: str, seed: int, model: str, extra_note: str = "") -> bytes:
    payload = build_payload(image_url, seed, model, extra_note)

    r = requests.post(
        BASE_URL,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json=payload,
        timeout=300,
        stream=True,
    )
    r.raise_for_status()

    out = None
    last_event = None
    for event in iter_sse_events(r):
        last_event = event
        if event.get("event") == "error":
            msg = event.get("data", {}).get("error", event.get("data", {}))
            sys.exit(f"router error: {msg}")
        found = extract_outputs(event.get("data", event))
        if found:
            out = found

    if not out:
        sys.exit(f"no image in stream; last event: {last_event}")

    return download_output(out[0])


def regenerate(input_path: str, output_path: str, seed: int | None, model: str):
    if not API_KEY:
        sys.exit("LLM_ROUTER_API_KEY missing in .env")

    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    print(f"model: {model}")

    image_url = upload_image(input_path)

    extra_note = ""
    for attempt in range(1, OVERLAP_VERIFY_ATTEMPTS + 1):
        attempt_seed = seed if attempt == 1 else random.randint(0, 2**31 - 1)
        print(f"attempt {attempt}/{OVERLAP_VERIFY_ATTEMPTS}, seed: {attempt_seed}")
        img_bytes = _generate_once(image_url, attempt_seed, model, extra_note)

        Path(output_path).write_bytes(img_bytes)
        overlap = check_overlap_defect(output_path)
        dashes = check_stitch_dash_defect(output_path)
        phantom = check_phantom_hem_defect(output_path)
        if not any(c.get("defect_found") for c in (overlap, dashes, phantom)):
            print(f"saved → {output_path} (no dash/solid overlap, no stitch "
                  "dashes on pocket/hem/neckline/yoke, no phantom hem)")
            return

        notes = []
        if overlap.get("defect_found"):
            locations = overlap.get("locations") or []
            print(f"attempt {attempt}: dash/solid overlap detected: {locations}")
            notes.append(
                "the last generation fused a dashed stitch line onto an "
                "adjacent solid line at: " + "; ".join(locations)
                + ". Redraw with a clear visible gap between every dash run "
                "and the solid line beside it, specifically at those locations."
            )
        if dashes.get("defect_found"):
            locations = dashes.get("locations") or []
            print(f"attempt {attempt}: stitch dashes on solid-only parts: {locations}")
            notes.append(
                "the last generation drew a topstitch line beside parts that "
                "must be a single line, at: " + "; ".join(locations)
                + ". DELETE that extra line entirely — pockets, hem, neckline "
                "and yoke line each keep ONE solid edge and nothing beside it. "
                "Do not replace a deleted dashed line with a second solid one, "
                "and do not draw a doubled or double-struck outline."
            )
        if phantom.get("defect_found"):
            print(f"attempt {attempt}: phantom hem at body bottom edge")
            notes.append(
                "the last generation drew the body's bottom edge as TWO "
                "parallel lines with a blank strip between them. This garment "
                "has no rib hem band, so that strip is a stray topstitch line "
                "and it gets mistaken downstream for a hem piece. Draw the "
                "torso's bottom edge as ONE single line. Only draw a two-line "
                "band there if it genuinely carries vertical rib ticks like "
                "the cuffs do."
            )
        extra_note = "CORRECTION FROM PREVIOUS ATTEMPT: " + " ALSO, ".join(notes)

    print(f"saved → {output_path} (defect still present after "
          f"{OVERLAP_VERIFY_ATTEMPTS} attempts, keeping last generation)")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("output", nargs="?", default="flat_sketch_regen.png")
    p.add_argument("--seed", type=int, default=None, help="fixed seed for reproducibility")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help="router image-edit alias (default: nano-banana)")
    a = p.parse_args()
    regenerate(a.input, a.output, a.seed, a.model)
