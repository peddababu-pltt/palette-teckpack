// Puts a reconstructed garment (garment3d.glb from three.ws, a solid object with
// its own textures) onto the scanned body: scaled to the pattern's span (HPS to
// hem for a top, waist down for a bottom), centred on the body and widened as a
// whole to wrap it (the scene hides the body it covers, so nothing pokes through). Everything comes out in scan space, so
// the measurement warp moves it with the body like the other garments.
import * as THREE from "three"
import type { TryOnPlan } from "./plan"
import { SCAN, shortsHem, type BodyFrame, type Ratios } from "./shape"

export interface FittedPiece {
  pos: Float32Array
  index: Uint32Array
  uv: Float32Array | null
  material: THREE.Material
}

/** Vertical span (scan space) the pattern's garment covers. */
export function garmentSpan(plan: TryOnPlan, r: Ratios): { top: number; bottom: number } {
  const hps = SCAN.hpsY + 0.05 // collars stand a little above the HPS
  const waist = SCAN.waistY + 0.02
  const skirtHem = plan.skirt ? waist - plan.skirt.lengthCm / 100 / r.legLen : null
  if (plan.top && (plan.skirt || plan.bottom))
    return { top: hps, bottom: skirtHem ?? (plan.bottom?.lengthCm ? shortsHem(plan.bottom.lengthCm, r) : SCAN.floorY + 0.03) }
  if (plan.top) return { top: hps, bottom: SCAN.hpsY - plan.top.lengthCm / 100 / r.torsoLen }
  if (plan.skirt) return { top: waist, bottom: skirtHem! }
  if (plan.bottom) return { top: SCAN.pantsTopY + 0.02, bottom: plan.bottom.lengthCm ? shortsHem(plan.bottom.lengthCm, r) : SCAN.floorY + 0.03 }
  return { top: hps, bottom: SCAN.waistY - 0.2 }
}

export function fitGenerated(root: THREE.Object3D, span: { top: number; bottom: number }, f: BodyFrame, gapCm: number): FittedPiece[] {
  root.updateMatrixWorld(true)
  const pieces: { g: THREE.BufferGeometry; material: THREE.Material }[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry?.getAttribute("position")) return
    const g = m.geometry.clone()
    g.applyMatrix4(m.matrixWorld)
    const mat = Array.isArray(m.material) ? m.material[0] : m.material
    pieces.push({ g, material: mat })
  })
  if (!pieces.length) return []
  const box = new THREE.Box3()
  for (const p of pieces) {
    p.g.computeBoundingBox()
    box.union(p.g.boundingBox!)
  }
  const size = box.getSize(new THREE.Vector3())
  const s = (span.top - span.bottom) / (size.y || 1)
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2
  const midZ = f.torsoZ[f.bin((span.top + span.bottom) / 2)]
  const gap = gapCm / 100
  return pieces.map(({ g, material }) => {
    const src = g.getAttribute("position")
    const pos = new Float32Array(src.count * 3)
    for (let i = 0; i < src.count; i++) {
      pos[i * 3] = (src.getX(i) - cx) * s
      pos[i * 3 + 1] = span.top - (box.max.y - src.getY(i)) * s
      pos[i * 3 + 2] = (src.getZ(i) - cz) * s + midZ
    }
    widenToBody(pos, f, gap, midZ)
    const idx = g.getIndex()
    const index = idx ? Uint32Array.from(idx.array as ArrayLike<number>) : Uint32Array.from({ length: src.count }, (_, i) => i)
    const uvAttr = g.getAttribute("uv")
    // per vertex: the GLB's attributes may be interleaved or quantized
    let uv: Float32Array | null = null
    if (uvAttr) {
      uv = new Float32Array(uvAttr.count * 2)
      for (let i = 0; i < uvAttr.count; i++) { uv[i * 2] = uvAttr.getX(i); uv[i * 2 + 1] = uvAttr.getY(i) }
    }
    if (material instanceof THREE.MeshStandardMaterial) {
      material.side = THREE.DoubleSide
      // glTF's default metalness is 1 when only a texture is given: this is cloth
      material.metalness = 0
    }
    g.dispose()
    return { pos, index, uv, material }
  })
}

/** The reconstruction is sized for an average ghost mannequin. One width factor
 *  (x and z, about the body's axis) makes its torso wrap this body plus `gap`:
 *  a single factor keeps the garment's own shape -- quilting, collar, sleeves --
 *  where per-height or per-point fitting crumples it. */
function widenToBody(pos: Float32Array, f: BodyFrame, gap: number, midZ: number) {
  const need: number[] = []
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    if (Math.abs(x) > SCAN.armX || y > SCAN.chestY + 0.02 || y < SCAN.crotchY) continue
    const dz = z - midZ, r = Math.hypot(x, dz)
    const body = f.radius(y, Math.atan2(z - f.torsoZ[f.bin(y)], x))
    if (body && r > 0.02) need.push((body + gap) / r)
  }
  if (!need.length) return
  need.sort((a, b) => a - b)
  const k = Math.min(1.6, Math.max(1, need[Math.floor(need.length * 0.85)]))
  for (let i = 0; i < pos.length; i += 3) {
    pos[i] *= k
    pos[i + 2] = midZ + (pos[i + 2] - midZ) * k
  }
}
