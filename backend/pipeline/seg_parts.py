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
import json
import os
import sys

from _bootstrap_deps import ensure

ensure(modules=["scipy", "skimage"], packages=["scipy==1.18.0", "scikit-image==0.26.0"])
import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from scipy import ndimage  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402
from skimage.draw import line as draw_line  # noqa: E402
from skimage.morphology import skeletonize  # noqa: E402


def _font(sz):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/System/Library/Fonts/Helvetica.ttc", "arialbd.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(p, sz)
        except Exception:
            pass
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

# Tracing ink is cut at each line's own half-darkness edge (see trace_edge_ink):
# a pixel stays ink only if darker than halfway between the darkest pixel
# near it (the stroke's core) and the paper. The cut picked above is for
# ENCLOSING regions and often lands high (227 on the bomber), which takes in
# every stroke's anti-aliased halo: lines traced ~2x their drawn width and rib
# hatching closed up into solid black bands. Both the paper tone and the
# search window are measured per image, so any sketch -- any garment, any
# resolution, any line weight or paper tint -- gets its own edge.
TRACE_EDGE = os.environ.get("TRACE_EDGE", "1") != "0"

# Faint-line bridge for the saved tracing ink (see bridge_faint_lines).
BRIDGE_WEAK_T = int(os.environ.get("BRIDGE_WEAK_T", "215"))  # 0 disables
BRIDGE_BODY_T = 200   # grey kept at full width along a bridged hairline
BRIDGE_MIN_LEN = 30   # px of centerline a run needs without seeding ink

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
        if total == 0:
            return 128
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


def trace_edge_ink(a, ink):
    """`ink` trimmed to each stroke's 50%-darkness edge: a black outline loses
    its grey halo, a faint grey line keeps its own (higher) halfway level.

    paper  -- the image's own background: the median of the pixels outside
              the ink (a cream or grey scan is not 255).
    window -- wide enough to reach a stroke's core from its outer halo: twice
              the stroke's half-width (distance-transform ridge, 95th
              percentile so the heaviest outlines are covered), plus a margin.
    """
    if not TRACE_EDGE or not ink.any() or ink.all():
        return ink
    paper = int(np.median(a[~ink]))
    dt = ndimage.distance_transform_edt(ink)
    ridge = dt[(dt > 0) & (dt >= ndimage.maximum_filter(dt, size=3))]
    half = float(np.percentile(ridge, 95)) if ridge.size else 2.0
    win = int(min(31, max(5, 2 * round(half) + 3))) | 1
    core = ndimage.minimum_filter(a.astype(np.int16), size=win)
    # a pixel only as dark as the paper (no stroke near it) never counts
    return ink & (a < (core + paper) // 2) & (core < paper - 8)


def bridge_faint_lines(a, ink, t):
    """Rejoin hairlines the ink threshold broke into dashes. Tracing ink only.

    Quilt lattices and rib hatching are drawn 1px wide in grey: their cores
    sit at ~110-170 and the anti-aliased runs between them at ~170-215. A cut
    picked for enclosing panels (160 on the quilted bomber) keeps only the
    cores, so every lattice line came out as hundreds of separate ticks (926
    components there against 72 at a 200 cut). remove_pattern_noise then
    deleted the ticks spread across the canvas, and the tracer filed the rest
    as stitch dashes -- the SVG drew the quilting as broken scratches.

    Hysteresis: grey pixels under BRIDGE_WEAK_T are kept when their component
    already holds ink (or, for a run whose cores the noise pass removed, holds
    pixels under the cut and is at least BRIDGE_MIN_LEN long, so isolated
    halftone dots stay out). What gets added is the line's own grey body,
    centerline guaranteed 4-connected so a 1px diagonal does not pinch to
    nothing in the tracer -- and never next to a heavy stroke, so outline
    weight is unchanged.
    """
    weak = a < BRIDGE_WEAK_T
    if t >= BRIDGE_WEAK_T or not weak.any():
        return ink
    lab, n = ndimage.label(weak, structure=np.ones((3, 3)))
    sk = skeletonize(weak)
    slen = ndimage.sum_labels(sk, lab, np.arange(n + 1))
    keep = np.zeros(n + 1, bool)
    keep[np.unique(lab[ink])] = True
    cored = np.unique(lab[a < t])
    keep[cored] |= slen[cored] >= BRIDGE_MIN_LEN
    keep[0] = False
    hy = keep[lab]
    cross = ndimage.generate_binary_structure(2, 1)
    near_heavy = ndimage.binary_dilation(
        ndimage.distance_transform_edt(ink) >= 2, cross, iterations=3)
    add = (ndimage.binary_dilation(sk & hy, cross) & hy) | (hy & (a < BRIDGE_BODY_T))
    out = ink | (add & ~near_heavy)
    if out.sum() > ink.sum() * INK_RATIO_CAP:
        # Grew like shading, not like hairlines: leave the ink alone.
        print(f"  faint-line bridge skipped ({int(out.sum())}px vs "
              f"{int(ink.sum())}px ink)")
        return ink
    print(f"  faint-line bridge: +{int(out.sum() - ink.sum())}px")
    return out


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


# Grey surface-design layer (see TWO_TONE_RULE in warp_pattern.py): prints,
# stripes, texture and quilting are drawn as their own flat light grey
# (~#A6A6A6) strokes that never touch the black line art. They must not become
# parts or SVG layers, so they are removed before anything is segmented. A
# stroke is judged as a whole: every connected mark whose DARKEST pixel is
# still lighter than GREY_DESIGN_MIN is grey design and goes; a black line,
# however faint its anti-aliased hairline gets, is connected to a near-black
# core and stays. GREY_DESIGN_MIN=0 disables.
GREY_DESIGN_MIN = int(os.environ.get("GREY_DESIGN_MIN", "130"))
GREY_DESIGN_INK = 228  # what still counts as a mark at all (paper is ~255)


GREY_SPECK_MAX = 40   # px: a mark this small touching grey design is part of it
GREY_PIXEL_MIN = 100  # a pixel at least this light can be grey design...
GREY_CORE_T = 90      # ...unless within GREY_CORE_EDGE px of a pixel darker
GREY_CORE_EDGE = 2    # than this (a black stroke's own anti-aliased edge)
GREY_RUN_MIN = int(os.environ.get("GREY_RUN_MIN", "40"))  # px: shortest grey run kept
# Texture fields (mesh, dot/check prints): hundreds of tiny marks whose
# darkness straddles GREY_DESIGN_MIN, so the darkness rule kept the darker half
# as black ink and sent the rest to grey.png -- and the tracer then dropped the
# black dots as specks/stitch marks, leaving the yoke blank in patches with
# black scraps. A mark that small with that many small neighbours in 2D is
# texture as a whole. A dash run or a zip's teeth is 1D and never gets near
# TEXTURE_MIN_NEIGHBOURS within the radius; buttons and snaps are isolated.
TEXTURE_MARK_MAX = int(os.environ.get("TEXTURE_MARK_MAX", "40"))   # px area
TEXTURE_RADIUS = int(os.environ.get("TEXTURE_RADIUS", "20"))       # px
TEXTURE_MIN_NEIGHBOURS = int(os.environ.get("TEXTURE_MIN_NEIGHBOURS", "15"))  # 0 disables
TEXTURE_CLUMP_MAX = int(os.environ.get("TEXTURE_CLUMP_MAX", "300"))
                   # px area: a few dots fused into one mark inside the same
                   # field is texture too (left black, the tracer read the
                   # clumps as buttons). Judged by the SMALL marks around it,
                   # so an isolated button or snap never qualifies.
TEXTURE_MAX_ASPECT = float(os.environ.get("TEXTURE_MAX_ASPECT", "2.5"))
TEXTURE_HALO_T = int(os.environ.get("TEXTURE_HALO_T", "210"))
TEXTURE_RESIDUE_DENSITY = float(os.environ.get("TEXTURE_RESIDUE_DENSITY", "0.15"))


def texture_field(a):
    """Pixel mask of dense dot/mesh texture (see TEXTURE_MARK_MAX).

    Labelled 4-connected, not 8: mesh dots touch diagonally, and chained
    corner to corner they join the garment outline into one huge 8-connected
    mark that no per-mark rule can split -- the yoke kept a black border of
    dots that the tracer dropped, leaving white patches. Only compact marks
    count (>= 3px, aspect <= TEXTURE_MAX_ASPECT), so a 1px diagonal hairline
    that 4-connectivity cuts into single pixels is never mistaken for dots."""
    lab4, n4 = ndimage.label(a < GREY_DESIGN_INK)
    if not n4:
        return None
    idx = np.arange(1, n4 + 1)
    areas = ndimage.sum_labels(np.ones_like(a), lab4, idx)
    objs = ndimage.find_objects(lab4)
    hw = np.array([(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start) for sl in objs])
    aspect = hw.max(axis=1) / np.maximum(1, hw.min(axis=1))
    compact = (areas >= 3) & (aspect <= TEXTURE_MAX_ASPECT)
    small = np.nonzero(compact & (areas <= TEXTURE_MARK_MAX))[0]
    if len(small) <= TEXTURE_MIN_NEIGHBOURS:
        return None
    cen = np.array(ndimage.center_of_mass(np.ones_like(a), lab4, small + 1))
    near_n = np.array([len(x) - 1 for x in
                       cKDTree(cen).query_ball_point(cen, TEXTURE_RADIUS)])
    in_field = near_n >= TEXTURE_MIN_NEIGHBOURS
    if not in_field.any():
        return None
    # A dot on the field's own edge has half the neighbours of one inside
    # it; let it join on a third of the count, all of which must already be
    # field marks.
    edge_n = np.array([len(x) for x in cKDTree(cen[in_field]).query_ball_point(
        cen, TEXTURE_RADIUS)])
    in_field |= edge_n >= max(1, TEXTURE_MIN_NEIGHBOURS // 3)
    field = small[in_field]
    clump = np.nonzero(compact & (areas > TEXTURE_MARK_MAX) & (areas <= TEXTURE_CLUMP_MAX))[0]
    if len(clump):
        ccen = np.array(ndimage.center_of_mass(np.ones_like(a), lab4, clump + 1))
        c_n = np.array([len(x) for x in
                        cKDTree(cen[in_field]).query_ball_point(ccen, TEXTURE_RADIUS)])
        field = np.concatenate([field, clump[c_n >= TEXTURE_MIN_NEIGHBOURS]])
    keep = np.zeros(n4 + 1, bool)
    keep[field + 1] = True
    return keep[lab4]


TEXTURE_ZONE = os.environ.get("TEXTURE_ZONE", "1") != "0"
TEXTURE_ZONE_DENSITY = 0.18   # ink fraction in a 15px window
TEXTURE_ZONE_COHERENCE = 0.35  # below = no dominant direction (mesh/check/dots)
TEXTURE_ZONE_MIN_AREA = 1500   # px: smaller patches are not a fabric zone
TEXTURE_ZONE_GROW = 12         # px: reach from the zone core out to its seams
TEXTURE_LINE_CORE = 60         # darker than this inside a zone = a real seam


def texture_zone(a):
    """Pixel mask of all-over texture (mesh, check, dense dots) and none of
    the seams running through or around it.

    Per-mark rules split a connected mesh into a patchwork -- part of it grey,
    part left as black ink the tracer then dropped -- so the yoke came out
    with white patches and black scraps. A texture zone is found from local
    structure instead: dense ink with NO dominant direction (low structure-
    tensor coherence). Lines, rib ticks, quilting and stripes are all strongly
    oriented and never qualify; on the garments tested only the mesh yokes
    did. Inside the zone, a seam is told from the texture by darkness: the
    mesh never prints darker than ~80 while drawn lines have near-black cores,
    so pixels within 2px of a <TEXTURE_LINE_CORE core stay black ink."""
    f = a.astype(np.float32)
    dens = ndimage.uniform_filter((f < 200).astype(np.float32), 15)
    g = ndimage.gaussian_filter(f, 1.0)
    gx, gy = ndimage.sobel(g, 1), ndimage.sobel(g, 0)
    jxx = ndimage.gaussian_filter(gx * gx, 5)
    jyy = ndimage.gaussian_filter(gy * gy, 5)
    jxy = ndimage.gaussian_filter(gx * gy, 5)
    tr = jxx + jyy
    coh = np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (tr + 1e-6)
    z = ((dens >= TEXTURE_ZONE_DENSITY) & (coh <= TEXTURE_ZONE_COHERENCE)
         & (tr > np.percentile(tr, 50)))
    z = ndimage.binary_opening(z, iterations=3)
    lab, n = ndimage.label(z)
    if not n:
        return None
    ar = ndimage.sum_labels(z, lab, np.arange(1, n + 1))
    z = np.isin(lab, np.nonzero(ar >= TEXTURE_ZONE_MIN_AREA)[0] + 1)
    if not z.any():
        return None
    z = ndimage.binary_dilation(ndimage.binary_fill_holes(z), iterations=TEXTURE_ZONE_GROW)
    core = a < TEXTURE_LINE_CORE
    # an isolated dark fleck inside the mesh is texture, not a seam
    cl, cn = ndimage.label(core & z, structure=np.ones((3, 3)))
    if cn:
        small = ndimage.sum_labels(np.ones_like(a), cl, np.arange(1, cn + 1)) < 20
        core &= ~np.concatenate([[False], small])[cl]
    keep = ndimage.binary_dilation(core, iterations=2)
    return (a < GREY_DESIGN_INK) & z & ~keep


def strip_grey_design(img):
    """-> (black-only image, grey-design mask). The mask is kept, not thrown
    away: layered_trace_v4 paints it back in grey inside each part's own
    layer, so the SVG shows the texture without it ever becoming a part."""
    a = np.array(img)
    none = np.zeros(a.shape, bool)
    if not GREY_DESIGN_MIN:
        return img, none
    lab, n = ndimage.label(a < GREY_DESIGN_INK, structure=np.ones((3, 3)))
    if not n:
        return img, none
    idx = np.arange(1, n + 1)
    darkest = ndimage.minimum(a, lab, idx)
    is_grey = darkest >= GREY_DESIGN_MIN
    areas = ndimage.sum_labels(np.ones_like(a), lab, idx)
    tex = texture_field(a) if TEXTURE_MIN_NEIGHBOURS else None
    zone = texture_zone(a) if TEXTURE_ZONE else None
    if zone is not None:
        tex = zone if tex is None else (tex | zone)
    grey = np.concatenate([[False], is_grey])[lab]
    if tex is not None and tex.any():
        print(f"grey design: {int((tex & ~grey).sum())}px of texture-field dots moved to grey")
        grey |= tex
    # Pixel rule on top of the whole-mark rule: the redraw does not always
    # keep its grey lines clear of the black ones, and one quilting lattice
    # touching the outline makes the whole lattice a single mark with a black
    # pixel in it (measured: quilt line centres at ~198, all of it kept as
    # black ink). A pixel that is clearly grey AND farther than a black
    # stroke's own anti-aliased edge from any near-black core is design ink.
    core = a < GREY_CORE_T
    near_core = ndimage.binary_dilation(core, iterations=GREY_CORE_EDGE)
    cand = (a < GREY_DESIGN_INK) & (a >= GREY_PIXEL_MIN) & ~near_core
    # Only long runs: a thin BLACK line's faint edge pixels pass the test too,
    # in short broken bits along it, and pulling those out split sleeve
    # stripes and rib ticks into scribbly black+grey fragments. Real grey
    # design (a quilting line, a stripe) is one long run of its own.
    cl, cn = ndimage.label(cand, structure=np.ones((3, 3)))
    if cn:
        sizes = ndimage.sum_labels(cand, cl, np.arange(1, cn + 1))
        grey |= np.concatenate([[False], sizes >= GREY_RUN_MIN])[cl]
    # Where two grey lines cross, or a grey line clips another, the overlap
    # prints darker than either line and splits off as its own tiny mark that
    # passes the darkness test -- it was traced as a black dot at every
    # quilting crossing. A speck that small sitting on grey design is grey.
    near = ndimage.binary_dilation(grey, iterations=2)
    touches = ndimage.maximum(near, lab, idx).astype(bool)
    speck = (~is_grey) & (areas <= GREY_SPECK_MAX) & touches
    grey |= np.concatenate([[False], speck])[lab]
    if TEXTURE_MIN_NEIGHBOURS and grey.any():
        # The pixel rule peels a connected dot lattice down to its darkest
        # cores, leaving 1-8px black bits all over the texture that the tracer
        # then reads as buttons. A mark that small in an area this dense with
        # grey design is part of it (a quilting line is ~5% of such a window).
        density = ndimage.uniform_filter(grey.astype(np.float32), 2 * TEXTURE_RADIUS + 1)
        rl, rn = ndimage.label((a < GREY_DESIGN_INK) & ~grey, structure=np.ones((3, 3)))
        if rn:
            ridx = np.arange(1, rn + 1)
            r_area = ndimage.sum_labels(np.ones_like(a), rl, ridx)
            r_dens = ndimage.mean(density, rl, ridx)
            residue = (r_area <= TEXTURE_MARK_MAX) & (r_dens >= TEXTURE_RESIDUE_DENSITY)
            grey |= np.concatenate([[False], residue])[rl]
    out = a.copy()
    out[grey] = 255
    if not grey.any():
        return img, none
    print(f"grey design: {int(is_grey.sum())} grey marks + {int(speck.sum())} "
          f"crossing specks ({grey.mean() * 100:.2f}% of canvas) -> grey.png, "
          f"black line art only for segmentation")
    return Image.fromarray(out), grey


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


FILL_GAP_MAX = 30  # px: farthest an enclosed unlabeled pixel may sit from a region


# A sealed rib band (see fill_enclosed_gaps): at least this many separate white
# strips between rib lines, packed this close together.
RIB_BAND_MIN_STRIPS = 3
RIB_BAND_JOIN_PX = 4


def _rib_bands(gaps, final, min_area):
    """Groups of enclosed white strips that are a whole rib band with no region.

    When ribbing is drawn tighter than the barrier closing's reach (gaps of
    ~4px), every strip between the rib lines is sealed shut, so a rib cuff gets
    NO region at all -- not even a small one to hand its leftover white to. Its
    outline then belonged to nothing but a sliver of the sleeve, and the cuff
    came out of the SVG with broken sides and open corners. Strips packed
    together like that are one band: returned as label masks to become their
    own region (closed across the rib lines between them)."""
    joined = ndimage.binary_dilation(gaps, structure=np.ones((3, 3)), iterations=RIB_BAND_JOIN_PX)
    gl, gn = ndimage.label(joined)
    bands = []
    for g in range(1, gn + 1):
        zone = gl == g
        strips = gaps & zone
        _, ns = ndimage.label(strips)
        if ns < RIB_BAND_MIN_STRIPS:
            continue
        # the band's body: its strips plus the rib ink between them, kept off
        # every region that already exists
        body = ndimage.binary_closing(strips, structure=np.ones((3, 3)),
                                      iterations=RIB_BAND_JOIN_PX) & (final == 0)
        body = ndimage.binary_fill_holes(body) & (final == 0)
        if body.sum() < min_area // 4:
            continue
        bands.append(body)
    return bands


def fill_enclosed_gaps(ink, final, min_area=0):
    """Hand enclosed white the segmentation left unlabeled to the nearest region.

    The barrier closing that seals hairline breaks also fills tight gaps
    between rib lines, so the white at the ends of a rib cuff/hem band
    becomes no region at all. The band's region then stops short of its own
    end ribs and edge, the tracer's boundary band never reaches that ink, and
    the cuff came out of the SVG with its ends and bottom edge missing. White
    that the RAW ink fully encloses (not connected to the page background) is
    garment interior by definition, so it joins the closest region.
    """
    white = ~ink
    wl, _ = ndimage.label(white)
    border = np.unique(np.concatenate([wl[0], wl[-1], wl[:, 0], wl[:, -1]]))
    gaps = white & ~np.isin(wl, border) & (final == 0)
    if not gaps.any() or not final.any():
        return final
    # whole rib bands that got no region become regions of their own first
    if min_area:
        final = final.copy()
        for band in _rib_bands(gaps, final, min_area):
            final[band] = int(final.max()) + 1
            gaps &= ~band
            print(f"rib band sealed shut by the closing: kept as its own region ({int(band.sum())}px)")
    dist, (iy, ix) = ndimage.distance_transform_edt(final == 0, return_indices=True)
    take = gaps & (dist <= FILL_GAP_MAX)
    out = final.copy()
    out[take] = final[iy[take], ix[take]]
    print(f"enclosed gaps: {int(take.sum())}px of unlabeled interior joined "
          f"to the nearest region")
    return out


OUTSIDE_MARGIN = int(os.environ.get("OUTSIDE_MARGIN", "15"))   # px; 0 disables
OUTSIDE_MAX_FRAC = 0.01   # only marks this small vs the biggest drawing go


def strip_outside_marks(src):
    """Drop caption text that sits entirely outside the garment drawing --
    "FRONT" / "BACK" labels. Nothing out there is a piece, but
    caption letters are rings (O, R, B, A) and were traced as buttons on the
    nearest part (the hem). The silhouette is every large drawing (each view)
    with its holes filled, grown by OUTSIDE_MARGIN so a detached drawcord tip
    or a detail drawn just off the edge still counts as inside."""
    if not OUTSIDE_MARGIN:
        return src
    aa = np.array(src)
    lab, n = ndimage.label(aa < 160, structure=np.ones((3, 3)))
    if n < 2:
        return src
    areas = ndimage.sum_labels(np.ones_like(aa), lab, np.arange(1, n + 1))
    biggest = areas.max()
    garment = np.isin(lab, np.nonzero(areas >= biggest * 0.05)[0] + 1)
    sil = ndimage.binary_dilation(ndimage.binary_fill_holes(garment),
                                  iterations=OUTSIDE_MARGIN)
    inside = ndimage.maximum(sil, lab, np.arange(1, n + 1)).astype(bool)
    out = np.nonzero((~inside) & (areas < biggest * OUTSIDE_MAX_FRAC))[0]
    if not len(out):
        return src
    # Outside the filled silhouette is not proof on its own: a view whose
    # outline is drawn broken never fills, and its seams would read as
    # outside. Only drop what looks like a caption -- letter-sized marks of
    # similar height sitting in a row with each other. (Not bare specks: a
    # faint raw flat draws whole seams as dotted fragments.)
    objs = ndimage.find_objects(lab)
    H = aa.shape[0]
    box = np.array([(objs[i][0].start, objs[i][0].stop, objs[i][1].start, objs[i][1].stop)
                    for i in out])
    hh = box[:, 1] - box[:, 0]
    ww = box[:, 3] - box[:, 2]
    cy = (box[:, 0] + box[:, 1]) / 2
    cx = (box[:, 2] + box[:, 3]) / 2
    letter = (hh >= 6) & (hh <= 0.06 * H) & (ww <= 1.6 * hh)
    drop = np.zeros(n, bool)
    for k, i in enumerate(out):
        if not letter[k]:
            continue
        row = (letter & (np.abs(cy - cy[k]) < 0.3 * hh[k])
               & (np.abs(hh - hh[k]) < 0.4 * hh[k]) & (np.abs(cx - cx[k]) < 3 * hh[k]))
        row[k] = False
        drop[i] = row.any()
    if not drop.any():
        return src
    aa[np.concatenate([[False], drop])[lab]] = 255
    print(f"  stripped {int(drop.sum())} marks outside the garment (captions, specks)")
    return Image.fromarray(aa)


def main(in_png, outdir, min_area=1500, _tile_escalations=0, _drop_thin=False):
    min_area_arg = int(min_area)
    os.makedirs(outdir, exist_ok=True)
    src = load_gray(in_png)
    validate_input(src)
    src, grey = strip_grey_design(src)
    # Grey design at the input's own resolution; layered_trace_v4 resizes it
    # onto work.png (which is this image at most upscaled and edge-trimmed).
    grey_img = np.full(grey.shape, 255, np.uint8)
    grey_img[grey] = np.array(load_gray(in_png))[grey]
    if TEXTURE_MIN_NEIGHBOURS and grey.any():
        # Inside a dense dot field, the dots' light anti-aliased halos touch
        # corner to corner, and the traced grey layer fused the mesh into
        # worm-like strands. Dropping the halo there keeps every dot its own
        # mark. Quilting and stripe lines are far below the field density and
        # keep their full weight.
        dense = ndimage.uniform_filter(grey.astype(np.float32),
                                       2 * TEXTURE_RADIUS + 1) >= TEXTURE_RESIDUE_DENSITY
        grey_img[grey & dense & (grey_img >= TEXTURE_HALO_T)] = 255
    Image.fromarray(grey_img).save(os.path.join(outdir, "grey.png"))
    # thin-line sketches trace badly at low res: upscale small images 2x
    if max(src.size) < 1400:
        src = src.resize((src.width * 2, src.height * 2), Image.LANCZOS)
        min_area = int(min_area) * 4
        print(f"upscaled 2x -> {src.size}")
    # trim near-solid dark bars on the edges (common screenshot artifact)
    aa = np.array(src)
    rows = (aa < 100).mean(axis=1)
    cols = (aa < 100).mean(axis=0)
    top = 0
    while top < len(rows) and rows[top] > 0.9:
        top += 1
    bot = len(rows)
    while bot > top and rows[bot - 1] > 0.9:
        bot -= 1
    left = 0
    while left < len(cols) and cols[left] > 0.9:
        left += 1
    right = len(cols)
    while right > left and cols[right - 1] > 0.9:
        right -= 1
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
    src = strip_outside_marks(src)
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
            [lab_[0], lab_[-1], lab_[:, 0], lab_[:, -1]])))
        bord.discard(0)
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
    # cleaned ink for tracing; segmentation below keeps the unbridged cut
    np.save(os.path.join(outdir, "ink.npy"), trace_edge_ink(a, bridge_faint_lines(a, ink, t)))

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
        while i in merged_into:
            i = merged_into[i]
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
            remap[r] = next_id
            next_id += 1
        final[lab == i] = remap[r]

    final = split_dangling_seams(seg_ink, final, min_area)
    final = fill_enclosed_gaps(ink, final, min_area)
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
