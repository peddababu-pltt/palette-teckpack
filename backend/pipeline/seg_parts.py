import sys
#!/usr/bin/env python3
"""
seg_parts.py — automatic part segmentation for flat sketches.

Idea: in a technical flat, every garment part IS an enclosed white region
(sleeve interior, cuff interior, waistband interior, pocket welt...).
So instead of hand/AI polygons:

  1. ink = dark pixels; white regions = connected components of ~ink
  2. the component touching the image border = background (dropped)
  3. every other white component = a candidate part region
  4. tiny regions (rib gaps, dash gaps) are greedily merged with the
     neighbor they share the longest border with -> rib slivers cluster
     into one "cuff"/"hem" region instead of polluting the map
  5. output: labels.npy (int region map) + preview.png with numbered
     regions for naming

The masks are pixel-accurate by construction — they follow the actual
drawn seam lines, which is exactly what polygons were approximating.

Usage: python3 seg_parts.py input.png outdir [min_area]
"""
import sys, os, json
from _bootstrap_deps import ensure
ensure(modules=["scipy", "skimage"], packages=["scipy==1.18.0", "scikit-image==0.26.0"])
import numpy as np
from scipy import ndimage
from PIL import Image, ImageDraw, ImageFont
from skimage.morphology import skeletonize
from skimage.draw import line as draw_line
def _font(sz):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/System/Library/Fonts/Helvetica.ttc", "arialbd.ttf", "arial.ttf"):
        try: return ImageFont.truetype(p, sz)
        except Exception: pass
    return ImageFont.load_default()

INK_T = None   # auto (Otsu); override with env INK_T

# Size band, in px of the working image, for the applied-detail rescue in
# main(): a cluster of small regions narrower than DETAIL_MIN_W is rib/dash
# gap noise and still gets merged away; wider than DETAIL_MAX_W it is a panel,
# not a badge/patch/tab.
DETAIL_MIN_W = 20
DETAIL_MAX_W = 120
DETAIL_MAX_LEN = 300   # long side; keeps a whole placket/seam strip out

# Most ink an auto-picked threshold may cost, as a multiple of the lightest
# candidate's ink. Past this the cut is swallowing halftone shading rather
# than line art, which traces as solid black (see the pick in main()).
INK_RATIO_CAP = 1.7

# Quilt/lattice collapse (see main()). Fires only when BOTH hold, so a plain
# sketch with a handful of regions is never touched:
TILE_MIN_COUNT = 100    # a lattice means many regions, not a few panels
TILE_BAND_SHARE = 0.75  # share of them within 0.4-2.5x the median area
TILE_CERTAIN_COUNT = 150  # ...or this many regions, whatever their spread
TILE_FLOOR_MULT = 4     # how much the merge floor rises per escalation
TILE_MAX_ESCALATIONS = 2



def otsu_threshold(a):
    """Otsu with recursion: line art is a dark MINORITY, so if the split
    yields too much ink (busy/checkered background), re-split the dark side."""
    def otsu(vals):
        hist = np.bincount(vals, minlength=256).astype(np.float64)
        total = hist.sum()
        if total == 0: return 128
        csum = np.cumsum(hist)
        cmean = np.cumsum(hist * np.arange(256))
        gmean = cmean[-1] / total
        with np.errstate(divide="ignore", invalid="ignore"):
            between = (gmean * csum - cmean) ** 2 / (csum * (total - csum))
        # Every split of a single-valued slice leaves one side empty, so the
        # between-class variance is NaN at every bin and there is nothing to
        # maximise. Reached by the recursion below, which keeps narrowing to
        # the dark side until one value is all that is left -- on a sketch whose
        # hatching is drawn at one exact stroke width, that happens on the
        # stroke-width histogram and used to abort the whole segmentation.
        if not np.isfinite(between).any():
            return int(vals.min())
        return int(np.nanargmax(between))
    flat = a.ravel()
    t = otsu(flat)
    for _ in range(3):
        if (flat < t).mean() <= 0.20:
            break
        t = otsu(flat[flat < t])
    return int(np.clip(t, 100, 245))

THIN_MODE_GAP = 1.2    # px the two stroke-width classes must differ by
THIN_MIN_SHARE = 0.15  # ...and the share of centerline the thin class must hold
THIN_MAX_SHARE = 0.90  # ...and must not exceed (else it IS the line art)


def stroke_width_map(ink):
    """Per-pixel stroke width: every ink pixel takes the width measured at the
    nearest point of a centerline (2x the distance transform there). The raw
    distance transform can't be thresholded directly -- it decays to 0 at every
    stroke's own edge, so a thick line's border pixels read as thin."""
    dt = ndimage.distance_transform_edt(ink)
    sk = skeletonize(ink)
    if not sk.any():
        return np.zeros_like(dt), sk
    idx = ndimage.distance_transform_edt(~sk, return_distances=False,
                                         return_indices=True)
    return np.where(ink, 2.0 * dt[idx[0], idx[1]], 0.0), sk


def drop_thin_lines(ink):
    """Keep only the heavy strokes, so surface stitching stops enclosing regions.

    A quilted garment is drawn with its diamond lattice in the SAME ink as its
    seams, so every diamond encloses a region and no region is ever a panel.
    Raising the merge floor cannot fix that: a quilt diamond is a big chunky
    blob, so it never even reaches the sliver-merge path (which requires a short
    side under 80px) -- measured on 54d9e9f90aa9, the lattice escalation ran to
    its limit and still left 76 diamond regions and zero real panels.

    The lines themselves are what differ. Measured on that sketch, stroke widths
    are cleanly bimodal: quilt/rib hatching at ~2px (52k centerline px) against
    seams and outlines at 4-6px (19k). Cutting between the two modes dissolves
    the decoration and leaves the garment's real seam skeleton, which encloses
    the actual panels.

    Only the LABEL MAP is built from this. ink.npy and work.png keep every line,
    so the quilting is still traced and drawn -- it just stops cutting the
    garment into pieces.

    Returns (mask, cut) with mask=None when the widths are not bimodal enough to
    tell decoration from seams; the caller then leaves the ink alone.
    """
    swt, sk = stroke_width_map(ink)
    w = swt[sk]
    if w.size < 500:
        return None, None
    # Otsu over the width histogram, in 1/4-px bins so 2.0 vs 2.83 vs 4.47 are
    # actually distinguishable at this scale.
    q = np.clip(np.round(w * 4).astype(int), 0, 255)
    cut_q = otsu_threshold(q.astype(np.uint8))
    cut = cut_q / 4.0
    thin, thick = w[w < cut], w[w >= cut]
    if not thin.size or not thick.size:
        return None, None
    share = thin.size / w.size
    if thick.mean() - thin.mean() < THIN_MODE_GAP:
        print(f"  stroke widths not bimodal (thin {thin.mean():.1f}px vs thick "
              f"{thick.mean():.1f}px) -- keeping every line")
        return None, None
    if not (THIN_MIN_SHARE <= share <= THIN_MAX_SHARE):
        print(f"  thin strokes are {share:.0%} of the linework -- too "
              f"{'few' if share < THIN_MIN_SHARE else 'many'} to be surface "
              f"decoration; keeping every line")
        return None, None
    strong = ink & (swt >= cut)
    print(f"  dissolved decoration thinner than {cut:.1f}px "
          f"({share:.0%} of the centerline, mean {thin.mean():.1f}px vs "
          f"{thick.mean():.1f}px) -- seams only for region finding")
    return strong, cut


def load_gray(path):
    """Transparency-safe grayscale load: composite alpha onto white."""
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    return im.convert("L")


def validate_input(src):
    """Stage 1: is this usable line art?"""
    a = np.array(src)
    if min(src.size) < 300:
        sys.exit(f"input too small ({src.size}); need >=300px on short side")
    dark = (a < 128).mean()
    if dark > 0.45:
        sys.exit("input looks like a photo/inverted image, not line art "
                 f"({dark:.0%} dark pixels). Provide a flat sketch on a "
                 "light background.")
    if a.std() < 8:
        sys.exit("input appears blank/flat (no drawing found)")
    print(f"input ok: {src.size[0]}x{src.size[1]}, {dark:.1%} dark")


def _skeleton_endpoints(skel):
    """Pixels in a skeleton with exactly one skeleton neighbor (open ends)."""
    k = np.array([[1, 1, 1], [1, 10, 1], [1, 1, 1]])
    conv = ndimage.convolve(skel.astype(int), k, mode="constant")
    return [tuple(p) for p in np.argwhere(skel & (conv == 11))]


def _nearest_far_ink(local_ink, ep, gap_tol):
    """Within a `gap_tol`-px window around endpoint `ep`, label ink locally
    and find the nearest pixel belonging to a DIFFERENT local component than
    the endpoint's own stroke -- i.e. a separate nearby line/wall close
    enough that this stroke was clearly meant to reach it. Local labeling
    (not global connectivity) is what makes this work: within a small
    window, the stroke's own tail stays one component while a genuinely
    separate line across a short gap is a different one, even though both
    may ultimately connect to the same outer boundary far outside the
    window."""
    y, x = ep
    r0, r1 = max(0, y - gap_tol), y + gap_tol + 1
    c0, c1 = max(0, x - gap_tol), x + gap_tol + 1
    crop = local_ink[r0:r1, c0:c1]
    lab, _ = ndimage.label(crop, structure=np.ones((3, 3)))
    self_id = lab[y - r0, x - c0]
    other = crop & (lab != self_id) & (lab != 0)
    if not other.any():
        return None
    oy, ox = np.nonzero(other)
    d2 = (oy - (y - r0)) ** 2 + (ox - (x - c0)) ** 2
    j = np.argmin(d2)
    return int(oy[j] + r0), int(ox[j] + c0)


def split_dangling_seams(ink, final, min_area, gap_tol=25):
    """A 'part' is an enclosed white region sealed by ink -- but a real seam
    line the generator drew almost-but-not-quite closed (a short gap at the
    open end) leaves two true parts (e.g. sleeve+body, collar+yoke) fused
    into one big region instead of splitting them. A line anchored to the
    outer silhouette at one end is a T-junction there, not a skeleton
    endpoint -- only its free/open end shows up as one, so this looks for
    individual dangling endpoints rather than isolated strokes.

    For each oversized region, skeletonize the ink touching it and test
    every dangling endpoint: if real ink sits just out of reach (within
    `gap_tol`, past the stroke's own tip), bridge the gap and check whether
    that genuinely separates the region into two big-enough pieces. Purely
    decorative fold/roll lines that dangle in open space with nothing
    nearby to reach are left alone -- there's nothing to bridge to, so
    nothing gets cut."""
    H, W = final.shape
    next_id = int(final.max()) + 1
    dil1 = ndimage.generate_binary_structure(2, 2)
    for rid in range(1, next_id):
        mask = final == rid
        area = int(mask.sum())
        if area < min_area * 1.3:
            continue
        ys, xs = np.nonzero(mask)
        pad = gap_tol + 10
        sy0, sy1 = max(0, ys.min() - pad), min(H, ys.max() + 1 + pad)
        sx0, sx1 = max(0, xs.min() - pad), min(W, xs.max() + 1 + pad)
        sub_mask = mask[sy0:sy1, sx0:sx1]
        sub_ink = ink[sy0:sy1, sx0:sx1]
        sub_final = final[sy0:sy1, sx0:sx1]

        # ink touching (or very near) this region only -- its own boundary
        # plus any interior strokes attached to/dangling into it
        region_zone = ndimage.binary_dilation(sub_mask, dil1, iterations=2)
        local_ink = sub_ink & region_zone

        skel = skeletonize(local_ink)
        endpoints = _skeleton_endpoints(skel)
        for ep in endpoints:
            tgt = _nearest_far_ink(local_ink, ep, gap_tol)
            if tgt is None:
                continue  # dangles freely -- fold-line, nothing to bridge to

            new_barrier = sub_ink.copy()
            rr, cc = draw_line(ep[0], ep[1], tgt[0], tgt[1])
            new_barrier[rr, cc] = True

            new_white = sub_mask & ~new_barrier
            new_lab, new_n = ndimage.label(new_white)
            sizes = ndimage.sum_labels(new_white, new_lab, np.arange(1, new_n + 1))
            big = [i for i in range(1, new_n + 1) if sizes[i - 1] >= min_area * 0.5]
            if len(big) < 2:
                continue  # bridging this gap didn't actually separate two real parts

            # accept: rewrite this region's pixels with the new sub-labels
            keep_final = sub_final.copy()
            keep_final[sub_mask] = 0
            for j, i in enumerate(big):
                new_id = rid if j == 0 else next_id
                if j > 0:
                    next_id += 1
                keep_final[new_lab == i] = new_id
            final[sy0:sy1, sx0:sx1] = keep_final
            print(f"  split region {rid}: bridged a dangling seam endpoint "
                  f"-> {len(big)} parts")
            break  # re-derive this region's state before trying more splits on it
    return final


def main(in_png, outdir, min_area=1500, _tile_escalations=0, _drop_thin=False):
    min_area_arg = int(min_area)
    os.makedirs(outdir, exist_ok=True)
    src = load_gray(in_png)
    validate_input(src)
    # thin-line sketches trace badly at low res: upscale small images 2x
    if max(src.size) < 1400:
        src = src.resize((src.width * 2, src.height * 2), Image.LANCZOS)
        min_area = int(min_area) * 4
        print(f"upscaled 2x -> {src.size}")
    # trim near-solid dark bars on the edges (common screenshot artifact)
    aa = np.array(src)
    rows = (aa < 100).mean(axis=1); cols = (aa < 100).mean(axis=0)
    top = 0
    while top < len(rows) and rows[top] > 0.9: top += 1
    bot = len(rows)
    while bot > top and rows[bot - 1] > 0.9: bot -= 1
    left = 0
    while left < len(cols) and cols[left] > 0.9: left += 1
    right = len(cols)
    while right > left and cols[right - 1] > 0.9: right -= 1
    if (top, left, bot, right) != (0, 0, len(rows), len(cols)):
        pad = np.full_like(aa, 255)
        pad[top:bot, left:right] = aa[top:bot, left:right]
        src = Image.fromarray(pad)
        print(f"trimmed edge bars -> content rows {top}:{bot}, cols {left}:{right}")
    # strip artificial view-divider lines: a ruler-straight line someone
    # drew between side-by-side front/back views (or similar) shows up as
    # its OWN fully isolated connected component spanning nearly the whole
    # canvas height/width while staying only a few px wide. A real seam
    # line is never isolated like that -- it always links into the rest of
    # the linework (collar/hem/sleeve strokes all touch each other), so its
    # connected component's bbox is wide/tall in BOTH dimensions.
    aa = np.array(src)
    H0, W0 = aa.shape
    dlab, dn = ndimage.label(aa < 160, structure=np.ones((3, 3)))
    if dn:
        objs = ndimage.find_objects(dlab)
        for i, sl in enumerate(objs, start=1):
            bh, bw = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
            if (bh >= 0.8 * H0 and bw <= 20) or (bw >= 0.8 * W0 and bh <= 20):
                aa[dlab == i] = 255
                print(f"  stripped view-divider line: bbox "
                      f"{sl[1].start},{sl[0].start},{sl[1].stop},{sl[0].stop}")
        src = Image.fromarray(aa)
    src.save(os.path.join(outdir, "work.png"))   # canonical working image
    a = np.array(src)
    H, W = a.shape
    seal = int(os.environ.get("SEAL", "2"))

    def remove_pattern_noise(ink_):
        """Kill periodic background patterns (checkerboards, halftone dots):
        any size-class of small components repeated 150+ times is noise."""
        lab_, n_ = ndimage.label(ink_, structure=np.ones((3, 3)))
        if n_ < 200:
            return ink_
        areas = ndimage.sum_labels(ink_, lab_, np.arange(1, n_ + 1))
        small = areas[areas < 2000]
        if len(small) < 150:
            return ink_
        kill = np.zeros(n_ + 1, bool)
        cents = ndimage.center_of_mass(ink_, lab_, np.arange(1, n_ + 1))
        cents = np.array(cents)                # (n, 2) = (y, x)
        my, mx = ink_.shape[0] * 0.06, ink_.shape[1] * 0.06
        in_margin = ((cents[:, 0] < my) | (cents[:, 0] > ink_.shape[0] - my) |
                     (cents[:, 1] < mx) | (cents[:, 1] > ink_.shape[1] - mx))
        bins = np.bincount(np.round(np.sqrt(np.maximum(areas, 1))).astype(int)
                           [areas < 2000], minlength=64)
        Himg, Wimg = ink_.shape
        for r, cnt in enumerate(bins):
            if cnt < 150:
                continue
            lo, hi = (r - 1) ** 2, (r + 2) ** 2
            cls = (areas >= lo) & (areas <= hi)
            # true background noise (checkerboard/halftone):
            #  (a) reaches the image margins, AND
            #  (b) spreads over most of the canvas in BOTH directions.
            # Ribbing/zipper teeth/dashes cluster in small bands -> kept.
            if (cls & in_margin).sum() < 15:
                continue
            cc = cents[cls]
            spread_y = (cc[:, 0].max() - cc[:, 0].min()) / Himg
            spread_x = (cc[:, 1].max() - cc[:, 1].min()) / Wimg
            if spread_y > 0.7 and spread_x > 0.7:
                kill[1:][cls] = True
        if kill.any():
            ink_ = ink_ & ~kill[lab_]
            print(f"  pattern noise removed: {int(kill.sum())} blobs")
        return ink_

    def enclosure_count(t):
        ink_ = remove_pattern_noise(a < t)
        barrier_ = ndimage.binary_closing(ink_, structure=np.ones((3, 3)),
                                          iterations=seal)
        lab_, n_ = ndimage.label(~barrier_)
        if n_ == 0:
            return 0, None, None
        bord = set(np.unique(np.concatenate(
            [lab_[0], lab_[-1], lab_[:, 0], lab_[:, -1]]))); bord.discard(0)
        szs = ndimage.sum_labels(~barrier_, lab_, np.arange(1, n_ + 1))
        cnt = sum(1 for i in range(1, n_ + 1)
                  if i not in bord and szs[i - 1] >= min_area)
        return cnt, ink_, barrier_

    if "INK_T" in os.environ:
        t = int(os.environ["INK_T"])
        _, ink, barrier = enclosure_count(t)
        print(f"ink threshold: {t} (env)")
    else:
        # candidate: just below the dominant background tone(s) --
        # handles baked-in checkerboard/noise backgrounds
        hist = np.bincount(a.ravel(), minlength=256).astype(float)
        k = np.ones(5) / 5
        sm = np.convolve(hist, k, mode="same")
        top2 = np.argsort(sm)[-40:]
        t_bg = int(max(100, min(top2[top2 > 150].min() - 8 if
                                (top2 > 150).any() else 200, 245)))
        # pick the threshold that closes the most garment parts;
        # ties -> the one with LESS ink (cleaner background)
        cands = sorted({otsu_threshold(a), 200, 230, 160, t_bg})
        scored = []
        for t in cands:
            (n_enc, ink_, barrier_) = enclosure_count(t)
            scored.append((n_enc, -(a < t).mean(), t, ink_, barrier_))
        # A cut that closes more regions ONLY by swallowing far more ink is
        # reading SHADING as line art. Halftone/dot fills -- a grey inside-neck
        # panel, a grey zip tape -- sit around 210-230, so a high cut turns
        # them into ink, and dots that dense trace as one solid black mass.
        # Measured across five sketches: every honest cut costs at most 1.6x
        # the lightest candidate's ink, while the one that swallowed a
        # halftone cost 2.1x (and 4 extra "regions" that were shading).
        floor = min(-s[1] for s in scored)
        allowed = [s for s in scored if -s[1] <= floor * INK_RATIO_CAP]
        dropped = [s[2] for s in scored if s not in allowed]
        n_enc, _negfrac, t, ink, barrier = max(allowed or scored)
        print(f"ink threshold: {t} (auto, {n_enc} enclosed parts; "
              f"tried {cands})")
        if dropped:
            print(f"  rejected {dropped} -- over {INK_RATIO_CAP}x the "
                  f"lightest candidate's ink (shading, not line art)")
    open(os.path.join(outdir, "threshold.txt"), "w").write(str(t))
    np.save(os.path.join(outdir, "ink.npy"), ink)   # cleaned ink for tracing

    # Surface stitching (quilt lattice, rib hatching) encloses regions exactly
    # like a seam does. When the pass below has flagged this sketch as a
    # lattice, find the regions from the heavy strokes alone -- the saved ink
    # above is untouched, so tracing still draws every line.
    seg_ink = ink
    if _drop_thin:
        strong, _cut = drop_thin_lines(ink)
        if strong is not None:
            seg_ink = strong
            barrier = ndimage.binary_closing(strong, structure=np.ones((3, 3)),
                                             iterations=seal)

    white = ~barrier
    lab, n = ndimage.label(white)          # 4-connectivity: lines seal regions
    # background = any white component touching the border
    border_ids = set(np.unique(np.concatenate(
        [lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
    border_ids.discard(0)

    sizes = ndimage.sum_labels(white, lab, np.arange(1, n + 1))
    dil = ndimage.generate_binary_structure(2, 2)

    # greedy merge: smallest region below min_area joins the neighbor
    # (excluding background) it shares the longest border with
    ids = [i for i in range(1, n + 1) if i not in border_ids]
    ids.sort(key=lambda i: sizes[i - 1])
    objs = ndimage.find_objects(lab)
    merged_into = {}
    def root(i):
        while i in merged_into: i = merged_into[i]
        return i

    # ---- applied-detail rescue, BEFORE the greedy merge below ----
    # A badge/patch/placket/tab is drawn with its own interior marks (a logo
    # circle, a hatch panel, a button), which cut its inside into several
    # pieces that are each under min_area. Merged one at a time into whichever
    # big panel they border, the entire detail dissolves into that panel and
    # can never be named as its own part -- measured on a puffer sleeve badge:
    # two ~1000px halves, both absorbed into the sleeve, no badge region at all.
    # So cluster mutually-touching small regions FIRST. If a cluster adds up to
    # a real region AND is detail-shaped, keep it as ONE region; the greedy
    # merge then sees it as already big enough and leaves it standing.
    # Shape gate both ways: narrower than DETAIL_MIN_W is a rib/dash sliver
    # (still merges), wider than DETAIL_MAX_W is a panel, not an applied piece.
    protected = set()
    small = [i for i in ids if sizes[i - 1] < min_area]
    small_set = set(small)
    cluster_of = {i: i for i in small}

    def croot(x):
        while cluster_of[x] != x:
            cluster_of[x] = cluster_of[cluster_of[x]]
            x = cluster_of[x]
        return x

    for i in small:
        rs = objs[i - 1]
        sl = (slice(max(0, rs[0].start - 10), min(H, rs[0].stop + 10)),
              slice(max(0, rs[1].start - 10), min(W, rs[1].stop + 10)))
        m = lab[sl] == i
        ring = ndimage.binary_dilation(m, dil, iterations=8) & ~m
        for v in np.unique(lab[sl][ring]):
            v = int(v)
            if v in small_set and v != i:
                a_, b_ = croot(i), croot(v)
                if a_ != b_:
                    cluster_of[a_] = b_
    clusters = {}
    for i in small:
        clusters.setdefault(croot(i), []).append(i)
    for members in clusters.values():
        if len(members) < 2:
            continue
        # Floor is min_area//4, not min_area: an applied detail is by nature
        # smaller than a panel, and min_area//4 is already the size below
        # which the rebuild step drops a region outright. Shape does the real
        # gating -- a detail is compact, so cap the LONG side too or a whole
        # placket strip (measured: 96x1140) walks through the short-side gate.
        total = int(sum(sizes[j - 1] for j in members))
        if total < min_area // 4:
            continue
        boxes = [objs[j - 1] for j in members]
        ch = max(b[0].stop for b in boxes) - min(b[0].start for b in boxes)
        cw = max(b[1].stop for b in boxes) - min(b[1].start for b in boxes)
        if not (DETAIL_MIN_W <= min(ch, cw) <= DETAIL_MAX_W):
            continue
        if max(ch, cw) > DETAIL_MAX_LEN:
            continue
        keep = members[0]
        for j in members[1:]:
            merged_into[j] = keep
        sizes[keep - 1] = total
        # Exempt it explicitly. Unioning alone changes nothing: the cluster is
        # still under min_area, so the greedy pass below would merge the whole
        # thing into the panel anyway (verified -- the region map came out
        # byte-identical until this set existed).
        protected.add(keep)
        print(f"  applied detail kept: {len(members)} pieces -> one "
              f"{cw}x{ch} region ({total}px)")

    for i in ids:
        if root(i) in protected:
            continue
        if sizes[root(i) - 1] >= min_area or root(i) != i:
            continue
        raw_sl = objs[i - 1]
        # thin slivers (rib gaps, dash gaps) are narrow in their short
        # dimension; a small-AREA but chunky/elongated blob (e.g. a yoke or
        # shoulder detail strip) is a real garment panel, not gap noise --
        # leave it standing on its own instead of swallowing it into
        # whichever bigger neighbor (often the sleeve) it borders longest.
        rh = raw_sl[0].stop - raw_sl[0].start
        rw = raw_sl[1].stop - raw_sl[1].start
        if min(rh, rw) > 80:
            continue
        sl = (slice(max(0, raw_sl[0].start - 8), min(H, raw_sl[0].stop + 8)),
              slice(max(0, raw_sl[1].start - 8), min(W, raw_sl[1].stop + 8)))
        m = lab[sl] == i
        ring = ndimage.binary_dilation(m, dil, iterations=6) & ~m
        cand = lab[sl][ring]
        cand = cand[(cand != 0)]
        cand = np.array([root(c) for c in cand], dtype=np.int64)
        if len(cand):
            keep = np.array([c not in border_ids for c in cand], dtype=bool)
            cand = cand[keep]
        if len(cand) == 0:
            continue
        vals, counts = np.unique(cand, return_counts=True)
        target = int(vals[counts.argmax()])
        if target == i:
            continue
        merged_into[i] = target
        sizes[target - 1] += sizes[i - 1]

    # rebuild final label map
    final = np.zeros((H, W), np.int32)
    remap, next_id = {}, 1
    for i in range(1, n + 1):
        if i in border_ids:
            continue
        r = root(i)
        if r in border_ids or sizes[r - 1] < min_area // 4:
            continue
        if r not in remap:
            remap[r] = next_id; next_id += 1
        final[lab == i] = remap[r]

    final = split_dangling_seams(seg_ink, final, min_area)
    next_id = int(final.max()) + 1

    np.save(os.path.join(outdir, "labels.npy"), final)

    # preview with numbered centroids (from the cleaned working image)
    prev = src.convert("RGB")
    d = ImageDraw.Draw(prev)
    rng = np.random.default_rng(0)
    overlay = Image.new("RGBA", prev.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    info = {}
    for rid in range(1, next_id):
        m = final == rid
        area = int(m.sum())
        ys, xs = np.nonzero(m)
        cy, cx = int(ys.mean()), int(xs.mean())
        col = tuple(int(c) for c in rng.integers(60, 220, 3)) + (90,)
        # paint region tint (coarse: bbox of mask rows sampled)
        idx = np.nonzero(m)
        pts = list(zip(idx[1][::97].tolist(), idx[0][::97].tolist()))
        for x, y in pts:
            od.point((x, y), fill=col)
        fs = max(22, min(48, int(area ** 0.5 / 6)))
        d.text((cx, cy), str(rid), fill=(255, 0, 0), font=_font(fs),
               anchor="mm", stroke_width=3, stroke_fill=(255, 255, 255))
        info[rid] = {"area": area, "centroid": [cx, cy],
                     "bbox": [int(xs.min()), int(ys.min()),
                              int(xs.max()), int(ys.max())]}
    prev = Image.alpha_composite(prev.convert("RGBA"), overlay).convert("RGB")
    prev.save(os.path.join(outdir, "preview.png"))
    json.dump(info, open(os.path.join(outdir, "regions.json"), "w"), indent=1)
    print(f"{next_id - 1} regions -> {outdir}/labels.npy, preview.png, regions.json")

    # ---- quilt/lattice collapse ----
    # Quilting and other all-over stitch patterns are surface decoration, but
    # they are drawn in the same ink as a seam, so every diamond they enclose
    # segments as its own region and the panel never exists as one shape. A
    # quilted bomber came out as 255 regions where a plain shirt gives 26,
    # which left the naming model hand-sorting 255 tiles into 32 parts -- and
    # that is how waistband tiles ended up in the body panel and pocket tiles
    # on the sleeve.
    #
    # A lattice is recognisable without reading the lines: it tiles an area
    # with MANY regions of near-uniform size, where real garment pieces vary
    # wildly (a body panel dwarfs a cuff). Measured on the final region sets:
    #     quilted bomber  255 regions, 95% within 0.4-2.5x the median area
    #     plain shirt      26 regions, 50%
    #     unquilted bomber 87 regions, 60%
    # Both gates are needed. Uniformity alone keeps firing once the tiles are
    # gone (18 real panels scored 94%), so the count is what says "these are
    # tiles, not pieces".
    #
    # First repair: find the regions from the heavy strokes only, so the lattice
    # stops enclosing anything (drop_thin_lines). This is what actually works on
    # an all-over quilt, because the tiles there are big chunky diamonds:
    #   - they clear min_area, so no merge floor ever reaches them, and raising
    #     the floor only made the greedy pass chain them into whichever
    #     neighbour they border longest -- which happily crosses the armhole and
    #     waistband seams. Measured on 54d9e9f90aa9: escalation ran out at 76
    #     diamond regions, sleeves came out holding body chunks and the
    #     waistband, and no region was ever a panel.
    #
    # Second repair, for lattices whose lines are NOT distinguishable by weight:
    # a higher merge floor. The greedy merge folds a sub-floor region into the
    # neighbour it shares the longest border with, which for a small quilt tile
    # is the panel it sits on. No lines are dropped either way; they simply stop
    # cutting the garment into pieces.
    areas = np.array([v["area"] for v in info.values()])
    if len(areas) >= TILE_MIN_COUNT and _tile_escalations < TILE_MAX_ESCALATIONS:
        med = float(np.median(areas))
        share = float(((areas > med * 0.4) & (areas < med * 2.5)).mean())
        # The uniformity figures quoted above were measured at a coarser merge
        # floor than flat2svg_auto actually passes (1500). At that floor the
        # stitch ticks, dash gaps and rib slivers that a higher floor merges
        # away all survive, and they widen the area spread enough to sink the
        # share below the gate: the SAME quilted bomber scores 79% at floor 6000
        # (158 regions, fires) and 67% at 1500 (242 regions, does not). Worse,
        # the share no longer separates -- across this project's sketches the
        # busiest honest one scores 68% at 73 regions, ABOVE the lattice's 67%.
        # The count still separates cleanly (242 against at most 73), and no
        # garment flat has 150 pieces, so past that a lattice is the only thing
        # this can be and uniformity gets no vote.
        if share >= TILE_BAND_SHARE or len(areas) >= TILE_CERTAIN_COUNT:
            if not _drop_thin:
                print(f"  lattice: {len(areas)} regions, {share:.0%} within "
                      f"0.4-2.5x the median ({int(med)}px) -> re-segmenting "
                      f"from the heavy strokes only")
                return main(in_png, outdir, min_area_arg, _tile_escalations, True)
            nxt = int(min_area_arg * TILE_FLOOR_MULT)
            print(f"  lattice: {len(areas)} regions, {share:.0%} within "
                  f"0.4-2.5x the median ({int(med)}px) -> re-segmenting with "
                  f"merge floor {nxt} so tiles fold into their panel")
            return main(in_png, outdir, nxt, _tile_escalations + 1, _drop_thin)

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 6000)
