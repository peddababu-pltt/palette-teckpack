
#!/usr/bin/env python3
"""
layered_trace_v4.py — layered SVG from AUTO-SEGMENTED region masks.

Pipeline:  sketch.png -> seg_parts.py -> labels.npy (+ preview to name)
                     -> groups.json (name -> region ids)
                     -> this script -> layered SVG

Assignment rule (simple + robust):
    layer_ink(part) = ink  ∩  dilate(union of part's white regions, BAND)

Because a drawn seam line sits BETWEEN two white regions, it lands inside
the dilation of both -> shared seams are duplicated into both layers and
every part is closed on all sides, automatically. Interior strokes
(creases, stitching, rib lines) are surrounded by their own region's
white, so they go to exactly one layer.

Optional per-part "grab_box": whole ink components whose majority falls
inside the box are moved EXCLUSIVELY to this part (for things like zipper
guard stitching that geometrically sits inside the body region).

groups.json:
{
  "z_order": ["body","yoke","sleeve","hem","cuff","zip","pocket","collar"],
  "parts": {
     "front_body":   {"regions": [6,7]},
     "front_zip":    {"regions": [8,9], "grab_box": [655,185,765,1345]},
     ...
  }
}
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from _bootstrap_deps import ensure

ensure(modules=["scipy", "vtracer", "svgpathtools"],
       packages=["scipy==1.18.0", "vtracer==0.6.15", "svgpathtools==1.7.2"])
import numpy as np  # noqa: E402
import vtracer  # noqa: E402
from _svg_render import svg2png  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from scipy import ndimage  # noqa: E402
from svgpathtools import parse_path  # noqa: E402


def _resolve_potrace():
    """Prefer a system potrace (dev machines with it on PATH). The Palette
    hosted runtime has no apt/Docker hook to install one -- pyproject.toml
    only ships pip packages -- so without a fallback, every hosted run
    silently drops to trace_vtracer(), which fuses thin gaps (rib lines,
    hood double-lines, pleat ladders) into solid black and can silently
    return zero paths on some canvases. bin/potrace is built from potrace
    1.16 source with `-all-static` (see bin/README.md) specifically so it
    carries no glibc version dependency at all -- an earlier version of this
    fallback dynamically linked against the host's libc.so.6, which broke on
    any hosted runtime whose glibc predated whatever build host produced it
    (surfaced as `potrace: ... GLIBC_2.38' not found`, not a load-bearing
    trace failure)."""
    found = shutil.which("potrace")
    if found:
        return found
    bin_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin")
    bundled = os.path.join(bin_dir, "potrace")
    if os.path.isfile(bundled) and os.access(bundled, os.X_OK):
        return bundled
    return None


POTRACE_BIN = _resolve_potrace()
# buttons / stitch-dashes: small, compact, isolated marks. vtracer's spline
# fit + speckle filter blur or drop these; potrace (turdsize=0, no curve
# smoothing) traces tiny bitonal detail faithfully. Anything bigger than
# this stays on vtracer (better for long smooth seam curves).
FINE_DETAIL_AREA = 400
FINE_DETAIL_DIM = 40
BUTTON_SIZE_MULT = 3.0   # a fine mark with no hole in it counts as a button
                         # only if it is this many times the MEDIAN fine-mark
                         # area in the same sketch (see classify_fine_detail)

BAND = 8
MIN_SYNTH_AREA = 12   # drop synthesized gap-fill blobs smaller than this (px area);
                      # was 40, which ate short corner/tip closures (armhole
                      # corner, sleeve tip, yoke side edge)
THICKEN = None   # dilate captured ink before tracing (px); env THICKEN
                 # default: 1 (evens out thin anti-aliased strokes)
TRACE_NATIVE = os.environ.get("TRACE_NATIVE", "1") != "0"
                       # Trace the thinned mask at NATIVE resolution instead of
                       # at the supersample the sub-pixel thinning needs. See
                       # the tail of thin_canvas: tracing the upscaled mask is
                       # what made every cutline a sawtooth. 0 restores it.
SMOOTH_SIGMA = float(os.environ.get("SMOOTH_SIGMA", "0.5"))
                       # Gaussian blur applied to the thinned mask, in SOURCE px
                       # (scaled by the supersample factor), before it is
                       # averaged back down to native resolution. This is what
                       # carries the sub-pixel edge position through the
                       # downsample; 0 loses the thinning entirely, and much
                       # above 0.5 starts rounding real corners.
NAT_CUT = float(os.environ.get("NAT_CUT", "0.5"))
                       # how much of a native pixel the thinned mask must cover
                       # for that pixel to stay ink when the supersampled mask
                       # is averaged back down. Lower keeps more weight.
NAT_CLOSE = int(os.environ.get("NAT_CLOSE", "1"))
                       # native-resolution closing iterations after that
                       # downsample, clipped to the un-thinned ink -- heals the
                       # necks the block threshold severs (see thin_canvas).
OPT_TOL = float(os.environ.get("OPT_TOL", "1.0"))
                       # potrace curve-fit deviation budget, in SOURCE px (it
                       # is scaled by the supersample factor before being
                       # handed over as -O; see run_potrace). potrace's own
                       # default of 0.2 canvas px is 0.05 source px on the 4x
                       # thinning canvas, which makes the fit trace the pixel
                       # staircase faithfully instead of riding through it: a
                       # long straight cutline comes out as a visible chain of
                       # steps with the stroke width wobbling along it. 1.0
                       # source px lets the fit cut the corner of each step
                       # while staying inside the drawn stroke's own width.
ALPHA_MAX = float(os.environ.get("ALPHA_MAX", "1.0"))
                       # potrace corner threshold (-a). Left at potrace's
                       # default: it is an angle, so raising it does not smooth
                       # the staircase, it rounds off the genuine corners of a
                       # panel (a pocket's square bottom, a placket's step).
TURD = float(os.environ.get("TURD", "2.0"))
                       # -t for the SMOOTHED pass only, in source px^2 (scaled
                       # by ss^2). Drops the 1-2px crumbs the thinning erosion
                       # leaves clinging to a stroke, which potrace otherwise
                       # traces as its own little island and reads as a lump on
                       # the edge. The fine-detail pass keeps -t 0 -- there,
                       # every tiny mark is real (see trace_potrace).
MAX_TRACE_DIM = 4096   # vtracer returns NOTHING, silently, on a canvas much
                       # bigger than this -- crop/downscale to fit (see trace)
TRACE_PAD = 4          # px of white kept around the ink in that crop
BOX_EDGE_KEEP = 3      # px around a part's own region that another part's
                       # grab_box may never cut away (its own boundary line)
RAIL_MARGIN = 16       # how far outside a grab_box that part's own ink still
                       # counts as its own (a zip's tape rails) -- see main()
CROSS_TOL = 40         # ink a boxed part may carry beyond that strip before it
                       # is judged a line merely passing through, not its own
SYNTH_BRIDGE = 6       # px of gap between closure fragments that gets bridged
                       # so a filled gap draws as one solid line
STITCH_CLEARANCE = 0   # px of clear white to force between a stitch dash run
                       # and the outline. 0 = never touch the stitching (see
                       # the trim in main())
DASH_KEEPOUT = int(os.environ.get("DASH_KEEPOUT", "2"))
                       # a dash run blocks closure this far out: no synthesized
                       # line is drawn where stitching already runs.
                       # DASH_KEEPOUT=0 closes pieces whose only boundary on a
                       # side is topstitch (a hem drawn as a dashed top edge
                       # comes out closed instead of an open U) -- but it also
                       # lays a solid cut line under EVERY dash-only seam, and
                       # a center-back seam the sketch draws as dashes alone
                       # then renders as a solid line with dashes on top of it.
                       # Faithfulness to the sketch wins: default stays 2.
THIN = 0.25      # shave this many px off EACH SIDE of the captured ink before
                 # tracing -> thinner black outline in the SVG. Fractional on
                 # purpose: sketch strokes here are only ~2-3px wide, so a full
                 # 1px-per-side erosion eats them down to fragments that
                 # vtracer's speckle filter then drops (dashed-looking seams).
                 #
                 # Was 0.75, tuned while the REGION_OUTLINE ring was still
                 # drawn on every side (see RING_ON_INK). The ring fused with
                 # the drawn stroke it ran beside, so the pair measured as one
                 # heavy line and 0.75px per side came off a ~4px stroke. With
                 # the doubling gone, the same cut lands on the 2px drawn line
                 # alone and shaves it to a half-pixel: measured on the bomber
                 # (17 parts, ring fix in place) 0.75 breaks the back body's
                 # outline open and loses 14.6% of the source ink to no part at
                 # all, 0.5 still traces the back body open, and 0.25 comes out
                 # clean on every check_layers test -- including the 9.7%
                 # uncovered ink the doubled-line build used to report.
                 # Env THIN overrides; ignored when THICKEN > 0; THIN=0 gives
                 # the old full-weight lines.
TRIM_SS = 4   # grab_box trim (zip teeth, guard stitching) is thresholded and
              # traced at this multiple of native resolution -- see the
              # grab_box branch in main()
KEEP_HALF_W = 0.5  # ink whose local half-width is within this much of the cut
                   # depth is already as light as THIN aims for -> left at full
                   # weight instead of being erased (see thin_canvas)
# Canonical layer order, bottom to top: the garment's structural pieces are
# laid down first -- collar, yoke, sleeves, body panels, waistband -- each one
# closed on all sides by REGION_OUTLINE below, and only then the applied
# detail (zip, placket, pockets, buttons, cuffs, badges, stitching) is drawn
# over those boundaries. Keywords are matched as substrings of a part name, so
# "front_left_shoulder_yoke" lands on "yoke" and "back_hem_band" on "hem".
APPLIED_NAMES = ("pocket", "welt", "badge", "label", "patch", "tab")
                   # pieces that are, by what they are, sewn ONTO another
                   # piece. Used only to answer "is this applied?" when the
                   # geometry is ambiguous -- see the containment test in
                   # main(). Flaps are excluded on purpose: a flap is applied
                   # to the POCKET, and the geometric test already finds it.
STRUCTURAL_Z = [
    # structural shells, each closed on all sides before anything is drawn on
    # them. "body" precedes "panel" so front_body_panel sorts as a body, and
    # "side_panel" still lands on panel.
    "collar", "hood", "yoke", "sleeve", "body", "panel", "leg",
    "waistband", "hem", "cuff",
    # applied components, drawn over those boundaries
    "pocket", "zip", "fly", "placket", "button",
    "belt", "strap", "drawcord", "badge", "label", "trim",
    # internal construction detail, last
    "stitch", "dart", "pleat", "fold",
]

REGION_OUTLINE = os.environ.get("REGION_OUTLINE", "1") != "0"
OUTLINE_PX = int(os.environ.get("OUTLINE_PX", "0")) or None
                   # Ring thickness in px. 0/unset measures the sketch's own
                   # stroke width and matches it (see stroke_width_of).
                   #
                   # Fixed at 1, the ring came out a hairline beside 2-3px
                   # drawn strokes, so a piece whose edge the sketch never drew
                   # -- a patch pocket's bag outline, a panel edge under an
                   # applied piece -- read as a faint grey line while the rest
                   # of the same piece read black. Same cut line, two weights.
                   # Close every part on ALL sides by outlining its own region
                   # mask, instead of relying purely on captured ink.
                   #
                   # A part's ink is whatever the artist drew, so a side whose
                   # seam the sketch never draws -- or draws as dashes, or
                   # hands to the neighbouring piece -- leaves that side open,
                   # and the piece cannot be cut. Its REGION, though, is a
                   # filled connected component straight out of seg_parts, so
                   # its boundary is closed by construction. Ringing the region
                   # gives a guaranteed-closed outline that still lands on the
                   # drawn line wherever one exists (the region boundary sits
                   # directly inside it), and supplies one only where it does
                   # not. REGION_OUTLINE=0 restores the ink-only behaviour.
RING_KEEPOUT_OFF = os.environ.get("RING_KEEPOUT", "").lower() == "off"
RING_KEEPOUT = -1 if RING_KEEPOUT_OFF else int(os.environ.get("RING_KEEPOUT", "-1"))
                   # px the stitch mask is GROWN by before the REGION_OUTLINE
                   # ring is switched off along it. The ring is dropped where a
                   # dash mark sits, because that side is drawn already and
                   # ringing it prints a second edge alongside the first.
                   #
                   # -1 (default) MEASURES the run's own dash pitch and bridges
                   # it, so the ring goes from the whole dashed seam rather than
                   # only from the marks. Anything less leaves ring fragments
                   # sitting in the white gaps between dashes, and leaving the
                   # keepout off entirely -- what the old `> 0` gate did at its
                   # own default of 0 -- draws the ring along the seam from BOTH
                   # of the pieces it divides, which is the pair of solid rails
                   # that turned every quilt baffle into a ladder.
                   # 0 subtracts the marks and nothing more; a positive value
                   # forces that many px; RING_KEEPOUT=off disables the keepout.
                   #
                   # Closure does not depend on this: ring_full[] is copied
                   # BEFORE the keepout, so each piece still carries a complete
                   # perimeter for extraction even where the visible ring is
                   # dropped and the drawn stitching belongs to its neighbour.
AUTO_ZIP_POLY = os.environ.get("AUTO_ZIP_POLY", "1") != "0"
                   # 0 disables deriving a rotated strip for slanted zips and
                   # goes back to trusting the naming model's axis-aligned box.
DASH_BRIDGE_MAX = 14   # ceiling on the measured pitch, so one freak component
                       # cannot erase a ring far from any stitching
RING_ON_INK = os.environ.get("RING_ON_INK", "0") != "0"
                   # 1 restores the old behaviour: the REGION_OUTLINE ring is
                   # drawn on EVERY side of every part, including the sides the
                   # sketch already drew. The ring lies immediately inside the
                   # region boundary and the drawn stroke lies immediately
                   # outside it, so the two fuse into one heavy black line --
                   # or, where a seam runs between two of a part's own
                   # sub-regions and RING_SEAL cannot weld the slit shut, into
                   # a drawn line flanked by a ring on each side. That is what
                   # rib bands and cuffs came out as: mostly hairline ribs with
                   # a handful rendered as solid black bars, and a doubled
                   # top/bottom edge on the band itself.
                   #
                   # Default 0 keeps the ring only where this part's own
                   # captured ink does NOT already run (see the subtraction in
                   # main()). The comparison is against the part's OWN cap, not
                   # against ink globally: a shared seam is drawn once and may
                   # be owned by the neighbouring piece, and subtracting global
                   # ink would leave that side with neither line nor ring.
                   # Extraction closure does not depend on this either way --
                   # ring_full[] already carries each part's complete perimeter
                   # as invisible geometry (see BOUNDARY_FILL).
RING_INK_PAD = int(os.environ.get("RING_INK_PAD", "0"))
                   # extra px, ON TOP of the stroke half-width, that the part's
                   # own captured ink is grown by before the visible ring is
                   # switched off along it.
                   #
                   # Was a hard-coded +2, to keep the ring out of the white gaps
                   # of a dashed seam. That reason no longer holds -- dash marks
                   # are stripped from `cap` before this point (cap &= ~fine_all),
                   # so nothing in cap is a dash run -- and the cost was severe:
                   # +2 grows every ink fragment into a 4px-wide veto, which
                   # spans the real breaks in a hairline seam and deletes the
                   # ring along the piece's WHOLE perimeter (measured on
                   # 83ab80984b39: back_body_panel's ring went 3216 -> 0px, and
                   # the panel still traced with visible gaps in its side seam
                   # and across its top). At 0 the veto is only as wide as the
                   # stroke itself, so a genuine break keeps its ring and the
                   # outline closes with a hairline exactly across the gap.
RING_PX = int(os.environ.get("RING_PX", "1"))
                   # Thickness of the VISIBLE ring, in px. Now that the ring is
                   # only drawn on undrawn sides it no longer has to match the
                   # weight of a stroke it sits beside, so it is a hairline: the
                   # composed drawing stacks layer on layer and every doubled
                   # or over-weight edge compounds. The invisible
                   # complete-boundary copy keeps the measured stroke width
                   # (outline_px) so it stays solid for extraction.
RING_SEAL = int(os.environ.get("RING_SEAL", "4"))
                   # px the region union is closed by before REGION_OUTLINE
                   # rings it, welding shut the hairline slits left by the
                   # seam lines drawn BETWEEN a part's own sub-regions.
                   # Measured on the puffer sketch: 53,148 px of ring across
                   # all parts unsealed, 31,714 at 4 -- the 21k difference is
                   # entirely invented cutline running along dashed seams.
                   # RING_SEAL=0 restores the old union ring.
CLOSE_BREAKS = int(os.environ.get("CLOSE_BREAKS", "3"))
                   # closing iterations applied after thinning, in supersampled
                   # px, to heal hairline breaks the erosion opens in a stroke
                   # that sits right at the cut depth (see thin_canvas).
                   # CLOSE_BREAKS=1 is the old behaviour.
INK_T = None   # auto (Otsu) / threshold.txt next to labels / env INK_T
PATH_RE = re.compile(r'\bd="([^"]+)"')
FILL_RE = re.compile(r'fill="([^"]+)"')
TR_RE = re.compile(r'transform="(translate\([^)]*\))"')
TR_OFF_RE = re.compile(r"translate\(([-\d.]+),\s*([-\d.]+)\)")


def is_background_fill(fill):
    """True for white / near-white path fills (the traced page background)."""
    f = fill.strip().lower()
    if f in ("#ffffff", "#fff", "white", "none"):
        return True
    m = re.fullmatch(r"#([0-9a-f]{6})", f)
    if not m:
        return False
    v = int(m.group(1), 16)
    return min((v >> 16) & 255, (v >> 8) & 255, v & 255) >= 240


def is_canvas_rect(d, w, h, tol=2.0):
    """True for a single subpath whose every point sits on the canvas border --
    i.e. the tracer's full-page background rectangle. Checking that ALL points
    are on the border (not just the bounding box) is what keeps a real garment
    outline, which spans the full canvas bbox but runs through its interior,
    from being mistaken for the page."""
    if d.count("M") + d.count("m") != 1:
        return False
    try:
        path = parse_path(d)
    except Exception:
        return False
    pts = []
    for seg in path:
        pts += [seg.start, seg.end]
        for attr in ("control1", "control2", "control"):
            c = getattr(seg, attr, None)
            if c is not None:
                pts.append(c)
    if not pts:
        return False
    return all(min(abs(p.real), abs(w - p.real)) <= tol
               or min(abs(p.imag), abs(h - p.imag)) <= tol for p in pts)


def dash_bridge_px(dash_mask):
    """How far to grow a dash mask so a run of marks becomes one solid strip.

    A dashed seam is a line the sketch has ALREADY drawn, so the synthesized
    region ring must not be laid along it. Subtracting the marks alone is not
    enough -- the ring survives in the white gap between every pair of dashes
    and the seam comes out as a drawn line woven through a broken one. Growing
    by the run's own pitch closes those gaps, and the pitch has to be measured
    rather than fixed: it scales with the sketch's resolution.

    Estimated from the median dash's own longest side, which is the same order
    as the gap that follows it, and capped so a stray long component cannot
    rub out ring far from any stitching.
    """
    lab, n = ndimage.label(dash_mask, structure=np.ones((3, 3)))
    if not n:
        return 0
    spans = []
    for sl in ndimage.find_objects(lab):
        spans.append(max(sl[0].stop - sl[0].start, sl[1].stop - sl[1].start))
    return int(min(DASH_BRIDGE_MAX, max(1, np.median(spans))))


def oriented_strip_poly(mask, pad=6):
    """Four corners of the tightest ROTATED rectangle around `mask`.

    Found by PCA: the principal axis of a zip's pixels is the direction it
    runs, and the second axis is its width. Returned corner order matches what
    grab_poly expects -- around the quadrilateral, not opposite pairs.
    """
    ys, xs = np.nonzero(mask)
    if xs.size < 8:
        return None
    pts = np.column_stack((xs, ys)).astype(float)
    c = pts.mean(axis=0)
    u, s, vt = np.linalg.svd(pts - c, full_matrices=False)
    axis, perp = vt[0], vt[1]
    t = (pts - c) @ axis
    w = (pts - c) @ perp
    t0, t1 = t.min() - pad, t.max() + pad
    w0, w1 = w.min() - pad, w.max() + pad
    corners = [c + axis * a + perp * b
               for a, b in ((t0, w0), (t0, w1), (t1, w1), (t1, w0))]
    return [[float(p[0]), float(p[1])] for p in corners]


def is_diagonal_strip(poly, min_slant=0.18):
    """Is this strip slanted enough that an axis-aligned box would be wrong?

    Compares the rotated rectangle's own area to its bounding box's. A
    vertical or horizontal strip fills its bbox, so the ratio is ~1 and a
    plain grab_box is the simpler, better-tested path. A moto zip running
    corner to corner fills a small fraction of its bbox, and that is exactly
    the case where the rectangle either misses the zip or swallows the panels.
    """
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    bbox_area = max(1.0, (max(xs) - min(xs)) * (max(ys) - min(ys)))
    # shoelace
    n = len(poly)
    a = abs(sum(poly[i][0] * poly[(i + 1) % n][1] - poly[(i + 1) % n][0] * poly[i][1]
                for i in range(n))) / 2.0
    return (a / bbox_area) < (1.0 - min_slant)


def poly_mask(poly, H, W):
    """Rasterize a grab polygon (list of [x,y]) to a boolean mask."""
    img = Image.new("1", (W, H), 0)
    ImageDraw.Draw(img).polygon([(float(x), float(y)) for x, y in poly], fill=1)
    return np.array(img, bool)


def grab_mask(p, H, W):
    """The pixels a part's grab region actually covers.

    grab_box stays an axis-aligned rectangle -- every coarse test in here
    (flank zones, rail margins, Voronoi clipping) wants bounds it can index
    with. But a DIAGONAL strip fills only a sliver of its own bounding box: a
    moto zip running corner to corner across the front has a bbox that is
    most of the garment, so grabbing the whole rectangle swallows both front
    panels, while a narrow vertical box set at the zip's top x-position
    catches only the top few centimetres and leaves the rest of the teeth
    inside whichever panel they crossed (measured on job 403c07d04f59: box
    [671,88,784,1545] against a zip that travels ~200px sideways as it
    descends -- the zip layer came out a bare dotted line and the slider
    traced into front_left_panel).

    "grab_poly" is the fix: the naming step hands over the strip's real
    four-corner footprint, grab_box becomes just its bounds, and membership
    is decided against the polygon. Parts without a polygon behave exactly as
    before.
    """
    gb = p.get("grab_box")
    if not gb:
        return np.zeros((H, W), bool)
    cached = p.get("_grab_mask")
    if cached is not None and cached.shape == (H, W):
        return cached
    x0, y0, x1, y1 = (int(round(v)) for v in gb)
    m = np.zeros((H, W), bool)
    m[max(0, y0):min(H, y1), max(0, x0):min(W, x1)] = True
    if p.get("grab_poly"):
        m &= poly_mask(p["grab_poly"], H, W)
    p["_grab_mask"] = m
    return m


def grab_halo(p, H, W, margin):
    """`margin` px of slack around a part's grab region.

    Rectangles keep their old behaviour -- the halo is the box grown on all
    four sides. A polygon is dilated instead, so a diagonal strip's halo hugs
    the strip rather than ballooning to its bounding rectangle.
    """
    gb = p.get("grab_box")
    if not gb:
        return np.zeros((H, W), bool)
    if p.get("grab_poly"):
        return ndimage.binary_dilation(
            grab_mask(p, H, W), ndimage.generate_binary_structure(2, 2),
            iterations=margin)
    x0, y0, x1, y1 = (int(round(v)) for v in gb)
    m = np.zeros((H, W), bool)
    m[max(0, y0 - margin):min(H, y1 + margin),
      max(0, x0 - margin):min(W, x1 + margin)] = True
    return m


def extend_box_along_strip(gb, ink, gap_tol=20):
    """Grow a grab_box along its own long axis to cover the whole strip.

    A hand-placed (or model-placed) box routinely stops partway down a zip --
    observed: a box covering y478-820 of a zip that runs to y1029. Everything
    past the box then falls back to the panel the zip sits on, which traces at
    native resolution where the teeth fuse into a solid bar, so the drawing
    showed a clean zip on top and a black smear below. Walk out row by row
    (column by column for a horizontal strip) while the strip's own ink keeps
    up, tolerating `gap_tol` px of quiet for a slider or a plain stretch of
    tape. Growth stays inside the box's cross-range: a free flood over dense
    ink leaks straight into the rest of the garment (measured: a zip's cluster
    swallowed the whole 1004x1672 drawing)."""
    x0, y0, x1, y1 = (int(round(v)) for v in gb)
    H, W = ink.shape
    x0, x1 = max(0, min(x0, W - 1)), max(1, min(x1, W))
    y0, y1 = max(0, min(y0, H - 1)), max(1, min(y1, H))
    if x1 <= x0 or y1 <= y0:
        return [x0, y0, x1, y1]
    vertical = (y1 - y0) >= (x1 - x0)
    prof = (ink[:, x0:x1].mean(axis=1) if vertical
            else ink[y0:y1, :].mean(axis=0))
    lo, hi = (y0, y1) if vertical else (x0, x1)
    inside = prof[lo:hi]
    if not inside.size:
        return [x0, y0, x1, y1]
    cut = max(0.10, float(inside.mean()) * 0.4)
    end, gap = hi, 0
    while end < prof.size and gap < gap_tol:
        gap = 0 if prof[end] >= cut else gap + 1
        end += 1
    start, gap = lo, 0
    while start > 0 and gap < gap_tol:
        gap = 0 if prof[start - 1] >= cut else gap + 1
        start -= 1
    start, end = start + gap, end - gap
    return ([x0, min(start, y0), x1, max(end, y1)] if vertical
            else [min(start, x0), y0, max(end, x1), y1])


def trace_vtracer(img):
    """The old coarse tracer, kept behind TRACER=vtracer.

    filter_speckle=0: it drops components under an area cutoff, and everything
    it drops here is real drawn detail -- cuff pleat squiggles, dart tips, zip
    teeth -- not scanner noise. The input is already a clean vector-drawn flat,
    so nothing needs de-speckling, and a thinned stroke sits right at the
    cutoff where the filter starts eating it. (length_threshold measurably
    does nothing in this binding, so it is left at its old value.)

    Its output traces the mask's pixel staircase literally -- `mode=pixel` and
    `mode=spline` come out byte-identical in this binding, so there is no
    smoothing to turn on -- which is why coarse tracing moved to potrace."""
    with tempfile.TemporaryDirectory() as td:
        pin, pout = os.path.join(td, "i.png"), os.path.join(td, "o.svg")
        img.save(pin)
        vtracer.convert_image_to_svg_py(
            pin, pout, colormode=os.environ.get("COLORMODE", "color"),
            hierarchical="stacked",
            mode=os.environ.get("TRACE_MODE", "pixel"),
            filter_speckle=int(os.environ.get("SPECKLE", "0")),
            corner_threshold=60,
            length_threshold=4.0, splice_threshold=45, path_precision=2)
        svg = open(pout).read()
    out = []
    for i, m in enumerate(re.finditer(r'<path[^>]*>', svg)):
        el = m.group(0)
        f = FILL_RE.search(el)
        # drop the background: in color mode vtracer emits near-white fills
        # (#fefefe and friends) for it, not the exact #ffffff binary mode gives
        if f and is_background_fill(f.group(1)):
            continue
        d = PATH_RE.search(el)
        if not d:
            continue
        # ...and on a large canvas it stops calling the page white at all:
        # past roughly 4000px a side, colour clustering hands the background
        # layer a near-BLACK fill (#010101 observed), which the near-white
        # test above sails straight past. That base layer is a plain rectangle
        # covering the whole canvas, so the part came out as one solid black
        # page. vtracer's stacked output always emits that base first, so
        # check the first path's geometry rather than trusting its colour.
        if i == 0 and is_canvas_rect(d.group(1), *img.size):
            continue
        t = TR_RE.search(el)
        p = parse_path(d.group(1))
        if t:
            m2 = TR_OFF_RE.search(t.group(1))
            if m2:
                p = p.translated(complex(float(m2.group(1)), float(m2.group(2))))
        out.append((p.d(), None))
    return out


def trace(img, ss=1):
    """Coarse tracer for panel outlines and seams. `ss` = supersample factor
    the canvas was rendered at (see thin_canvas), and it is handed to potrace so
    its curve-fitting tolerances stay fixed in SOURCE px: potrace measures
    -O in canvas pixels, so at ss=4 the default 0.2 tolerated only 0.05 source
    px of deviation and the fit chased every bump the erosion left on the
    upscaled edge -- a long cutline came out as a chain of visible steps and
    lumps with the line width wobbling along it.

    potrace WITH its curve fitting on (no -n): a mask edge is a pixel
    staircase, and vtracer traces that staircase literally -- every step
    becomes nodes, so a zoomed cutline reads as a ragged sawtooth with a
    visibly wobbling width. potrace's polygon+Bezier fit rides through the
    steps and lands a smooth curve, at roughly half the nodes, without moving
    the line off the ink (measured: same ink coverage, corners preserved).
    Fine detail still goes through trace_potrace's -n mode, where staying
    pixel-faithful is the point.

    The canvas is cropped to its own ink before tracing, and the crop offset is
    baked back into the returned coordinates. This also works around vtracer
    FAILING SILENTLY on an oversized canvas -- the same layer mask that traces
    to 12 paths on a 4200px-tall page returns ZERO paths at 4824px (2x
    supersample of a 2412px sketch), with no error, so whole body/collar/
    placket panels came back empty or as a single full-page background
    rectangle that painted the layer solid black. A part's ink occupies a
    small slice of the page, so cropping keeps the tracer well inside its
    working range at full resolution; a crop that is still oversized (a
    full-height silhouette) is scaled down to fit rather than lost."""
    ink = np.asarray(img.convert("L")) < 128
    if not ink.any():
        return []
    ys, xs = np.nonzero(ink)
    x0, y0 = max(0, int(xs.min()) - TRACE_PAD), max(0, int(ys.min()) - TRACE_PAD)
    x1 = min(ink.shape[1], int(xs.max()) + 1 + TRACE_PAD)
    y1 = min(ink.shape[0], int(ys.max()) + 1 + TRACE_PAD)
    img = img.crop((x0, y0, x1, y1))
    down = 1.0
    if max(img.size) > MAX_TRACE_DIM:
        down = MAX_TRACE_DIM / max(img.size)
        img = img.resize((max(1, round(img.size[0] * down)),
                          max(1, round(img.size[1] * down))), Image.LANCZOS)
        img = Image.fromarray(
            np.where(np.asarray(img.convert("L")) < 128, 0, 255).astype(np.uint8))

    if POTRACE_BIN and os.environ.get("TRACER", "potrace") == "potrace":
        # `down` shrank the canvas, so a source pixel is now down*ss canvas px
        paths = run_potrace(img, smooth=True, ss=max(1.0, ss * down))
    else:
        paths = trace_vtracer(img)

    out = []
    for d, _tr in paths:
        p = parse_path(d)
        if down != 1.0:
            p = p.scaled(1.0 / down)
        out.append((p.translated(complex(x0, y0)).d(), None))
    return out


def run_potrace(img, smooth=False, ss=1):
    """Run potrace over `img` and return paths in its own pixel coordinates.

    smooth=False keeps -n (curve optimization off) so tiny compact marks stay
    pixel-faithful; smooth=True lets potrace fit curves, which is what takes
    the staircase off long cutlines (see trace).

    `ss` scales the two smoothing tolerances so both are expressed in SOURCE
    pixels rather than canvas pixels:

      -O opttolerance  how far the fitted Bezier may sit off the traced polygon
      -a alphamax      how sharp a turn is treated as a corner (kept as-is; it
                       is an angle, not a distance, and raising it rounds off
                       the real corners of a panel)

    OPT_TOL is the deviation budget in source px. potrace's own default is 0.2
    CANVAS px, which on a 4x supersampled thinning canvas is 0.05 source px --
    tight enough that the fit reproduces the staircase instead of riding
    through it. TURD drops specks smaller than this many source px^2 from the
    smoothed pass only, which is where the erosion's leftover 1px crumbs turn
    into the lumps along an otherwise straight edge; fine detail still traces
    through the -n path with -t 0 and keeps every mark.

    No --tight (keeps potrace's canvas == img's full size) plus -u 1
    (1 output unit per pixel) makes potrace's own transform a plain
    y-flip: translate(0,H) scale(1,-1). Baked into the path data directly
    below, so callers get back plain absolute-pixel coordinates -- no
    lingering transform for the caller to apply."""
    H = img.height
    args = [POTRACE_BIN, "-s", "-u", "1"]
    if not smooth:
        args += ["-t", "0", "-n"]
    else:
        args += ["-t", f"{TURD * ss * ss:.3f}",
                 "-O", f"{OPT_TOL * ss:.3f}", "-a", f"{ALPHA_MAX:.3f}"]
    with tempfile.TemporaryDirectory() as td:
        pin, pout = os.path.join(td, "i.bmp"), os.path.join(td, "o.svg")
        img.convert("1", dither=Image.NONE).save(pin)
        try:
            subprocess.run(args + ["-o", pout, pin], check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            stderr = (e.stderr or b"").decode(errors="replace").strip()
            raise RuntimeError(
                f"potrace exited {e.returncode} on a {img.width}x{img.height} "
                f"{img.mode} canvas: {stderr or '(no stderr)'}"
            ) from e
        svg = open(pout).read()
    out = []
    for m in re.finditer(r'<path[^>]*>', svg):
        el = m.group(0)
        d = PATH_RE.search(el)
        if d:
            flipped = parse_path(d.group(1)).scaled(1, -1).translated(
                complex(0, H)).d()
            out.append((flipped, None))
    return out


def trace_potrace(img):
    """Fine-detail tracer for buttons/stitch-dashes: potrace with speckle
    suppression OFF and no curve smoothing, so tiny compact marks survive
    pixel-faithful instead of being blurred/dropped like vtracer does them."""
    if not POTRACE_BIN:
        return trace_vtracer(img)
    return run_potrace(img, smooth=False)


def split_fine_detail(mask):
    """Peel small/compact connected components (buttons, individual dash
    ticks) off a capture mask so they can be routed through potrace, while
    everything else (long seam/outline strokes) keeps going through vtracer.

    Uses the component's THICKNESS (min(bh,bw)), not its bbox span, for the
    dimension check -- a sparse run of several dashes (real ink still tiny,
    gated by FINE_DETAIL_AREA) can span a bbox width well past 40px just
    from the gaps between dashes, even though each dash itself is thin.
    Gating on the bbox's long side would wrongly bump that whole run to
    vtracer, which smooths/blobs it instead of tracing it pixel-faithful."""
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return np.zeros_like(mask), mask
    objs = ndimage.find_objects(lab)
    fine = np.zeros_like(mask)
    for cid, sl in enumerate(objs, start=1):
        m = lab[sl] == cid
        bh, bw = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if m.sum() <= FINE_DETAIL_AREA and min(bh, bw) <= FINE_DETAIL_DIM:
            fine[sl] |= m
    return fine, mask & ~fine


def classify_fine_detail(mask):
    """Splits a fine-detail mask (from split_fine_detail) into buttons vs stitch
    dashes.

    Primary test is TOPOLOGY, not shape: a button/snap/eyelet is drawn as a
    ring (outer circle plus a hole, thread cross or inner disc), so it encloses
    background; a stitch dash is a solid tick that encloses nothing.

    The old shape test (aspect <= 1.8 and fill_ratio >= 0.35) called any short
    compact dash a button, which is most of them -- a quilted puffer's baffle
    ticks scored 476 buttons against 8 real snaps, a biker jacket's zip teeth
    1004 against 6. The ring test scores those same three sketches 7 / 12 / 5,
    and needs no pixel thresholds, so it holds across sketch resolutions where
    an absolute size floor does not (real buttons measure 24px on one sketch
    and 9px on another).

    A button drawn as a plain solid disc has no hole, so it gets a fallback:
    round, solid, and much larger than the typical fine mark in THIS sketch --
    relative, again, so it travels between resolutions.
    """
    lab, n = ndimage.label(mask, structure=np.ones((3, 3)))
    buttons = np.zeros_like(mask)
    stitches = np.zeros_like(mask)
    if n == 0:
        return buttons, stitches
    objs = ndimage.find_objects(lab)
    areas = ndimage.sum_labels(mask, lab, np.arange(1, n + 1))
    big_mark = np.median(areas) * BUTTON_SIZE_MULT
    for cid, sl in enumerate(objs, start=1):
        m = lab[sl] == cid
        bh, bw = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        aspect = max(bh, bw) / max(1, min(bh, bw))
        fill_ratio = m.sum() / max(1, bh * bw)
        # background components inside the padded bbox: 1 is the surround, any
        # extra is a hole the mark encloses
        _, n_bg = ndimage.label(~np.pad(m, 1))
        ringed = n_bg > 1
        solid_disc = (aspect <= 1.25 and fill_ratio >= 0.70
                      and m.sum() >= big_mark)
        if (ringed or solid_disc) and aspect <= 1.8:
            buttons[sl] |= m
        else:
            stitches[sl] |= m
    return buttons, stitches


def stroke_width_of(ink):
    """Half-width, in px, of a typical stroke in this sketch.

    The synthesized ring has to read as the same cut line as the drawn ones
    beside it, and sketches arrive at wildly different resolutions -- the same
    garment at 1600px and at 4096px has strokes of 2px and 6px. A fixed ring
    thickness is right at one scale and wrong at every other, so measure.

    The distance transform gives every ink pixel its distance to the nearest
    white pixel; the median over the ridge of the strokes (the upper quartile
    of those distances) is the typical half-width, unswayed by the anti-aliased
    edges that make up most ink pixels.
    """
    if not ink.any():
        return 1
    edt = ndimage.distance_transform_edt(ink)
    d = edt[ink]
    ridge = d[d >= np.quantile(d, 0.75)]
    return max(1, int(round(float(np.median(ridge)))))


def thin_canvas(mask, dil, thin=None, protect=None):
    """Build the black-on-white canvas handed to the tracer, with the ink
    shrunk by `thin` px on each side. Returns (image, scale) -- traced paths
    must be multiplied by `scale` to land back in source-image coordinates.

    Traced paths are FILLED outlines, not stroked lines, so the black line
    weight in the output SVG is exactly the ink thickness of this mask; the
    only way to draw thinner is to shave the mask first.

    Thinning happens on a `ss`x supersampled copy so it can be sub-pixel: the
    sketch's own strokes are ~2-3px wide, and a whole-pixel erosion at native
    scale reduces them to 0-1px slivers that vtracer's speckle filter drops,
    turning continuous seams into dashes.

    Erosion is per-component guarded: a component that loses at least
    KEEP_RATIO of its area is already drawn at (or under) the weight we're
    aiming for, so it is restored untouched. Without this, the lightest marks
    -- cuff pleat squiggles, dart tips, small ticks -- shrink under vtracer's
    speckle floor and disappear from the layer entirely, while the heavy
    outlines this is meant to slim keep well over half their area and thin
    normally.

    `protect` is a mask of pixels the erosion may never touch. The per-pixel
    guard above keys off LOCAL stroke thickness, which is the wrong question
    for a synthesized boundary: a 1px ring lying a pixel away from the drawn
    seam it runs beside fuses with that seam under the bilinear upscale, the
    pair measures as one heavy stroke, and the ring erodes away with it --
    taking the only thing closing that side of the piece. A part's boundary is
    not a line weight to be matched, so it opts out of thinning entirely (1px,
    so it costs no visible weight).
    """
    thin = THIN if thin is None else thin
    if thin > 0 and mask.any():
        ss = 2 if (thin * 2) % 1 == 0 else 4
        it = max(1, int(round(thin * ss)))
        h, w = mask.shape
        # Every step below is LOCAL (erosion, distance transform, closing,
        # median), so run them on the ink's own bounding box instead of the
        # whole page. A part occupies a slice of the sketch, and the work
        # here is done at ss x resolution -- at ss=4 a full page is 16x the
        # pixels of the source, and the distance transform / grey dilation
        # over all of it, per part, is what made a 26-part sketch take 7+
        # minutes. Padding keeps the crop clear of its own borders so the
        # bilinear upscale and the erosion see the same neighbourhood they
        # would have on the full page.
        pad = it + 4
        ys, xs = np.nonzero(mask)
        cy0, cy1 = max(0, int(ys.min()) - pad), min(h, int(ys.max()) + 1 + pad)
        cx0, cx1 = max(0, int(xs.min()) - pad), min(w, int(xs.max()) + 1 + pad)
        sub = mask[cy0:cy1, cx0:cx1]
        sh, sw = sub.shape
        # bilinear (not nearest) upscale: smooths the pixel staircase before
        # erosion, so the thinned edge lands sub-pixel accurate and vtracer
        # emits far fewer nodes than it would chasing magnified stair steps
        big = np.array(Image.fromarray(sub.astype(np.uint8) * 255).resize(
            (sw * ss, sh * ss), Image.BILINEAR)) > 127
        eroded = ndimage.binary_erosion(big, dil, iterations=it)
        # Protect already-light ink PER PIXEL, by local stroke thickness. The
        # distance transform gives each ink pixel its distance to the nearest
        # background pixel; grey-dilating that by the erosion radius spreads
        # each stroke's own half-width across the whole stroke, so any run of
        # ink whose half-width never exceeds the cut stays at full weight.
        # (Doing this per connected COMPONENT instead fails: the 2x upscale
        # fuses a faint cuff squiggle or dart tip into the heavy outline it
        # sits next to, and the outline's area then outvotes the mark, which
        # erodes away and drops under vtracer's speckle floor.)
        edt = ndimage.distance_transform_edt(big)
        half_w = ndimage.grey_dilation(edt, size=2 * it + 1)
        eroded |= big & (half_w <= it + KEEP_HALF_W)
        # Knock the 1px stair steps off the upscaled edge, so scaling back down
        # doesn't leave the outline visibly ragged -- and, more importantly,
        # heal any hairline break the erosion just opened.
        #
        # The per-pixel guard above protects ink that is ALREADY thin, but a
        # stroke sitting right at the cut depth gets severed at its weakest
        # points instead of being kept whole: one shoulder yoke came out of the
        # tracer in 10 fragments against its mirror's 3, so its outline no
        # longer enclosed anything and the part read as open on one side.
        # Measured, that break was a single pixel wide. Closing is dilate-then-
        # erode, so widening it here reconnects the stroke without meaningfully
        # adding line weight. Measured on the test sketch, same grouping, only
        # this value changed: open parts 2 -> 1 (the survivor is the zip, a
        # strip that has no interior to enclose), total traced ink 53,493 ->
        # 54,123 px, +1.2%.
        #
        # The closing is CLIPPED BACK to the un-eroded ink. A break the
        # erosion opened sits inside a stroke, so it is ink in `big` and the
        # closing still heals it; the white gap between two stitch dashes is
        # NOT ink in `big`, so the closing can no longer bridge it. Without
        # the clip, CLOSE_BREAKS=3 spans a 3px native gap -- exactly the gap
        # a dashed seam is drawn with -- and every dash run in the sketch
        # traced out as one solid line (measured on the puffer sketch: a
        # 620x100px crop of dashed baffle seams collapsed from 66 ink
        # components to 9; clipped, it keeps 65).
        eroded = ndimage.binary_closing(
            eroded, dil, iterations=CLOSE_BREAKS) & big
        eroded = ndimage.median_filter(eroded, size=3) & big
        # Restore the protected pixels last, after the median filter -- which
        # would otherwise clip a 1px ring back off as if it were noise.
        if protect is not None and protect.any():
            psub = protect[cy0:cy1, cx0:cx1]
            pbig = np.array(Image.fromarray(psub.astype(np.uint8) * 255).resize(
                (sw * ss, sh * ss), Image.BILINEAR)) > 127
            eroded |= pbig & big
        if TRACE_NATIVE:
            # Hand the tracer a NATIVE-resolution mask, not the supersampled
            # one. The thinning has to happen at ss to be sub-pixel, but
            # TRACING at ss is what put the sawtooth in the output: every step
            # of the upscaled staircase, and every 1px crumb the erosion /
            # closing / median left on it, is a real feature at that scale, so
            # potrace's polygon stage plants vertices on all of them and the
            # line comes out visibly stepped with its width lurching between
            # two levels. Scaling those paths back down by 1/ss shrinks the
            # wobble but keeps every node.
            #
            # Blur at ss, then average each ss x ss block and keep the blocks
            # at least half covered. The blur is what carries the sub-pixel
            # position across the downsample: without it, area-averaging alone
            # rounds the thinned edge straight back onto the pixel it came
            # from and the thinning is lost. Measured on a 200x100 crop of a
            # body side seam, THIN=0.25 (ink 1802px unthinned):
            #   trace at ss:            1591px ink, 425 nodes/1000px
            #   average down, no blur:  1757px ink,  90 nodes/1000px (no thinning)
            #   blur then average down: 1612px ink,  89 nodes/1000px
            # -- same thinning as tracing at ss, same node density as never
            # supersampling at all.
            sm = ndimage.gaussian_filter(eroded.astype(np.float32),
                                         SMOOTH_SIGMA * ss)
            eh, ew = sm.shape
            eroded = (sm.reshape(eh // ss, ss, ew // ss, ss).mean(axis=(1, 3))
                      >= NAT_CUT)
            # Heal at native resolution, clipped to the un-thinned ink exactly
            # as CLOSE_BREAKS is at ss. A neck narrower than the block
            # threshold disappears in the downsample, and a boundary held
            # together by one such neck traces open (measured: the back middle
            # body panel on one sketch and the back body on another, both of
            # which closed when traced at ss). The clip means this can only
            # rejoin ink to ink -- it cannot bridge the white gap between two
            # stitch dashes, which is the invariant CLOSE_BREAKS protects.
            if NAT_CLOSE > 0:
                eroded = ndimage.binary_closing(
                    eroded, dil, iterations=NAT_CLOSE) & sub
            full = np.zeros((h, w), bool)
            full[cy0:cy1, cx0:cx1] = eroded
            mask, scale = full, 1.0
        else:
            # back onto the full page at ss resolution: callers (and the
            # tracer's own crop-and-bake) work in whole-canvas coordinates
            full = np.zeros((h * ss, w * ss), bool)
            full[cy0 * ss:cy1 * ss, cx0 * ss:cx1 * ss] = eroded
            mask, scale = full, 1.0 / ss
    else:
        scale = 1.0
    canvas = np.full(mask.shape, 255, np.uint8)
    canvas[mask] = 0
    return Image.fromarray(canvas), scale


def ss_of(scale):
    """Supersample factor a thin_canvas scale came from."""
    return int(round(1.0 / scale))


def scale_paths(paths, scale):
    """Bring paths traced on a supersampled canvas back to source pixels."""
    if scale == 1.0:
        return paths
    out = []
    for d, tr in paths:
        p = parse_path(d)
        if tr:
            m = re.search(r"translate\(([-\d.]+),\s*([-\d.]+)\)", tr)
            if m:
                p = p.translated(complex(float(m.group(1)), float(m.group(2))))
        # round back to the same 2 decimals vtracer emits natively -- scaling
        # otherwise leaves long float tails that triple the SVG's size
        d2 = re.sub(r"-?\d+\.\d{3,}",
                    lambda m: f"{float(m.group(0)):.2f}", p.scaled(scale).d())
        out.append((d2, None))
    return out


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
        return int(np.nanargmax(between))
    flat = a.ravel()
    t = otsu(flat)
    for _ in range(3):
        if (flat < t).mean() <= 0.20:
            break
        t = otsu(flat[flat < t])
    return int(np.clip(t, 100, 245))

def load_gray(path):
    im = Image.open(path)
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        bg.alpha_composite(im)
        im = bg
    return im.convert("L")


def main(in_png, labels_npy, groups_json, out_svg):
    a = np.array(load_gray(in_png))
    H, W = a.shape
    tfile = os.path.join(os.path.dirname(labels_npy), "threshold.txt")
    thr = int(os.environ.get("INK_T", 0)) or \
          (int(open(tfile).read()) if os.path.exists(tfile) else otsu_threshold(a))
    inkfile = os.path.join(os.path.dirname(labels_npy), "ink.npy")
    if os.path.exists(inkfile):
        ink = np.load(inkfile)                 # cleaned ink from seg step
        print("using cleaned ink from seg folder")
    else:
        print(f"ink threshold: {thr}")
        ink = a < thr
    # Identify buttons/stitch dashes up front so each becomes its own layer at
    # the end -- but `ink` itself keeps every pixel (fine detail included).
    # Ownership/band-sharing/stray-rescue/close-parts-synthesis all still see
    # the FULL ink, exactly as before this feature existed: a dash sitting
    # right on a part's own boundary still correctly counts as "already drawn
    # there" (so synthesis doesn't duplicate a solid line on top of it).
    # Fine detail is stripped out only once, at the final per-part trace step
    # below, so it doesn't ALSO get duplicated into that part's own coarse
    # layer -- it already has its own dedicated button_N/stitch_N layer.
    fine_all, _coarse_only = split_fine_detail(ink)
    buttons_mask, stitches_mask = classify_fine_detail(fine_all)

    labels = np.load(labels_npy)
    if labels.shape != a.shape:
        sys.exit(f"image {a.shape} vs labels {labels.shape} mismatch: "
                 "pass the seg folder's work.png as the image "
                 "(flat2svg_auto.py does this automatically)")
    cfg = json.load(open(groups_json))
    for nm, p in cfg["parts"].items():
        gb = p.get("grab_box")
        if isinstance(gb, dict):
            p["grab_box"] = [gb["x0"], gb["y0"], gb["x1"], gb["y1"]]
        # A grab_poly states the strip's real (possibly diagonal) footprint;
        # grab_box is then just its bounds, so the two can never disagree.
        # Fewer than 3 points is not a polygon -- drop it and fall back to the
        # rectangle rather than rasterizing a degenerate shape.
        poly = p.get("grab_poly")
        if poly and len(poly) >= 3:
            xs = [float(pt[0]) for pt in poly]
            ys = [float(pt[1]) for pt in poly]
            p["grab_poly"] = [[float(pt[0]), float(pt[1])] for pt in poly]
            p["grab_box"] = [int(min(xs)), int(min(ys)),
                             int(max(xs)) + 1, int(max(ys)) + 1]
            print(f"  [{nm}] grab_poly with {len(poly)} points -> "
                  f"bounds {p['grab_box']}")
        elif poly:
            print(f"  [{nm}] grab_poly has {len(poly)} point(s), ignoring")
            p.pop("grab_poly")
        # A zip named without a box is the one failure that shows up as a
        # SOLID BLACK BAR: its teeth fall through to the coarse tracer at
        # native resolution, where the ladder's 1px gaps land inside a single
        # pixel and fuse. The naming prompt asks for a box on every zip, but
        # a sketch with six of them reliably loses a few, so derive the
        # missing box from the part's own regions rather than trusting it.
        if not p.get("grab_box") and "zip" in nm:
            reg = np.isin(labels, p["regions"])
            if reg.any():
                ys, xs = np.nonzero(reg)
                p["grab_box"] = [int(xs.min()), int(ys.min()),
                                 int(xs.max()) + 1, int(ys.max()) + 1]
                print(f"  [{nm}] no grab_box from naming -- derived "
                      f"{p['grab_box']} from its own regions")
        # A SLANTED zip gets its polygon derived here rather than waiting for
        # the naming model to supply one. This is the solid-black-bar bug in
        # its worst form: an axis-aligned box around a zip that travels
        # sideways as it descends covers only part of the run, the components
        # that leave the strip are dropped by the CROSS_TOL cut below, and the
        # panel that keeps them traces the teeth at native resolution, where
        # the 1px gaps fall inside one pixel and fuse. Measured on job
        # 403c07d04f59: the top two thirds of the moto zip came out a solid
        # bar while the bottom third, which happened to stay inside the box,
        # resolved into teeth.
        #
        # The part's own regions ARE the zip, strung out along its run, so
        # their principal axis is the zip's direction. Only applied when the
        # rotated rectangle is meaningfully tighter than the bounding box --
        # a vertical or horizontal zip keeps the simpler, better-tested
        # rectangle path.
        if ("zip" in nm and not p.get("grab_poly") and p.get("regions")
                and AUTO_ZIP_POLY):
            reg = np.isin(labels, p["regions"])
            cand = oriented_strip_poly(reg) if reg.any() else None
            if cand and is_diagonal_strip(cand):
                xs = [pt[0] for pt in cand]
                ys = [pt[1] for pt in cand]
                p["grab_poly"] = cand
                p["grab_box"] = [int(min(xs)), int(min(ys)),
                                 int(max(xs)) + 1, int(max(ys)) + 1]
                print(f"  [{nm}] slanted zip -- derived grab_poly from its own "
                      f"regions, bounds {p['grab_box']}")
        # Only rectangles get extended: the growth walks along the box's long
        # axis, which for a polygon would push the bounds off the strip.
        if p.get("grab_box") and not p.get("grab_poly"):
            p["grab_box"] = extend_box_along_strip(p["grab_box"], ink)
    # Build the drawing in garment order: every structural piece first, each
    # closed on all sides, then the applied detail drawn ON TOP of those
    # boundaries. The naming model also returns a z_order, but it varies run to
    # run; this fixes the sequence so the same garment always stacks the same
    # way. A keyword the canonical list does not know falls back to the
    # model's own ordering, appended after the structural pieces.
    z = STRUCTURAL_Z + [k for k in cfg.get("z_order", []) if k not in STRUCTURAL_Z]

    def kw_key(nm):
        return next((i for i, k in enumerate(z) if k in nm), -1)

    # PART RELATIONSHIP GRAPH: measure containment between parts from the
    # label map itself. A part mostly inside another's expanded footprint
    # sits ON it -> stacks above it. Bigger/container parts sink lower.
    pregs = {nm: np.isin(labels, p["regions"]) for nm, p in cfg["parts"].items()}
    # neighbor-ring test: part A sits ON part B if the ring around A is
    # mostly B (pocket ringed by body, placket ringed by body, ...)
    contained_in = {nm: set() for nm in pregs}
    st3 = np.ones((3, 3), bool)
    for a_ in pregs:
        ra = pregs[a_]
        if not ra.any():
            continue
        ring = ndimage.binary_dilation(ra, st3, iterations=15) & ~ra
        ring_total = ring.sum()
        best_b, best_f, region_cov = None, 0.0, 0.0
        for b_ in pregs:
            if b_ == a_:
                continue
            f = (ring & pregs[b_]).sum() / ring_total
            region_cov += f
            if f > best_f:
                best_b, best_f = b_, f
        # ring dominated by one bigger part -> contained (rings are mostly
        # ink/background, so calibrated threshold is 0.25)
        if best_b and best_f >= 0.25 \
                and pregs[best_b].sum() > 1.5 * ra.sum():
            contained_in[a_].add(best_b)
        elif best_b and any(k in a_ for k in APPLIED_NAMES) \
                and pregs[best_b].sum() > ra.sum():
            # A pocket is applied BY DEFINITION -- it is sewn onto a panel, it
            # is not a panel. The 0.25 ring test asks the question
            # geometrically, and it misses whenever the piece sits against an
            # edge: a patch pocket on the side seam splits its own ring between
            # the panel and the background outside the garment, and neither
            # side clears the threshold (measured on 1d22549af6c7, where the
            # relationship graph found the drawcords and the back collar but
            # neither front pocket). When the name already settles the
            # question, take the biggest ring neighbour as the host.
            contained_in[a_].add(best_b)
    depth = {nm: len(contained_in[nm]) for nm in pregs}

    # An applied piece (pocket welt+flap, badge, ...) sitting ON a bigger
    # part (body panel, sleeve, ...) can slice that bigger part's own
    # segmented white area into disconnected chunks in the 2D drawing --
    # even though in the real garment the panel fabric is one continuous
    # piece underneath the applied piece. Left alone, the panel's outer
    # contour synthesis (below) traces each disconnected chunk separately
    # and steps inward around the gap instead of running straight past it.
    # Bridge it: fold each contained part's own footprint into its
    # container's silhouette ONLY for that contour computation, so the
    # container's outer edge reads as one smooth continuous cutting line.
    # (Ink ownership/band-sharing for actual line capture is untouched --
    # this only affects synthesized-edge geometry.)
    #
    # The ring-neighbor test above just measures "is this region's border
    # mostly one bigger neighbor" -- it flags plenty of relationships that
    # are NOT an applied-on-continuous-fabric case: a placket/zip's own
    # grab_box marks it as its own separate trim piece; a collar/yoke/cuff
    # is a genuine separate cut piece sewn on with its own real seam,
    # already correctly shared into both sides by the normal band logic
    # below, and can even geometrically fragment its container (e.g. a
    # collar's neckline notch touching a yoke's own top edge) without that
    # meaning anything needs bridging -- bridging it would just reconstruct
    # a duplicate of a line that's already there, or fold a whole separate
    # piece (buttons and all) into the container's own cutting line. Only
    # bridge for a small part that's BOTH keyword-decorative (not one of
    # these structural piece types) AND does NOT have its own grab_box.
    #
    # Bridging applies whenever `small` is contained in `big` -- not only
    # when `big` ends up split into 2+ disjoint blobs. An applied piece
    # sitting fully inside its container's silhouette (e.g. a patch pocket
    # that doesn't reach any of the container's own edges) still carves a
    # notch/hole out of the container's raw segmented white area without
    # ever splitting it into separate components, and that notch is just as
    # wrong in the container's own traced/synthesized edge as a full split
    # would be -- gating on component count misses this common case.
    STRUCTURAL_KEYWORDS = ("collar", "yoke", "placket", "zip", "cuff", "hem",
                           "waistband", "fly", "hood", "sleeve", "body",
                           "panel")

    def bbox_of(mask):
        ys, xs = np.where(mask)
        return None if len(xs) == 0 else (xs.min(), ys.min(), xs.max(), ys.max())

    part_bboxes = {nm: bbox_of(r) for nm, r in pregs.items()}
    bridge_regs = {}
    for small, containers in contained_in.items():
        if cfg["parts"][small].get("grab_box"):
            continue
        if any(kw in small for kw in STRUCTURAL_KEYWORDS):
            continue
        targets = set(containers)
        if not targets and part_bboxes[small]:
            # Ring test found no single dominant neighbor -- common for a
            # small applied piece sitting near the seam between two
            # containers (e.g. a patch pocket close to a side seam), which
            # splits its surrounding ring across both roughly evenly and
            # lets neither clear the 0.25 threshold. Fall back to bbox
            # containment: if this part's own bbox sits fully inside
            # exactly one bigger part's bbox, that's still a reliable
            # "sits on this container" signal, independent of ring geometry.
            sx0, sy0, sx1, sy1 = part_bboxes[small]
            s_area = pregs[small].sum()
            candidates = [big for big, bb in part_bboxes.items()
                          if big != small and bb is not None
                          and bb[0] <= sx0 and bb[1] <= sy0
                          and bb[2] >= sx1 and bb[3] >= sy1
                          and pregs[big].sum() > 1.5 * s_area]
            if len(candidates) == 1:
                targets = set(candidates)
        for big in targets:
            bridge_regs[big] = bridge_regs.get(
                big, np.zeros_like(pregs[small])) | pregs[small]

    def zkey(nm):
        # containment depth dominates; keyword order breaks ties;
        # bigger parts lower within the same depth
        return (depth.get(nm, 0), kw_key(nm), -int(pregs.get(nm, np.zeros(1)).sum()))
    print("relationship graph:", {n: sorted(c) for n, c in contained_in.items() if c})
    dil = ndimage.generate_binary_structure(2, 2)
    outline_px = OUTLINE_PX or stroke_width_of(ink)
    print(f"ring thickness: {outline_px}px "
          f"({'forced by OUTLINE_PX' if OUTLINE_PX else 'measured from the sketch'})")

    # exclusive grab_box strokes first
    grabbed = {}                      # part -> bool mask
    grabbed_union = np.zeros((H, W), bool)
    slab, sn = ndimage.label(ink, structure=np.ones((3, 3)))
    sobjs = ndimage.find_objects(slab)
    for nm, p in cfg["parts"].items():
        gb = p.get("grab_box")
        if not gb:
            continue
        box = grab_mask(p, H, W)
        g = np.zeros((H, W), bool)
        for cid in range(1, sn + 1):
            sl = sobjs[cid - 1]
            cm = slab[sl] == cid
            if (cm & box[sl]).sum() / cm.sum() > 0.6:
                g[sl] |= cm
        grabbed[nm] = g
        grabbed_union |= g

    # second-chance grab: a dash/stitch component partly inside the box can
    # touch ink OUTSIDE it (e.g. zipper topstitch merging into the collar
    # curve) and fail the whole-component 60% test above, dropping that
    # detail into "unassigned" instead of the part it visually belongs to.
    # Anything inside the box that no OTHER part's own region+BAND already
    # owns gets grabbed directly, pixel-for-pixel, as a fallback.
    prelim_owned = np.zeros((H, W), bool)
    owned_region = np.zeros((H, W), bool)
    for p2 in cfg["parts"].values():
        reg2 = np.isin(labels, p2["regions"])
        prelim_owned |= ndimage.binary_dilation(reg2, dil, iterations=BAND)
        owned_region |= reg2
    for nm, p in cfg["parts"].items():
        gb = p.get("grab_box")
        if not gb:
            continue
        box = grab_mask(p, H, W)
        # A neighbour's BAND reaches into the box whenever the boxed strip is
        # drawn on top of that neighbour's panel -- which is always, for a zip
        # sewn onto a placket. Gating on prelim_owned therefore handed the box
        # nothing at all: a zip whose teeth are fused into the placket outline
        # failed the 60% component test AND lost the pixel fallback, so its
        # layer came out empty while the teeth stayed on the placket, where
        # they are traced at native resolution and fuse into a solid bar. The
        # box IS the statement of ownership, so inside it only a neighbour's
        # own REGION interior outranks it, not that region's shared band.
        #
        # A neighbour's own BOUNDARY LINE is still off limits, though. The box
        # is placed by the naming model and is routinely off-centre: measured
        # on one bomber, the front zip's box ran x694-746 while the right body
        # panel's region started at x723, so this grab took 4719px of that
        # panel's own center-front edge (the left panel, ending at x686, lost
        # nothing) -- the right panel then traced open all the way down the zip
        # side. Ink within BOX_EDGE_KEEP of a region interior is that panel's
        # edge; a zip's own content -- teeth, tape, slider -- sits out in the
        # strip, clear of either neighbour, and is still grabbed.
        own_reg = np.isin(labels, p["regions"]) if p["regions"] \
            else np.zeros((H, W), bool)
        neighbour_edge = ndimage.binary_dilation(
            owned_region & ~own_reg, dil, iterations=BOX_EDGE_KEEP)
        extra = ink & box & ~owned_region & ~grabbed_union & ~neighbour_edge
        if extra.any():
            grabbed[nm] |= extra
            grabbed_union |= extra

    # A margin just OUTSIDE every grab_box (e.g. a zip's own tight teeth/tape
    # box) is where flanking attachment lines live -- lines that stitch the
    # zip/placket tape down to the body panel. A tight grab_box deliberately
    # excludes them (so the zip's own piece is just the tape/teeth), but they
    # can sit far enough from the neighboring part's own region that normal
    # BAND-sharing never reaches them either -- without this, they're lost
    # entirely. Flagged here; actually attached to the nearest part below,
    # alongside the (same mechanism) stray-ink rescue.
    FLANK_MARGIN = 20
    flank_zone = np.zeros((H, W), bool)
    for p in cfg["parts"].values():
        gb = p.get("grab_box")
        if not gb:
            continue
        if p.get("grab_poly"):
            # For a diagonal strip the flanks run along the strip's own sides,
            # not down two vertical columns beside its bounding box.
            flank_zone |= grab_halo(p, H, W, FLANK_MARGIN) & ~grab_mask(p, H, W)
            continue
        x0, y0, x1, y1 = gb
        fx0, fx1 = max(0, x0 - FLANK_MARGIN), min(W, x1 + FLANK_MARGIN)
        flank_zone[y0:y1, fx0:x0] = True
        flank_zone[y0:y1, x1:fx1] = True

    # Flank-zone ink must never be treated as fine detail, even if it happens
    # to rasterize as small fragments (the same antialiasing fragmentation a
    # solid decorative line can show at lower sketch resolutions) -- it's a
    # real continuous attachment line, not an individual button/stitch mark.
    # Left unfixed, `cap &= ~fine_all` below would strip it right back out
    # after the stray-rescue above just attached it to its neighboring part.
    fine_all &= ~flank_zone
    buttons_mask &= ~flank_zone
    stitches_mask &= ~flank_zone

    # Neither may a boxed part's own INTERIOR be scattered into per-mark
    # layers. A zip's teeth are exactly what the button/stitch detector is
    # built to peel off -- small, compact, repetitive -- so a single zip was
    # coming apart into a hundred-plus one-tooth `stitch_N` layers (measured:
    # 105 inside one front zip's box), leaving the zip's own layer with a
    # ladder-shaped hole through the middle. It read as a zip cut in half.
    # The teeth belong to the zip piece; the grab_box is the statement that
    # this strip's content is one part's, so keep the whole strip out of the
    # fine-detail split and let the part trace it as a unit.
    box_zone = np.zeros((H, W), bool)
    for p in cfg["parts"].values():
        gb = p.get("grab_box")
        if not gb:
            continue
        box_zone |= grab_halo(p, H, W, RAIL_MARGIN)
    fine_all &= ~box_zone
    buttons_mask &= ~box_zone
    stitches_mask &= ~box_zone

    # The boxes themselves (no RAIL_MARGIN halo): ink in here is the boxed
    # part's alone -- see the exclusivity cut in the part loop below.
    box_interior = np.zeros((H, W), bool)
    for p in cfg["parts"].values():
        if p.get("grab_box"):
            box_interior |= grab_mask(p, H, W)

    # A stitch line is never a boundary line, and an outline synthesized for a
    # piece may land in the same place as a dash run -- overlapping there is
    # fine, they are separate layers. So nothing is trimmed by default:
    # STITCH_CLEARANCE > 0 would cut dash ink back off the outline, which
    # deletes real stitching to buy a gap the sketch never had.
    outline_ink = ink & ~fine_all
    if outline_ink.any() and STITCH_CLEARANCE > 0:
        clearance = ndimage.binary_dilation(
            outline_ink, dil, iterations=STITCH_CLEARANCE)
        trimmed = stitches_mask & clearance
        if trimmed.any():
            print(f"  stitch clearance: trimmed {int(trimmed.sum())} px of dash "
                  f"ink off the outline")
        stitches_mask &= ~clearance
        fine_all &= ~trimmed

    layers = []
    close_parts = os.environ.get("CLOSE_PARTS", "1") == "1"

    # ---- stroke ownership: every ink component gets ONE owner part if a
    # single part contains >=80% of it (interior details: creases, dashes,
    # stitching). Unowned strokes are shared seams / big outlines. ----
    part_regs = {nm: np.isin(labels, p["regions"]) for nm, p in cfg["parts"].items()}
    part_regs_d2 = {nm: ndimage.binary_dilation(r, dil, iterations=2)
                    for nm, r in part_regs.items()}

    # stray-component rescue: ink that touches NO part's own region+BAND and
    # isn't in any grab_box would otherwise vanish into "unassigned" -- e.g.
    # rib/stitch fragments sitting between two segmented sub-regions of the
    # same part, farther apart than BAND can bridge across a seam-allowance
    # divider line. Voronoi-assign each such stray blob to whichever part's
    # region is nearest (by pixel distance, not centroid -- parts can be
    # long/curved), instead of losing it.
    part_names = list(part_regs.keys())
    id_map = np.zeros((H, W), np.int32)
    for i, nm in enumerate(part_names, start=1):
        reg_i = part_regs[nm]
        # A grab_box part's raw label region can extend past its own tight
        # box (that's exactly why the box exists -- to keep it from pulling
        # in flanking attach/topstitch lines that belong on the neighboring
        # part). Left uncapped here, its full region would still win the
        # nearest-part vote for that flanking ink purely by proximity,
        # silently undoing the box. Clip its Voronoi footprint to the box
        # itself so flank ink always resolves to the true neighbor instead.
        if cfg["parts"][nm].get("grab_box"):
            reg_i = reg_i & grab_mask(cfg["parts"][nm], H, W)
        id_map[reg_i] = i
    _, (iy, ix) = ndimage.distance_transform_edt(id_map == 0, return_indices=True)
    nearest_part_id = id_map[iy, ix]
    # Flank-zone ink (just outside a grab_box, e.g. a zip's flanking
    # topstitch/attachment lines) is ALSO routed through this same
    # nearest-part assignment -- it's real ink attaching a grabbed feature
    # (zip/placket) to whichever neighboring part it actually borders, not
    # that neighbor's own region+BAND necessarily reaching it directly.
    # It's bridged with a small closing first: these attachment lines can
    # rasterize as a chain of tiny anti-aliasing-separated fragments (same
    # issue a solid decorative line shows at lower sketch resolutions), which
    # would otherwise trace as a scatter of small dots instead of one solid
    # line even once correctly attached. Safe to close here (unlike a
    # whole-image closing, which cascades unpredictably): flank_zone is a
    # narrow, sparse margin, not the busy full canvas.
    flank_ink = ink & flank_zone & ~grabbed_union
    if flank_ink.any():
        flank_ink = ndimage.binary_closing(flank_ink, structure=np.ones((3, 3)), iterations=2)
    stray = (ink & ~prelim_owned & ~grabbed_union) | flank_ink
    if stray.any():
        slab2, sn2 = ndimage.label(stray, structure=np.ones((3, 3)))
        sobjs2 = ndimage.find_objects(slab2)
        for cid in range(1, sn2 + 1):
            sl = sobjs2[cid - 1]
            cm = slab2[sl] == cid
            local_ids = nearest_part_id[sl]
            # Split THIS stray component pixel-by-pixel by its own nearest
            # part, instead of a whole-blob majority vote -- a long stray
            # line can legitimately drift past several parts' territory
            # (e.g. a placket edge running the full body length), and a
            # majority vote would wholesale misattach the ENTIRE line to
            # whichever single part wins over most of its length.
            for pid in np.unique(local_ids[cm]):
                if pid == 0:
                    continue
                nm = part_names[pid - 1]
                m = np.zeros((H, W), bool)
                m[sl] = cm & (local_ids == pid)
                grabbed[nm] = grabbed.get(nm, np.zeros((H, W), bool)) | m
                grabbed_union |= m

    owner = {}                                     # stroke id -> part name
    for cid in range(1, sn + 1):
        sl = sobjs[cid - 1]
        cm = slab[sl] == cid
        tot = cm.sum()
        best, bf = None, 0.0
        for nm, rd in part_regs_d2.items():
            f = (cm & rd[sl]).sum() / tot
            if f > bf:
                best, bf = nm, f
        if bf >= 0.80:
            owner[cid] = best

    # Footprint of every OTHER part, per part: where a synthesized closure for
    # this piece would be covered by a neighbouring piece in the composed
    # drawing (see the guide split at the end of the loop).
    all_regs = np.zeros((H, W), bool)
    for r_ in part_regs.values():
        all_regs |= r_

    # Measured once off this sketch's own stitching, not per part: the pitch is
    # a property of the drawing, and per-part medians swing wildly on a piece
    # that happens to carry only two or three dashes.
    dash_keepout_px = dash_bridge_px(fine_all) if fine_all.any() else 0
    print(f"dash keepout: {dash_keepout_px}px "
          f"({'measured' if RING_KEEPOUT < 0 else f'forced {RING_KEEPOUT}'}"
          f"{', DISABLED' if RING_KEEPOUT_OFF else ''})")

    # Complete closed perimeter per component, independent of what the sketch
    # draws and of who owns which stroke: part name -> full ring mask, and the
    # traced version of whatever part of it the inked layer does not cover.
    ring_full = {}
    boundary_paths = {}

    for nm, p in cfg["parts"].items():
        reg = part_regs[nm]
        ring_protect = None    # this part's synthesized perimeter, exempt from
                               # the thinning erosion (see thin_canvas)
        other_regs_d = ndimage.binary_dilation(all_regs & ~reg, dil,
                                               iterations=BAND)
        # 1) whole strokes owned by this part (never sliced, never shared)
        cap = np.zeros((H, W), bool)
        for cid, onm in owner.items():
            if onm == nm:
                sl = sobjs[cid - 1]
                cap[sl] |= (slab[sl] == cid)
        # 2) shared seams & outlines: UNOWNED ink in this part's boundary
        #    band -> duplicated into every adjacent part (closure), while
        #    strokes owned by OTHER parts stay out (purity)
        band = ndimage.binary_dilation(reg, dil, iterations=BAND) \
               & ~ndimage.binary_erosion(reg, dil, iterations=BAND)
        others = np.zeros((H, W), bool)
        for cid, onm in owner.items():
            if onm != nm:
                sl = sobjs[cid - 1]
                others[sl] |= (slab[sl] == cid)
        # Kept deliberately: each component preserves its OWN complete
        # boundary even where it touches a neighbour, so every part stays
        # independently extractable. Coincident strokes on a shared seam are
        # the accepted cost of that.
        cap |= ink & band & ~others
        cap &= ~grabbed_union
        if nm in grabbed:
            cap |= grabbed[nm]
        # A grab_box is EXCLUSIVE: no OTHER part may re-draw what is inside it.
        # Without this the strip came out twice -- the zip's own layer carried
        # the clean trace off the 4x re-threshold, while the panel the zip sits
        # on carried the same ink again from ordinary band sharing, traced at
        # native resolution where the teeth fuse. The two stacked into a black
        # mess (measured on one quarter-zip: the body panel put 6827px into the
        # zip's box against the zip layer's own 3138, for 12353px total where
        # the sketch has 7886).
        # Same BOX_EDGE_KEEP carve-out as the grab above, and it needs to be in
        # both places: the grab decides what the zip TAKES, this decides what
        # the panel may KEEP, and an off-centre box strips the panel's edge
        # through whichever one is left unguarded (measured: guarding only the
        # grab dropped the bomber's right-hand tape line from the drawing
        # entirely -- the zip no longer took it and this cut still deleted it).
        if box_interior.any():
            others_box = box_interior.copy()
            if p.get("grab_box"):
                others_box &= ~grab_mask(p, H, W)
            if others_box.any():
                own_edge = ndimage.binary_dilation(reg, dil,
                                                   iterations=BOX_EDGE_KEEP)
                cap &= ~(others_box & ~own_edge)
        # An applied piece (pocket welt+flap, badge, ...) contained on this
        # part draws its OWN edge lines, which can sit inside this part's own
        # band and get duplicated in here as if they were this part's true
        # cutting edge -- notching the silhouette inward around the applied
        # piece instead of running straight past it (the fabric underneath
        # is continuous; only the applied piece's outline actually stops
        # there). Strip that ink back out of THIS part's own cap; it already
        # has its own dedicated copy in the applied piece's own layer, and
        # the bridged contour synthesis below fills the resulting span.
        #
        # Only do this when this part's OWN silhouette actually has a gap
        # near the applied piece to begin with. A piece sitting fully inside
        # the panel (not touching/notching the panel's own outer edge at
        # all) leaves the panel's real ink boundary fully intact everywhere
        # -- stripping cap there anyway would erase a legitimate, already-
        # correct shared-seam duplicate of the piece's own edge, and the
        # synthesis below would then rebuild nearly its ENTIRE perimeter
        # from scratch as a "bridge span" and merge that back into cap,
        # producing a bold second copy of the piece's own outline right on
        # top of the real one. Check for a real pre-existing gap first.
        use_bridge = False
        if nm in bridge_regs:
            own_contour = reg & ~ndimage.binary_erosion(reg, dil, iterations=2)
            own_near_ink = ndimage.binary_dilation(cap, dil, iterations=5)
            bridge_zone = ndimage.binary_dilation(bridge_regs[nm], dil, iterations=BAND)
            use_bridge = ((own_contour & ~own_near_ink) & bridge_zone).sum() >= 20
        if use_bridge:
            cap &= ~ndimage.binary_dilation(bridge_regs[nm], dil, iterations=BAND)
        elif nm in bridge_regs:
            # An applied piece's own drawing does not belong to the piece it is
            # laid on. Band-sharing hands the container every unowned stroke in
            # its boundary band, and a pocket sitting inside a panel puts its
            # flap, its button and its whole bag outline in that band -- the
            # panel layer then renders a complete second copy of the pocket
            # (measured on 1d22549af6c7: 51% of the pocket's ink was also in
            # front_left_body_panel). The panel still gets a complete perimeter
            # UNDER the pocket, because the ring is unioned into cap further
            # down, after this strip -- so what goes is the duplicate, not the
            # panel's own closure.
            drawn_by_applied = ndimage.binary_dilation(
                bridge_regs[nm], dil, iterations=BAND) & ~reg
            cap &= ~drawn_by_applied
        if os.environ.get("DEBUG_PART") == nm:
            print(f"  DEBUG {nm}: in bridge_regs={nm in bridge_regs} "
                  f"use_bridge={use_bridge} cap={int(cap.sum())}px")
        # Buttons/stitches get their own dedicated layer (below), so strip
        # them out of this part's own cap BEFORE checking for gaps -- not
        # after. That way the close-parts synthesis below judges coverage by
        # COARSE ink only: where a real seam line already exists alongside a
        # dash (e.g. topstitching next to a drawn boundary), it correctly
        # stays put, not duplicated; where a boundary was drawn ONLY as fine
        # fragments (no separate coarse line underneath), synthesis now
        # correctly sees a gap there and fills it with a proper line, instead
        # of the gap silently appearing once fine detail is pulled out.
        cap &= ~fine_all
        # No dash ink is EVER given back to a part's own layer. A copy of the
        # dash run traced here as well as in its own stitch_N layer prints the
        # same marks twice, from two different tracers (vtracer here, potrace
        # there) whose outlines land a fraction of a pixel apart -- rendered,
        # the pair reads as one lumpy, doubled-weight dash chain. Every dash
        # lives in exactly one place: its own layer. A side the sketch draws
        # as dashes alone is closed by the region ring below (REGION_OUTLINE),
        # which is geometry, filed as a guide, and switchable.
        # NOTE: no `cap.any()` guard here -- a part whose captured ink was
        # ENTIRELY fine detail (now stripped) needs its whole boundary
        # synthesized from scratch, not skipped just because cap is empty.
        # Synthesized gap-fill is kept SEPARATE from `cap` (not merged in) and
        # traced/styled on its own: a thin light-gray construction guide, not
        # a bold duplicate cutline -- a neighboring part (e.g. a placket) may
        # already carry the "real" line for this boundary, so this is just a
        # closure hint, drawn underneath everything else in this layer.
        synth_mask = np.zeros((H, W), bool)
        if close_parts:
            # 3) close all sides: synthesize edges where the part boundary
            #    has no drawn line (e.g. body edge hidden under a sleeve)
            # Same silhouette the ring uses: the applied piece folded in. Gated
            # on use_bridge, the panel's contour stepped around the pocket-
            # shaped notch in its own region and synthesized a closure line
            # along it -- so the panel layer drew a full copy of the pocket
            # outline even after the captured ink for it had been stripped.
            # The fabric is continuous under an applied piece; its contour has
            # to be too.
            contour_reg = (reg | bridge_regs[nm]) if nm in bridge_regs else reg
            contour = contour_reg & ~ndimage.binary_erosion(contour_reg, dil, iterations=2)
            # Closure fills a gap in the OUTLINE. Dashes count as cover even
            # though they are not part of this piece's outline and live in
            # their own per-mark layers: a stitch run marks a side that IS
            # already drawn, so laying a synthesized line along it printed a
            # black band over the dashes. Where the outline is genuinely
            # absent AND no dashes run there, the gap gets a line.
            # NOTHING is ever synthesized where stitching runs. Laying an
            # outline in the same place as a dash run merges the two into one
            # fat black band when rendered -- the dashes and the new line
            # coalesce -- so a side carrying stitching is left exactly as
            # drawn, dashes only, even if that leaves the piece open there.
            # Closure is only for a side with nothing on it at all.
            near_ink = ndimage.binary_dilation(cap, dil, iterations=5)
            if DASH_KEEPOUT > 0:
                # iterations=0 would be an identity dilation, not "no term" --
                # the dash run itself would still mask the contour it sits on
                # and leave the piece open there.
                near_ink = near_ink | ndimage.binary_dilation(
                    fine_all, dil, iterations=DASH_KEEPOUT)
            synth = contour & ~near_ink
            if synth.any():
                sl_, sn_ = ndimage.label(synth, structure=np.ones((3, 3)))
                sizes_ = ndimage.sum_labels(synth, sl_, np.arange(1, sn_ + 1))
                # Corner/tip closures (armhole corner, sleeve underarm tip,
                # yoke side edge) are naturally short curve segments -- a
                # 40px-area cutoff dropped them outright, leaving a real
                # gap in the traced silhouette exactly at those spots.
                # No dilation here. The contour ring is already ~2px, which is
                # the sketch's own stroke weight; widening it produced a guide
                # heavier than any real line, and on a piece whose whole
                # perimeter synthesizes (a cuff whose outline ink got owned by
                # the sleeve) that fat ring rendered as a solid black blob
                # sitting on top of the real outline.
                keep_ = np.isin(sl_, np.nonzero(sizes_ >= MIN_SYNTH_AREA)[0] + 1)
                synth_mask = keep_
                # The span bridging an applied piece's footprint used to be
                # promoted into `cap` and inked as a solid cutting line, on the
                # grounds that it is this part's own true edge rather than a
                # hidden-elsewhere guess. It is still SYNTHESIZED geometry
                # though -- no stroke in the sketch corresponds to it -- and
                # promoting it put a solid line into the drawing that
                # GUIDE_FILL could not switch off (measured: 2421px of invented
                # cutline in one bomber's back body panel). Leave it in
                # synth_mask so it obeys the same rule as every other closure:
                # present in the SVG, not inked unless GUIDE_FILL says so.
        if synth_mask.any():
            # Draw the closure as ONE continuous line, not the row of short
            # fragments the raw contour-minus-ink mask breaks into (traced,
            # those read as stitching). Bridge along the contour and pin the
            # result to the contour itself -- closing inside the wider BAND
            # ring inflates each bridge into a blocky lump.
            # Pinned to the contour EXACTLY, not a dilated copy of it: the
            # closing fills notches on a diagonal/staircase ring, and letting
            # the result spill into a wider ring turned every corner into a
            # blocky lump.
            synth_mask = ndimage.binary_closing(
                synth_mask, dil, iterations=SYNTH_BRIDGE) & contour
        # Close the piece on all four sides off its own region boundary.
        # Skipped for grab_box parts (a zip tape is a strip cut geometrically,
        # not an enclosed panel) and for parts with no region of their own.
        # A boxed part still gets a complete-boundary copy below -- the strip it
        # is cut as -- so it too extracts as a closed shape.
        if p.get("grab_box") and REGION_OUTLINE:
            strip = grab_mask(p, H, W)
            if reg.any():
                # prefer the piece's own silhouette when seg found one; the box
                # is a hand/model-placed rectangle around it, always coarser
                strip = ndimage.binary_closing(reg, dil, iterations=RING_SEAL) \
                    if RING_SEAL > 0 else reg
            if strip.any():
                ring_full[nm] = strip & ~ndimage.binary_erosion(
                    strip, dil, iterations=outline_px)
        if REGION_OUTLINE and reg.any() and not p.get("grab_box"):
            # Ring the part's SEALED silhouette, not the raw region union. A
            # part is usually several seg regions (a puffer's baffles, a
            # panel split by a dart), and every seam BETWEEN them shows up in
            # the union as a hairline slit -- the drawn line's own pixels,
            # which belong to no region. Ringing the union walks into each
            # slit and back out, printing a solid line down BOTH sides of
            # every internal seam: on a dash-drawn baffle seam that is two
            # invented cutlines flanking the dashes, which is what made the
            # stitching read as a fat black band. Closing the union first
            # welds those slits shut, so the ring is the piece's outer
            # perimeter only -- the thing it is actually for.
            #
            # Ring the silhouette WITH every applied piece folded back into
            # it. A pocket or a badge laid on a panel carves its own footprint
            # out of the panel's segmented white area, and ringing the raw
            # region walks around that hole -- the panel comes out cut in two
            # around the pocket instead of running continuously underneath it.
            # The fabric is one piece under an applied one, so the container's
            # perimeter has to be complete beneath it. This is unconditional,
            # unlike the `use_bridge` gate on contour synthesis below: that one
            # is about not duplicating a line that already exists, while a hole
            # in the perimeter is wrong however the ink fell.
            ring_reg = reg | bridge_regs[nm] if nm in bridge_regs else reg
            sealed = ndimage.binary_closing(ring_reg, dil, iterations=RING_SEAL) \
                if RING_SEAL > 0 else ring_reg
            ring = sealed & ~ndimage.binary_erosion(
                sealed, dil, iterations=max(1, outline_px))
            # COMPLETE BOUNDARY: keep the whole perimeter, before the dash
            # keepout below opens it. Every component must own its full closed
            # outline so it can be extracted on its own without reconstructing
            # the edges its neighbours happen to draw -- overlapping a
            # neighbour's boundary is fine, missing one's own is not. This copy
            # is geometry only (BOUNDARY_FILL, "none" by default), so it never
            # doubles a line in the composed drawing.
            ring_full[nm] = ring.copy()
            # From here on `ring` is the VISIBLE ring, and it is a hairline: it
            # only ever appears on sides the sketch left undrawn (see the
            # RING_ON_INK subtraction below), so it has no neighbouring stroke
            # weight to match, and the composed drawing stacks part on part.
            if RING_PX != max(1, outline_px):
                ring = sealed & ~ndimage.binary_erosion(
                    sealed, dil, iterations=max(1, RING_PX))
            # Per PIXEL, drop the ring where STITCHING runs. A dashed seam is
            # a drawn line already; ringing it lays a hairline through the
            # gaps that links dash to dash, and the run reads as a dashed
            # line printed over a solid one.
            #
            # Gated on the DASH mask only, never on ink in general. A shared
            # seam is drawn once and owned by one of the two pieces it
            # divides, so the other piece has no ink of its own there --
            # keeping the ring off every inked pixel left exactly those sides
            # open (measured on the bomber: sleeves, body panels, yoke, back
            # panel and collar all traced as open curves). A piece must come
            # out closed even when its edge belongs to its neighbour, so the
            # ring stays everywhere except along stitching.
            # The ring runs straight through a stitched seam, unbroken.
            #
            # A seam drawn as topstitching is still a seam: both pieces either
            # side of it get cut along it, so both need a continuous line
            # there. Subtracting the dash mask from the ring (the old
            # behaviour) left each piece with closure fragments sitting in the
            # white gaps between the dashes -- enough to pass a flood test, but
            # it reads as a broken line woven through the stitching rather than
            # a cut line. The stitching keeps its own per-dash layers on top;
            # this is the boundary underneath it.
            #
            # RING_KEEPOUT > 0 restores the old subtraction, dilated by that
            # many px, for comparing against earlier output.
            if not RING_KEEPOUT_OFF and fine_all.any():
                grow = dash_keepout_px if RING_KEEPOUT < 0 else RING_KEEPOUT
                keepout = ndimage.binary_dilation(
                    fine_all, dil, iterations=grow) if grow > 0 else fine_all
                before_k = int(ring.sum())
                ring &= ~keepout
                if before_k != int(ring.sum()):
                    print(f"  [{nm}] ring: {before_k} -> {int(ring.sum())}px "
                          f"(kept off dashed seams, bridge {grow}px)")
            # Ring the part only when its own captured ink does not already
            # close it. The ring runs alongside the drawn seam, so applying it
            # unconditionally puts a second stroke on every edge in the
            # drawing (measured: 54k -> 80k px of ink at OUTLINE_PX=1, 105k at
            # 2). Pieces the sketch already draws shut keep their original
            # line exactly; only the broken ones are repaired.
            #
            # Two finer-grained variants measured worse:
            #   - adding the ring only where this part captured nothing leaves
            #     the side open anyway, because a boundary drawn as dashed
            #     quilting reads as "captured" at every dash while closing
            #     nothing (front body panel enclosed 60k px against 152k true);
            #   - deleting the captured edge band and substituting the ring
            #     removed more than it put back and opened every part.
            # Gating this on a WHOLE-PART fill test was measurably unreliable --
            # a boundary held together by a single-pixel chain passed the test
            # and still broke in the traced output, leaving one sleeve open
            # while its identically sized mirror closed. So the decision is made
            # per pixel instead: the ring is kept everywhere EXCEPT where this
            # part's own captured ink already runs, which is the only place it
            # can double a line. A side whose seam belongs to the neighbouring
            # piece has no ink in this part's cap, so its ring survives and the
            # piece still closes. Extraction closure never depended on this at
            # all -- ring_full above is the complete perimeter.
            if not RING_ON_INK and cap.any():
                # Radius: the ring sits a pixel inside the region boundary and
                # the drawn stroke a pixel outside it, so their centres are
                # ~outline_px apart; +2 covers the sub-pixel slop of the seg
                # boundary and, along a dashed seam, bridges the white gaps
                # between marks so the run does not keep a ring in each gap.
                # Tried and rejected: vetoing only with ink inside a band at the
                # region edge, on the theory that a quilted panel's interior
                # baffle lines were deleting its perimeter ring. Measured
                # identically (1464/2543/0px kept on the three body panels,
                # same as vetoing with all of cap), so interior ink is not what
                # opens these outlines -- the veto here is already edge ink.
                drawn = ndimage.binary_dilation(
                    cap, dil, iterations=max(1, outline_px) + RING_INK_PAD)
                before = int(ring.sum())
                ring = ring & ~drawn
                print(f"  [{nm}] ring: {before} -> {int(ring.sum())}px "
                      f"(dropped where its own ink already draws the edge)")
            cap |= ring
            ring_protect = ring

        if not cap.any() and not synth_mask.any():
            continue
        th = int(os.environ.get("THICKEN", "0"))
        thin = 0.0 if th > 0 else float(os.environ.get("THIN", str(THIN)))
        if th > 0:
            cap = ndimage.binary_dilation(cap, dil, iterations=th)
        paths = []
        if cap.any():
            # binarize: vtracer re-thresholds at ~128, faint gray strokes
            # would vanish otherwise
            canvas, cscale = thin_canvas(cap, dil, thin, protect=ring_protect)
            if p.get("grab_box"):
                # grab_box parts are small, sharp-cornered exclusive-cut
                # detail (zipper tape/teeth, guard stitching) -- exactly what
                # potrace's no-curve-smoothing mode is for. vtracer's spline
                # fit smooths sharp zigzag turns (zip teeth) into a rounded
                # blob; a whole zip's teeth run is too large an ink area to
                # get caught by the global fine_all button/stitch detector
                # above (which gates on a single component's own bbox/area,
                # and a continuous zigzag the length of the zip fails both),
                # so it falls through to vtracer unless routed here directly.
                #
                # A tooth is ~1px wide in the source art and the gap between
                # two teeth is narrower still, so at native resolution the gap
                # falls inside a single pixel and the ladder traces as one
                # fused bar. Re-threshold this part's own footprint on a
                # LANCZOS-upscaled copy instead: interpolation puts the gaps
                # back on pixels of their own and the zigzag survives.
                #
                # The cut matters and neither automatic choice is good on a
                # low-res source: a local Otsu over the tape's own footprint
                # lands near the clip floor (~100) and leaves a scatter of
                # dots, while the global ink cut (~160) swallows the whole
                # gray tape into one filled bar. Default to local Otsu and
                # let TRIM_T override it per sketch.
                #
                # Trim IS thinned, same as every other part -- see the shave
                # below. It used to be exempt, from when a box held only faint
                # tape ticks rather than a whole zip.
                gb = p["grab_box"]
                gx0, gy0 = max(0, int(gb[0])), max(0, int(gb[1]))
                gx1, gy1 = min(W, int(gb[2])), min(H, int(gb[3]))
                if gx1 > gx0 and gy1 > gy0:
                    # Confine this part to its own strip. Band-sharing and the
                    # second-chance pixel grab both hand a boxed part ink that
                    # merely PASSES THROUGH its box -- a lapel edge crossing
                    # the front zip diagonally, a panel seam clipping a pocket
                    # zip -- and that ink then traced into the zip's layer, so
                    # extracting the zip on its own produced the zip plus two
                    # stray lapel edges instead of a clean zip strip. A zip's
                    # own ink (teeth, rails, slider, stops) stays inside the
                    # strip; a crossing line keeps going well past it. Drop
                    # any component that carries more than CROSS_TOL px beyond
                    # the strip, and leave it to the panel it belongs to,
                    # which already holds its own shared copy.
                    # With a grab_poly this hugs the diagonal strip; the crop
                    # below still works off the bbox, which only has to CONTAIN
                    # the zone for the re-threshold to see the same pixels.
                    zone = grab_halo(p, H, W, RAIL_MARGIN)
                    clab, cn_ = ndimage.label(cap, structure=np.ones((3, 3)))
                    if cn_:
                        outside_px = ndimage.sum_labels(
                            (cap & ~zone).astype(np.uint8), clab,
                            np.arange(1, cn_ + 1))
                        crossers = np.nonzero(outside_px > CROSS_TOL)[0] + 1
                        if crossers.size:
                            cap = cap & ~np.isin(clab, crossers)
                    cap &= zone
                    if not cap.any():
                        layers.append((zkey(nm), nm, [], []))
                        print(f"  [{nm}] 0 paths (no ink in its own strip)")
                        continue
                    zs = TRIM_SS
                    up = np.array(Image.fromarray(
                        a[gy0:gy1, gx0:gx1]).resize(
                        ((gx1 - gx0) * zs, (gy1 - gy0) * zs), Image.LANCZOS))
                    trim_thr = int(os.environ.get("TRIM_T", 0)) or \
                        otsu_threshold(up)
                    strict = np.zeros((H * zs, W * zs), bool)
                    strict[gy0 * zs:gy1 * zs, gx0 * zs:gx1 * zs] = up < trim_thr
                    cap_up = np.repeat(np.repeat(cap, zs, axis=0), zs, axis=1)
                    fine_mask = strict & cap_up
                    # Shave a boxed part the same way every other part is
                    # shaved. Skipping THIN here dates from when a box held
                    # only faint tape ticks; now that the box owns the whole
                    # zip -- rails, teeth, slider -- the exemption made the zip
                    # the boldest thing in the drawing (measured: a belt/zip
                    # crop carried 33% more ink than the sketch). The cut runs
                    # at trim resolution, so it is `thin * zs` deep, and the
                    # per-pixel half-width guard inside thin_canvas keeps the
                    # teeth themselves from being eaten.
                    # Done in place on the box's own crop: fine_mask is a
                    # full-canvas array at trim resolution (~68MB here), and
                    # thin_canvas would supersample it again on top of that.
                    if thin > 0 and fine_mask.any():
                        it = max(1, int(round(thin * zs)))
                        sy0, sy1, sx0, sx1 = gy0 * zs, gy1 * zs, gx0 * zs, gx1 * zs
                        sub = fine_mask[sy0:sy1, sx0:sx1]
                        eroded = ndimage.binary_erosion(sub, dil, iterations=it)
                        # same per-pixel guard as thin_canvas: ink already as
                        # light as the cut keeps its full weight, so a tooth
                        # thinner than `it` survives instead of being erased
                        half_w = ndimage.grey_dilation(
                            ndimage.distance_transform_edt(sub), size=2 * it + 1)
                        eroded |= sub & (half_w <= it + KEEP_HALF_W)
                        fine_mask[sy0:sy1, sx0:sx1] = eroded
                    canvas_fine = Image.fromarray(
                        np.where(fine_mask, 0, 255).astype(np.uint8))
                    fscale = 1.0 / zs
                    # A zip's own tape rails routinely sit just OUTSIDE the
                    # grab_box -- the box is drawn tight around the teeth/pull
                    # track, which is the part of a zip only the zip can own,
                    # while a rail runs a few px to either side of it. That
                    # rail ink is still in this part's cap (and has already
                    # been stripped out of the neighbouring panels as this
                    # part's), so tracing only the box-limited mask dropped it
                    # from the drawing entirely: the zip came out with one rail
                    # instead of two, and welt/pocket outlines around a boxed
                    # zip lost whole edges. Trace what the box left behind
                    # through the coarse path as well -- but only within a
                    # rail-width margin of the box, NOT this part's whole
                    # remaining cap: band-sharing also lends a boxed part the
                    # seam/outline ink of whatever it sits on (observed: a
                    # front zip's layer dragging in the lapel's V edges), and
                    # those lines already have their own copy on the panel
                    # they belong to. Keeping the margin tight is what makes
                    # the zip extract as JUST the zip strip.
                    outside = np.zeros((H, W), bool)
                    my0, my1 = max(0, gy0 - RAIL_MARGIN), min(H, gy1 + RAIL_MARGIN)
                    mx0, mx1 = max(0, gx0 - RAIL_MARGIN), min(W, gx1 + RAIL_MARGIN)
                    outside[my0:my1, mx0:mx1] = True
                    outside &= cap
                    outside[gy0:gy1, gx0:gx1] = False
                    if outside.any():
                        canvas_o, oscale = thin_canvas(outside, dil, thin)
                        paths += scale_paths(trace(canvas_o, ss_of(oscale)), oscale)
                else:
                    canvas_fine, fscale = canvas, cscale
                paths += scale_paths(trace_potrace(canvas_fine), fscale)
            else:
                paths += scale_paths(trace(canvas, ss_of(cscale)), cscale)
        # Closure splits by whether anything covers it. A synthesized line that
        # runs UNDER another piece (a placket's end caps, tucked beneath the
        # collar and the hem band) can be inked freely: it closes the piece for
        # anyone extracting it on its own, and the piece on top hides it in the
        # composed drawing, so no stroke appears that the sketch does not have.
        # A synthesized line out in the open is the opposite -- that is what put
        # a solid seam beside the center-back dashes -- so it stays GUIDE_FILL
        # (white by default) and shows only if asked for.
        hidden_mask = synth_mask & other_regs_d if synth_mask.any() else synth_mask
        open_mask = synth_mask & ~hidden_mask
        guide_paths, hidden_paths = [], []
        if open_mask.any():
            canvas_g, gscale = thin_canvas(open_mask, dil, thin)
            guide_paths += scale_paths(trace(canvas_g, ss_of(gscale)), gscale)
        if hidden_mask.any():
            canvas_h, hscale = thin_canvas(hidden_mask, dil, thin)
            hidden_paths = scale_paths(trace(canvas_h, ss_of(hscale)), hscale)
            paths += hidden_paths
            print(f"  [{nm}] closure under another piece: "
                  f"{int(hidden_mask.sum())}px inked")
        # COMPLETE BOUNDARY copy: the part's whole closed perimeter, traced only
        # where the layer's own inked geometry does not already carry it (dash
        # keepout drops the ring along stitching, a boxed part gets no ring at
        # all, and a shared seam is owned by exactly one of its two pieces).
        # Emitted unfilled, so the composed drawing is unchanged while every
        # component still extracts as a closed shape.
        bpaths = []
        if nm in ring_full:
            # Dilate cap by the ring's own thickness, not a fixed 1px: ring_full
            # is an erosion-band outline_px wide, so a 1px check for "does the
            # part's own ink already cover this" left a sliver up to
            # (outline_px - 1) wide uncovered along EVERY already-inked edge,
            # not just genuinely open ones -- a thin duplicate line hugging the
            # real seam the whole way round (measured: visible beside a
            # sleeve's own seam next to a badge, not just at the gap the badge
            # actually left open).
            missing = ring_full[nm] & ~ndimage.binary_dilation(
                cap, dil, iterations=max(1, outline_px))
            if missing.sum() >= MIN_SYNTH_AREA:
                # Trace only the MISSING arc, not the whole ring_full silhouette.
                # Tracing the full ring stacked a second, independently-eroded
                # copy of the outline on top of every side the part's own ink
                # already draws -- invisible while this path stayed fill="none"
                # everywhere, but the per-part crop now paints it (see
                # _visible_boundary in EXPORT_PARTS below), and the two
                # near-but-not-pixel-identical copies of the same edge
                # rendered as a doubled, visibly thickened line on sides that
                # were already fine. Only the genuinely open span needs this.
                canvas_b, bscale = thin_canvas(missing, dil, thin)
                bpaths = scale_paths(trace(canvas_b, ss_of(bscale)), bscale)
                print(f"  [{nm}] complete-boundary copy "
                      f"({int(missing.sum())}px not in the inked layer)")
        boundary_paths[nm] = bpaths
        layers.append((zkey(nm), nm, paths, guide_paths))
        print(f"  [{nm}] {len(paths)} paths")

    # Every individual button and every individual stitch dash gets its OWN
    # layer (never bundled together, never left inside whichever part it sits
    # on). Trace the WHOLE mask in a single potrace pass -- not one crop+trace
    # per mark -- so geometry stays clean and matches the input exactly
    # (tracing tiny marks individually, each cropped to its own bbox, was
    # introducing extra jitter/fragmentation not present in the source art).
    # potrace's own SVG output already emits one <path> per disjoint shape,
    # so splitting those into separate named layers is just enumerating them.
    # ("button" is itself an allowed part-naming keyword, so guard against a
    # real region-based part already claiming one of these exact names.)
    existing_names = {nm for _, nm, _, _ in layers}
    # Which real part each button/stitch mark visually sits on -- so the
    # per-part preview PNG below can show a complete piece (edge + its own
    # darts/tacks/topstitch dashes) instead of a bare silhouette with pale
    # synthesized guide lines standing in for detail that actually exists,
    # just filed under its own dedicated button_N/stitch_N layer elsewhere.
    # The real SVG layer structure (each mark its own group) is untouched;
    # this only decides what gets composited alongside it in the PNG export.
    # A mark sitting inside (or right on the margin of) a grab_box part's own
    # tight box is that part's own trim detail (e.g. a zip tape's printed
    # ticks) -- nearest_part_id can flicker mark-by-mark right at that box
    # edge (whichever side wins by a fraction of a pixel), which made
    # otherwise-symmetric ticks show up composited into one body panel's
    # preview but not its mirror. Resolve those deterministically to the
    # grab_box part instead of trusting the nearest-distance tie-break.
    grab_boxes = [(nm, p["grab_box"]) for nm, p in cfg["parts"].items()
                  if p.get("grab_box")]

    def mark_owner_of(cx, cy):
        for nm, (x0, y0, x1, y1) in grab_boxes:
            if x0 - FLANK_MARGIN <= cx < x1 + FLANK_MARGIN and y0 <= cy < y1:
                return nm
        pid = nearest_part_id[cy, cx]
        return part_names[pid - 1] if pid else None

    # Hardware marks that the fine-detail detector files as "stitch" because
    # they LOOK like dashes -- a zip's teeth, a placket's snap ticks, a fly's
    # bar tacks -- are not stitching and must not be grayed with it. A tooth
    # run rendered gray reads as a smudge where the sketch has a hard black
    # ladder. Judged by the part the mark sits on (mark_owner_of), which is
    # the only thing that separates a tooth from the topstitch beside it.
    HARDWARE_OWNER_KEYWORDS = ("zip", "placket", "fly", "button", "snap",
                               "eyelet", "buckle", "rivet", "grommet")
    dark_marks = set()

    mark_owner = {}
    for mask, prefix in ((buttons_mask, "button"), (stitches_mask, "stitch")):
        if not mask.any():
            continue
        canvas = np.full((H, W), 255, np.uint8)
        canvas[mask] = 0
        paths = trace_potrace(Image.fromarray(canvas))
        for i, path in enumerate(paths, start=1):
            name = f"{prefix}_{i}"
            if name in existing_names:
                name = f"{prefix}_{i}_2"
            existing_names.add(name)
            layers.append(((10**6, 10**6, i), name, [path], []))
            d, _tr = path
            xmin, xmax, ymin, ymax = parse_path(d).bbox()
            cy = min(max(int((ymin + ymax) / 2), 0), H - 1)
            cx = min(max(int((xmin + xmax) / 2), 0), W - 1)
            owner = mark_owner_of(cx, cy)
            if owner:
                mark_owner[name] = owner
                if any(k in owner for k in HARDWARE_OWNER_KEYWORDS):
                    dark_marks.add(name)
        print(f"  [{prefix}_*] {len(paths)} individual layers")

    # catch-all: ink no part captured -> "unassigned" layer (never lose lines)
    captured = np.zeros((H, W), bool)
    for _, _, _ in []:
        pass
    for nm, p in cfg["parts"].items():
        reg = np.isin(labels, p["regions"])
        captured |= ndimage.binary_dilation(reg, dil, iterations=BAND)
    captured |= grabbed_union
    left = ink & ~captured
    if left.sum() > 200:
        th = int(os.environ.get("THICKEN", "0"))
        thin = 0.0 if th > 0 else float(os.environ.get("THIN", str(THIN)))
        if th > 0:
            left = ndimage.binary_dilation(left, dil, iterations=th)
        canvas, lscale = thin_canvas(left, dil, thin)
        paths = scale_paths(trace(canvas, ss_of(lscale)), lscale)
        layers.append(((-1, -1, 0), "unassigned", paths, []))
        print(f"  [unassigned] {len(paths)} paths ({int(left.sum())} px)")

    layers.sort(key=lambda t: t[0])
    merge = os.environ.get("MERGE_PATHS", "1") == "1"
    TR_NUM = re.compile(r"translate\(([-\d.]+),([-\d.]+)\)")
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" '
           f'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" '
           f'viewBox="0 0 {W} {H}" width="{W}" height="{H}">']
    def bake(d, tr):
        if tr:
            m = TR_NUM.search(tr)
            off = complex(float(m.group(1)), float(m.group(2)))
            d = parse_path(d).translated(off).d()
        return d

    # Topstitch dashes are real ink, but they are construction detail, not
    # cutlines -- drawn at the same black as the outlines they sit beside,
    # a busy sketch's stitching competes with the seams for read. Gray by
    # default: still clearly there, clearly secondary. STITCH_FILL=#000000
    # restores full black, #ffffff hides the stitching entirely.
    stitch_fill = os.environ.get("STITCH_FILL", "#808080")

    for _, name, paths, guide_paths in layers:
        # Gray is for stitching ONLY. Every cutline, every hardware mark
        # (zip teeth, snaps, buttons) stays black -- see dark_marks.
        fill = (stitch_fill if name.startswith("stitch_")
                and name not in dark_marks else "#000000")
        out.append(f'  <g id="{name}" inkscape:groupmode="layer" '
                   f'inkscape:label="{name}">')
        # Guide (synthesized gap-closure) paths first, underneath the real
        # cutline -- inked BLACK by default, same as a drawn cutline. A guide
        # is the pipeline's own closure for a span the sketch left open (a
        # sleeve underarm, a side seam dying out at the hem), and leaving it
        # white made those pieces render with a visible hole in the outline.
        # It never lands on top of stitching: DASH_KEEPOUT/RING_KEEPOUT hold
        # the closure off every dash run and every stroke already drawn, so
        # what gets inked here is only the blank spans. GUIDE_FILL=#ffffff
        # hides them again.
        if guide_paths:
            parts_g = [bake(d, tr) for d, tr in guide_paths]
            out.append(f'    <path d="{" ".join(parts_g)}" '
                       f'fill="{os.environ.get("GUIDE_FILL", "#000000")}" '
                       f'fill-rule="evenodd"/>')
        # The component's own complete closed perimeter, unfilled: geometry for
        # extraction, invisible in the composed drawing (BOUNDARY_FILL=#000000
        # to see it, BOUNDARY_FILL=off to leave it out of the file).
        bfill = os.environ.get("BOUNDARY_FILL", "none")
        if boundary_paths.get(name) and bfill != "off":
            parts_b = [bake(d, tr) for d, tr in boundary_paths[name]]
            out.append(f'    <path class="component-boundary" '
                       f'd="{" ".join(parts_b)}" fill="{bfill}" '
                       f'fill-rule="evenodd"/>')
        if merge:
            # ONE compound path per part: bake translate into coordinates
            # and join all subpaths (disjoint regions -> evenodd is safe)
            parts_d = [bake(d, tr) for d, tr in paths]
            out.append(f'    <path d="{" ".join(parts_d)}" '
                       f'fill="{fill}" fill-rule="evenodd"/>')
        else:
            for d, tr in paths:
                ta = f' transform="{tr}"' if tr else ''
                out.append(f'    <path d="{d}" fill="{fill}" '
                           f'fill-rule="evenodd"{ta}/>')
        out.append('  </g>')
    out.append('</svg>')
    svg_text = "\n".join(out)
    if os.environ.get("OPTIMIZE", "1") == "1":
        # round coordinates to 1 decimal, collapse whitespace: typically
        # 30-40% smaller with no visible change
        svg_text = re.sub(r"(\d+\.\d{2,})",
                          lambda m: f"{float(m.group(1)):.1f}", svg_text)
        svg_text = re.sub(r"[ \t]+", " ", svg_text)
    open(out_svg, "w").write(svg_text)
    print(f"wrote {out_svg} ({len(layers)} layers, "
          f"{len(svg_text)//1024} KB)")

    # visual proof pack: each part as PNG + recombined composite
    if os.environ.get("EXPORT_PARTS", "1") == "1":
        try:
            import fitz  # noqa: F401 -- just probing availability here
        except (ImportError, OSError) as e:
            print(f"(skipping per-part PNG exports: {e})")
            return
        pdir = os.path.join(os.path.dirname(os.path.abspath(labels_npy)),
                            "parts_png")
        # flat2svg_auto's verify loop re-traces up to 3x, renaming/splitting
        # parts as it corrects groups.json (e.g. a merged panel splits into
        # body_panel + sleeve). Without a wipe, a part dropped by a later
        # round stays on disk forever, so the API still serves it alongside
        # the corrected parts. Clear before repopulating.
        shutil.rmtree(pdir, ignore_errors=True)
        os.makedirs(pdir, exist_ok=True)
        svg_txt = "\n".join(out)
        head = svg_txt[:svg_txt.index(">") + 1]
        groups = {nm: g for g, nm in
                  re.findall(r'(<g id="([^"]+)".*?</g>)', svg_txt, re.S)}
        owned_marks = {}
        for mark_name, owner_nm in mark_owner.items():
            owned_marks.setdefault(owner_nm, []).append(mark_name)
        # Real parts only. Every button and every stitch dash is its own
        # layer, so exporting a PNG per layer meant a full-canvas cairosvg
        # render for each of them -- on the puffer sketch 757 renders, of
        # which 741 were a single 10px tick alone on a 1600px page, and they
        # dominated the run (minutes, against seconds for the trace itself).
        # The marks are still visible in the export: each one is composited
        # into the PNG of the part it sits on, which is where you would look
        # for it anyway.
        # The component-boundary path is emitted fill="none" so it stays
        # invisible in the composed drawing (out_svg, _recombined.png below) --
        # visible there it would double every shared seam a neighbour already
        # draws. A part exported alone has no neighbour to double against, and
        # for a part whose own ink never draws one of its sides at all (a cuff
        # whose top edge is topstitching "owned" by the sleeve above it, per
        # the ring-ownership comment above) that boundary is the ONLY copy of
        # that edge that exists anywhere -- invisible, the per-part PNG came
        # out open on that side. Paint it in, matching the ink fill, for this
        # standalone crop only.
        def _visible_boundary(svg_fragment: str) -> str:
            return re.sub(r'(<path class="component-boundary"[^>]*?fill=")none(")',
                          r'\g<1>#000000\g<2>', svg_fragment)

        for nm, g in groups.items():
            if nm.startswith(("stitch_", "button_")):
                continue
            # Stitch-dash layers carry real construction detail -- quilting
            # channels and panel topstitch are drawn as gray dashes too, not
            # just decorative topstitching, so excluding every "stitch_" mark
            # here once stripped the quilting off a part along with it. Keep
            # them; a genuine seam boundary between two DIFFERENT parts is
            # handled separately by the solid closing line below, not by
            # hiding this piece's own surface detail.
            extra_g = "".join(groups[m] for m in owned_marks.get(nm, [])
                               if m in groups)
            svg2png(svg_bytes=(head + _visible_boundary(g) + extra_g + "</svg>").encode(),
                    write_to=os.path.join(pdir, nm + ".png"),
                    output_width=min(W, 1600))
        svg2png(svg_path=out_svg,
                write_to=os.path.join(pdir, "_recombined.png"),
                output_width=min(W, 1600))
        print(f"part images -> {pdir}/ (open _recombined.png to see "
              f"all parts reattached in place)")


if __name__ == "__main__":
    main(*sys.argv[1:5])
