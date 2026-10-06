#!/usr/bin/env python3
"""Slim the 3D preview's mannequin GLB down to the body-shape morphs it uses.

Source: parametric-base.glb from github.com/nirholas/three.ws (public/avatars/),
baked from the CC0 MakeHuman / MPFB2 base mesh (via NAVER's anny). The source
carries ~300 face/body morph targets; the pattern viewer only fits the body to
the garment's measurements, so every other target is dropped -- same mesh, rig
and materials, a fraction of the size.

Usage: python3 scripts/slim-mannequin.py parametric-base.glb backend/assets/mannequin.glb
"""
import json
import struct
import sys

KEEP = {
    "bodyFeminine", "bodyMasculine", "bodyHeavier", "bodyThinner",
    "chestWider", "chestNarrower", "chestDeeper", "chestShallower",
    "torsoUnderbustWider", "torsoUnderbustNarrower",
    "bustBigger", "bustSmaller", "shouldersWider", "shouldersNarrower",
    "waistWider", "waistNarrower", "bellyBigger", "bellySmaller",
    "hipsWider", "hipsNarrower", "hipsCircWider", "hipsCircNarrower",
    "gluteusBigger", "gluteusSmaller", "armsThicker", "armsThinner",
    "thighsThicker", "thighsThinner", "neckThicker", "neckThinner",
    "heightTaller", "heightShorter", "legsLonger", "legsShorter",
}

COMP_SIZE = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
TYPE_N = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def main(src, dst):
    raw = open(src, "rb").read()
    jlen = struct.unpack("<I", raw[12:16])[0]
    gltf = json.loads(raw[20:20 + jlen])
    bin_start = 20 + jlen + 8
    binary = raw[bin_start:bin_start + struct.unpack("<I", raw[20 + jlen:24 + jlen])[0]]

    for mesh in gltf["meshes"]:
        names = (mesh.get("extras") or {}).get("targetNames") or []
        if not names:
            continue
        keep_idx = [i for i, n in enumerate(names) if n in KEEP]
        for prim in mesh["primitives"]:
            if "targets" in prim:
                prim["targets"] = [prim["targets"][i] for i in keep_idx]
        mesh["extras"]["targetNames"] = [names[i] for i in keep_idx]
        if "weights" in mesh:
            mesh["weights"] = [mesh["weights"][i] for i in keep_idx]

    # accessors still referenced
    used = set()
    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            used.update(prim["attributes"].values())
            if "indices" in prim:
                used.add(prim["indices"])
            for tgt in prim.get("targets", []):
                used.update(tgt.values())
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            used.add(skin["inverseBindMatrices"])
    for anim in gltf.get("animations", []):
        for s in anim["samplers"]:
            used.update([s["input"], s["output"]])

    views, out = [], bytearray()

    def copy(view_idx, offset, length, target=None):
        view = gltf["bufferViews"][view_idx]
        start = view.get("byteOffset", 0) + offset
        while len(out) % 4:
            out.append(0)
        new = {"buffer": 0, "byteOffset": len(out), "byteLength": length}
        if target is not None:
            new["target"] = target
        out.extend(binary[start:start + length])
        views.append(new)
        return len(views) - 1

    # Dense views (vertex attributes -- interleaved here -- indices, bind matrices)
    # are copied whole, once; only the sparse morph data is repacked per accessor.
    whole = {}

    def copy_whole(view_idx):
        if view_idx not in whole:
            bv = gltf["bufferViews"][view_idx]
            whole[view_idx] = copy(view_idx, 0, bv["byteLength"], bv.get("target"))
            if bv.get("byteStride"):
                views[whole[view_idx]]["byteStride"] = bv["byteStride"]
        return whole[view_idx]

    remap, accessors = {}, []
    for i, acc in enumerate(gltf["accessors"]):
        if i not in used:
            continue
        acc = dict(acc)
        elem = COMP_SIZE[acc["componentType"]] * TYPE_N[acc["type"]]
        if "bufferView" in acc:
            acc["bufferView"] = copy_whole(acc["bufferView"])
        if "sparse" in acc:
            sp = json.loads(json.dumps(acc["sparse"]))
            ind, val = sp["indices"], sp["values"]
            ind["bufferView"] = copy(ind["bufferView"], ind.get("byteOffset", 0), sp["count"] * COMP_SIZE[ind["componentType"]])
            ind["byteOffset"] = 0
            val["bufferView"] = copy(val["bufferView"], val.get("byteOffset", 0), sp["count"] * elem)
            val["byteOffset"] = 0
            acc["sparse"] = sp
        remap[i] = len(accessors)
        accessors.append(acc)

    for mesh in gltf["meshes"]:
        for prim in mesh["primitives"]:
            prim["attributes"] = {k: remap[v] for k, v in prim["attributes"].items()}
            if "indices" in prim:
                prim["indices"] = remap[prim["indices"]]
            prim["targets"] = [{k: remap[v] for k, v in t.items()} for t in prim.get("targets", [])]
            if not prim["targets"]:
                del prim["targets"]
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = remap[skin["inverseBindMatrices"]]
    for anim in gltf.get("animations", []):
        for s in anim["samplers"]:
            s["input"], s["output"] = remap[s["input"]], remap[s["output"]]

    gltf["accessors"], gltf["bufferViews"] = accessors, views
    while len(out) % 4:
        out.append(0)
    gltf["buffers"] = [{"byteLength": len(out)}]
    gltf.setdefault("asset", {})["copyright"] = "CC0 1.0 - MakeHuman/MPFB2 base mesh (via NAVER anny, nirholas/three.ws)"

    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(dst, "wb") as f:
        f.write(struct.pack("<4sII", b"glTF", 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(out), b"BIN\0") + bytes(out))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
