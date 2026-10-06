// What the Blender simulation job (backend/pipeline/blender_sim.py) needs: the fitted
// body as a collision mesh, every piece at its initial assembly, and the stitch pairs.
import * as THREE from "three"
import type { Assembly } from "./GarmentAssembly"
import type { ClothSim } from "./ClothSim"
import type { FabricSpec } from "./types"

export interface BlenderPayload {
  body: { verts: number[]; tris: number[] }
  parts: { key: string; verts: number[]; tris: number[] }[]
  stitches: [number, number][]
  frames: number
  fabric: { mass: number; tension: number; bending: number; thickness: number }
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5

/** The body mesh in world space (as fitted + shown), for collision. */
export function bodyMesh(root: THREE.Object3D): { verts: number[]; tris: number[] } {
  root.updateMatrixWorld(true)
  const verts: number[] = [], tris: number[] = []
  const v = new THREE.Vector3()
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.visible || /eye|teeth|tongue/i.test(m.name)) return
    const pos = m.geometry.attributes.position
    const base = verts.length / 3
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld)
      verts.push(r5(v.x), r5(v.y), r5(v.z))
    }
    const idx = m.geometry.index
    if (idx) for (let i = 0; i < idx.count; i++) tris.push(base + idx.getX(i))
    else for (let i = 0; i < pos.count; i++) tris.push(base + i)
  })
  return { verts, tris }
}

export function blenderPayload(a: Assembly, sim: ClothSim, bodyRoot: THREE.Object3D, fabric: FabricSpec, frames = 120): BlenderPayload {
  return {
    body: bodyMesh(bodyRoot),
    parts: a.parts.map((p) => ({ key: p.inst.key, verts: Array.from(p.initial, r5), tris: Array.from(p.tris) })),
    stitches: sim.stitches.map((s) => [s.a, s.b]),
    frames,
    fabric: {
      mass: 0.12 + fabric.thickness * 60,
      tension: 5 + (1 - fabric.stretch) * 25,
      bending: 0.05 + fabric.bend * 2,
      thickness: fabric.thickness,
    },
  }
}
