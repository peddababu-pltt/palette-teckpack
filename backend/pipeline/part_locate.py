#!/usr/bin/env python3
"""
part_locate.py — find a flat sketch's parts by WHERE they are, not by region number.

Usage: python3 part_locate.py seg_out/ groups.json

Same output contract as name_regions.py (groups.json for layered_trace_v4.py),
different method, and nothing in it is specific to one kind of garment:

1. LOCATE. The vision model sees the clean drawing with a labelled pixel grid
   and outlines every cut piece as a polygon (view, side, kind, outline). It is
   good at "where is the left sleeve"; it is bad at "is region 41 sleeve or
   pocket" when quilting, rib lines and seams have cut the drawing into 70+
   tiny numbered regions -- which is what the region-numbering namer asks.
2. ASSIGN. Every segmented region goes to the outline covering most of it; when
   several cover it, the smallest (most specific) wins, so a pocket beats the
   panel under it. Quilting and rib slices land in their piece by geometry.
3. CHECK. Garment-agnostic sanity checks on the result: coverage, each part one
   connected piece, left/right pairs mirror each other, front/back views agree,
   a "button" is round, every outline caught something.
4. RETRY. Failed checks go back to the model -- with an overlay of the current
   grouping -- as specific, measured findings; up to MAX_ROUNDS corrections,
   keeping whichever round has the fewest findings.
"""
import base64
import io
import json
import os
import sys

from _bootstrap_deps import ensure

ensure(modules=["scipy"], packages=["scipy==1.18.0"])
import anthropic  # noqa: E402

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from scipy import ndimage  # noqa: E402

from name_regions import check_grab_boxes  # noqa: E402  (generic: snaps zip boxes to ink)

MODEL = os.environ.get("PART_LOCATE_MODEL", "claude-opus-5")
MAX_SIDE = 1568          # longest side of the image the model sees
GRID = 100               # px between labelled grid lines, in the model's image
MAX_ROUNDS = 2           # correction rounds after the first answer
COVER_MIN = 0.5          # an outline "covers" a region at this overlap fraction
WEAK_MIN = 0.15          # below this an outline doesn't claim a region at all
TOUCH_PX = 3             # regions closer than this are neighbours (ink line between)

KINDS = ["body_panel", "side_panel", "yoke", "sleeve", "cuff", "collar", "hood",
         "placket", "zip", "pocket", "pocket_flap", "waistband", "hem_band",
         "leg", "button", "strap", "belt", "badge", "trim", "other"]
# Draw order handed to the tracer (it keeps its own structural order first).
Z_ORDER = ["body", "panel", "leg", "yoke", "sleeve", "hem", "cuff", "waistband",
           "zip", "placket", "pocket", "collar", "hood", "strap", "belt",
           "badge", "trim", "button"]
PAIRED = {"sleeve", "cuff", "leg"}   # a side-specific one of these needs its mirror
BOXED_HARDWARE = {"button", "badge"}  # may have no region of their own (see _assign)
MIRROR_MIN = 0.75                     # left/right pair (and front/back totals) size ratio

SCHEMA = {
    "type": "object",
    "properties": {
        "garment_type": {"type": "string"},
        "parts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "view": {"type": "string", "enum": ["front", "back", "side", "detail"]},
                    "side": {"type": "string", "enum": ["left", "right", "center", "none"]},
                    "kind": {"type": "string", "enum": KINDS},
                    "qualifier": {"type": "string"},
                    "polygon": {"type": "array", "items": {"type": "array", "items": {"type": "number"}}},
                },
                "required": ["view", "side", "kind", "qualifier", "polygon"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["garment_type", "parts"],
    "additionalProperties": False,
}

PROMPT = """This is a fashion technical flat sketch, possibly showing several views of
one garment (front, back, ...). The image carries a pixel grid: a line every
{grid}px, labelled with its coordinate along the top and left edges.

Outline EVERY separately cut piece of the garment in every view, as a polygon in
this image's pixel coordinates (x right, y down), tracing the piece's own outer
edge -- its seams and its edge against the background -- with enough points to
follow curves (8-40 points).

- A piece runs from seam to seam. A sleeve, for instance, runs unbroken from
  the seam where it joins the body (its armhole seam -- straight across the
  shoulder, dropped, or diagonal all the way up to the neckline) down to its
  cuff; a leg from waist to hem.
- A piece is bounded by SEAMS and garment edges. Surface lines -- quilting,
  channel stitching, rib lines, topstitching, prints, folds -- run across a
  piece; they do not end it. Follow the piece across them to its real seams.
- Applied pieces sitting on another piece (pockets, flaps, badges, buttons,
  zips, plackets) get their own outline; the piece underneath is still
  outlined whole, as if they were not there.
- view: which drawing the piece is in. side: left/right as seen by YOU looking
  at the image (the viewer's left), "center" for a piece on the centre line,
  "none" when it does not apply. kind: what the piece is. qualifier: a short
  extra word only when two pieces would otherwise share view+side+kind (e.g.
  "upper"/"lower", "inner"); otherwise "".
- Each button gets its own small outline. A zip is a narrow strip outline
  covering its teeth and pull.
- Every part of the drawing that belongs to the garment must be inside some
  outline; nothing outside the garment (labels, view names) should be.
"""

REVIEW = """The second image shows how your outlines were applied: each segmented region
of the drawing is tinted by the part it went to, with the part's name at its
centre. Compare it with the drawing piece by piece. Is every region in the right
part -- especially where a piece meets its neighbour (sleeve/body, collar/body,
cuff/sleeve, pocket/panel), and is every piece one whole cut piece rather than
split or merged with a neighbour? Return the COMPLETE list of parts, corrected
where needed (unchanged if all is right)."""

FEEDBACK = """Your previous outlines were assigned to the drawing's segmented regions and
then checked. The second image shows the result: each region tinted by the part
it went to, with the part's name at its centre. These checks failed:

{issues}

Fix the outlines so every check passes where the drawing really allows it (a
check can be legitimately unmet -- e.g. a garment with one chest pocket has no
mirror pocket -- leave those). Return the COMPLETE corrected list of parts, not
only the changed ones."""


# ------------------------------------------------------------------ images

def _grid_image(work: Image.Image, scale: float) -> Image.Image:
    im = work.convert("RGB")
    if scale != 1.0:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    try:
        font = ImageFont.truetype("Arial.ttf", 13)
    except OSError:
        font = ImageFont.load_default()
    for x in range(0, im.width, GRID):
        d.line([(x, 0), (x, im.height)], fill=(120, 170, 255), width=1)
        d.text((x + 2, 1), str(x), fill=(30, 90, 220), font=font)
    for y in range(0, im.height, GRID):
        d.line([(0, y), (im.width, y)], fill=(120, 170, 255), width=1)
        d.text((2, y + 1), str(y), fill=(30, 90, 220), font=font)
    return im


def _png_b64(im: Image.Image) -> str:
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _overlay(work: Image.Image, labels: np.ndarray, parts: dict, scale: float) -> Image.Image:
    rng = np.random.default_rng(7)
    rgb = np.array(work.convert("RGB")).astype(np.float32)
    tint = np.zeros_like(rgb)
    hit = np.zeros(labels.shape, bool)
    for nm, p in parts.items():
        m = np.isin(labels, p["regions"])
        tint[m] = rng.integers(60, 230, 3)
        hit |= m
    rgb[hit] = rgb[hit] * 0.45 + tint[hit] * 0.55
    im = Image.fromarray(rgb.astype(np.uint8))
    d = ImageDraw.Draw(im)
    for nm, p in parts.items():
        m = np.isin(labels, p["regions"])
        if m.any():
            ys, xs = np.nonzero(m)
            d.text((int(xs.mean()) - 20, int(ys.mean())), nm, fill=(0, 0, 0))
    if scale != 1.0:
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    return im


# ------------------------------------------------------------------ model

FALLBACK_MODEL = "claude-sonnet-4-6"  # what name_regions uses; served by the hosted bridge
JSON_ONLY = ("\n\nReply with ONLY a JSON object of the form "
             '{"garment_type": str, "parts": [{"view", "side", "kind", "qualifier", "polygon": [[x, y], ...]}]}'
             " -- no markdown, no explanation.")


def _last_json(text: str) -> dict | None:
    """The last top-level {...} block that parses (the model's final answer)."""
    best, depth, start = None, 0, None
    for i, ch in enumerate(text):
        if ch == "{":
            depth, start = depth + 1, (i if depth == 0 else start)
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0:
                try:
                    best = json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    pass
    return best


def _ask(client, content: list) -> dict | None:
    """One request. Non-streaming and plain-text-parsable on purpose: on the
    hosted platform the call goes through llm_bridge.py, which answers one JSON
    body (no SSE) and drops thinking/output_config -- harmless here, since the
    reply is parsed from text either way. Structured output still applies when
    calling the API directly."""
    content = content + [{"type": "text", "text": JSON_ONLY}]
    global MODEL
    for model in dict.fromkeys([MODEL, FALLBACK_MODEL]):
        try:
            msg = client.messages.create(
                model=model,
                max_tokens=16000,
                thinking={"type": "adaptive"},
                output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
                messages=[{"role": "user", "content": content}],
            )
        except (anthropic.NotFoundError, anthropic.BadRequestError, anthropic.InternalServerError) as e:
            if model == FALLBACK_MODEL:
                raise
            print(f"  {model} unavailable here ({e.__class__.__name__}) -- using {FALLBACK_MODEL}")
            MODEL = FALLBACK_MODEL
            continue
        break
    if msg.stop_reason == "refusal":
        print(f"  model declined: {getattr(msg.stop_details, 'explanation', '')}")
        return None
    text = "".join(b.text for b in msg.content if b.type == "text")
    ans = _last_json(text)
    if not ans or not isinstance(ans.get("parts"), list):
        print(f"  unreadable answer (stop_reason={msg.stop_reason})")
        return None
    return ans


# ------------------------------------------------------------------ assign

def _name_parts(raw: list, inv: float, W: int, H: int) -> list:
    """Model parts -> [{name, kind, view, side, poly (work px)}], unique names."""
    out, seen = [], {}
    for p in raw:
        poly = [(x * inv, y * inv) for x, y in (pt[:2] for pt in p["polygon"] if len(pt) >= 2)]
        if len(poly) < 3:
            continue
        bits = [p["view"]]
        if p["side"] in ("left", "right", "center"):
            bits.append(p["side"])
        if p.get("qualifier"):
            bits.append("".join(c for c in p["qualifier"].lower() if c.isalnum() or c == "_"))
        bits.append(p["kind"])
        nm = "_".join(b for b in bits if b)
        seen[nm] = seen.get(nm, 0) + 1
        if seen[nm] > 1:
            nm = f"{nm}_{seen[nm]}"
        out.append({"name": nm, "kind": p["kind"], "view": p["view"], "side": p["side"], "poly": poly})
    return out


def _assign(parts: list, labels: np.ndarray, info: dict) -> tuple[dict, list]:
    H, W = labels.shape
    ids = np.array(sorted(int(k) for k in info))
    masks, areas = [], []
    for p in parts:
        im = Image.new("1", (W, H), 0)
        ImageDraw.Draw(im).polygon(p["poly"], fill=1)
        m = np.array(im, bool)
        masks.append(m)
        areas.append(int(m.sum()))
    region_area = ndimage.sum_labels(np.ones_like(labels, bool), labels, ids)
    cover = np.stack([ndimage.sum_labels(m, labels, ids) / np.maximum(region_area, 1) for m in masks]) \
        if masks else np.zeros((0, len(ids)))
    groups = {p["name"]: {"regions": []} for p in parts}
    unassigned = []
    for j, rid in enumerate(ids):
        col = cover[:, j] if len(parts) else np.zeros(0)
        strong = [i for i in range(len(parts)) if col[i] >= COVER_MIN]
        if strong:
            i = min(strong, key=lambda k: areas[k])        # most specific outline
        elif len(col) and col.max() >= WEAK_MIN:
            i = int(col.argmax())
        else:
            unassigned.append(int(rid))
            continue
        groups[parts[i]["name"]]["regions"].append(int(rid))
    # Leftovers join the part they touch most (they sit between outlines).
    if unassigned:
        owner = np.zeros(int(labels.max()) + 1, np.int32)  # region id -> part index + 1
        for i, p in enumerate(parts):
            for r in groups[p["name"]]["regions"]:
                owner[r] = i + 1
        dil = ndimage.generate_binary_structure(2, 2)
        still = []
        for rid in unassigned:
            ring = ndimage.binary_dilation(labels == rid, dil, iterations=TOUCH_PX) & (labels != rid)
            nb = owner[labels[ring]]
            nb = nb[nb > 0]
            if nb.size:
                groups[parts[np.bincount(nb).argmax() - 1]["name"]]["regions"].append(rid)
            else:
                still.append(rid)
        unassigned = still
    for p in parts:
        # Traced from a box over their own ink rather than from regions: a zip
        # strip, and small hardware (buttons, badges) drawn ON a piece -- a
        # button's circle sits inside the placket's region and is no region of
        # its own. check_grab_boxes() snaps each box to the ink it holds.
        if p["kind"] == "zip" or (p["kind"] in BOXED_HARDWARE and not groups[p["name"]]["regions"]):
            xs, ys = [q[0] for q in p["poly"]], [q[1] for q in p["poly"]]
            x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
            if p["kind"] != "zip":
                # a few px off is normal for a small outline: look around it
                # (check_grab_boxes snaps the box back to the ink it finds)
                pad = max(6.0, 0.5 * max(x1 - x0, y1 - y0))
                x0, y0, x1, y1 = x0 - pad, y0 - pad, x1 + pad, y1 + pad
            groups[p["name"]]["grab_box"] = [max(0, int(x0)), max(0, int(y0)), min(W, int(x1) + 1), min(H, int(y1) + 1)]
    return groups, unassigned


# ------------------------------------------------------------------ checks

def _checks(parts: list, groups: dict, unassigned: list, labels: np.ndarray, info: dict) -> list:
    issues = []
    kind_of = {p["name"]: p for p in parts}
    area = lambda regs: sum(info[str(r)]["area"] for r in regs)  # noqa: E731
    if unassigned:
        issues.append(f"Regions {unassigned} lie inside no outline and touch none -- some garment area is not outlined.")
    dil = ndimage.generate_binary_structure(2, 2)
    for nm, g in groups.items():
        p = kind_of[nm]
        regs = g["regions"]
        if not regs and not g.get("grab_box"):
            issues.append(f"{nm}: its outline caught no region -- it is misplaced or traces nothing.")
            continue
        if p["kind"] == "button":
            for r in regs:
                x0, y0, x1, y1 = info[str(r)]["bbox"]
                w, h = max(1, x1 - x0), max(1, y1 - y0)
                if max(w, h) / min(w, h) >= 2.5:
                    issues.append(f"{nm}: region {r} is {w}x{h}px, a long thin sliver -- not a button "
                                  f"(rib slices of a cuff or band look like this).")
                    break
        if len(regs) > 1:   # one connected piece?
            # grown just enough to cross the ink line between two neighbours
            lab, n = ndimage.label(ndimage.binary_dilation(np.isin(labels, regs), dil, iterations=TOUCH_PX))
            comps = {}
            for r in regs:
                ys, xs = np.nonzero(labels == r)
                comps.setdefault(int(lab[ys[0], xs[0]]), []).append(r)
            if len(comps) > 1:
                pieces = sorted(comps.values(), key=area, reverse=True)
                stray = sum(area(c) for c in pieces[1:])
                if stray > 0.05 * area(regs):
                    issues.append(f"{nm} falls apart into {len(pieces)} separate pieces "
                                  f"({' | '.join(str(c) for c in pieces)}) -- one cut piece should be one connected area.")
    # left/right mirrors
    for nm, p in kind_of.items():
        if p["side"] != "left":
            continue
        twin = nm.replace("_left_", "_right_", 1) if "_left_" in nm else None
        if twin and twin in groups:
            a, b = area(groups[nm]["regions"]), area(groups[twin]["regions"])
            if min(a, b) < MIRROR_MIN * max(a, b):
                issues.append(f"{nm} ({a}px, regions {groups[nm]['regions']}) and {twin} ({b}px, regions "
                              f"{groups[twin]['regions']}) should mirror each other but differ in size "
                              f"{max(a, b) / max(1, min(a, b)):.1f}x.")
    for nm, p in kind_of.items():
        if p["kind"] in PAIRED and p["side"] in ("left", "right"):
            other = "right" if p["side"] == "left" else "left"
            twin = nm.replace(f"_{p['side']}_", f"_{other}_", 1)
            if twin not in groups:
                issues.append(f"{nm} has no {other}-side counterpart {twin}.")
    # views agree on paired limbs: same count, and about the same size -- the
    # same sleeve seen from the front and from the back covers similar area
    views = {p["view"] for p in parts if p["view"] in ("front", "back")}
    if views == {"front", "back"}:
        for kind in PAIRED:
            names = {v: [p["name"] for p in parts if p["kind"] == kind and p["view"] == v] for v in views}
            per = {v: len(n) for v, n in names.items()}
            if per["front"] != per["back"] and max(per.values()) > 0:
                issues.append(f"{kind}: {per['front']} on the front view but {per['back']} on the back view.")
            elif per["front"]:
                tot = {v: sum(area(groups[n]["regions"]) for n in names[v]) for v in views}
                if min(tot.values()) < MIRROR_MIN * max(tot.values()):
                    small = min(tot, key=tot.get)
                    regs = {n: groups[n]["regions"] for n in names[small]}
                    issues.append(f"{kind}: the {small} view's {kind}s cover {tot[small]}px but the other view's "
                                  f"cover {max(tot.values())}px -- the {small} {kind}s ({regs}) are probably "
                                  f"missing a section that went to a neighbouring part.")
    return sorted(set(issues), key=issues.index)


# ------------------------------------------------------------------ main

def main(segdir: str, out_json: str) -> None:
    info = json.load(open(os.path.join(segdir, "regions.json")))
    labels = np.load(os.path.join(segdir, "labels.npy"))
    work = Image.open(os.path.join(segdir, "work.png"))
    H, W = labels.shape
    scale = min(1.0, MAX_SIDE / max(W, H))
    inv = 1.0 / scale
    grid_b64 = _png_b64(_grid_image(work, scale))
    client = anthropic.Anthropic()

    content = [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": grid_b64}},
        {"type": "text", "text": PROMPT.format(grid=GRID)},
    ]
    best = None
    for rnd in range(MAX_ROUNDS + 1):
        ans = _ask(client, content)
        if not ans:
            break
        parts = _name_parts(ans["parts"], inv, W, H)
        groups, unassigned = _assign(parts, labels, info)
        issues = _checks(parts, groups, unassigned, labels, info)
        print(f"round {rnd}: {len(parts)} parts, {len(issues)} findings")
        for i in issues:
            print(f"  - {i}")
        # later rounds win ties: they have seen their own result
        if best is None or len(issues) <= len(best[2]):
            best = (ans, groups, issues)
        # One review round always (a self-consistent mistake passes every
        # check); after that, only while measured findings remain.
        if rnd == MAX_ROUNDS or (rnd >= 1 and not issues):
            break
        overlay_b64 = _png_b64(_overlay(work, labels, groups, scale))
        ask = FEEDBACK.format(issues="\n".join(f"- {i}" for i in issues)) if issues else REVIEW
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": grid_b64}},
            {"type": "text", "text": PROMPT.format(grid=GRID)},
            {"type": "text", "text": "Your previous answer:\n" + json.dumps(ans)},
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": overlay_b64}},
            {"type": "text", "text": ask},
        ]
    if not best:
        sys.exit("part_locate: the model returned no usable outlines")
    ans, groups, issues = best
    groups = check_grab_boxes({k: v for k, v in groups.items() if v["regions"] or v.get("grab_box")}, segdir)
    cfg = {"garment_type": ans.get("garment_type", ""), "z_order": Z_ORDER, "parts": groups,
           "method": "part_locate", "unresolved": issues}
    json.dump(cfg, open(out_json, "w"), indent=1)
    json.dump(ans, open(os.path.join(segdir, "locate_raw.json"), "w"), indent=1)
    print(f"garment: {cfg['garment_type']}")
    print(f"wrote {out_json}:")
    for nm, p in groups.items():
        print(f"  {nm}: {sorted(p['regions'])}{'  box ' + str(p['grab_box']) if p.get('grab_box') else ''}")
    if issues:
        print(f"  ({len(issues)} findings left unresolved -- see 'unresolved' in {out_json})")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: part_locate.py seg_out/ groups.json")
    main(sys.argv[1], sys.argv[2])
