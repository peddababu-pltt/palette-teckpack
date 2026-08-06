#!/usr/bin/env python3
"""
detect_parts.py — Claude Vision -> parts.json for layered_trace.py

Usage: ANTHROPIC_API_KEY=... python3 detect_parts.py sketch.png parts.json

Sends the sketch (with a coordinate grid burned in so the model can read
pixel positions accurately) and asks for part polygons in the exact schema
layered_trace.py consumes.
"""
import sys, os, json, base64, io
import anthropic
try:                                   # load .env if python-dotenv installed
    from dotenv import load_dotenv
    load_dotenv()                      # looks in current dir and parents
except ImportError:
    pass
from PIL import Image, ImageDraw

PROMPT = """You are analyzing a fashion flat sketch (technical drawing) that has a
coordinate grid overlaid: blue lines every 500px (labeled), red lines every 100px.
Image size: {W}x{H} pixels.

READ THE DRAWING BEFORE YOU ANSWER. The first key of your reply is "reading",
and you fill it in before anything else. It is not decoration -- the parts you
then emit have to agree with it:
  "reading": {{
    "surface_pattern": "what decoration is printed/stitched on, or 'none'",
    "views": {{
      "front": {{"middle": "what runs down the middle of this view: 'zip',
                           'placket', 'button stand' or 'none'",
                 "yoke_seam": false}},
      "back":  {{"middle": "none", "yoke_seam": true}}
    }}
  }}
- "middle" is what you find running from the collar or shoulder down to the hem
  in the centre of that view. If it is anything but "none", that view's body
  MUST carry a "split" (below). No exceptions.
- "yoke_seam" belongs to the BACK VIEW AND NOWHERE ELSE. A yoke is the panel
  above a seam running right across the upper back from armhole to armhole.
  A front view has no yoke -- ever -- and neither does a side view: set
  "yoke_seam": false there and emit no yoke part of any kind. Even on the back
  it is only true when that seam is actually drawn.
- "surface_pattern" is what you must then ignore everywhere else.

Then identify every garment view (front/back/side) and every construction part
in each view: body panels, sleeves, collar, yoke, zipper/placket, pockets,
waistband, cuffs, hem/rib bands, fly, hood, belt loops, etc.

For each part give a tight polygon (or box) in ACTUAL pixel coordinates.
- Sleeves: polygon following the armhole seam so the sleeve is separated from the body.
- Small applied parts (pockets, zip, cuffs): a bounding box with ~15px margin is fine.
- Do NOT let part regions of the SAME view overlap more than slightly.

SEAMS THAT SPLIT THE BODY -- GIVE THE LINE, NOT TWO SHAPES. The body of a view
is ONE {{"remainder": true}} part, and where a seam cuts it into two pattern
pieces you state that seam as a single polyline and let the cutting happen
automatically. Do NOT try to outline the two halves yourself.
  "body_panel": {{"remainder": true,
                 "split": {{"line": [[x,y],[x,y],...],
                            "names": ["left_body_panel","right_body_panel"]}}}}
The two seams that do this:
- THE FRONT OPENING. Look at the middle of the view and decide what runs down
  it: a zip, a placket, a button stand, or nothing. If there is one, trace its
  edge line from the collar/shoulder all the way down to the hem. It may run
  straight down the centre, slant across the chest like a moto zip, or bend
  partway -- follow where it actually goes, not where centre front would be.
  Put 4-10 points along it; more where it bends. Order the names left then
  right as seen in the drawing. The zip tape or placket strip itself is still
  its own separate part on top, as usual.
- THE BACK YOKE SEAM. If a seam runs right across the upper back from armhole
  to armhole, state it the same way, with names ordered top then bottom:
  ["back_yoke","back_body_panel"].
A view whose body has neither (a plain back) is just {{"remainder": true}} with
no "split". Use exactly one remainder part per view.

THE ARMHOLE IS A CUT LINE, NOT A PIECE. Where the sleeve meets the body there
is a seam, and its only job here is to say where the sleeve stops and the body
panel starts. Do NOT emit a part for the strip along it -- no "shoulder_panel",
no "armhole_panel", no "yoke" sitting on the shoulder, however much the drawing
shades or hatches that area. Cut along the armhole and give the fabric on the
outboard side to the sleeve and the fabric on the inboard side to the body
panel, so exactly two pieces meet there and nothing sits between them.
A BACK YOKE is the one exception, and it exists ONLY on the back view: it is
the panel above a seam that runs right across the upper back, well below the
shoulder line, from armhole to armhole. The test is that seam -- a yoke has its
own seam across the back; a shoulder has only the armholes either side of it.
When there is one, do not outline it either: state its seam as a "split" on the
back body, exactly as described above. Never emit a yoke on a front or side
view under any name.

SURFACE PATTERN IS NOT A PART, AND NOT A SEAM. Quilting diamonds, houndstooth,
checks, stripes, camo, polygons, squares, and the diagonal hatching ruled down a
sleeve are printed or stitched ONTO a piece. They never cut a pattern piece, and
they are never their own part. Read straight through them to the construction
seams underneath -- armhole, side seam, shoulder, yoke line, the opening -- and
put every patterned area inside whichever piece it decorates. A quilted front is
still one left panel and one right panel, not forty diamonds.
The pieces you are looking for are the ones a cutter cuts: body panels, yoke,
sleeves, cuffs, collar, waistband/hem band, placket, zip, buttons, pockets.

Respond with ONLY valid JSON, no markdown fences, in this exact schema:
{{
  "z_order": ["body","yoke","sleeve","hem","cuff","waistband","fly","zip","pocket","collar","hood"],
  "views": {{
    "front": {{
      "bbox": [x0,y0,x1,y1],
      "parts": {{
        "body": {{"remainder": true}},
        "sleeve_left": {{"poly": [[x,y],[x,y],...]}},
        "zip": {{"box": [x0,y0,x1,y1]}}
      }}
    }}
  }}
}}
Part names must contain one of the z_order keywords so z-sorting works."""

def grid_overlay(im: Image.Image) -> Image.Image:
    im = im.convert("RGB").copy()
    d = ImageDraw.Draw(im)
    W, H = im.size
    for x in range(0, W, 100):
        blue = x % 500 == 0
        d.line([(x, 0), (x, H)], fill=(0, 0, 255) if blue else (255, 120, 120), width=2)
        if blue: d.text((x + 4, 4), str(x), fill=(0, 0, 255))
    for y in range(0, H, 100):
        blue = y % 500 == 0
        d.line([(0, y), (W, y)], fill=(0, 0, 255) if blue else (255, 120, 120), width=2)
        if blue: d.text((4, y + 4), str(y), fill=(0, 0, 255))
    return im

def load_rgb(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    return im.convert("RGB")


def extract_json(t):
    t = t.strip().removeprefix("```json").removeprefix("```")
    t = t.removesuffix("```").strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        i, j = t.find("{"), t.rfind("}")
        if i != -1 and j > i:
            try:
                return json.loads(t[i:j + 1])
            except json.JSONDecodeError:
                pass
    return None


def check_reading(cfg):
    """Hold the answer to what it said it saw, and to the rules that never bend.

    The model states, before it names anything, what runs down the middle of
    each view and whether a yoke seam crosses it. Those two readings decide the
    two things that kept coming out wrong: a front opening has to cut the body
    in two, and a yoke only ever exists on the back. Checking them here means a
    reply that drifts costs a retry instead of a bad parts sheet -- and the
    check is on the model's OWN reading, so it cannot be argued with.
    """
    problems = []
    reading = (cfg.get("reading") or {}).get("views") or {}
    for view, vcfg in (cfg.get("views") or {}).items():
        parts = vcfg.get("parts") or {}
        # a yoke is a back-view piece, whatever the reading claims
        if "back" not in view.lower():
            stray = [nm for nm in parts if "yoke" in nm.lower()]
            if stray:
                for nm in stray:
                    del parts[nm]
                problems.append(f"{view} had yoke parts {stray}")
        middle = str((reading.get(view) or {}).get("middle", "none")).lower()
        if middle and middle != "none":
            if not any(p.get("split") for p in parts.values()):
                problems.append(f"{view} reads a {middle} down the middle but "
                                f"no body split was given")
    return problems


def main(in_png, out_json):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not found.\n"
                 "Create a .env file next to your scripts containing:\n"
                 "  ANTHROPIC_API_KEY=sk-ant-your-key\n"
                 "and install:  pip install python-dotenv")
    src = load_rgb(in_png)
    W, H = src.size
    g = grid_overlay(src)
    # keep under API image limits
    scale = 1.0
    if max(W, H) > 1568:
        scale = 1568 / max(W, H)
        g = g.resize((int(W * scale), int(H * scale)))
    buf = io.BytesIO(); g.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    client = anthropic.Anthropic()
    # Writing a few thousand coordinates by hand, the model occasionally fumbles
    # the punctuation -- one reply came back with "box": [185,290],[285,790],
    # two arrays where one was asked for, which fails the whole parse over a
    # single part. Nothing about the request is wrong, so ask again rather than
    # making the caller rerun the stage.
    for attempt in range(3):
        msg = client.messages.create(
            model="claude-sonnet-4-6",
            # A jacket answers with a dozen polygons of 10-25 points each, and
            # every point is a pair of 3-4 digit pixel coords -- 4000 truncated
            # mid-array and the whole call was thrown away as invalid JSON.
            max_tokens=16000,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64",
                     "media_type": "image/png", "data": b64}},
                    {"type": "text", "text": PROMPT.format(W=g.width, H=g.height)},
                ],
            }],
        )
        text = "".join(b.text for b in msg.content if b.type == "text")
        cfg = extract_json(text)
        if cfg and "views" in cfg:
            problems = check_reading(cfg)
            if not problems:
                break
            print(f"  part detection reply {attempt + 1} contradicts its own "
                  f"reading: {'; '.join(problems)}; retrying")
            cfg = None
            continue
        print(f"  part detection reply {attempt + 1} did not parse; retrying")
    if not cfg or "views" not in cfg:
        # Keep the reply. "run again" alone can't tell a truncated answer
        # (raise max_tokens) from a malformed one (fix the prompt), and the
        # difference costs another call to find out.
        raw = out_json + ".raw.txt"
        open(raw, "w").write(text)
        sys.exit(f"part detection returned invalid JSON "
                 f"(stop_reason={msg.stop_reason}, {len(text)} chars); "
                 f"raw reply saved to {raw}")

    # rescale coords back to full resolution if we downscaled
    if scale != 1.0:
        inv = 1 / scale
        def rs(v): return [round(c * inv) for c in v]
        for v in cfg["views"].values():
            v["bbox"] = rs(v["bbox"])
            for p in v["parts"].values():
                if "box" in p: p["box"] = rs(p["box"])
                if "poly" in p: p["poly"] = [rs(pt) for pt in p["poly"]]

    json.dump(cfg, open(out_json, "w"), indent=2)
    print(f"wrote {out_json}: " + ", ".join(
        f"{v} [{', '.join(vv['parts'])}]" for v, vv in cfg["views"].items()))

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
