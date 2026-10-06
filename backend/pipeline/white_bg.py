#!/usr/bin/env python3
"""
white_bg.py — make a product render's background pure white (#FFFFFF).

The image model is asked for "a clean white background" and returns off-white
(~249) with a soft grey gradient and floor shadow, which reads as a grey box
next to the pure-white flat sketch in the before/after slider. This floods the
background in from the image border and paints it pure white:

  * the flood moves pixel to pixel (floating range), so it follows a gentle
    gradient or a soft shadow across the canvas, but stops at the garment's
    edge -- even a white garment keeps its outline, because the step from the
    background to the garment's edge is sharper than the gradient;
  * it only starts from border pixels that are light and nearly colourless,
    so a garment cropped by the frame is never a seed;
  * the mask edge is feathered by a pixel so the garment doesn't get a hard
    jagged outline against the new white.

Usage:  python3 white_bg.py image.png [out.png]     (in place without out)
"""
import sys

import cv2
import numpy as np
from PIL import Image

STEP = 3          # max per-pixel difference the flood crosses (gradient, not edges)
SEED_MIN = 225    # border pixel must be at least this light to start a flood
SEED_CHROMA = 18  # ...and this close to grey (max channel spread)


def whiten_background(rgb: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    mask = np.zeros((h + 2, w + 2), np.uint8)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8)  # floating range (neighbour-relative)
    lo = up = (STEP, STEP, STEP)
    border = [(x, 0) for x in range(0, w, 4)] + [(x, h - 1) for x in range(0, w, 4)] + \
             [(0, y) for y in range(0, h, 4)] + [(w - 1, y) for y in range(0, h, 4)]
    for x, y in border:
        if mask[y + 1, x + 1]:
            continue
        px = rgb[y, x].astype(int)
        if px.min() < SEED_MIN or px.max() - px.min() > SEED_CHROMA:
            continue
        cv2.floodFill(bgr, mask, (x, y), (0, 0, 0), lo, up, flags)
    bg = mask[1:-1, 1:-1] > 0
    if not bg.any():
        return rgb
    # feather: 1px soft edge between the garment and the new white
    alpha = cv2.GaussianBlur(bg.astype(np.float32), (3, 3), 0)[..., None]
    out = rgb.astype(np.float32) * (1 - alpha) + 255.0 * alpha
    return np.clip(out, 0, 255).astype(np.uint8)


def whiten_file(src: str, dst: str | None = None) -> None:
    im = Image.open(src)
    has_alpha = im.mode in ("RGBA", "LA")
    rgb = np.array(im.convert("RGB"))
    out = Image.fromarray(whiten_background(rgb))
    if has_alpha:
        out.putalpha(im.getchannel("A"))
    out.save(dst or src)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: white_bg.py image.png [out.png]")
    whiten_file(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
