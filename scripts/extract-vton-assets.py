"""Extract the 3D virtual try-on assets from a Three.js editor scene export.

Source: the `app.json` of https://github.com/Qingcsai/3DVirtualTryOn (a scanned
body plus pre-aligned T-shirt / trouser scans). Writes, into backend/assets/vton/:

  <name>.bin   indexed mesh: header (u32 nVerts, u32 nIndex) + f32 pos[n*3]
               + f32 uv[n*2] + u32 index[nIndex]
  <name>.jpg   the mesh's scan texture
  manifest.json  meshes, kinds, y-ranges and the body's landmark profile

Usage: venv/bin/python scripts/extract-vton-assets.py path/to/app.json
"""

import base64
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parents[1] / "backend" / "assets" / "vton"
KIND = {"body1": "body", "tshirt": "top", "pant": "bottom"}
TEX_MAX = 2048


def kind_of(name: str) -> str:
    for prefix, kind in KIND.items():
        if name.startswith(prefix):
            return kind
    return "other"


def dedupe(pos: np.ndarray, uv: np.ndarray):
    key = np.concatenate([np.round(pos, 5), np.round(uv, 5)], axis=1)
    _, first, inverse = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return pos[first].astype(np.float32), uv[first].astype(np.float32), inverse.reshape(-1).astype(np.uint32)


def write_mesh(path: Path, pos, uv, index):
    with open(path, "wb") as f:
        f.write(struct.pack("<II", len(pos), len(index)))
        f.write(pos.tobytes())
        f.write(uv.tobytes())
        f.write(index.tobytes())


def write_texture(path: Path, data_url: str):
    img = Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1]))).convert("RGB")
    img.thumbnail((TEX_MAX, TEX_MAX))
    img.save(path, "JPEG", quality=85)


def torso_girth(slab: np.ndarray) -> tuple[float, float, float]:
    """Perimeter (m), width and depth of the torso part of a horizontal slab:
    the x-cluster around the body's centre, so hanging arms are left out."""
    xs = np.sort(slab[:, 0])
    gaps = np.where(np.diff(xs) > 0.012)[0]
    lo, hi = xs[0], xs[-1]
    for g in gaps:
        if xs[g] < 0:
            lo = max(lo, xs[g + 1])
        elif xs[g + 1] > 0:
            hi = min(hi, xs[g])
    t = slab[(slab[:, 0] >= lo) & (slab[:, 0] <= hi)][:, [0, 2]]
    return hull_perimeter(t), float(hi - lo), float(t[:, 1].max() - t[:, 1].min())


def hull_perimeter(pts: np.ndarray) -> float:
    pts = np.unique(np.round(pts, 4), axis=0)
    if len(pts) < 3:
        return 0.0
    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in pts[::-1]:
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    hull = np.array(lower[:-1] + upper[:-1])
    return float(np.linalg.norm(np.roll(hull, -1, axis=0) - hull, axis=1).sum())


def main(app_json: str):
    OUT.mkdir(parents=True, exist_ok=True)
    scene = json.load(open(app_json))["scene"]
    geos = {g["uuid"]: g for g in scene["geometries"]}
    mats = {m["uuid"]: m for m in scene["materials"]}
    texs = {t["uuid"]: t for t in scene["textures"]}
    imgs = {i["uuid"]: i for i in scene["images"]}
    meshes, body_pos = [], None

    def walk(obj, group=""):
        nonlocal body_pos
        if obj.get("geometry"):
            name = obj["name"]
            attrs = geos[obj["geometry"]]["data"]["attributes"]
            pos = np.array(attrs["position"]["array"], dtype=np.float64).reshape(-1, 3)
            uv = np.array(attrs["uv"]["array"], dtype=np.float64).reshape(-1, 2)
            p, u, idx = dedupe(pos, uv)
            write_mesh(OUT / f"{name}.bin", p, u, idx)
            mat = mats[obj["material"]]
            tex = texs[mat["emissiveMap"]]
            write_texture(OUT / f"{name}.jpg", imgs[tex["image"]]["url"])
            kind = kind_of(name)
            if kind == "body":
                body_pos = p
            meshes.append({
                "name": name, "kind": kind, "scan": group, "verts": int(len(p)),
                "yMin": float(p[:, 1].min()), "yMax": float(p[:, 1].max()),
            })
            print(f"{name}: {len(pos)} -> {len(p)} verts")
        for c in obj.get("children", []):
            walk(c, obj.get("name", group))

    walk(scene["object"])

    # body profile: torso girth / width / depth every 1 cm, for measuring the scan
    y0, y1 = float(body_pos[:, 1].min()), float(body_pos[:, 1].max())
    profile = []
    for y in np.arange(y0 + 0.02, y1 - 0.02, 0.01):
        slab = body_pos[np.abs(body_pos[:, 1] - y) < 0.005]
        if len(slab) < 20:
            continue
        g, w, d = torso_girth(slab)
        profile.append([round(float(y), 3), round(g, 4), round(w, 4), round(d, 4)])
    manifest = {"source": "github.com/Qingcsai/3DVirtualTryOn", "bodyY": [y0, y1], "meshes": meshes, "profile": profile}
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print("wrote", OUT)


if __name__ == "__main__":
    main(sys.argv[1])
