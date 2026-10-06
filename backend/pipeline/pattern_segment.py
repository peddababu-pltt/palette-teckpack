#!/usr/bin/env python3
"""
pattern_segment.py -- an uploaded image of sewing-pattern pieces -> one asset per piece.

    image -> ink/fill mask -> gaps closed, holes filled -> connected components
          -> per piece: mask, crop (transparent PNG), outline contour -> polygon

Pieces drawn as outlines on white/grid paper and pieces photographed as filled
shapes both end up as solid components: ink is "not near-white", thin grid lines
are opened away, outlines are closed and filled. The border-touching background
and tiny specks are dropped.

Scale: pixels have no real size, so `--longest-cm` says how long the longest piece
is (default 70 cm, a typical bodice); every polygon is scaled from that.

Output (same contract as the drafted pattern's pattern-pieces.json, so the 3D
garment pipeline consumes it unchanged):
  <outdir>/pattern-pieces/<Pnn>.png, <outdir>/pattern-pieces.json

Segmenter adapter: `--segmenter contours` (built-in). A SAM-family model can be
plugged in behind the same `segment_masks()` signature.

Usage: python3 pattern_segment.py image.png outdir [--longest-cm 70]
"""
import argparse
import json
import os
import sys

from _bootstrap_deps import ensure

ensure(modules=["scipy", "skimage"], packages=["scipy==1.18.0", "scikit-image==0.26.0"])
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage as ndi  # noqa: E402
from skimage import measure, morphology  # noqa: E402

PAD_MM = 20


def segment_masks(rgb: np.ndarray) -> list:
    """Built-in contour segmenter: list of boolean masks, one per piece."""
    h, w = rgb.shape[:2]
    gray = rgb.mean(axis=2)
    sat = rgb.max(axis=2) - rgb.min(axis=2)
    # ink / fabric = noticeably darker than paper, or coloured
    paper = np.percentile(gray, 90)
    ink = (gray < paper - 40) | (sat > 40)
    # thin grid / dimension lines: an opening removes 1-2px strokes...
    k = max(1, round(min(h, w) / 600))
    solid = ndi.binary_opening(ink, structure=morphology.disk(k))
    # ...but outline-only drawings must keep their outline: close gaps, then fill
    outline = ndi.binary_closing(ink, structure=morphology.disk(k * 2 + 1))
    filled = ndi.binary_fill_holes(outline)
    mask = filled | solid
    lab, n = ndi.label(mask)
    if n:
        sizes = ndi.sum(mask, lab, range(1, n + 1))
        mask = np.isin(lab, np.nonzero(sizes >= h * w * 0.0008)[0] + 1)
    labels = measure.label(mask, connectivity=2)
    out = []
    for region in measure.regionprops(labels):
        minr, minc, maxr, maxc = region.bbox
        touches = minr == 0 or minc == 0 or maxr == h or maxc == w
        if touches and region.area > h * w * 0.4:
            continue  # background / page frame
        m = labels == region.label
        m = ndi.binary_fill_holes(m)
        out.append(m)
    return out


def polygon_of(mask: np.ndarray) -> np.ndarray:
    padded = np.pad(mask, 1)
    contours = measure.find_contours(padded.astype(float), 0.5)
    c = max(contours, key=len) - 1  # (row, col)
    poly = measure.approximate_polygon(c, tolerance=1.2)
    return poly[:, ::-1]  # -> (x, y)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("outdir")
    ap.add_argument("--longest-cm", type=float, default=70.0)
    ap.add_argument("--segmenter", default="contours", choices=["contours"])
    a = ap.parse_args()

    img = Image.open(a.image).convert("RGB")
    # work at a bounded size
    scale_px = min(1.0, 1800 / max(img.size))
    if scale_px < 1:
        img = img.resize((round(img.width * scale_px), round(img.height * scale_px)), Image.LANCZOS)
    rgb = np.asarray(img).astype(np.float32)
    print("segmenting pattern image", flush=True)
    masks = segment_masks(rgb)
    if not masks:
        print(json.dumps({"error": "no pattern pieces found in the image"}))
        sys.exit(1)
    boxes = [(np.argwhere(m)) for m in masks]
    longest_px = max(max(np.ptp(b[:, 0]), np.ptp(b[:, 1])) for b in boxes)
    mm_per_px = (a.longest_cm * 10) / max(1, longest_px)
    print(f"{len(masks)} pieces; scale {mm_per_px:.2f} mm/px (longest piece = {a.longest_cm} cm)", flush=True)

    pdir = os.path.join(a.outdir, "pattern-pieces")
    os.makedirs(pdir, exist_ok=True)
    rgba_full = np.dstack([np.asarray(img), np.full(rgb.shape[:2], 255, np.uint8)])
    pieces = []
    # order: top-to-bottom, left-to-right, like reading the sheet
    order = sorted(range(len(masks)), key=lambda i: (round(boxes[i][:, 0].min() / 80), boxes[i][:, 1].min()))
    for n, i in enumerate(order, 1):
        m = masks[i]
        ys, xs = np.nonzero(m)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        pad = max(2, round(PAD_MM / mm_per_px))
        Y0, X0 = max(0, y0 - pad), max(0, x0 - pad)
        Y1, X1 = min(m.shape[0], y1 + pad), min(m.shape[1], x1 + pad)
        crop = rgba_full[Y0:Y1, X0:X1].copy()
        crop[..., 3] = np.where(m[Y0:Y1, X0:X1], 255, 0)
        suffix = f"P{n:02d}"
        Image.fromarray(crop).save(os.path.join(pdir, f"{suffix}.png"))
        poly = polygon_of(m[Y0:Y1, X0:X1]) * mm_per_px
        w_mm, h_mm = (X1 - X0) * mm_per_px, (Y1 - Y0) * mm_per_px
        px = poly[:, 0]
        py = poly[:, 1]
        pieces.append({
            "suffix": suffix,
            "file": f"pattern-pieces/{suffix}.png",
            "wMm": round(float(w_mm), 1),
            "hMm": round(float(h_mm), 1),
            "cutMm": {"x": round(float(px.min()), 1), "y": round(float(py.min()), 1),
                      "w": round(float(np.ptp(px)), 1), "h": round(float(np.ptp(py)), 1)},
            "polygon": [[round(float(x), 1), round(float(y), 1)] for x, y in poly[:-1]],
            "foldLine": None,
            "onFold": False,
            "extra": False,
            "source": "image",
        })
    with open(os.path.join(a.outdir, "pattern-pieces.json"), "w") as f:
        json.dump({"dir": "pattern-pieces", "source": "image", "mmPerPx": mm_per_px, "pieces": pieces}, f, indent=2)
    print(f"Saved: {len(pieces)} pieces", flush=True)


if __name__ == "__main__":
    main()
