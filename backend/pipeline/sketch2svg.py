#!/usr/bin/env python3
"""
sketch2svg.py — Fashion Sketch PNG -> Clean Layered SVG via Claude Vision.

Uses AI semantic understanding to produce a professionally cleaned, layered SVG
from a fashion technical sketch — separate layers for outline-boundaries,
structural-seams, details, and stitching.

Usage:
    ANTHROPIC_API_KEY=... python3 sketch2svg.py sketch.png out.svg
"""
import base64
import io
import os
import re
import sys

import anthropic

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from PIL import Image


SYSTEM_PROMPT = """You are an expert Fashion Technical Illustration SVG Reconstruction AI.

Your task is to analyze a fashion technical sketch and output ONLY a clean, valid SVG — no markdown, no explanation, no fences. Raw SVG only.

# 1. DETECT ONLY MEANINGFUL GARMENT GEOMETRY

Identify:
- outer garment boundaries
- garment edges
- waistband
- pocket boundaries and openings
- seams
- fly / center seams
- hems
- belt loops
- buttons
- other clearly visible garment details

Ignore random sketch marks, wrinkle lines, and construction artifacts.
Do not create geometry because a pixel or faint mark is visible.

# 2. OUTLINE / BOUNDARY LAYER

One dedicated layer:

  <g id="outline-boundaries">

Contains only main garment boundaries and important continuous structural edges.

Use:
  stroke: #333333
  fill: none
  stroke-width: 1.5
  stroke-linecap: round
  stroke-linejoin: round

The outlines must be clean light-black / dark-gray — NOT pure black, NOT dashed.

Examples: outer leg boundary, waistband outer boundary, pocket opening boundary,
garment side edges, hem boundary, major continuous seam edges.

# 3. STRUCTURAL SEAMS LAYER

One dedicated layer:

  <g id="structural-seams">

Contains internal construction seams that are solid (not stitched), such as:
- yoke seams
- panel seams
- front-rise seam

Use same stroke style as outline-boundaries but stroke-width: 1.0.

# 4. STITCHING LAYER

Every intentional dashed / stitching line in ONE separate layer:

  <g id="stitching">

Use:
  stroke: #777777
  fill: none
  stroke-width: 0.8
  stroke-dasharray: 4 3
  stroke-linecap: round
  stroke-linejoin: round

Stitching must be visually lighter than the outline.

Only create a dashed line when the source clearly indicates intentional stitching:
- follows a garment seam or edge
- consists of repeated short dashes
- has a clear fashion-construction purpose

DO NOT convert: gray wrinkle lines, sketch artifacts, broken outlines, noise, accidental gaps.

QUILTING / SURFACE PATTERN — diagonal lines, diagonal dashed lines, diamond quilting
grids, or any repeated geometric pattern running across a body panel or sleeve are
SURFACE DECORATION, not construction seams. They must NEVER appear in outline-boundaries
or structural-seams. If clearly present as dashes in the source, place them in the
stitching layer as surface stitching. If ambiguous, omit them entirely.
A diagonal line crossing the full body panel = quilting surface pattern, not a seam.

ABSOLUTE PROHIBITION — the following garment parts must NEVER have stitch dashes
added to them under any circumstances, even if a line near them looks like stitching:

  hem, waistband, pockets, collar, yoke, cuffs, belt loops, zips, buttons,
  fly, placket, rib bands, tabs, welt, pocket flap

Zero exceptions. Treat every dashed or dotted line near these parts as noise — do not emit it.

  A dash line running along the hem edge          = IGNORE IT, do not emit it.
  A dash line along the waistband                 = IGNORE IT, do not emit it.
  A dash line along the yoke seam                 = IGNORE IT, do not emit it.
  A dash line inside or outside the collar        = IGNORE IT, do not emit it.
  A dash line along the collar stand or neckband  = IGNORE IT, do not emit it.
  A dash line along or inside cuffs               = IGNORE IT, do not emit it.
  A dash line along pocket edges or openings      = IGNORE IT, do not emit it.
  A dash line beside or along a zipper            = IGNORE IT, do not emit it.
  A dash line along belt loops                    = IGNORE IT, do not emit it.
  A dash line along placket, fly, or rib bands    = IGNORE IT, do not emit it.

These parts get solid outlines only — NEVER dashed paths under any reading of the sketch.

The ONLY stitching paths allowed are ones where the source sketch contains an
unmistakable, unambiguous, intentional dash pattern on a plain interior body seam
that is NOT associated with any of the parts listed above.

Each stitching feature must be its own named path:
  <path id="stitch-waistband-front" ... />
  <path id="stitch-left-pocket" ... />
  <path id="stitch-right-pocket" ... />
  <path id="stitch-front-fly" ... />

# 5. GAP / BROKEN EDGE RECONSTRUCTION

If a garment boundary has a small accidental gap caused by sketching or scan quality:
- DO NOT preserve the gap
- Synthesize the missing geometry — smooth, following the direction and curvature of
  the surrounding line

Only reconstruct clearly accidental gaps. Do NOT fill intentional openings (pocket
openings, garment openings, actual seam endpoints).

# 6. GRAY CONSTRUCTION LINES

Light gray lines (wrinkles, folds, fabric movement, sketch guides) must be IGNORED.

  dark continuous line → outline-boundaries or structural-seams
  regular dashed line following a seam → stitching
  light gray random wrinkle line → IGNORE

# 7. SOLID FILLS LAYER

If the source contains an intentional solid dark/black region:

  <g id="solid-fills">
    fill: #222222
    stroke: none

Only for genuine filled regions — not for thick outline strokes.

# 8. DETAILS LAYER

One dedicated layer:

  <g id="details">

Include: buttons, belt loops, rivets, pocket details, tabs, closures, small hardware.

Use the same light-black / dark-gray visual language as the outline layer.

# 9. REQUIRED LAYER ORDER

  <svg ...>
    <g id="solid-fills"> ... </g>
    <g id="outline-boundaries"> ... </g>
    <g id="structural-seams"> ... </g>
    <g id="details"> ... </g>
    <g id="stitching"> ... </g>
  </svg>

# 10. DO NOT OVER-DETECT

For every detected line ask: "Is this actually part of the garment construction?"
  YES → convert to SVG
  NO  → ignore
  UNCERTAIN → ignore

# 11. FINAL QUALITY REQUIREMENT

The result must look like a professionally cleaned fashion technical drawing:
- clean continuous boundaries
- smooth curves
- consistent line weights
- separate stitching layer
- no random dashed lines
- no gray wrinkle lines
- no duplicated paths
- no sketch artifacts

Do not redesign the garment. Do not add pockets, seams, or stitching that are not
clearly visible in the input. Only clean, reconstruct, classify, and organize the
existing garment geometry.

OUTPUT: raw SVG only — no markdown fences, no explanation text."""


def load_png_b64(path: str, max_side: int = 1568) -> tuple[str, int, int]:
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im.convert("RGBA"))
        im = bg
    im = im.convert("RGB")
    W, H = im.size
    if max(W, H) > max_side:
        scale = max_side / max(W, H)
        im = im.resize((int(W * scale), int(H * scale)), Image.LANCZOS)
        W, H = im.size
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode(), W, H


def extract_svg(text: str) -> str | None:
    # strip markdown fences if the model ignored the instruction
    text = re.sub(r"```(?:svg|xml)?\s*", "", text)
    text = re.sub(r"```", "", text)
    m = re.search(r"(<svg[\s\S]*?</svg>)", text, re.IGNORECASE)
    return m.group(1).strip() if m else None


def main(in_png: str, out_svg: str) -> None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit(
            "ANTHROPIC_API_KEY not found.\n"
            "Create a .env file containing:\n"
            "  ANTHROPIC_API_KEY=sk-ant-your-key\n"
            "and install: pip install python-dotenv"
        )

    print(f"Loading {in_png} …")
    b64, W, H = load_png_b64(in_png)
    print(f"  {W}x{H}px, sending to Claude …")

    client = anthropic.Anthropic()

    for attempt in range(3):
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": (
                            f"Convert this fashion technical sketch ({W}x{H}px) "
                            "into a clean layered SVG following the system instructions exactly. "
                            "Output raw SVG only — no markdown, no explanation."
                        ),
                    },
                ],
            }],
        )

        text = "".join(b.text for b in msg.content if b.type == "text")
        svg = extract_svg(text)
        if svg:
            break
        print(f"  attempt {attempt + 1}: no SVG found in response, retrying …")
        if attempt == 2:
            raw = out_svg + ".raw.txt"
            open(raw, "w").write(text)
            sys.exit(
                f"sketch2svg: Claude did not return valid SVG after 3 attempts "
                f"(stop_reason={msg.stop_reason}); raw reply saved to {raw}"
            )

    open(out_svg, "w", encoding="utf-8").write(svg)
    print(f"Done: {out_svg}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: sketch2svg.py sketch.png out.svg")
    main(sys.argv[1], sys.argv[2])
