#!/usr/bin/env python3
"""
regen_sketch.py — low-quality technical flat → clean, high-res vector-style flat.

Reconstruction only: the garment design is preserved exactly, nothing is
redesigned, simplified, or invented. Runs through the LLM router's image-edit
alias, which resolves to nano-banana by default.

usage: python regen_sketch.py input_sketch.png [output.png] [--seed 42] [--model image-edit-default]
"""

import argparse
import random
import sys
from pathlib import Path

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

REGEN_PROMPT = (
    "You are an expert Fashion Technical Illustration Reconstruction AI specialized in garment "
    "technical flats and tech pack artwork. "
    "TASK: reconstruct the uploaded low-quality garment technical sketch into a clean, "
    "high-resolution, vector-style technical flat. "

    "REFERENCE QUALITY STANDARD: the output must match professional apparel CAD artwork and be "
    "indistinguishable from a vector illustration drafted in Adobe Illustrator for a commercial "
    "production tech pack — crisp razor-sharp black line art, smooth Bezier-quality curves, perfectly "
    "closed outlines with no gaps at any corner or junction, consistent line hierarchy, clearly "
    "separated body panels, clean sleeve construction, precisely defined collars and cuffs, and "
    "high-contrast pocket outlines. "

    "HARD RULES — preserve the design exactly. Do NOT redesign, restyle, simplify, or invent "
    "features. No new panels, pockets, buttons, seams, or trims that are not in the input. Do not "
    "remove anything that is in the input. Keep the same garment category, the same silhouette, the "
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
    "side seam, chest, hidden), count and position, with pocket opening, pocket stitching, and crisply "
    "defined pocket corners. Never add a pocket the input does not have, and never upgrade a plain "
    "welt or patch pocket into a flapped or buttoned one. "
    "(7) FASTENERS — only those present: zipper (tape, teeth, slider, puller, top stop, bottom stop, "
    "zipper stitching), buttons (button, buttonhole, button stitching), snaps, hooks, eyelets, buckles. "
    "Match the button count exactly; do not add a button to a pocket, tab or placket that has none. "
    "(8) TRIMS — only those present: belt, belt loops, drawstring, elastic, tabs, labels, bows, "
    "ribbons, velcro, cordlocks. "
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

    "STITCHING: draw all stitching and topstitching in clean vector technical-dashed style. HALVE the "
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
    "it. Keep the spacing between adjacent parallel seams consistent along their whole run. Minimize "
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
    "background objects, logos, text, watermarks, blur, low resolution, pixelation, broken lines, "
    "uneven stitching, missing seams, missing zipper teeth, incorrect garment proportions, design "
    "modifications, extra pockets, extra buttons, or extra panels. "

    "The final image must be indistinguishable from a professionally drafted apparel technical flat "
    "used in commercial tech packs, and ready for SVG vectorization, garment layer extraction, "
    "pattern-piece segmentation, AI garment understanding, and manufacturing documentation."
)


def build_payload(image_url: str, seed: int, model: str) -> dict:
    return {
        "prompt": REGEN_PROMPT,
        "model": model,
        "seed": seed,
        "inputs": [{"type": "image", "url": image_url, "role": "subject"}],
        "metadata": {"source": "sketch-regen", "seed": seed},
    }


def regenerate(input_path: str, output_path: str, seed: int | None, model: str):
    if not API_KEY:
        sys.exit("LLM_ROUTER_API_KEY missing in .env")

    if seed is None:
        seed = random.randint(0, 2**31 - 1)
    print(f"seed: {seed}")
    print(f"model: {model}")

    image_url = upload_image(input_path)
    payload = build_payload(image_url, seed, model)

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

    Path(output_path).write_bytes(download_output(out[0]))
    print(f"saved → {output_path}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("output", nargs="?", default="flat_sketch_regen.png")
    p.add_argument("--seed", type=int, default=None, help="fixed seed for reproducibility")
    p.add_argument("--model", default=DEFAULT_MODEL,
                   help="router image-edit alias (default: nano-banana)")
    a = p.parse_args()
    regenerate(a.input, a.output, a.seed, a.model)
