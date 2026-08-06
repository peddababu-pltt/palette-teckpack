#!/usr/bin/env python3
"""
variations.py — existing two-view flat sketch → design/color variations.
usage: python variations.py sketch.png out_dir --mode sketch --variants 2 [--prompt "extra instructions"] [--seed 42]
       python variations.py sketch.png out_dir --mode both [--colors "#RRGGBB,#RRGGBB,#RRGGBB"] [--prompt "..."] [--seed 42]

The original sketch itself is the "Default" output — the caller (app.py)
already has it, so this script never regenerates it. Two modes:

'sketch' — N independent B&W design variants, each changing ONE structural
detail (pocket, collar, closure, cuff, or sleeve style). No color.

'both'   — ONE photorealistic color flat-lay of the original sketch.
"""
import argparse
import base64
import io
import json
import random
import sys
from pathlib import Path

import anthropic
import requests
from PIL import Image
from warp_pattern import (
    API_KEY, BASE_URL, FLAT_SKETCH_PROMPT, upload_image, iter_sse_events,
    extract_outputs, download_output,
)

# Both views ship inside ONE render: closed on top, opened underneath. Keeping them
# in a single image is what lets the overlay's compare slider wipe the flat against
# the whole garment story at once -- and the flat itself is a front/back pair, so a
# closed+open realistic still registers row-for-row against it.
# The open row is where the lining, facings and inner panels become visible -- the
# whole reason construction references get uploaded -- so it is asked for explicitly
# rather than left to the model's mood. Conditional on purpose: a pullover has
# nothing to open, and forcing a second row onto one invents construction that
# isn't there.
_OPEN_CLOSED_LAYOUT = (
    "LAYOUT — READ CAREFULLY, the output is compared against the input by overlaying one on "
    "the other, so its geometry is not a free choice. "
    "1) The output image must have the SAME width-to-height proportion as the input image. "
    "Never return a square image for a wide input. "
    "2) The TOP ROW must reproduce the input's layout EXACTLY: the same views in the same "
    "left-to-right order at the same relative positions and scale — front view on the LEFT, "
    "back view on the RIGHT, side by side. NEVER stack the front view above the back view, "
    "never reorder them, never re-centre or re-crop them. Laid over the input, each garment "
    "in the top row must sit directly on top of its counterpart in the input. "
    "3) THEN, only if the garment has a real front opening (zip, buttons, snaps, or a wrap), "
    "add a SECOND ROW underneath showing the SAME garment OPENED — opened front view on the "
    "left, opened back view on the right, in the same two columns as the row above, with the "
    "opening spread apart so the lining, facings and inner panels are clearly visible. "
    "4) If the garment has NO front opening (a pullover, tee, or one-piece), output the top "
    "row ONLY and leave no second row — never invent an opening the garment does not have."
)

# Same rule warp_pattern.py applies to the default flat, so the variants and the
# realistic render read the references the same way the default does.
_REFERENCE_DETAIL_RULE = (
    "ADDITIONAL REFERENCE IMAGES: the extra images provided alongside the main image are "
    "construction references for THIS SAME garment, usually shot open or inside-out to show "
    "detail the main image cannot. The main subject image remains the authority on garment "
    "type, overall silhouette, and proportions — never restyle the garment into a different "
    "one. But for any of these specific parts — collar and collar stand, sleeves and sleeve "
    "construction, cuffs, pockets, plackets and closures, lining, facings, inner panels, "
    "yokes and seam placement — if a reference image shows that part clearly, render that "
    "part the way the REFERENCE shows it. Where no reference shows a given part, follow the "
    "main image as usual. "
    "CRITICAL — REPLACE, NEVER ADD: when a reference's version of a part differs from the main "
    "image's, the reference version REPLACES it. Render one version only, never both overlaid. "
    "The garment has EXACTLY ONE front closure — a zip OR a button placket OR a snap placket, "
    "never a zip and a row of buttons/snaps together down the same center front."
)

_REALISTIC_PROMPT_BASE = (
    "Convert this black and white technical flat sketch into a photorealistic fashion "
    "product flat-lay photograph. Lay the garment flat on a clean white background, "
    "keeping the same flat layout and view arrangement as the input. "
    "Show realistic fabric texture, natural soft shadows, stitching quality. "
    "Keep the same silhouette and construction details as the reference — "
    "only render it as a real garment instead of a line drawing. "
    "Professional product photography style."
)

SEASONS = {
    "spring": (
        "lightweight cotton or light blends, soft layers, breathable but slightly "
        "structured, fresh floral tones, airy and refreshing mood"
    ),
    "summer": (
        "ultra-lightweight cotton or linen, highly breathable, minimal layering, "
        "open weave or ventilated panels, bright or light colors, cool and relaxed mood"
    ),
    "autumn": (
        "mid-weight wool or flannel, earthy tonal buttons and hardware, warm rich mood"
    ),
    "winter": (
        "heavy wool or cashmere, reinforced closures, thick inner lining, cozy and "
        "protective mood"
    ),
    # Not a calendar season like the other four -- a weather brief. Phrased around
    # construction (coated shell, sealed seams, storm flap) rather than a month, so
    # the render changes the fabric and the closures instead of only the palette.
    "rain": (
        "water-repellent coated shell or technical nylon with a subtle sheen, taped "
        "and sealed seams, storm flap over the front closure, waterproof zips, "
        "drawcord hem and hood if the garment has one, slightly longer cut for "
        "coverage, muted wet-weather tones, practical and protective mood"
    ),
}

_COLOR_LABELS = ["primary", "secondary", "tertiary"]
_COLOR_ROLE_HINTS = [
    "main body panels — the primary fabric color covering most of the garment",
    "contrast panels/lining/details if present",
    "trim details ONLY, NOT the main body fabric: zippers, buttons, snaps, "
    "ribbon/piping/bias tape lining edges or seams, ribbing/elastic on collar "
    "bands/cuffs/waistlines, drawstrings and eyelets, and labels/thread/brand "
    "tags. This color must be VISIBLY applied to at least one of these trim "
    "elements — do not skip it or blend it into the body color",
]

# Design variants reuse the EXACT same big B&W technical-flat prompt stage 1
# uses (FLAT_SKETCH_PROMPT: pure white bg, black outlines only, hairline-thin
# uniform stroke weight, zip/part-separation construction rules) so a variant
# sketch matches the original sketch's drawing rigor exactly. The only
# override: instead of "keep the design identical," make the one described
# change -- everything else in that prompt still applies as-is.
_DESIGN_VARIANT_FRAMING = (
    "The reference image is an existing TWO-VIEW technical fashion flat sketch "
    "(front-left, back-right) — not a photo. It was already drawn using the exact "
    "rules below; follow those SAME rules for this new drawing, with ONE override: "
    "instead of keeping the design identical to the reference, apply the single "
    "deliberate change described further below. Keep the two-view layout, "
    "silhouette, and every other construction detail the same as the reference."
)

# Static fallback only — generate_variant_ideas() asks Claude to look at the
# actual garment photo and propose fresh, garment-specific recipes each run so
# repeated requests don't produce the same variants every time. This list is
# used only if that vision call fails (network/parsing error).
#
# Each recipe names ONE plain construction change (not vague "a different X"
# phrasing) — specific enough that the model can't quietly reproduce the
# reference, simple enough that the result is still an ordinary garment someone
# would wear. Not every recipe applies to every garment type (e.g. a t-shirt has
# no collar) -- build_design_variant_prompt tells the model to substitute the
# nearest equivalent when something doesn't apply.
#
# No pattern/print recipes: allover fills (houndstooth, plaid, dense hatch)
# swamped the line art, made the change unreadable and the flat useless to the
# tracer. Variants are construction changes drawn in plain line work only.
_VARIANT_RECIPES = [
    "Replace the pockets with two simple angled FLAP pockets — a plain rectangular "
    "flap with one button on each (if the reference has no pockets, add these). "
    "Leave everything else alone.",
    "Replace the front closure with a full-length exposed centre-front ZIPPER (two "
    "parallel rail lines with tick-mark teeth and a pull tab), and remove the chest "
    "pockets for a clean front. Leave everything else alone.",
    "Add one horizontal YOKE seam across the front chest and the upper back — a "
    "single clean seam line separating the yoke panel from the body below. Leave "
    "everything else alone.",
    "Change the pockets to angled WELT pockets — a narrow slit with bound edges, no "
    "flap and no pocket bag showing. Leave everything else alone.",
    "Change the sleeve seam from a set-in seam to a RAGLAN seam running from the "
    "underarm up to the neckline on both views. Leave everything else alone.",
    "Change the collar/neckline: if it has a collar, swap it for a plain stand "
    "collar; if it is collarless, give it a noticeably different neckline shape. "
    "Leave everything else alone.",
    "Change the hem and cuffs to plain ribbed bands (or, if they are already ribbed, "
    "to a flat hem with a simple stitched turn-up). Leave everything else alone.",
]


# A "bold, immediately obvious" change is easy to satisfy with something that
# cannot be manufactured or worn -- the failure seen in practice is a second
# zipper drawn across the front on top of the real one, so the garment has two
# crossing closures and no way to actually open. These rules are the hard floor
# under the design brief: whatever changes, the result stays a garment a factory
# could cut and sew and a person could put on.
_WEARABILITY_RULES = (
    "NON-NEGOTIABLE — THE RESULT MUST BE A REAL, MANUFACTURABLE, WEARABLE GARMENT. "
    "Every line drawn has to be something a factory can cut and sew and a person can "
    "actually put on and take off. Specifically: "
    "(1) EXACTLY ONE front-opening system. One closure — a centre-front zip, OR an "
    "asymmetric/offset moto zip, OR a button placket, OR a pullover with no front "
    "opening. Never two. A second zip, placket or button row drawn across, over or "
    "beside the first one is forbidden even as decoration. "
    "(2) A CLOSURE MUST RUN THE FULL LENGTH OF A REAL OPENING EDGE, end to end, "
    "terminating at a genuine boundary (hem band, collar/neckline seam, pocket mouth, "
    "cuff). A zip or placket that starts or stops in the middle of a panel, crosses "
    "another closure, or runs diagonally over an unbroken body panel is not an opening "
    "— it is a drawing error. If the design is an asymmetric moto zip, the body panel "
    "overlaps and the zip sits along that overlap edge, and there is then NO centre-front "
    "zip as well. "
    "(3) POCKET ZIPS are short, sit inside their own pocket opening, and never touch or "
    "cross the front closure. "
    "(4) THE GARMENT MUST BE ENTERABLE: the head opening, the front opening and the "
    "cuffs must be wide enough to get through, or the closure must open far enough to "
    "make them so. A pullover with a tight closed neckline needs a real placket, zip or "
    "back opening. "
    "(5) SEAMS AND PANELS MUST CLOSE: every seam line meets another seam, a hem, or an "
    "edge. No line that stops in open fabric, no panel that cannot be cut flat, no "
    "floating detail attached to nothing. "
    "(6) FRONT AND BACK MUST MATCH: shoulder, side and armhole seams, hem bands, collar "
    "and sleeve length must line up between the two views — they are the same garment "
    "from two sides, so a detail that crosses the side seam has to appear on both."
)


_IDEA_PROMPT = """You are a production designer proposing simple, buildable alternate versions of this exact garment.

Look at the garment in the reference image and propose {count} DISTINCT variations — each one a single, plain construction change to something you can actually see on THIS garment (its pockets, collar/neckline, closure, cuffs/hem, sleeves, panel seams).

Rules for each idea:
- ONE named change per idea, in plain words (e.g. "swap the patch pockets for angled welt pockets", "replace the button placket with a full-length centre-front zip", "change the set-in sleeve to a raglan sleeve"). Never vague phrasing like "a different style", and never a list of three changes at once.
- Keep it SIMPLE and ordinary — a normal garment a factory makes every day and a customer would wear. Not a runway concept, not an experiment. If an idea sounds complicated to sew, it is the wrong idea.
- NO fabric prints or patterns. No houndstooth, plaid, check, stripe, camo or allover hatch fill. The drawing stays clean line art on plain white; a filled pattern hides the construction and makes the change unreadable. Colour-blocking is fine ONLY as a seam line — never as a filled panel.
- Base it on garment parts that are ACTUALLY VISIBLE in this photo/sketch — don't invent a collar for a garment that has none.
- Each of the {count} ideas must change a DIFFERENT element (pockets in one, closure in another, sleeve seam in another, hem/cuff in another).
- The result must stay a REAL, WEARABLE garment. If you change the closure, you REPLACE the existing one — never add a second zip or placket alongside it, never route a closure diagonally across a body panel, never leave a zip ending in the middle of fabric. A person has to be able to open the garment, get into it, and close it again.
- Do not propose anything that cannot be cut and sewn from flat panels: no seam that stops in open fabric, no detail floating off the garment, no opening too small to pass a head or arm through.

Respond with ONLY a valid JSON array of {count} strings, no markdown fences, no explanation:
["<idea 1 as one instruction sentence>", "<idea 2>", ...]"""


def _load_image_b64(path: str, max_dim: int = 1568) -> str:
    im = Image.open(path).convert("RGB")
    if max(im.size) > max_dim:
        scale = max_dim / max(im.size)
        im = im.resize((int(im.width * scale), int(im.height * scale)))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _extract_json_array(text: str):
    text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        val = json.loads(text)
        return val if isinstance(val, list) else None
    except json.JSONDecodeError:
        i, j = text.find("["), text.rfind("]")
        if i != -1 and j > i:
            try:
                val = json.loads(text[i:j + 1])
                return val if isinstance(val, list) else None
            except json.JSONDecodeError:
                pass
    return None


def _extract_json_object(text: str):
    text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        val = json.loads(text)
        return val if isinstance(val, dict) else None
    except json.JSONDecodeError:
        i, j = text.find("{"), text.rfind("}")
        if i != -1 and j > i:
            try:
                val = json.loads(text[i:j + 1])
                return val if isinstance(val, dict) else None
            except json.JSONDecodeError:
                pass
    return None


_RECOMMEND_PROMPT = """You are a colorist and merchandiser recommending a realistic-render \
treatment for this exact garment.

Look at the garment in the reference image (its type, silhouette, and any fabric cues already \
drawn) and recommend:
1. A 3-color palette that actually suits THIS garment — not a generic default. Pick colors a \
real buyer would put this garment into production in.
   - "primary": the main body fabric color (most of the garment).
   - "secondary": a contrast panel/lining color if the garment has a place for one, otherwise \
a color close to primary.
   - "trim": zippers/buttons/snaps/piping/ribbing/drawstring/label color — should read as \
metal, plastic, or a deliberate accent, not just a repeat of primary.
2. The single best-fit season from this exact list: {seasons}. Base it on the garment's weight \
and construction as drawn (e.g. a heavy hooded parka reads winter or rain, a sleeveless cotton \
dress reads spring or summer) — not a random pick.

Respond with ONLY a valid JSON object, no markdown fences, no explanation:
{{"primary": "#RRGGBB", "secondary": "#RRGGBB", "trim": "#RRGGBB", "season": "<one of {seasons}>"}}"""


def recommend_colors_and_season(sketch_path: str, extra_prompt: str) -> tuple[list[str], str]:
    """Ask Claude to recommend a color palette + season from the actual garment,
    used whenever the caller didn't supply one (the "AI Recommendation" tabs in
    the UI send neither) instead of falling back to a flat generic prompt line
    that looks the same on every job regardless of garment. Returns ([], "") on
    any failure so the caller's existing generic fallback still applies."""
    try:
        b64 = _load_image_b64(sketch_path)
        prompt = _RECOMMEND_PROMPT.format(seasons=", ".join(SEASONS.keys()))
        if extra_prompt:
            prompt += f"\n\nAlso take into account these additional instructions from the user: {extra_prompt}"

        client = anthropic.Anthropic()
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=300,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64",
                     "media_type": "image/png", "data": b64}},
                    {"type": "text", "text": prompt},
                ],
            }],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        result = _extract_json_object(text) or {}

        colors = [result.get(k, "") for k in ("primary", "secondary", "trim")]
        colors = [c for c in colors if isinstance(c, str) and c.startswith("#")]
        season = result.get("season", "")
        season = season if season in SEASONS else ""

        if colors or season:
            print(f"AI recommended: colors={colors or 'none'} season={season or 'none'}")
        return colors, season
    except Exception as e:
        print(f"AI color/season recommendation failed ({e}) — using generic fallback")
        return [], ""


def generate_variant_ideas(sketch_path: str, count: int, extra_prompt: str) -> list[str]:
    """Ask Claude to brainstorm `count` garment-specific redesign ideas from the
    actual reference photo. Falls back to the static recipe list (cycled) on
    any failure, so a bad vision call never blocks generation entirely."""
    try:
        b64 = _load_image_b64(sketch_path)
        prompt = _IDEA_PROMPT.format(count=count)
        if extra_prompt:
            prompt += f"\n\nAlso take into account these additional instructions from the user: {extra_prompt}"

        client = anthropic.Anthropic()
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1200,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64",
                     "media_type": "image/png", "data": b64}},
                    {"type": "text", "text": prompt},
                ],
            }],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        ideas = _extract_json_array(text)
        ideas = [i for i in (ideas or []) if isinstance(i, str) and i.strip()]
        if ideas:
            print(f"AI proposed {len(ideas)} variant idea(s)")
    except Exception as e:
        print(f"variant idea generation failed ({e}) — using fallback recipes")
        ideas = []

    if len(ideas) < count:
        fallback = [_VARIANT_RECIPES[i % len(_VARIANT_RECIPES)] for i in range(count)]
        ideas = ideas + fallback[len(ideas):]
    return ideas[:count]


def build_design_variant_prompt(recipe: str, extra_prompt: str, has_references: bool = False) -> str:
    parts = [
        _DESIGN_VARIANT_FRAMING,
        FLAT_SKETCH_PROMPT,
        # Design variants stay front/back like the default flat: they exist to show
        # ONE deliberate design change, and an open/closed axis on top of that would
        # make it harder to spot which element actually changed. Open vs closed is
        # the realistic render's job, where it ships as two separate tiles.
        # No pattern exception: the 'plain solid white, no texture, no hatching'
        # rule holds absolutely. Filled panels (houndstooth, plaid, dense hatch)
        # buried the line art, hid the actual change, and left the tracer with a
        # sheet of pattern instead of construction lines.
        "NO FABRIC PATTERN, EVER. The 'plain solid white, no texture, no hatching' "
        "rule above has no exceptions: no houndstooth, plaid, check, stripe, camo, "
        "polka dot or allover hatch fill on any panel. Every panel stays plain white. "
        "The only marks on the garment are construction lines — seams, stitching, "
        "closures, pockets, ribbing.",
        f"THE ONE CHANGE TO MAKE: {recipe} "
        "Change ONLY that. If this garment type doesn't have the exact element named "
        "(e.g. no collar, no cuffs, no sleeves), substitute the nearest equivalent "
        "feature and apply the change there instead — don't skip it, adapt it. The "
        "changed element must be clearly visible when the two drawings are compared "
        "side by side, but keep it a plain, ordinary, factory-buildable detail — not "
        "an elaborate or experimental one. Every other construction detail, and the "
        "garment type itself, stays exactly the same as the reference.",
        # Last in the list, so it is the constraint the model reads immediately
        # after the instruction most likely to break it.
        _WEARABILITY_RULES,
    ]
    if has_references:
        parts.append(_REFERENCE_DETAIL_RULE)
    if extra_prompt:
        parts.append(f"ADDITIONAL INSTRUCTIONS: {extra_prompt}")
    return " ".join(parts)


def build_realistic_prompt(colors: list[str], season: str, extra_prompt: str,
                            has_references: bool = False) -> str:
    parts = [_REALISTIC_PROMPT_BASE, _OPEN_CLOSED_LAYOUT]
    if has_references:
        parts.append(_REFERENCE_DETAIL_RULE)
    if season and season in SEASONS:
        parts.append(f"Apply this seasonal fabric/mood direction: {SEASONS[season]}.")
    # colors is a FIXED 3-slot list [primary, secondary, tertiary] — an unset
    # slot is "", never omitted, so a slot's position always maps to the
    # correct label/hint even when an earlier slot is unset (e.g. secondary
    # blank, tertiary/trim set — without fixed slots, filtering blanks first
    # would shift trim's hex into secondary's label and drop trim's hint).
    padded = (list(colors) + ["", "", ""])[:3]
    color_parts = [
        f"{label}: {hexval} - {hint}"
        for label, hexval, hint in zip(_COLOR_LABELS, padded, _COLOR_ROLE_HINTS)
        if hexval
    ]
    if color_parts:
        parts.append(f"Apply colors: [{'], ['.join(color_parts)}].")
    else:
        parts.append("Use natural, realistic fabric colors appropriate for the design.")
    if extra_prompt:
        parts.append(f"ADDITIONAL INSTRUCTIONS: {extra_prompt}")
    return " ".join(parts)


def _run_image_edit(label: str, prompt: str, inputs: list[dict], seed: int) -> bytes:
    payload = {
        "prompt": prompt,
        "model": "image-edit-default",
        "seed": seed,
        "inputs": inputs,
        "metadata": {"source": "flat2variations", "label": label, "seed": seed},
    }

    r = requests.post(
        BASE_URL,
        headers={"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"},
        json=payload,
        timeout=180,
        stream=True,
    )
    r.raise_for_status()

    out = None
    last_event = None
    for event in iter_sse_events(r):
        last_event = event
        if event.get("event") == "error":
            msg = event.get("data", {}).get("error", event.get("data", {}))
            sys.exit(f"'{label}' failed: router error {msg}")
        found = extract_outputs(event.get("data", event))
        if found:
            out = found

    if not out:
        sys.exit(f"'{label}' failed: no image in stream (last event: {last_event})")

    return download_output(out[0])


def _reference_inputs(reference_urls: list[str]) -> list[dict]:
    return [{"type": "image", "url": u, "role": "style_reference"} for u in reference_urls]


def generate_realistic(image_url: str, colors: list[str], season: str, extra_prompt: str,
                        seed: int, reference_urls: list[str] | None = None) -> bytes:
    refs = reference_urls or []
    prompt = build_realistic_prompt(colors, season, extra_prompt, bool(refs))
    inputs = [{"type": "image", "url": image_url, "role": "subject"}] + _reference_inputs(refs)
    return _run_image_edit("realistic", prompt, inputs, seed)


def generate_design_variant(image_url: str, recipe: str, extra_prompt: str, seed: int, index: int,
                             reference_urls: list[str] | None = None) -> bytes:
    refs = reference_urls or []
    prompt = build_design_variant_prompt(recipe, extra_prompt, bool(refs))
    inputs = [{"type": "image", "url": image_url, "role": "subject"}] + _reference_inputs(refs)
    return _run_image_edit(f"variant:{index}", prompt, inputs, seed)


def main():
    if not API_KEY:
        sys.exit("LLM_ROUTER_API_KEY missing in .env")

    ap = argparse.ArgumentParser()
    ap.add_argument("sketch")
    ap.add_argument("out_dir")
    ap.add_argument("--colors", default="", help="comma-separated hex colors, optional ('both' mode only)")
    ap.add_argument("--season", default="", choices=["", *SEASONS.keys()],
                     help="seasonal fabric/mood direction, optional ('both' mode only)")
    ap.add_argument("--prompt", default="", help="extra free-text instructions, optional")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--mode", default="both", choices=["sketch", "both"],
                     help="'sketch' generates N B&W design variants, no color. "
                          "'both' generates one photorealistic color flat-lay")
    ap.add_argument("--variants", type=int, default=2,
                     help="number of design variants to generate in 'sketch' mode")
    ap.add_argument("--references", default="", help="comma-separated local paths to reference images, optional")
    a = ap.parse_args()

    seed = a.seed if a.seed is not None else random.randint(0, 2**31 - 1)
    print(f"seed: {seed}")

    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    image_url = upload_image(a.sketch)
    reference_paths = [p.strip() for p in a.references.split(",") if p.strip()]
    reference_urls = [upload_image(p) for p in reference_paths]
    if reference_urls:
        print(f"uploaded {len(reference_urls)} reference image(s)")

    manifest = []

    if a.mode == "sketch":
        count = max(1, a.variants)
        ideas = generate_variant_ideas(a.sketch, count, a.prompt)
        for i, recipe in enumerate(ideas):
            variant_seed = random.randint(0, 2**31 - 1)
            sketch_bytes = generate_design_variant(image_url, recipe, a.prompt, variant_seed, i, reference_urls)
            sketch_file = f"variant_{i + 1}_sketch.png"
            (out_dir / sketch_file).write_bytes(sketch_bytes)

            manifest.append({
                "id": f"variant{i + 1}", "label": f"Variant {i + 1}",
                "sketch": sketch_file, "realistic": None,
            })
            print(f"variation done: variant{i + 1} -> {sketch_file} ({recipe[:60]}...)")
    else:
        # NOT filtering blanks here -- position (slot 0/1/2 = primary/secondary/
        # trim) must be preserved even when an earlier slot is unset; see the
        # comment in build_realistic_prompt.
        colors = [c.strip() for c in a.colors.split(",")] if a.colors else []
        season = a.season
        # Neither given ("AI Recommendation" tabs send nothing) -- ask for a
        # real palette/season instead of the flat generic fallback line.
        if not colors or not season:
            rec_colors, rec_season = recommend_colors_and_season(a.sketch, a.prompt)
            if not colors:
                colors = rec_colors
            if not season:
                season = rec_season
        # One render, both views: closed row over open row. See _OPEN_CLOSED_LAYOUT.
        realistic_bytes = generate_realistic(image_url, colors, season, a.prompt, seed,
                                             reference_urls)
        realistic_file = "realistic.png"
        (out_dir / realistic_file).write_bytes(realistic_bytes)

        manifest.append({
            "id": "realistic", "label": "Realistic",
            "sketch": None, "realistic": realistic_file,
        })
        print(f"variation done: realistic -> {realistic_file}")

    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"saved {len(manifest)} variation(s) → {out_dir}")


if __name__ == "__main__":
    main()
