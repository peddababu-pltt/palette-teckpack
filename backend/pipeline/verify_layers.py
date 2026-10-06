#!/usr/bin/env python3
"""
verify_layers.py — the self-check loop.

After tracing, renders every layer as a labeled tile sheet, shows Claude
Vision the ORIGINAL sketch + the LAYER SHEET + the current grouping, and
asks: "which layers are wrong?" If corrections come back, groups.json is
updated and the caller re-traces. This automates the review-and-fix
iteration a human would do in Inkscape.

Usage: python3 verify_layers.py work.png labels.npy groups.json layered.svg
Exit code: 0 = groups.json unchanged (all good), 3 = corrected (re-trace!)
"""
import base64
import io
import json
import os
import re
import sys

import anthropic

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from _svg_render import svg2png
from name_regions import deterministic_repairs
from PIL import Image, ImageDraw


def format_groups_for_prompt(parts: dict) -> dict:
    """Grouping text shown to the verify-vision-call. Must include grab_box,
    not just regions -- a part with an empty regions list is a normal,
    valid grab_box-only part (e.g. a zip whose ink comes purely from
    geometric box-grab), and the model can't reason about whether that box
    is positioned/sized correctly if it never sees the box's coordinates."""
    out = {}
    for n, p in parts.items():
        out[n] = {"regions": p["regions"]}
        if p.get("grab_box"):
            out[n]["grab_box"] = p["grab_box"]
        # A diagonal strip's real footprint. Without it in the prompt the model
        # sees only the polygon's bounding rectangle and reads a correctly
        # boxed moto zip as one swallowing both front panels.
        if p.get("grab_poly"):
            out[n]["grab_poly"] = p["grab_poly"]
    return out

PROMPT = """You are quality-checking a fashion-flat-to-layered-SVG extraction.

IMAGE 1: the original flat sketch.
IMAGE 2: a contact sheet — every extracted layer rendered separately with
its name in red.

Current grouping (part -> segmented region ids):
{groups}

Region stats (id: area px, centroid [x,y], bbox [x0,y0,x1,y1]):
{stats}

Check each tile in IMAGE 2 against IMAGE 1:
- Does a layer contain content that belongs to a DIFFERENT part?
- Are two parts merged that should be separate (or vice versa)?
- Is a part misnamed (wrong side, wrong view, wrong garment term)?
- Is a whole visible part of the garment missing from every layer?
- EVERY "_zip" TILE MUST SHOW TEETH. Look at each zip tile in IMAGE 2: it
  has to show the ladder of teeth with its rails, slider and end stop. A
  zip tile showing only a dashed/dotted line, a plain curve, or two bare
  parallel lines is not a zip — either the teeth were left behind in the
  panel the zip crosses (find them and move them in, and widen the
  grab_box to cover the zip's whole run), or the garment has no zip there
  at all and the part must be deleted. Check the original sketch: a zip
  named on a view that has no toothed strip is invented hardware.
- A DIAGONAL ZIP IS THE CLASSIC MISS: grab_box is axis-aligned, so a
  narrow vertical box set at the zip's top x-position captures only the
  top of a zip that travels sideways as it descends, and the rest stays
  inside a body panel. If IMAGE 1 shows a zip running corner to corner and
  a body_panel tile shows zip teeth or a slider drawn on it, replace that
  zip's "grab_box" with a "grab_poly": the four corners of the strip
  itself, [[x,y],[x,y],[x,y],[x,y]] around the quadrilateral in order (top
  end's two corners, then the bottom end's two). Keep it the zip's own
  width and cover its full length including slider and end stop, and drop
  the grab_box — the bounds come from the polygon. Use a polygon only for
  a genuinely slanted strip; a vertical or horizontal one keeps grab_box.
- ZIPS CUT THE PANELS: no body-panel tile may show content from both sides
  of a zip. If one panel tile spans across the zip line, that region is a
  leak and belongs to whichever side holds most of its area.
- CROSS-VIEW INVENTORY, do this one FIRST: list the part names per view
  (front_*, back_*) and compare the two lists. A sleeved garment shows
  sleeves on BOTH views, so front_left_sleeve/front_right_sleeve with no
  back_left_sleeve/back_right_sleeve means the back sleeves were swallowed
  by the back body panels — find the outboard region inside each back
  body panel group and move it into a new back sleeve part. Apply the same
  comparison to cuffs, pockets and collars. A part present on one view and
  absent on the other is a merge defect until the sketch proves otherwise.
- SILHOUETTE OF THE WHOLE GROUP, not the plausibility of each region: a
  body panel tile must read as a torso alone — shoulder, armhole, side
  seam, hem. If a "body_panel" tile shows a torso WITH an arm attached to
  it, that group is holding a sleeve; the arm's region has to come out
  even though each region in the group looked reasonable on its own.
- SLEEVE vs BODY PANEL, specifically: a quilted/paneled sleeve is cut
  into several stacked bands from shoulder to cuff, all sharing nearly
  the SAME bbox x-range. If a "body" tile in IMAGE 2 shows a piece of
  the tapered limb silhouette (not the flat torso), that region belongs
  to the sleeve instead — check EVERY band in that x-range, not just
  the topmost one. Likewise a "sleeve" tile that shows flat torso
  content (not a tapered limb) is misnamed body panel.
- POCKET regions (small closed welt/flap shape with a button/snap)
  must never be filed under "sleeve" — they belong on the body panel
  they sit on top of.
- SHAWL / LAPEL COLLAR SWALLOWED BY A BODY PANEL: size is not a test
  for a collar. A shawl, lapel or notch collar is a LARGE draped shape
  that frames the neck opening and sweeps down both sides of the chest
  to the V where the two sides meet — on a puffer it can be the single
  biggest region in the front view. Look at each body_panel tile: if it
  shows that whole collar shape sitting on top of the panel, the
  collar's region was filed under the panel and must move to the collar
  part. Measured on a shawl-collar puffer, the collar region was 133k px
  against the panel's 44k, and it was named front_left_body_panel purely
  because it looked too big to be a collar. Conversely a collar tile
  that shows only a thin inner neckband, while the big draped shape
  lives on a panel tile, is the same defect seen from the other side.
- COLLAR vs YOKE vs PLACKET, specifically: these sit close together
  near the neckline/center-front and are the most commonly wrongly
  merged parts. Collar = the band or draped shape at the neckline (see
  the shawl/lapel note above — it is not always a narrow band). Yoke =
  roughly horizontal shoulder-width panel BELOW the collar's seam.
  Placket = narrow vertical button strip down the center front,
  starting below the collar. If a "collar" tile shows a horizontal
  shoulder-width panel, that's yoke content misfiled into collar. If a
  "collar" or "yoke" tile shows a thin vertical strip running down the
  chest, that's placket content misfiled. Also confirm front-view
  collar and back-view collar are kept as separate parts, not merged
  with each other or with a yoke/placket region.
- COLLAR vs SHOULDER PANEL: a narrow diagonal/triangular strip running
  from the collar's outer point OUT to the sleeve/armhole at the
  shoulder is a shoulder panel, not the collar, even though its region
  was segmented touching the collar's own region and the tile shows
  them as one connected shape. If a "collar" tile's silhouette extends
  out into a long diagonal arm toward the shoulder/sleeve instead of
  staying a short curved neckband, split that outboard region into its
  own "..._shoulder_panel" part.
- POCKET vs BODY PANEL stitch-guide: a welt pocket is often drawn with
  a dashed rectangle/box line running sideways from the welt over to
  the placket/center-front seam (a hidden stitch-guide for the pocket
  bag). That dashed-box region is body-panel fabric with a marking on
  it, NOT the pocket piece. If a "pocket" tile shows anything wider
  than the welt's own small closed slit shape — e.g. a box or rectangle
  reaching sideways toward center front — move that region into the
  body panel part instead, keeping only the welt's own slit region
  under "pocket".
- PART LISTED BUT NO TILE AT ALL IN IMAGE 2: the current grouping above
  lists every part name, including "grab_box"-only ones (empty "regions",
  a coordinate box instead). If a part name from that list has NO
  matching tile anywhere in IMAGE 2 (not even a blank/faint one -- it's
  simply absent), that part's captured ink was completely empty: its
  grab_box most likely doesn't reach the actual feature at all (e.g. a
  zip's box only spans the bodice height and the zip's own ink -- being
  one continuous stroke that's mostly OUTSIDE the box -- got swept into
  the neighboring body panel as ordinary shared-seam ink instead). Look
  at IMAGE 1 at that part's grab_box x-position, full image height, to
  find where the real feature actually runs, and widen the grab_box's
  y0/y1 (keep x0/x1) to cover it end to end. This is the same fix as the
  cut-short case below, just more severe -- treat "no tile" as "cut short
  to nothing", not as "nothing to check here".
- INCOMPLETE / CUT-SHORT ZIP OR PLACKET: compare a "zip"/"placket"
  tile against IMAGE 1 at that same x-position, full image height. If
  the sketch shows a pull-tab/slider at the top and/or an end-stop/
  bar-tack at the bottom of that zip run and the tile's content stops
  short before reaching one or both (i.e. the tile is visibly a
  shorter strip than the full zip drawn in the sketch), that part's
  "grab_box" is too short — widen its y0 upward and/or y1 downward
  enough to cover the pull-tab and end-stop, while keeping x0/x1
  unchanged (do not widen sideways into the flanking topstitch).
- EMPTY / NEARLY-EMPTY PLACKET TILE: if a "placket" tile is blank or shows
  only scattered fragments (no continuous line) while IMAGE 1 clearly
  shows a real strip at that x-position, this is a PLAIN double-line
  placket/band with no separate interior content (unlike a zip's own
  teeth/tape, its two bounding lines ARE the piece, and each line is
  simultaneously a neighboring panel's own center-front edge). Widening
  the grab_box does NOT fix this -- those lines are fused into the
  garment's main outline stroke, not an isolated one, so no box width
  ever satisfies the grab-box majority test, and the panels already carry
  their own edge correctly regardless. Fix: drop the "grab_box" for this
  part entirely, and remove any of its regions that aren't a genuinely
  separate small piece (e.g. a distinct flap/tab with its own closed
  outline at one end) -- keep the part only if such a piece actually
  exists; otherwise fold whatever regions it has into the neighboring
  body panel instead of leaving an empty placket part.

If EVERYTHING is correct, respond with exactly: {{"ok": true}}

Otherwise respond with the FULL corrected grouping as a JSON object
with a top-level "parts" key, e.g.:
{{"parts": {{"front_body": {{"regions": [5, 19]}},
            "front_left_sleeve": {{"regions": [9, 21, 27, 31]}}}}}}
(part names must contain: body, panel, leg, yoke, sleeve, hem, cuff,
waistband, fly, zip, placket, pocket, collar, hood, strap, belt, badge,
label, drawcord or button; every region id in exactly one part; keep
"grab_box" entries that are correct, and widen y0/y1 on any that are
cut short per the check above. "grab_box" MUST be a 4-element array
[x0, y0, x1, y1] in that exact order, e.g. "grab_box": [695, 180, 715,
1350] -- never an object with x0/y0/x1/y1 keys). ONLY JSON, no markdown
fences, no prose before or after."""


def render_sheet(svg_path, out_png, width=1400):
    try:
        import fitz  # noqa: F401 -- just probing availability here
    except (ImportError, OSError):
        sys.exit("verify step needs PyMuPDF:  pip install pymupdf")
    svg = open(svg_path).read()
    head = re.search(r"<svg[^>]*>", svg).group(0)
    groups = re.findall(r'(<g id="([^"]+)".*?</g>)', svg, re.S)
    # Individual button_N/stitch_N layers (one per mark, can number in the
    # hundreds) aren't part of the region-grouping this review checks -- they
    # come from global fine-detail extraction, not groups.json's parts, so
    # skip them here instead of building a contact sheet with hundreds of tiles.
    groups = [(g, name) for g, name in groups if not re.fullmatch(r"(button|stitch|text)_(\d+|label)(_2)?", name)]
    tiles = []
    for g, name in groups:
        one = head + g + "</svg>"
        buf = io.BytesIO()
        svg2png(svg_bytes=one.encode(), write_to=buf, output_width=width)
        im = Image.open(io.BytesIO(buf.getvalue())).convert("RGBA")
        bg = Image.new("RGB", im.size, "white")
        bg.paste(im, (0, 0), im)
        bb = Image.eval(bg.convert("L"), lambda p: 255 - p).getbbox()
        crop = bg.crop(bb) if bb else bg
        crop.thumbnail((280, 260))
        tile = Image.new("RGB", (300, 300), "white")
        tile.paste(crop, (10 + (280 - crop.width) // 2, 34 + (260 - crop.height) // 2))
        ImageDraw.Draw(tile).text((8, 6), name, fill="red")
        tiles.append(tile)
    cols = 5
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (300 * cols, 300 * rows), "white")
    for i, t in enumerate(tiles):
        sheet.paste(t, ((i % cols) * 300, (i // cols) * 300))
    sheet.save(out_png)
    return out_png


def b64_img(path, max_dim=1568):
    im = Image.open(path).convert("RGB")
    sc = min(1.0, max_dim / max(im.size))
    if sc < 1.0:
        im = im.resize((int(im.width * sc), int(im.height * sc)))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def main(work_png, labels_npy, groups_json, svg_path):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not found (put it in a .env file)")
    segdir = os.path.dirname(os.path.abspath(labels_npy))
    info = json.load(open(os.path.join(segdir, "regions.json")))
    cfg = json.load(open(groups_json))
    sheet = render_sheet(svg_path, os.path.join(segdir, "layer_sheet.png"))
    stats = "\n".join(f"{k}: {v['area']}px, c{v['centroid']}, bbox{v['bbox']}"
                      for k, v in sorted(info.items(), key=lambda kv: int(kv[0])))

    def extract_json(t):
        t = t.strip().removeprefix("```json").removeprefix("```")
        t = t.removesuffix("```").strip()
        try:
            return json.loads(t)
        except json.JSONDecodeError:
            pass
        # scan all top-level {...} blocks, keep the LAST one that parses
        best = None
        depth = 0
        start = None
        for idx, ch in enumerate(t):
            if ch == "{":
                if depth == 0:
                    start = idx
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and start is not None:
                    try:
                        best = json.loads(t[start:idx + 1])
                    except json.JSONDecodeError:
                        pass
                    start = None
        return best

    client = anthropic.Anthropic()
    base_content = [
        {"type": "image", "source": {"type": "base64",
         "media_type": "image/png", "data": b64_img(work_png)}},
        {"type": "image", "source": {"type": "base64",
         "media_type": "image/png", "data": b64_img(sheet)}},
        {"type": "text", "text": PROMPT.format(
            groups=json.dumps(format_groups_for_prompt(cfg["parts"])),
            stats=stats)},
    ]
    retry_notice = {"type": "text", "text": (
        "Reply with ONLY the JSON object -- no markdown fences, no "
        "explanation, no self-correction, no second attempt in your reply. "
        "Output the final JSON once.")}
    ans = None
    for attempt in (1, 2, 3):
        content = base_content if attempt == 1 else base_content + [retry_notice]
        msg = client.messages.create(
            model="claude-sonnet-4-6", max_tokens=3000,
            messages=[{"role": "user", "content": content}])
        text = "".join(b.text for b in msg.content if b.type == "text").strip()
        raw_path = os.path.join(segdir, f"verify_raw_{attempt}.txt")
        open(raw_path, "w").write(f"stop_reason: {msg.stop_reason}\n---\n{text}")
        ans = extract_json(text)
        if ans is not None and ("ok" in ans or "parts" in ans):
            break
        print(f"verify attempt {attempt}: not valid JSON "
              f"(stop_reason={msg.stop_reason}, starts: {text[:120]!r}) "
              f"-> saved {raw_path}")
        ans = None
    if ans is None:
        # never crash the pipeline over a malformed review
        print("verify: could not parse reviewer response after 3 attempts, "
              "keeping current grouping (layers already written)")
        sys.exit(0)

    if ans.get("ok"):
        print("verify: all layers correct")
        sys.exit(0)

    # validate corrected grouping (same repair as name_regions)
    all_ids = {int(k) for k in info}
    for p in ans["parts"].values():
        gb = p.get("grab_box")
        if isinstance(gb, dict):
            p["grab_box"] = [gb["x0"], gb["y0"], gb["x1"], gb["y1"]]
    # A verify round may only lengthen a strip, never fatten it. The prompt
    # above asks for exactly one grab_box edit -- widen y0/y1 (x0/x1 for a
    # horizontal strip) when the box stops short of the zip's real run -- but
    # the model routinely rewrites the short axis too, and nothing downstream
    # pulls it back: the box is read from this file on the next trace and
    # written out again by the next round, so one bad edit compounds. Measured
    # across reruns of one bomber the front zip went [700,103,740,1307] ->
    # [694,97,746,1313] -> [700,97,841,1313], the last of them 141px wide
    # against a 40px zip. A grab_box is EXCLUSIVE, so those extra 100px took
    # the right body panel's own center-front edge into the zip's layer and
    # left the panel traced open down its whole zip side. Keep the model's
    # long-axis edit, keep the previous short axis.
    for nm, p in ans["parts"].items():
        gb, old_gb = p.get("grab_box"), cfg["parts"].get(nm, {}).get("grab_box")
        if not (gb and old_gb) or len(gb) != 4 or len(old_gb) != 4:
            continue
        if p.get("grab_poly") or cfg["parts"][nm].get("grab_poly"):
            continue          # a polygon's bounds are derived, not authored
        x0, y0, x1, y1 = (int(round(v)) for v in gb)
        ox0, oy0, ox1, oy1 = (int(round(v)) for v in old_gb)
        vertical = (oy1 - oy0) >= (ox1 - ox0)
        fixed = [ox0, y0, ox1, y1] if vertical else [x0, oy0, x1, oy1]
        if fixed != [x0, y0, x1, y1]:
            print(f"  {nm}: grab_box {gb} widens the strip itself -- keeping "
                  f"the run, restoring its width: {fixed}")
            p["grab_box"] = fixed
    ans["parts"] = deterministic_repairs(ans["parts"], all_ids, info, segdir)
    ans.setdefault("z_order", cfg.get("z_order", []))

    json.dump(ans, open(groups_json, "w"), indent=1)
    print("verify: corrections applied to", groups_json)
    for nm, p in ans["parts"].items():
        print(f"  {nm}: {sorted(p['regions'])}")
    sys.exit(3)


if __name__ == "__main__":
    main(*sys.argv[1:5])
