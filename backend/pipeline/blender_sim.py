"""
blender_sim.py -- high-quality garment simulation in Blender (run headless):

  blender -b --factory-startup --python blender_sim.py -- in.json out.json out.glb

in.json (written by the 3D garment workspace):
  body:      { verts: [x,y,z,...], tris: [a,b,c,...] }        fitted body, metres, y up
  parts:     [{ key, verts: [...], tris: [...] }]              pieces at their initial assembly
  stitches:  [[i, j], ...]                                     global vertex pairs to sew
  frames:    int
  fabric:    { mass, tension, bending, thickness }

What it does: body -> collision object; every piece -> one cloth mesh whose seams
are loose "sewing" edges between stitched vertices (Blender's sewing springs pull
them shut); gravity; step the frames; write the final vertex positions (same order
as the input) to out.json and export the draped garment to out.glb.

Axis: the workspace is y-up; Blender is z-up. Converted on the way in and out.
"""
import json
import sys

import bpy
import bmesh

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) < 2:
    print("usage: blender -b --python blender_sim.py -- in.json out.json [out.glb]")
    sys.exit(1)
IN, OUT = argv[0], argv[1]
GLB = argv[2] if len(argv) > 2 else None
data = json.load(open(IN))


def to_b(x, y, z):  # y-up -> z-up
    return (x, -z, y)


def from_b(x, y, z):
    return (x, z, -y)


def log(msg):
    print(msg, flush=True)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
frames = int(data.get("frames", 120))
scene.frame_start, scene.frame_end = 1, frames


def mesh_obj(name, verts, tris, edges=()):
    me = bpy.data.meshes.new(name)
    vs = [to_b(verts[i], verts[i + 1], verts[i + 2]) for i in range(0, len(verts), 3)]
    fs = [(tris[i], tris[i + 1], tris[i + 2]) for i in range(0, len(tris), 3)]
    me.from_pydata(vs, list(edges), fs)
    me.update()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    return ob


# ---- body: collision ----
body = mesh_obj("Body", data["body"]["verts"], data["body"]["tris"])
col = body.modifiers.new("Collision", "COLLISION")
body.collision.thickness_outer = 0.006
body.collision.cloth_friction = 8.0
log(f"body: {len(body.data.vertices)} verts")

# ---- garment: all pieces in one cloth mesh, seams as sewing edges ----
verts, tris, offset = [], [], 0
for p in data["parts"]:
    verts.extend(p["verts"])
    tris.extend(t + offset for t in p["tris"])
    offset += len(p["verts"]) // 3
seen = set()
sew = []
for a, b in data["stitches"]:
    k = (min(a, b), max(a, b))
    if a != b and k not in seen:
        seen.add(k)
        sew.append(k)
garment = mesh_obj("Garment", verts, tris, sew)
log(f"garment: {offset} verts, {len(tris) // 3} tris, {len(sew)} sewing edges")

fab = data.get("fabric", {})
cloth = garment.modifiers.new("Cloth", "CLOTH")
s = cloth.settings
s.quality = 10
s.mass = float(fab.get("mass", 0.15))
s.tension_stiffness = s.compression_stiffness = float(fab.get("tension", 15))
s.shear_stiffness = float(fab.get("tension", 15)) * 0.5
s.bending_stiffness = float(fab.get("bending", 0.5))
s.air_damping = 1.0
s.use_sewing_springs = True
s.sewing_force_max = 120.0
s.shrink_min = 0.0
cc = cloth.collision_settings
cc.use_collision = True
cc.distance_min = float(fab.get("thickness", 0.004)) + 0.003
cc.use_self_collision = bool(data.get("selfCollision", False))
cc.self_distance_min = 0.003
cloth.point_cache.frame_start, cloth.point_cache.frame_end = 1, frames

# ---- step the simulation ----
for f in range(1, frames + 1):
    scene.frame_set(f)
    if f % 10 == 0 or f == frames:
        log(f"frame {f}/{frames}")

dg = bpy.context.evaluated_depsgraph_get()
ev = garment.evaluated_get(dg)
me = ev.to_mesh()
out = []
for v in me.vertices:
    out.extend(round(c, 5) for c in from_b(*v.co))
json.dump({"x": out, "frames": frames}, open(OUT, "w"))
log(f"Saved: {OUT}")

if GLB:
    # bake the drape into a plain mesh and export just the garment
    baked = bpy.data.meshes.new_from_object(ev)
    ev.to_mesh_clear()
    final = bpy.data.objects.new("GarmentBaked", baked)
    scene.collection.objects.link(final)
    for ob in list(scene.objects):
        ob.select_set(ob is final)
    bpy.context.view_layer.objects.active = final
    bpy.ops.export_scene.gltf(filepath=GLB, export_format="GLB", use_selection=True)
    log(f"Saved: {GLB}")
