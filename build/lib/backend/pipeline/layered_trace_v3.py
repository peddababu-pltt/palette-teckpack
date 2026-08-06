#!/usr/bin/env python3
"""
layered_trace_v2.py — Flat sketch PNG -> layered SVG (clean part extraction)

v2 fix over v1: v1 cut the image with polygon masks, which sliced through
strokes at mask borders -> neighbor lines leaked into layers and left stubs
(e.g. shoulder seam in sleeve layer, jagged rib tops in cuff layer).

v2 strategy:
  1. Threshold ink, label connected components (8-conn).
  2. NORMAL strokes (dashes, rib lines, zipper teeth, pocket welts, seams):
     assigned WHOLE to the part whose region contains the largest share of
     the stroke. Never sliced -> no stubs, no leakage.
  3. SKELETON components (the big garment outline that physically connects
     body+sleeves+collar): these are the only ones pixel-cut by the part
     polygons — and there a cut at the seam is what you actually want.
  4. Each part image traced separately with vtracer, composed at original
     coordinates into one SVG with Inkscape layers.

Usage: python3 layered_trace_v2.py input.png parts.json output.svg
parts.json schema identical to v1 (poly / box / remainder, z_order).
"""
import sys, json, re, tempfile, os
import numpy as np
from scipy import ndimage
from PIL import Image, ImageDraw
import vtracer

PATH_RE = re.compile(r'\bd="([^"]+)"')
FILL_RE = re.compile(r'fill="([^"]+)"')
TRANSFORM_RE = re.compile(r'transform="(translate\([^)]*\))"')

SPLIT_LINE_W = 3         # px; how thick a split polyline is drawn when cutting
SPLIT_MIN_SIDE = 0.04    # a side smaller than this share of the part is a sliver
                         # -- only just big enough to reject a line that merely
                         # nicks the mask. An asymmetric moto zip puts its own
                         # seam far off centre and the narrow panel is a real
                         # piece: measured at 10.8% of the body (7165px against
                         # 54121px), which a 0.12 guard threw away.


def split_mask_by_polyline(mask, line, shape):
    """Cut one part's mask in two along a polyline, returning (a, b) in order.

    A vision model can put ONE line where a seam is -- the front opening from
    collar to hem, the yoke seam across the back -- but it cannot draw the two
    panels either side of that line as polygons. Measured on a quilted moto
    bomber: asked for two front body polygons it returned 17- and 22-point
    outlines that traced to slivers, while every piece the tracer DERIVED
    (remainder, boxes) came out clean. So take the line and derive both sides
    here, the same way remainder is already derived.

    The line is extended well past the part at both ends before cutting -- a
    model states the seam over the garment only, and a cut that stops inside
    the mask leaves the two sides joined around its end. Returns None when the
    line fails to separate anything, so the caller can keep the part whole.
    """
    H, W = shape
    pts = [(float(x), float(y)) for x, y in line]
    if len(pts) < 2:
        return None
    far = 2 * max(H, W)

    def extend(p, q):        # push q outward, away from p
        dx, dy = q[0] - p[0], q[1] - p[1]
        n = (dx * dx + dy * dy) ** 0.5
        if n == 0:
            return q
        return (q[0] + dx / n * far, q[1] + dy / n * far)

    pts = [extend(pts[1], pts[0])] + pts + [extend(pts[-2], pts[-1])]
    cut = Image.new("1", (W, H), 0)
    ImageDraw.Draw(cut).line([(int(round(x)), int(round(y))) for x, y in pts],
                             fill=1, width=SPLIT_LINE_W)
    rest = mask & ~np.array(cut, bool)
    lab, n = ndimage.label(rest)
    if n < 2:
        return None
    sizes = ndimage.sum(rest, lab, range(1, n + 1))
    order = np.argsort(sizes)[::-1]
    total = float(mask.sum()) or 1.0
    if sizes[order[1]] / total < SPLIT_MIN_SIDE:
        return None
    a = lab == order[0] + 1
    b = lab == order[1] + 1
    # every leftover fragment joins whichever side its centroid sits nearer,
    # so no ink is dropped on the floor by the cut
    ca = ndimage.center_of_mass(a)
    cb = ndimage.center_of_mass(b)
    for i in order[2:]:
        frag = lab == i + 1
        cf = ndimage.center_of_mass(frag)
        da = (cf[0] - ca[0]) ** 2 + (cf[1] - ca[1]) ** 2
        db = (cf[0] - cb[0]) ** 2 + (cf[1] - cb[1]) ** 2
        if da <= db:
            a |= frag
        else:
            b |= frag
    a |= mask & ~rest & ndimage.binary_dilation(a, iterations=SPLIT_LINE_W)
    # order the two sides along the axis the line runs across: a mostly
    # vertical seam (a front opening) gives left then right, a mostly
    # horizontal one (a yoke seam) gives top then bottom.
    x0, y0 = pts[1]
    x1, y1 = pts[-2]
    vertical = abs(y1 - y0) >= abs(x1 - x0)
    ca, cb = ndimage.center_of_mass(a), ndimage.center_of_mass(b)
    key = 1 if vertical else 0        # centre_of_mass is (row, col) = (y, x)
    return (a, b) if ca[key] <= cb[key] else (b, a)


INK_THRESHOLD = 200      # gray < this = ink
SKELETON_FRAC = 0.25     # component spanning >25% of view w AND h = skeleton
OWNERSHIP_MIN = 0.70     # a part must own >50% of a stroke to claim it
STUB_MIN_AREA = 150       # px; drop tiny slivers created by skeleton cuts
SEAM_CUT = 2             # px; small skeleton-cut overlap (no visible nubs)
SEAM_BAND = 8            # px; boundary-band width for seam duplication --
                         # the band has a length filter, so closure comes
                         # from here without picking up crossing-stroke nubs


def trace(img: Image.Image) -> list[tuple[str, str | None]]:
    with tempfile.TemporaryDirectory() as td:
        pin, pout = os.path.join(td, "in.png"), os.path.join(td, "out.svg")
        img.save(pin)
        vtracer.convert_image_to_svg_py(
            pin, pout, colormode="binary", hierarchical="stacked",
            mode="spline", filter_speckle=2, corner_threshold=60,
            length_threshold=4.0, splice_threshold=45, path_precision=2)
        svg = open(pout).read()
    out = []
    for m in re.finditer(r'<path[^>]*>', svg):
        el = m.group(0)
        f = FILL_RE.search(el)
        if f and f.group(1).lower() in ("#ffffff", "#fff", "white"):
            continue
        d = PATH_RE.search(el)
        if not d:
            continue
        t = TRANSFORM_RE.search(el)
        out.append((d.group(1), t.group(1) if t else None))
    return out


def snap_parts_to_ink(cfg, ink):
    """Snap AI-estimated part boundaries onto the actual drawn seams:
    - polygon vertices -> nearest ink pixel within 25px (SNAP=1 only:
      good for AI-estimated polygons, harmful for hand-threaded ones)
    - box edges -> the strongest ink row/col within +-20px
    Cuts then land ON seams -> closed edges, no mid-air gaps."""
    H, W = ink.shape
    from scipy.spatial import cKDTree
    ys, xs = np.nonzero(ink)
    if len(ys) == 0:
        return cfg
    tree = cKDTree(np.column_stack([xs, ys]))
    snap_polys = os.environ.get("SNAP", "0") == "1"
    SEAM_BOUND = ("cuff", "hem", "waistband", "rib", "band")
    for vcfg in cfg["views"].values():
        for pname, part in vcfg["parts"].items():
            seam_part = any(k in pname for k in SEAM_BOUND)
            if "poly" in part and snap_polys:
                newp = []
                for x, y in part["poly"]:
                    d, i = tree.query([x, y], distance_upper_bound=25)
                    newp.append([int(xs[i]), int(ys[i])] if np.isfinite(d)
                                else [x, y])
                part["poly"] = newp
            elif "box" in part and seam_part:
                # only seam-bounded bands snap their edges; applied parts
                # (pockets, zip, badges) keep their generous margins
                x0, y0, x1, y1 = part["box"]
                x0, x1 = sorted((max(0, x0), min(W - 1, x1)))
                y0, y1 = sorted((max(0, y0), min(H - 1, y1)))
                def snap_row(y):
                    lo, hi = max(0, y - 20), min(H - 1, y + 20)
                    counts = ink[lo:hi + 1, x0:x1].sum(axis=1)
                    return lo + int(counts.argmax()) if counts.max() > 10 else y
                def snap_col(x):
                    lo, hi = max(0, x - 20), min(W - 1, x + 20)
                    counts = ink[y0:y1, lo:hi + 1].sum(axis=0)
                    return lo + int(counts.argmax()) if counts.max() > 10 else x
                part["box"] = [snap_col(x0), snap_row(y0),
                               snap_col(x1), snap_row(y1)]
    return cfg


def poly_mask_np(size, part) -> np.ndarray:
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    if "poly" in part:
        d.polygon([tuple(p) for p in part["poly"]], fill=255)
    else:
        d.rectangle(part["box"], fill=255)
    return np.array(m) > 0


def load_gray(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    return im.convert("L")


def main(in_png, parts_json, out_svg):
    src = load_gray(in_png)
    W, H = src.size
    a = np.array(src)
    ink = a < INK_THRESHOLD

    labels, n = ndimage.label(ink, structure=np.ones((3, 3)))
    objs = ndimage.find_objects(labels)
    areas = ndimage.sum_labels(ink, labels, index=np.arange(1, n + 1))

    cfg = json.load(open(parts_json))
    cfg = snap_parts_to_ink(cfg, ink)
    z = cfg.get("z_order", [])
    zkey = lambda name: next((i for i, k in enumerate(z) if k in name), -1)

    layers = []
    for view, vcfg in cfg["views"].items():
        x0, y0, x1, y1 = vcfg["bbox"]
        vw, vh = x1 - x0, y1 - y0
        view_box = np.zeros((H, W), bool)
        view_box[y0:y1, x0:x1] = True

        # part regions; remainder = bbox minus named siblings
        named = {nm: poly_mask_np(src.size, p)
                 for nm, p in vcfg["parts"].items() if not p.get("remainder")}
        regions = dict(named)
        for nm, p in vcfg["parts"].items():
            if p.get("remainder"):
                r = view_box.copy()
                for sm in named.values():
                    r &= ~sm
                regions[nm] = r

        # A part carrying a "split" is one piece of cloth in the drawing but two
        # pattern pieces: the front body either side of its opening, the back
        # body either side of its yoke seam. Cut it here rather than asking the
        # model to outline both halves -- see split_mask_by_polyline. Both
        # halves inherit remainder=True so every rule below treats them exactly
        # as it treated the part they came from; the remainder mask itself is
        # already built above, so re-flagging them now changes nothing else.
        for nm, p in list(vcfg["parts"].items()):
            spec = p.get("split")
            if not spec or nm not in regions:
                continue
            halves = split_mask_by_polyline(regions[nm], spec.get("line", []),
                                            (H, W))
            names = spec.get("names") or []
            if halves is None or len(names) != 2:
                print(f"  [{view}] {nm}: split line did not separate it "
                      f"-> kept whole")
                continue
            del vcfg["parts"][nm], regions[nm]
            for side, new in zip(halves, names):
                vcfg["parts"][new] = {"remainder": True}
                regions[new] = side
            print(f"  [{view}] {nm} cut along its seam -> {names[0]} + {names[1]}")

        # overlay parts (zip/fly/pockets) take priority in shared areas:
        # remove their footprint from other named parts' regions
        ov_union = np.zeros((H, W), bool)
        for _nm, _p in vcfg["parts"].items():
            if _p.get("overlay"):
                ov_union |= regions[_nm]
        for _nm, _p in vcfg["parts"].items():
            if not _p.get("overlay") and not _p.get("remainder"):
                regions[_nm] = regions[_nm] & ~ov_union

        # components belonging to this view (centroid inside bbox)
        cids = []
        for cid in range(1, n + 1):
            sl = objs[cid - 1]
            cy = (sl[0].start + sl[0].stop) / 2
            cx = (sl[1].start + sl[1].stop) / 2
            if x0 <= cx < x1 and y0 <= cy < y1:
                cids.append(cid)

        skeleton_ids, stroke_ids = [], []
        for cid in cids:
            sl = objs[cid - 1]
            ch, cw = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
            (skeleton_ids if (cw > SKELETON_FRAC * vw and ch > SKELETON_FRAC * vh)
             else stroke_ids).append(cid)

        # whole-stroke ownership
        part_pix = {nm: np.zeros((H, W), bool) for nm in regions}
        for cid in stroke_ids:
            sl = objs[cid - 1]
            cm = labels[sl] == cid
            total = cm.sum()
            best, best_frac = None, 0.0
            for nm, reg in regions.items():
                frac = (cm & reg[sl]).sum() / total
                if frac > best_frac:
                    best, best_frac = nm, frac
            if best is None:
                continue
            # claim needs majority, otherwise give to remainder(body)
            if best_frac < OWNERSHIP_MIN:
                best = next((nm for nm, p in vcfg["parts"].items()
                             if p.get("remainder")), best)
            part_pix[best][sl] |= cm

        # skeleton: cut with DILATED regions so seam strokes duplicate into
        # both neighbors -> closed boundaries; then drop tiny slivers
        dil = ndimage.generate_binary_structure(2, 2)
        regions_d = {nm: ndimage.binary_dilation(reg, dil, iterations=SEAM_CUT)
                     for nm, reg in regions.items()}
        for cid in skeleton_ids:
            sl = objs[cid - 1]
            cm = labels[sl] == cid
            for nm, reg in regions_d.items():
                piece = cm & reg[sl]
                if not piece.any():
                    continue
                plain = regions[nm][sl]
                pl, pn = ndimage.label(piece, structure=np.ones((3, 3)))
                for pi, psl in enumerate(ndimage.find_objects(pl), start=1):
                    pmask = pl[psl] == pi
                    area = pmask.sum()
                    if area < STUB_MIN_AREA:
                        continue
                    inside = (pmask & plain[psl]).sum() / area
                    if inside >= 0.35:      # tangential ring-only stubs out
                        part_pix[nm][sl][psl] |= pmask

        # boundary-band duplication: any drawn seam running along a part's
        # border is copied into that part too -> closed edges on all sides.
        # Long/elongated pieces only, so strokes merely CROSSING the border
        # don't leave stubs. Parts flagged "overlay": true (fly, zip,
        # pockets) sit ON a panel; the panel's band runs beneath them so
        # its edge stays continuous across the overlay.
        overlay_union = np.zeros((H, W), bool)
        named_solid = np.zeros((H, W), bool)   # non-overlay named parts
        for nm, p in vcfg["parts"].items():
            if p.get("overlay"):
                overlay_union |= regions[nm]
            elif not p.get("remainder"):
                named_solid |= regions[nm]
        for nm, reg in regions.items():
            if vcfg["parts"][nm].get("remainder"):
                # overlays sit ON the remainder panel: its edge runs
                # beneath them, clipped so it still follows the seams
                # of the other named parts
                basis = reg | (overlay_union & ~named_solid)
            else:
                basis = reg
            band = ndimage.binary_dilation(basis, dil, iterations=SEAM_BAND) \
                   & ~ndimage.binary_erosion(basis, dil, iterations=SEAM_BAND)
            overlay_ink = np.zeros((H, W), bool)
            for onm, op in vcfg["parts"].items():
                if op.get("overlay") and onm != nm:
                    overlay_ink |= part_pix[onm]
            cand = ink & band & view_box & ~part_pix[nm] & ~overlay_ink
            if not cand.any():
                continue
            cl, cn = ndimage.label(cand, structure=np.ones((3, 3)))
            for csl_i, csl in enumerate(ndimage.find_objects(cl), start=1):
                ch = csl[0].stop - csl[0].start
                cw = csl[1].stop - csl[1].start
                if max(ch, cw) < 60:    # seam-like: long along the border
                    continue
                pmask = cl[csl] == csl_i
                inside = (pmask & basis[csl]).sum() / pmask.sum()
                if inside >= 0.25:      # hugging outside only -> not ours
                    part_pix[nm][csl] |= pmask

        for nm, pix in part_pix.items():
            if not pix.any():
                continue
            canvas = np.full((H, W), 255, np.uint8)
            canvas[pix] = 0
            paths = trace(Image.fromarray(canvas))
            lname = f"{view}_{nm}"
            layers.append((zkey(nm), lname, paths))
            print(f"  [{lname}] {len(paths)} paths")

    layers.sort(key=lambda t: t[0])
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" '
           f'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
           f'viewBox="0 0 {W} {H}" width="{W}" height="{H}">']
    for _, name, paths in layers:
        out.append(f'  <g id="{name}" inkscape:groupmode="layer" '
                   f'inkscape:label="{name}">')
        for d, tr in paths:
            ta = f' transform="{tr}"' if tr else ''
            out.append(f'    <path d="{d}" fill="#000000" fill-rule="evenodd"{ta}/>')
        out.append('  </g>')
    out.append('</svg>')
    open(out_svg, "w").write("\n".join(out))
    print(f"wrote {out_svg} ({len(layers)} layers)")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
