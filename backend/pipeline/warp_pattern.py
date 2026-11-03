#!/usr/bin/env python3
"""
warp_pattern.py — garment photo → flat technical sketch (front + back view)
usage: python warp_pattern.py input.jpg [output.png] [--seed 42]
"""

import argparse
import base64
import io
import json
import mimetypes
import os
import random
import sys
import time
from pathlib import Path

import anthropic
import requests
from dotenv import load_dotenv
from PIL import Image

load_dotenv()

API_KEY = os.getenv("LLM_ROUTER_API_KEY")
BASE_URL = os.getenv("LLM_ROUTER_BASE_URL", "https://api.your-router.com/v1/images/edit")
UPSCALE_URL = os.getenv("LLM_ROUTER_UPSCALE_URL", "https://router-api.pltt.ai/image/upscale")

# Two inks, two jobs, and no stitching. The flat used to be pure black only
# with every print and fabric texture deleted, so a striped or embroidered
# garment came back as a blank shell. Part outlines and construction stay
# black; surface design (including quilting) is kept in a flat light grey that
# never touches the black, and seg_parts.strip_grey_design() removes it before
# segmentation, so the parts SVG and every vision step see black line art only.
# Stitch / topstitch dashes are not drawn at all. regen_sketch.py and the
# design variants reuse this same rule.
TWO_TONE_RULE = (
    "TWO INK COLORS — BLACK FOR PARTS, GREY FOR SURFACE DESIGN. Every mark in the drawing belongs "
    "to exactly one of two layers. "
    "BLACK LAYER (pure black #000000): the outer silhouette, the outline of EVERY garment part "
    "(body panels, collar, yoke, sleeves, cuffs, waistband, plackets, pockets, flaps, tabs, belt "
    "loops, hood, badges/patches as shapes), every construction seam, dart, pleat, fold and gather "
    "line, zips, buttons, snaps and other hardware, and rib-knit ticks. "
    "NO STITCHING AT ALL: do not draw any stitch line, topstitch line, dashed line, edge-stitch, "
    "bartack or stitch mark anywhere on the garment — not along seams, pockets, hems, plackets, "
    "flies, waistbands, cuffs, collars or zips — even where the photo or input clearly shows "
    "stitching. Every edge and seam is ONE solid line with nothing running beside it. "
    "ONE exception: a dashed line that runs ACROSS a panel or sleeve from one edge to the other "
    "(a puffer baffle / quilting channel line, a quilting grid) is not edge stitching -- it marks "
    "the quilting. Redraw it as ONE thin SOLID GREY line in the grey layer below, at the same "
    "position: never delete it, never draw it black. "
    "Removing stitching NEVER changes what a part is. A button or snap PLACKET -- two parallel "
    "lines down the center front with buttons/snaps between them and topstitch dashes along its "
    "edges -- stays a plain placket strip with exactly those buttons/snaps once the dashes are "
    "gone. Never fill a placket strip with zipper teeth, never add a zip pull, never turn it into "
    "a zip. "
    "BUTTONS, SNAPS AND HARDWARE ARE COPIED, NOT REDESIGNED: same count, same positions, same "
    "shape as the input -- a ring with a hole stays a ring with a hole, a snap with a small tab "
    "keeps its tab, drawn as hollow black outlines (never solid black dots). "
    "GREY LAYER (one flat light-medium grey, about #A6A6A6, the same grey everywhere): the surface "
    "DESIGN that sits on the fabric rather than being cut and sewn — prints, graphics, logos, "
    "lettering, embroidery, appliqué motifs, stripes, plaid/check, florals, camo, jacquard or knit "
    "motifs (cable, argyle, fair-isle), and visible fabric texture such as corduroy wales, twill, "
    "denim, or a boucle/terry surface — plus quilting / baffle / channel lines across a padded "
    "panel (drawn as SOLID grey lines, never dashed) and the interior artwork inside a badge or "
    "patch. Draw the "
    "grey layer as thin clean line art that copies the photo's design faithfully: same motif, same "
    "position, same scale, same direction, same repeat spacing, clipped neatly to the part it sits "
    "on and kept INSIDE that part's black outline. Stripes are grey lines, plaid is a grey line "
    "grid, a print is its grey outline drawing, a texture is a light, evenly spaced grey line "
    "pattern suggesting it. Ignore the photo's COLORS (no color, no tint, no hue), but never drop "
    "its DESIGN: a printed, striped, embroidered or textured garment must not come back as a blank "
    "white shell. "
    "Keep the two layers cleanly apart: grey never replaces a black construction line, never "
    "touches or runs over a black outline or seam (stop each grey line a small white gap short of "
    "any black line it would meet — "
    "never touching), and is never used for a part boundary. Grey is LINES only — no grey fill, no grey "
    "shading, no gradients, no shadows, no solid grey blocks. A plain fabric with no print, "
    "pattern or visible texture gets NO grey at all; do not invent a design the photo does not "
    "show. "
)

FLAT_SKETCH_PROMPT = (
    "Redraw THIS EXACT garment as a fashion flat technical sketch. "

    # Stated first: as a clause further down it lost every time to "match the
    # photo feature for feature", and stage 1 kept emitting a dashed outline
    # offset just outside each welt pocket for regen to inherit.
    "RULE ZERO — NO TOPSTITCH LINE OF ANY KIND ON POCKETS, HEM, NECKLINE OR YOKE LINE. Each of these "
    "four parts is drawn with EXACTLY ONE single solid line and NOTHING beside it. Do not draw, in "
    "either of its two forms: (a) a DASHED line tracing the part a short distance from its edge; "
    "(b) a SECOND SOLID line — a thin outline hugging the main edge, a doubled or double-struck "
    "outline, a narrow parallel band, an offset contour — alongside the part's real edge. Both are "
    "topstitch representations and both are FORBIDDEN here. A pocket edge is ONE line, not two lines "
    "close together. A hem is ONE line. A neckline is ONE line. A yoke seam is ONE line. Draw it that "
    "way even when the photo clearly shows topstitching there. This overrides the feature-for-feature "
    "matching rule below. And it is not limited to these four parts: NO stitching or topstitch "
    "line is drawn ANYWHERE on the garment (see the NO STITCHING rule); quilting/baffle lines are "
    "drawn as solid grey surface lines, not stitches. "
    "THE BOTTOM EDGE, SPECIFICALLY. Unless the garment truly has a rib-knit band there — a real band "
    "carrying visible vertical rib ticks, like the cuffs do — the body simply ENDS at its bottom "
    "edge, drawn as ONE line. Do NOT draw a second line running parallel a short distance above that "
    "edge. A narrow featureless strip along the bottom, formed by the bottom edge plus a line just "
    "above it, is the exact defect to avoid: downstream it is read as a hem band this garment does "
    "not have, and a phantom hem piece gets cut from it. An elasticated, drawcord or plain bottom "
    "edge is ONE line and nothing more. "

    "Do NOT change the design: keep the exact same silhouette, neckline, collar, "
    "sleeve length, pockets, buttons, zips, and proportions as the input image. "
    "MATCH THE PHOTO FEATURE FOR FEATURE. Draw every feature the photo shows and NOT ONE MORE. Count "
    "the pockets, buttons, zips, belt loops, tabs and panels in the photo and reproduce exactly those, "
    "at their real positions. Do not add the hardware or detail a garment of this kind usually carries, "
    "do not resolve a feature you cannot see clearly by inventing a definite one, and do not upgrade a "
    "plain detail into a fancier one (no flap added to a plain pocket, no button added to a plain tab). "
    "An area of the garment the photo shows as empty stays empty. "
    "IGNORE the color of the input — render the fabric as white. Its print, plaid, stripes, "
    "graphics, embroidery and fabric texture are NOT ignored: they are drawn as the grey surface "
    "layer described in the TWO INK COLORS rule, never as black lines and never as fill. "
    "Show TWO views side by side: FRONT view on the left, BACK view on the right "
    "(back view inferred from the same garment). "
    "Only pure black construction lines (plus the grey surface-design lines) on a pure white "
    "background, flat 2D, no body, no mannequin, no shadows, no shading, no fill of any kind. "
    "The outer silhouette outline must be solid, fully opaque pure black (#000000), drawn as thin a "
    "hairline as it can be while staying fully opaque and unbroken, and hold ONE "
    "constant width along its ENTIRE length, all the way around the garment — never tapering from "
    "thick to thin, never fading to gray or low-contrast partway through, never breaking into a "
    "thinner or fainter line at corners, curves, or seam junctions, and never drawn as a bold/heavy "
    "marker-thick line either — a heavy outline is as much a defect as an inconsistent one. "
    "Every segment of the outline, "
    "front and back, must look like it was drawn with the same pen in a single continuous pass — "
    "that outline is what gets cut/traced, so any variation in its width or darkness along the way "
    "is a defect, not a style choice. "
    "This applies all the way to BOTH ENDPOINTS of every single line and seam, not just its middle: "
    "a line must stay full-width, solid pure black right up to its exact start and end point — never "
    "taper to a point, never fade out, thin down, or lighten toward gray as it approaches its tip. "
    "A line that trails off or loses ink at the end (common at shoulder seams, yoke seams, dart tips, "
    "and other line endpoints) is a defect — cut it off with a blunt, full-strength end instead. "
    "EVERY construction line in the image — including pleat/fold lines, gather lines, dart lines, and "
    "any other secondary or interior construction lines — must be drawn in the exact same pure black "
    "ink as the main outline. "
    "NEVER render pleat/fold/gather lines (or any other 'secondary' line) in gray or any lighter tone "
    "to suggest depth or softness — construction has only ONE ink color: pure black. If a line "
    "is thinner or lighter-weight than another, that must come from stroke width alone, never from a "
    "gray/lighter color value. "
    "If the input photo shows the garment being worn by a person, or any person, skin, face, "
    "hands, hair, or body parts elsewhere in the frame, COMPLETELY REMOVE them — extract and "
    "flatten only the garment itself, as if it were laid flat with nothing inside or around it. "
    "The output must contain the garment ONLY: no humans, no mannequins, no body silhouette. "
    "Include all construction details visible in the input (but never stitching): seams, darts, "
    "collar, cuffs, plackets, pockets, closures, hems. "
    "FUR/SHEARLING/FAUX-FUR TRIM: if the input shows a fur, shearling, or faux-fur collar, cuff, or "
    "hood trim, draw its edge as a gentle, open, evenly-spaced scalloped or wavy border — like a "
    "cloud outline — in the SAME hairline stroke weight as every other line in the drawing. Do NOT "
    "draw fur as a dense jagged zigzag, a spiky scribble, or repeated sharp spikes packed tight enough "
    "that they visually merge into a heavier or darker-looking band than the rest of the outline; that "
    "reads as a thick black smear, not a construction detail. A few evenly spaced individual tufts or "
    "waves suggesting texture is enough — never cover the whole trim edge in dense spiking. "
    "Detect and draw EVERY garment part as its own clearly separated, closed outline — body panels, "
    "collar, yoke, sleeves, cuffs, plackets, pockets, zips/closures — each one a distinct enclosed "
    "shape with a visible boundary line, so parts can be told apart individually, not merged into one "
    "undifferentiated blob. The collar and the shoulder/yoke are SEPARATE parts — draw the seam line "
    "between the collar and the shoulder/yoke explicitly, all the way across; never let the collar "
    "outline blend directly into the shoulder line with no seam between them. "
    "The same separation applies at the BOTTOM of the garment: the hem is its own line, distinct from "
    "whatever closure runs down the center front. Where a zip strip, button placket, or snap placket "
    "reaches the bottom of the garment, its vertical rail lines must stop AT the hem line, not run "
    "through it, merge into it, or blend into one continuous stroke with it — the hem's curve and the "
    "placket/zip's bottom edge are two separate lines that meet at a corner, each still individually "
    "visible, never a single fused shape. "
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
    "skirts — is drawn as a fly seam with its curved solid fly-front line and whatever waistband button or "
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
    "and DENSE, like a ladder/herringbone coil zipper: short perpendicular ticks packed close together, "
    "each one separated from its neighbor by a small but clearly visible gap of white background — "
    "'packed close together' means a short repeating rhythm of tooth-gap-tooth-gap down the strip, it "
    "does NOT mean the ticks touch or merge into each other. If the ticks are drawn so close that the "
    "gaps between them disappear, the whole strip reads as one solid black bar with no teeth visible at "
    "all, which is the single worst version of this mistake — every tooth must stay individually "
    "countable, with white clearly showing between each one and the next, all the way down the strip. "
    "Every tick the exact same length and spacing as "
    "its neighbors, covering that zip's own real length with no interruption — this is a rule about tooth "
    "spacing WITHIN the zip's true length, not a reason to make the zip itself any longer. Sparse, "
    "widely-spaced, or irregular ticks are NOT an acceptable zip texture, but neither is a fused solid bar. "
    "Add the pull/slider shape at "
    "the top of the "
    "strip. A single plain or dashed line with no tick marks, or teeth on only one side, is NOT an "
    "acceptable zip, it reads as ordinary topstitching and must not be used for a zip. EVERY line in the "
    "drawing — outer silhouette, seams, darts, "
    "AND every closure/hardware piece (zipper rails, zipper pull/slider, snaps, buttons, "
    "hooks) — must be drawn as a single hairline-thin stroke of the SAME light weight, all the way "
    "through. NEVER render any of them as a solid/thick black fill, a bold heavy stroke, or a dense "
    "filled-in shape, no matter how small the part is — a zipper pull is a small thin-outlined shape "
    "with a hollow (white) center, not a solid black blob. If in doubt, draw EVERY line lighter and "
    "thinner rather than darker/thicker — err toward too little ink, never too much. "
    "ONE explicit exception to all of the above: the zipper TEETH themselves (the small tick marks "
    "crossing the rails, not the rails and not the pull/slider) must be drawn as small SOLID filled "
    "black shapes, not hollow hairline outlines — each tooth is a tiny solid black mark, packed tight "
    "and dense as already described, but still a row of SEPARATE marks with visible white gaps between "
    "them, never one continuous filled rectangle. This solid-fill rule applies ONLY to each individual "
    "tooth; the rails on either side of them and the pull/slider stay hairline-thin outlines as normal, "
    "and the strip as a whole must never become a single solid black block. "
    "Technical tech-pack drawing style, uniform hairline-thin line weight throughout the ENTIRE image, "
    "no bold, no thick, no filled lines or shapes anywhere. "
    "If the input photo has a contrast-colored trim, panel, or material — a different-colored leather "
    "waistband/belt, a contrast collar underside, contrast pocket welts or flap binding, a two-tone yoke "
    "— NEVER represent that color/material contrast by filling the region solid black. Draw ONLY its "
    "outline as the same hairline stroke as everything else and leave its interior blank white, exactly "
    "like every other panel on the garment. Color and material differences are not drawn at all in this "
    "flat sketch; only construction lines are. A solid black waistband, collar facing, belt loop, or "
    "pull tab copied from a dark-colored photo is exactly the defect to avoid. "
    "NO STITCH DASHES, ESPECIALLY ON THESE PARTS. Pockets, hem, neckline and yoke line are drawn with SOLID "
    "outlines only — never with dashed topstitch marks, and never with a dashed line running "
    "parallel to them, even if the input photo clearly shows topstitching there. Specifically: "
    "  pockets — all edges, flap, opening, sides, bottom; "
    "  hem — EVERY hem, with no exception: body hem, sleeve hem, a rib knit hem band (solid edges "
    "on both sides of the band), a plain turned-up hem, and any hem on a lower-body garment "
    "(pants, shorts, skirt); "
    "  neckline — the neck opening edge, neckline seam, neckband/binding edges, and any neck "
    "facing line, on both front and back views; "
    "  yoke line — the front yoke seam and the back yoke seam, across their full width. "
    "Draw each of these as a single clean solid line. The same no-stitch rule applies everywhere "
    "else on the garment too (princess seam, fly, side seams, sleeves) — no topstitch dashes "
    "anywhere. "
    "To be unambiguous: outline, seams, darts, pleat/fold/gather lines, buttons, "
    "snaps, zip rails and pull, badges, patches, and labels — every single mark anywhere in this "
    "drawing, front and back, with no exception besides the zip teeth rule above — is drawn in the "
    "same pure black hairline ink. The ONLY grey in the image is the surface-design layer (print, "
    "pattern, texture, graphic, badge artwork); nothing structural is grey, faded or dim, and "
    "nothing is any color. "
    + TWO_TONE_RULE +
    "The sketch must be recognizable as the same garment shape AND the same surface design as the "
    "input photo, drawn on white fabric."
)


# fal's Nano Banana edit picks its own frame on "auto" and can return a wide
# image for a 4:3 flat, cropping the legs off; pin the input's shape instead.
FAL_ASPECTS = ("21:9", "16:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16")


def keep_aspect_options(path: str) -> dict:
    """provider_options that keep an edit's output at the input image's aspect ratio."""
    import math

    with Image.open(path) as im:
        ratio = im.width / im.height

    def dist(a: str) -> float:
        w, h = a.split(":")
        return abs(math.log(ratio * int(h) / int(w)))

    return {"fal": {"aspect_ratio": min(FAL_ASPECTS, key=dist)}}


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
    "IMAGE ORDER IS MEANING, NOT JUST INPUT ORDER: IMAGE 1 is the main photo. Every image "
    "after it (IMAGE 2, IMAGE 3, ...) is a PARTS CATALOG for this design — a donor garment "
    "whose individual construction pieces get grafted onto IMAGE 1. "
    "THE DONOR IS ALMOST ALWAYS A DIFFERENT GARMENT TYPE, AND THAT IS EXPECTED, NOT A "
    "MISTAKE TO GUARD AGAINST: a reference is attached specifically because it shows some "
    "construction detail — a closure, a pocket, a collar, a quilting/panel pattern — that "
    "the user wants pulled onto IMAGE 1's garment, even though the reference as a whole is a "
    "completely different silhouette (e.g. IMAGE 1 is a tunic and IMAGE 2 is a puffer jacket). "
    "Do not reject or discount a reference for looking like a different kind of garment — "
    "that mismatch is the normal case, not a signal to ignore it. "
    "IMAGE 1 is the ONLY authority on garment TYPE, overall silhouette, proportions, pose, "
    "and layout — the output must still read as the SAME kind of garment as IMAGE 1 (a tunic "
    "stays a tunic-length top, it does not grow a puffer's bulk or length), so never copy the "
    "donor's overall shape, garment category, or length. Within that fixed silhouette, though, "
    "graft its CONSTRUCTION PIECES freely. "
    "The parts eligible to graft — collar and collar stand, sleeves and sleeve construction, "
    "cuffs, pockets, plackets and closures (including their hardware: zips, snaps, buttons, "
    "studs), lining, facings, inner panels, yokes and seam placement, and surface construction "
    "like quilting/panel-stitch patterns — get drawn the way a reference shows them whenever "
    "one shows that part clearly, replacing IMAGE 1's version of it. Where no reference shows a "
    "given part, follow IMAGE 1 as usual. Internal parts visible only in the references (lining "
    "panels, facings, inner seams) should be drawn as construction detail on the corresponding "
    "outer part. "
    "CRITICAL — REPLACE, NEVER ADD: when a reference's version of a part differs from IMAGE "
    "1's, the reference version REPLACES it. Draw one version only. Never draw both and never "
    "overlay them. If IMAGE 1 shows a zip at center front and a reference shows a button or "
    "snap placket there (or the reverse), the garment ends up with exactly ONE of those "
    "closures — the reference's — and the other is omitted entirely, not drawn alongside it. "
    "Two closures stacked down the same center front is a defect. Same for every other part: "
    "one collar, one cuff treatment, one pocket per position. "
    "MANDATORY SELF-CHECK BEFORE YOU DRAW: reference images were attached to this job for a "
    "reason — go through the eligible part list one item at a time (collar/collar stand, "
    "sleeve/cuff construction, pockets, plackets/closures, lining, facings, inner panels, "
    "yoke/seam placement, quilting/panel-stitch pattern) and for EACH one ask 'does IMAGE 2 or "
    "later show this part clearly, at a different construction than IMAGE 1?'. If yes, you MUST "
    "draw that reference's version — defaulting back to IMAGE 1 out of caution when a reference "
    "clearly shows otherwise is just as much a mistake as inventing a detail, because it means "
    "the reference images were uploaded and then silently ignored. The donor being a different "
    "garment type is never a valid reason to skip this check. Only fall back to IMAGE 1 for a "
    "part when NO reference shows that specific part clearly enough to draw from."
)


def _check_reference_compliance(output_bytes: bytes, reference_paths: list[str]) -> str | None:
    """Ask a vision model whether the drawn flat actually grafted the references'
    construction parts, per REFERENCE_DETAIL_RULE's eligible-part list. Returns
    None when compliant (or when there is nothing to check), or corrective
    feedback naming the specific parts that were skipped, for one retry.

    An image-edit model is far less reliable at following a multi-part grafting
    instruction than a text model is at reading one: the same prompt, same
    reference pair, and a fresh seed drew the reference's collar/pockets/quilting
    faithfully on one run and a plain unmodified flat on the next -- nothing in
    the request changed, only the model's compliance did. A text-model
    compliance check catches that miss before it reaches the user instead of
    silently shipping a flat the references never touched.
    """
    if not reference_paths:
        return None

    def _png_b64(data: bytes) -> str:
        # Re-encode rather than trust the file's extension or a guessed mime
        # type: a reference saved with a ".png" name but JPEG bytes inside
        # (seen in practice — an upstream upload path didn't re-encode on
        # save) makes Anthropic's vision API reject the whole request with a
        # media-type mismatch, which silently read as "compliant" once that
        # error was swallowed below. Decoding and re-saving as real PNG here
        # makes the declared media_type true regardless of what is on disk.
        buf = io.BytesIO()
        img = Image.open(io.BytesIO(data))
        (img.convert("RGB") if img.mode == "CMYK" else img).save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()

    client = anthropic.Anthropic()
    content = [
        {"type": "text", "text": "OUTPUT (the newly drawn flat sketch):"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
         "data": _png_b64(output_bytes)}},
    ]
    for i, p in enumerate(reference_paths, 1):
        content.append({"type": "text", "text": f"REFERENCE {i}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/png",
                        "data": _png_b64(Path(p).read_bytes())}})
    content.append({"type": "text", "text": (
        "OUTPUT was supposed to graft specific construction parts from each REFERENCE onto "
        "its own garment wherever a reference shows that part clearly and differently from "
        "how OUTPUT drew it: collar/collar stand, sleeve/cuff construction, pockets, "
        "plackets/closures (zips, snaps, buttons), lining/facings/inner panels, yokes/seam "
        "placement, quilting/panel-stitch pattern. The reference being a totally different "
        "garment type from OUTPUT is expected and is never a reason a part should have been "
        "skipped. "
        "Go through that list. For each part a reference shows clearly, does OUTPUT actually "
        "draw that reference's version of it (not the generic version OUTPUT would draw with "
        "no reference at all)? "
        "Reply with ONLY a JSON object, no markdown fence: "
        '{"ok": true} if every clearly-shown part was grafted, or '
        '{"ok": false, "missing": ["<part>: <what the reference shows that OUTPUT is missing>", ...]} '
        "listing each part that was skipped."
    )})
    try:
        msg = client.messages.create(model="claude-sonnet-4-6", max_tokens=1024,
                                     messages=[{"role": "user", "content": content}])
    except anthropic.APIError as e:
        print(f"reference compliance check: judge call failed ({e}) -- skipping check")
        return None  # judge unavailable -- don't block the pipeline on it
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        print(f"reference compliance check: judge reply wasn't JSON ({text[:120]!r}) -- skipping check")
        return None  # can't parse the judge's answer -- don't block on it
    missing = result.get("missing") or []
    if result.get("ok", True) or not missing:
        return None
    return ("REVISION REQUIRED: the previous attempt at this same request skipped these "
            "reference parts -- draw them this time: " + "; ".join(missing))


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


class RouterBusy(Exception):
    """The router said try again later (a provider rate limit, an overload)."""


# waits between tries of a busy image edit: about 3.5 minutes in all
ROUTER_BACKOFF_S = (15, 30, 60, 90)


def router_failed(msg, prefix: str = "router error: "):
    """An error event from the router: RouterBusy when it is retryable, else exit."""
    if isinstance(msg, dict) and msg.get("retryable", msg.get("status") in (429, 502, 503)):
        raise RouterBusy(msg)
    sys.exit(f"{prefix}{msg}")


def with_router_retry(fn, *args, **kwargs):
    """fn(*args, **kwargs), tried again after a pause while the router is busy
    (retryable error events and HTTP 429/502/503)."""
    for n, wait in enumerate((*ROUTER_BACKOFF_S, None)):
        try:
            return fn(*args, **kwargs)
        except RouterBusy as e:
            err = e.args[0]
        except requests.HTTPError as e:
            if e.response is None or e.response.status_code not in (429, 502, 503):
                raise
            err = f"HTTP {e.response.status_code}"
        if wait is None:
            sys.exit(f"router still busy after {n + 1} tries: {err}")
        print(f"router busy ({err}) -> waiting {wait}s, then retry {n + 2}/{len(ROUTER_BACKOFF_S) + 1}", flush=True)
        time.sleep(wait)


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
    return with_router_retry(_generate_once, image_url, seed, extra_prompt, reference_urls)


def _generate_once(image_url: str, seed: int, extra_prompt: str = "",
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
            router_failed(event.get("data", {}).get("error", event.get("data", {})))
        found = extract_outputs(event.get("data", event))
        if found:
            out = found

    if not out:
        sys.exit(f"no image in stream; last event: {last_event}")

    return download_output(out[0])


FIDELITY_RETRIES = int(os.environ.get("FIDELITY_RETRIES", "2"))


def _check_input_fidelity(input_path: str, output_bytes: bytes) -> str | None:
    """Compare the drawn flat against the INPUT and name anything invented or
    changed. Returns None when faithful (or the judge is unavailable), else a
    correction note for a retry.

    The prompt alone does not stop it: a snap-placket puffer whose placket
    topstitching the no-stitch rule removed came back with zipper teeth filling
    the placket and the snaps redrawn as solid dots -- the long zip section of
    the prompt reads as "draw a zip" to the image model. A text model reading
    both images catches that reliably."""
    def _png_b64(data: bytes) -> str:
        buf = io.BytesIO()
        img = Image.open(io.BytesIO(data))
        (img.convert("RGB") if img.mode in ("CMYK", "P", "LA") else img).save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()

    content = [
        {"type": "text", "text": "INPUT (the garment to reproduce):"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
         "data": _png_b64(Path(input_path).read_bytes())}},
        {"type": "text", "text": "OUTPUT (the technical flat drawn from it):"},
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
         "data": _png_b64(output_bytes)}},
        {"type": "text", "text": (
            "OUTPUT must reproduce INPUT's design exactly, with only these intended changes: color "
            "removed, stitch/topstitch dashes removed, prints/textures/quilting lines shown as grey "
            "lines, and a BACK view added if INPUT shows only the front. Judge only the FRONT view "
            "against INPUT (plus anything INPUT's back view shows, if it has one). "
            "Check, part by part: (1) closure TYPE -- zip vs buttons vs snaps vs placket: did "
            "OUTPUT add a zip, zipper teeth or a zip pull INPUT does not have, or change the closure "
            "type? (2) button/snap COUNT and shape on the front, the pockets, the sleeves. (3) "
            "pockets, flaps, tabs, badges: same count, type and position? (4) any panel, seam, "
            "collar or cuff added, removed or changed? (5) quilting/baffle lines that INPUT shows "
            "dropped from OUTPUT? Ignore line weight, color, dash removal and drawing style. "
            "Reply with ONLY a JSON object, no markdown fence: "
            '{"ok": true} if OUTPUT is faithful, or '
            '{"ok": false, "problems": ["<what OUTPUT got wrong, and what INPUT actually shows>", ...]}'
        )},
    ]
    try:
        msg = anthropic.Anthropic().messages.create(
            model="claude-sonnet-4-6", max_tokens=1024,
            messages=[{"role": "user", "content": content}])
    except anthropic.APIError as e:
        print(f"fidelity check: judge call failed ({e}) -- skipping check")
        return None
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        result = json.loads(text)
    except json.JSONDecodeError:
        print(f"fidelity check: judge reply wasn't JSON ({text[:120]!r}) -- skipping check")
        return None
    problems = result.get("problems") or []
    if result.get("ok", True) or not problems:
        return None
    return ("CORRECTION FROM THE PREVIOUS ATTEMPT -- it did not match the input garment: "
            + "; ".join(problems)
            + ". Redraw matching the input exactly: same closure type, same button/snap count and "
            "shape, nothing added that the input does not show.")


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

    feedback = _check_reference_compliance(img_bytes, reference_paths or [])
    if feedback:
        print(f"reference compliance check flagged a miss -> retrying once: {feedback}")
        img_bytes = _generate(image_url, seed, extra_prompt=feedback,
                              reference_urls=reference_urls)

    # References deliberately graft parts the input does not have, so the
    # "nothing added" check only runs without them.
    if not reference_urls:
        for attempt in range(1, FIDELITY_RETRIES + 1):
            note = _check_input_fidelity(input_path, img_bytes)
            if not note:
                print("fidelity check: output matches the input")
                break
            print(f"fidelity check flagged a mismatch -> retry {attempt}/{FIDELITY_RETRIES}: {note}")
            img_bytes = _generate(image_url, random.randint(0, 2**31 - 1), extra_prompt=note)

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
    p.add_argument("--upscale-only", action="store_true",
                   help="upscale an existing image file instead of generating a sketch from a photo")
    p.add_argument("--references", default="",
                   help="comma-separated local paths to construction reference images, optional")
    a = p.parse_args()
    if a.upscale_only:
        upscale_file(a.input, a.output)
    else:
        photo_to_flat(a.input, a.output, a.seed,
                      [r.strip() for r in a.references.split(",") if r.strip()])