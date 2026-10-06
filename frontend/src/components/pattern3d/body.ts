// The body the 3D pattern preview dresses, reduced to what the piece placement
// needs: torso cross-sections by height, arm and leg centre-lines, and a few
// landmark heights. Two sources, same `Fit` shape:
//
//   - fitModel: the realistic MakeHuman body (backend/assets/mannequin.glb, CC0),
//     shaped to the pattern's measurements (morph search per girth, then a small
//     baked residual scale), with sections sampled from its actual mesh and limbs
//     read off its skeleton.
//   - proceduralFit: the built-in lathe mannequin, used when no model is installed.
//
// Metres, y up, the body faces +z, floor at y = 0.
import * as THREE from "three"
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js"

export const TAU = Math.PI * 2
export const GAP = 0.012 // cloth sits this far off the skin

const DEFAULT_CM: Record<string, number> = {
  chest: 94, waist: 78, hips: 100, neck: 38, shoulderToShoulder: 43, hpsToWaistBack: 45,
  waistToHips: 12, inseam: 78, biceps: 30, wrist: 17, shoulderToWrist: 58, upperLeg: 55, ankle: 23,
}

export function measurement(cm: Record<string, number>, key: string): number {
  return (cm[key] > 0 ? cm[key] : DEFAULT_CM[key]) / 100
}

export interface Section {
  a: number // half-width
  zf: number // depth in front of cz
  zb: number // depth behind cz
  cz: number // z of the section's centre
}

// A limb centre-line (shoulder -> elbow -> wrist, or hip -> knee -> ankle).
export class Polyline {
  pts: THREE.Vector3[]
  lens: number[]
  length: number
  constructor(pts: THREE.Vector3[]) {
    this.pts = pts
    this.lens = pts.slice(1).map((p, i) => p.distanceTo(pts[i]))
    this.length = this.lens.reduce((s, l) => s + l, 0)
  }
  // d < 0 extends the first segment backwards (a sleeve cap rising over the shoulder)
  at(d: number): { p: THREE.Vector3; dir: THREE.Vector3 } {
    if (d < 0 && this.pts.length > 1) {
      const dir = this.pts[1].clone().sub(this.pts[0]).normalize()
      return { p: this.pts[0].clone().addScaledVector(dir, d), dir }
    }
    let rest = Math.max(0, d)
    for (let i = 0; i < this.lens.length; i++) {
      if (rest <= this.lens[i] || i === this.lens.length - 1) {
        const dir = this.pts[i + 1].clone().sub(this.pts[i]).normalize()
        return { p: this.pts[i].clone().addScaledVector(dir, rest), dir }
      }
      rest -= this.lens[i]
    }
    return { p: this.pts[0].clone(), dir: new THREE.Vector3(0, -1, 0) }
  }
}

export interface Fit {
  crotchY: number; hipY: number; waistY: number; chestY: number; shoulderY: number; neckY: number
  shoulderX: number; rNeck: number
  rBiceps: number; rWrist: number; rThigh: number; rAnkle: number
  section(y: number): Section
  hang: Section // widest body extent from mid-thigh up to the hip line (what a skirt/hem must clear)
  shoulderTop(x: number): number // skin height across the shoulders at |x|
  /** one leg's cross-section (centre + radius enclosing its skin) at height y, below the crotch */
  legSection(side: number, y: number): { cx: number; cz: number; r: number } | null
  /** the fitted body mesh itself (world space) -- the cloth collides with this */
  mesh?: { verts: Float32Array; tris: Uint32Array }
  /** radius enclosing the arm's skin `along` metres down its line (0 = not sampled) */
  armRadius?(side: number, along: number): number
  arm(side: number): Polyline // side +1 = the body's left (+x)
  leg(side: number): Polyline
}

// ---------------- built-in mannequin ----------------

interface Proc {
  profile: [number, number][]
  sx: number
  sz: number
  fit: Fit
}

export function proceduralBody(cm: Record<string, number>): Proc {
  const m = (k: string) => measurement(cm, k)
  const crotchY = m("inseam")
  const hipY = crotchY + 0.09
  const waistY = hipY + m("waistToHips")
  const shoulderY = waistY + m("hpsToWaistBack") - 0.03
  const chestY = waistY + (shoulderY - waistY) * 0.55
  const neckY = shoulderY + 0.07
  const r = (g: number) => g / TAU
  const rHip = r(m("hips")), rWaist = r(m("waist")), rChest = r(m("chest")), rNeck = r(m("neck"))
  const shoulderHalf = m("shoulderToShoulder") / 2
  const sx = 1.12, sz = 0.8
  const profile: [number, number][] = [
    [0, crotchY - 0.02], [rHip * 0.8, crotchY], [rHip, hipY], [rWaist, waistY], [rChest, chestY],
    [rChest * 0.97, shoulderY - 0.07], [Math.max((shoulderHalf / sx) * 0.92, rChest * 0.9), shoulderY - 0.025],
    [rNeck * 1.3, shoulderY + 0.01], [rNeck, shoulderY + 0.03], [rNeck, neckY], [0, neckY],
  ]
  const radiusAt = (y: number) => {
    if (y <= profile[1][1]) return profile[1][0]
    for (let i = 1; i < profile.length - 2; i++) {
      const [r0, y0] = profile[i], [r1, y1] = profile[i + 1]
      if (y >= y0 && y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0 || 1)
    }
    return rNeck
  }
  const armLen = m("shoulderToWrist")
  const a = (28 * Math.PI) / 180
  const legSpread = rHip * 0.5
  const fit: Fit = {
    crotchY, hipY, waistY, chestY, shoulderY, neckY, shoulderX: shoulderHalf, rNeck,
    rBiceps: r(m("biceps")), rWrist: r(m("wrist")), rThigh: r(m("upperLeg")), rAnkle: r(m("ankle")),
    section: (y) => {
      const rr = radiusAt(y)
      return { a: rr * sx, zf: rr * sz, zb: rr * sz, cz: 0 }
    },
    hang: { a: rHip * sx, zf: rHip * sz, zb: rHip * sz, cz: 0 },
    legSection: (side, y) => {
      if (y > crotchY || y < 0.03) return null
      const t = y / crotchY
      return { cx: side * legSpread, cz: 0, r: r(m("ankle")) + (r(m("upperLeg")) - r(m("ankle"))) * t }
    },
    shoulderTop: (x) => {
      const ax = Math.abs(x)
      if (ax <= rNeck * 1.15) return shoulderY + 0.03
      const t = Math.min(1, (ax - rNeck * 1.15) / Math.max(0.02, shoulderHalf - rNeck * 1.15))
      return shoulderY + 0.03 - 0.045 * t
    },
    arm: (side) => {
      const o = new THREE.Vector3(side * (shoulderHalf - r(m("biceps")) * 0.4), shoulderY - 0.035, 0)
      return new Polyline([o, o.clone().add(new THREE.Vector3(side * Math.sin(a), -Math.cos(a), 0).multiplyScalar(armLen))])
    },
    leg: (side) => new Polyline([new THREE.Vector3(side * legSpread, crotchY + 0.04, 0), new THREE.Vector3(side * legSpread, 0.04, 0)]),
  }
  return { profile, sx, sz, fit }
}

export function buildProceduralMannequin(p: Proc): THREE.Group {
  const { fit } = p
  const g = new THREE.Group()
  const skin = new THREE.MeshStandardMaterial({ color: 0xe9c8ad, roughness: 0.62, metalness: 0 })
  const torso = new THREE.Mesh(new THREE.LatheGeometry(p.profile.map(([r, y]) => new THREE.Vector2(r, y)), 64), skin)
  torso.scale.set(p.sx, 1, p.sz)
  g.add(torso)
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 48, 32), skin)
  head.scale.set(0.85, 1.1, 0.95)
  head.position.set(0, fit.neckY + 0.1, 0.01)
  g.add(head)
  const limb = (line: Polyline, r0: number, r1: number) => {
    const { p: start } = line.at(0)
    const end = line.at(line.length).p
    const len = line.length
    const geo = new THREE.CylinderGeometry(r0, r1, len, 32, 1)
    geo.translate(0, -len / 2, 0)
    const mesh = new THREE.Mesh(geo, skin)
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), end.clone().sub(start).normalize())
    mesh.position.copy(start)
    const cap = new THREE.Mesh(new THREE.SphereGeometry(r1 * 1.2, 20, 14), skin)
    cap.position.copy(end)
    const joint = new THREE.Mesh(new THREE.SphereGeometry(r0 * 1.02, 20, 14), skin)
    joint.position.copy(start)
    g.add(mesh, cap, joint)
  }
  for (const side of [-1, 1]) {
    limb(fit.arm(side), fit.rBiceps, fit.rWrist)
    limb(fit.leg(side), fit.rThigh * 0.95, fit.rAnkle)
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true })
  return g
}

// ---------------- realistic model ----------------

function perimeter(a: number, b: number) {
  return Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))
}
export const girthOf = (s: Section) => (perimeter(s.a, s.zf) + perimeter(s.a, s.zb)) / 2

const BAND = 0.01

// Sections of the torso by 1cm height band, from world-space vertex positions.
// A vertex counts as torso when it's inside the shoulder line and clear of the
// (A-posed) arm hanging beside it -- arms and legs never widen a section.
function sampleSections(pos: Float32Array, crotchY: number, topY: number, shoulderX: number, shoulderY: number,
  armX: (y: number) => number | null, armR: number): { y0: number; bands: (Section | null)[] } {
  const n = Math.ceil((topY - crotchY) / BAND) + 1
  const acc = Array.from({ length: n }, () => ({ ax: 0, zmin: Infinity, zmax: -Infinity, c: 0 }))
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    if (y < crotchY || y > topY) continue
    // above the armpit: out to the shoulder point; beside the hanging arm: clear of
    // it; below the hands: nothing to exclude (legs start under crotchY)
    const ax = armX(y)
    const limit = y > shoulderY - 0.06 ? shoulderX : ax !== null ? ax - armR * 1.1 : 0.3 // 0.3: hips, not the fingertips beside them
    if (Math.abs(x) > limit) continue
    const b = acc[Math.min(n - 1, Math.floor((y - crotchY) / BAND))]
    b.ax = Math.max(b.ax, Math.abs(x))
    b.zmin = Math.min(b.zmin, z)
    b.zmax = Math.max(b.zmax, z)
    b.c++
  }
  const bands = acc.map((b) => (b.c < 12 ? null : { a: b.ax, zf: (b.zmax - b.zmin) / 2, zb: (b.zmax - b.zmin) / 2, cz: (b.zmax + b.zmin) / 2 }))
  // A body slice is squarer than the ellipse through its width and depth -- its
  // front/back "corners" (belly, hip bones, seat) poke outside it. Grow each
  // band's ellipse until it contains every torso vertex in the band.
  const grow = new Array(n).fill(1)
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2]
    if (y < crotchY || y > topY) continue
    const ax = armX(y)
    const limit = y > shoulderY - 0.06 ? shoulderX : ax !== null ? ax - armR * 1.1 : 0.3
    if (Math.abs(x) > limit) continue
    const bi = Math.min(n - 1, Math.floor((y - crotchY) / BAND))
    const b = bands[bi]
    if (!b || b.a <= 0 || b.zf <= 0) continue
    const r = Math.hypot(x / b.a, (z - b.cz) / b.zf)
    if (r > grow[bi]) grow[bi] = r
  }
  bands.forEach((b, i) => {
    if (!b) return
    const k = Math.min(1.3, grow[i])
    b.a *= k; b.zf *= k; b.zb *= k
  })
  // fill gaps + light smoothing
  for (let i = 0; i < bands.length; i++) if (!bands[i]) bands[i] = bands[i - 1] || bands.find(Boolean) || null
  return { y0: crotchY, bands }
}

function sectionAt(s: { y0: number; bands: (Section | null)[] }, y: number): Section {
  const f = (y - s.y0) / BAND
  const i = Math.max(0, Math.min(s.bands.length - 1, Math.floor(f)))
  const avg = (k: keyof Section) => {
    let sum = 0, c = 0
    for (let j = i - 2; j <= i + 2; j++) {
      const b = s.bands[Math.max(0, Math.min(s.bands.length - 1, j))]
      if (b) { sum += b[k]; c++ }
    }
    return c ? sum / c : 0.12
  }
  return { a: avg("a"), zf: avg("zf"), zb: avg("zb"), cz: avg("cz") }
}

// Shapes the model to the measurements and returns it (ready to add to the scene)
// plus its Fit. Mutates the loaded GLTF.
export function fitModel(gltf: GLTF, cm: Record<string, number>, designKey: string, targetHeight: number, gender: "male" | "female" = "male"): { root: THREE.Object3D; fit: Fit } {
  const root = gltf.scene
  let body: THREE.SkinnedMesh | null = null
  root.traverse((o) => {
    const mesh = o as THREE.SkinnedMesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.frustumCulled = false
      if (mesh.name === "Body" || (!body && mesh.isSkinnedMesh)) body = mesh
    }
  })
  if (!body) throw new Error("model has no body mesh")
  const bodyMesh: THREE.SkinnedMesh = body
  root.updateMatrixWorld(true)
  const bone = (name: string) => {
    let found: THREE.Object3D | undefined
    root.traverse((o) => { if (!found && o.name.replace(/[:_]/g, "").toLowerCase().endsWith(name.toLowerCase())) found = o })
    return found ? found.getWorldPosition(new THREE.Vector3()) : null
  }
  const baseBox = new THREE.Box3().setFromObject(root)
  const s = targetHeight / (baseBox.max.y - baseBox.min.y)
  const J = (name: string, fallback: THREE.Vector3) => (bone(name) || fallback).clone().multiplyScalar(s)

  const toWorld = bodyMesh.matrixWorld.clone()
  const toLocal = toWorld.clone().invert()
  const geo = bodyMesh.geometry
  // positions (and possibly morphs) can be interleaved -- read them per component
  const flatOf = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) => {
    const f = new Float32Array(attr.count * 3)
    for (let i = 0; i < attr.count; i++) { f[i * 3] = attr.getX(i); f[i * 3 + 1] = attr.getY(i); f[i * 3 + 2] = attr.getZ(i) }
    return f
  }
  const base = flatOf(geo.attributes.position)
  const targets = ((geo.morphAttributes.position || []) as THREE.BufferAttribute[]).map(flatOf)
  const dict = bodyMesh.morphTargetDictionary || {}
  const weights: Record<string, number> = {}
  // the men's figure unless asked for the women's (MakeHuman's gender morphs)
  void designKey
  if (gender === "female") { weights.bodyFeminine = 0.85; weights.bustBigger = 0.25 }
  else weights.bodyMasculine = 0.85
  const evalPositions = () => {
    const out = base.slice()
    for (const [name, w] of Object.entries(weights)) {
      const idx = dict[name]
      if (idx === undefined || !w) continue
      const d = targets[idx]
      for (let i = 0; i < out.length; i++) out[i] += d[i] * w
    }
    // mesh-local -> world (the body node can carry its own transform), then scale
    const v = new THREE.Vector3()
    for (let i = 0; i < out.length; i += 3) {
      v.set(out[i], out[i + 1], out[i + 2]).applyMatrix4(toWorld).multiplyScalar(s)
      out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z
    }
    return out
  }

  // the feminine morph is shorter than the rig it's skinned to: grow it back to
  // the rig's height so the joints (and any pose about them) sit in the body
  if (gender === "female" && dict.heightTaller !== undefined) {
    const heightOf = () => { const p = evalPositions(); let lo = Infinity, hi = -Infinity; for (let i = 1; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]) } return hi - lo }
    const want = (baseBox.max.y - baseBox.min.y) * s
    let lo = 0, hi = 1
    for (let it = 0; it < 8; it++) {
      weights.heightTaller = (lo + hi) / 2
      if (heightOf() < want) lo = weights.heightTaller
      else hi = weights.heightTaller
    }
  }

  const hips = J("Hips", new THREE.Vector3(0, 0.91, 0)), upLeg = J("LeftUpLeg", new THREE.Vector3(0.11, 0.87, 0))
  const arm = J("LeftArm", new THREE.Vector3(0.17, 1.34, 0)), fore = J("LeftForeArm", new THREE.Vector3(0.31, 1.17, 0))
  const hand = J("LeftHand", new THREE.Vector3(0.43, 1.06, 0.1)), neck = J("Neck", new THREE.Vector3(0, 1.41, 0))
  const spine2 = J("Spine2", new THREE.Vector3(0, 1.25, 0)), spine = J("Spine", new THREE.Vector3(0, 1.02, 0))
  const leg = J("LeftLeg", new THREE.Vector3(0.16, 0.45, 0)), foot = J("LeftFoot", new THREE.Vector3(0.22, 0.07, 0))
  const crotchY = upLeg.y - 0.07 * s
  const shoulderY = arm.y + 0.03 * s
  const armLine = new Polyline([arm, fore, hand])
  const armX = (y: number) => {
    if (y > arm.y || y < hand.y) return null
    const segs: [THREE.Vector3, THREE.Vector3][] = [[arm, fore], [fore, hand]]
    for (const [p0, p1] of segs) if (y <= p0.y && y >= p1.y) return p0.x + ((p1.x - p0.x) * (p0.y - y)) / (p0.y - p1.y || 1)
    return null
  }
  const rBiceps = measurement(cm, "biceps") / TAU
  // sampled from the upper thighs: skirts and long hems hang over them
  const lowY = Math.max(0.05, crotchY - 0.22 * s)
  const sample = (pos: Float32Array) => sampleSections(pos, lowY, neck.y + 0.06 * s, arm.x, arm.y, armX, rBiceps)

  // landmark heights: widest (hips) below the waist, narrowest (waist) between
  const findY = (pos: Float32Array) => {
    const sec = sample(pos)
    let hipY = hips.y, best = 0
    for (let y = crotchY + 0.06; y < spine.y; y += BAND) { const g = girthOf(sectionAt(sec, y)); if (g > best) { best = g; hipY = y } }
    let waistY = spine.y, low = Infinity
    for (let y = hipY + 0.05; y < spine2.y; y += BAND) { const g = girthOf(sectionAt(sec, y)); if (g < low) { low = g; waistY = y } }
    return { sec, hipY, waistY, chestY: spine2.y - 0.02 * s }
  }

  // morph search, one girth at a time (two passes: the regions overlap a little)
  const regions: [string, string, string, () => number][] = [
    ["hips", "hipsWider", "hipsNarrower", () => findY(evalPositions()).hipY],
    ["waist", "waistWider", "waistNarrower", () => findY(evalPositions()).waistY],
    ["chest", "chestWider", "chestNarrower", () => findY(evalPositions()).chestY],
  ]
  const girthAt = (y: number) => girthOf(sectionAt(sample(evalPositions()), y))
  // shoulder breadth: the shoulder band's full width against shoulderToShoulder
  const fitShoulders = () => {
    if (dict.shouldersWider === undefined || dict.shouldersNarrower === undefined) return
    const goal = measurement(cm, "shoulderToShoulder")
    let lo = -1, hi = 1
    for (let it = 0; it < 8; it++) {
      const w = (lo + hi) / 2
      weights.shouldersWider = Math.max(0, w)
      weights.shouldersNarrower = Math.max(0, -w)
      if (2 * sectionAt(sample(evalPositions()), arm.y - 0.02 * s).a < goal) lo = w
      else hi = w
    }
  }
  fitShoulders()
  for (let pass = 0; pass < 2; pass++) {
    for (const [key, up, down, yOf] of regions) {
      if (dict[up] === undefined || dict[down] === undefined) continue
      const goal = measurement(cm, key)
      const y = yOf()
      let lo = -1, hi = 1
      for (let it = 0; it < 9; it++) {
        const w = (lo + hi) / 2
        weights[up] = Math.max(0, w)
        weights[down] = Math.max(0, -w)
        if (girthAt(y) < goal) lo = w
        else hi = w
      }
    }
  }

  // bake: morphed shape + a residual radial scale so each girth lands on its measurement
  let pos = evalPositions()
  const land = findY(pos)
  const ratio = (key: string, y: number) => Math.min(1.25, Math.max(0.8, measurement(cm, key) / girthOf(sectionAt(land.sec, y))))
  const keys: [number, number][] = [
    [land.hipY, ratio("hips", land.hipY)], [land.waistY, ratio("waist", land.waistY)], [land.chestY, ratio("chest", land.chestY)],
  ]
  const factor = (y: number) => {
    if (y < crotchY - 0.1 || y > shoulderY) return 1
    if (y <= keys[0][0]) return 1 + (keys[0][1] - 1) * Math.max(0, (y - (crotchY - 0.1)) / (keys[0][0] - crotchY + 0.1))
    for (let i = 0; i < keys.length - 1; i++) {
      const [y0, f0] = keys[i], [y1, f1] = keys[i + 1]
      if (y >= y0 && y <= y1) return f0 + ((f1 - f0) * (y - y0)) / (y1 - y0 || 1)
    }
    const [yc, fc] = keys[2]
    return fc + ((1 - fc) * (y - yc)) / (shoulderY - yc || 1)
  }
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1]
    const x = pos[i]
    const sec = y >= crotchY && y <= shoulderY ? sectionAt(land.sec, y) : null
    // only the torso scales -- arms beside it keep their shape
    const ax = armX(y)
    // torso only: inside the sampled section, and clear of an arm or hand beside it
    if (sec && Math.abs(x) <= sec.a * 1.08 && (ax === null || Math.abs(x) < ax - rBiceps)) {
      const f = factor(y)
      pos[i] *= f
      pos[i + 2] = sec.cz + (pos[i + 2] - sec.cz) * f
    }
  }
  // write back in model units (root is scaled by s) and drop the morphs: baked
  const local = new Float32Array(pos.length)
  const lv = new THREE.Vector3()
  for (let i = 0; i < pos.length; i += 3) {
    lv.set(pos[i] / s, pos[i + 1] / s, pos[i + 2] / s).applyMatrix4(toLocal)
    local[i] = lv.x; local[i + 1] = lv.y; local[i + 2] = lv.z
  }
  geo.setAttribute("position", new THREE.BufferAttribute(local, 3))
  geo.morphAttributes = {}
  bodyMesh.morphTargetInfluences = []
  bodyMesh.morphTargetDictionary = {}
  geo.computeVertexNormals()
  geo.computeBoundingSphere()
  // face-detail meshes keep their morphs; zero them so they match the base head
  root.traverse((o) => {
    const mm = o as THREE.Mesh
    // eyes / mouth carry some of the same body morphs -- give them the same weights
    // so they stay seated in the reshaped head
    if (mm !== bodyMesh && mm.isMesh && mm.morphTargetInfluences && mm.morphTargetDictionary) {
      mm.morphTargetInfluences.fill(0)
      for (const [name, w] of Object.entries(weights)) {
        const i = mm.morphTargetDictionary[name]
        if (i !== undefined) mm.morphTargetInfluences[i] = w
      }
    }
    // mouth interior never shows on a closed-mouth mannequin, and pokes through the
    // neck once the body is reshaped
    if (/teeth|tongue/i.test(mm.name)) mm.visible = false
    if (mm.isMesh) {
      const mat = mm.material as THREE.MeshStandardMaterial
      if (mm === bodyMesh && mat) { mat.roughness = 0.58; mat.metalness = 0 }
    }
  })
  root.scale.setScalar(s)
  root.position.set(0, -baseBox.min.y * s, 0)

  const final = findY(pos)
  // skin height across the top of the shoulders, 1cm bins of |x| from the neck out
  const topBins = new Array(40).fill(-Infinity)
  const neckR = measurement(cm, "neck") / TAU
  for (let i = 0; i < pos.length; i += 3) {
    const x = Math.abs(pos[i]), y = pos[i + 1]
    // the shoulder zone only: clear of the neck column, below the jaw
    if (y < arm.y - 0.08 * s || y > arm.y + 0.13 * s || x > Math.abs(arm.x) + 0.06 || x < neckR * 1.4) continue
    const bin = Math.min(39, Math.floor(x / 0.01))
    if (y > topBins[bin]) topBins[bin] = y
  }
  const firstBin = Math.min(39, Math.ceil((neckR * 1.4) / 0.01))
  for (let i = firstBin - 1; i >= 0; i--) topBins[i] = topBins[i + 1] // flat across the neck base
  for (let i = firstBin; i < 40; i++) if (!Number.isFinite(topBins[i])) topBins[i] = topBins[i - 1]
  // each leg's cross-section by 1cm band from the mesh: centre + enclosing radius
  const legBands = [-1, 1].map((side) => {
    const n = Math.ceil(crotchY / BAND) + 1
    const acc = Array.from({ length: n }, () => ({ sx: 0, sz: 0, c: 0, pts: [] as number[] }))
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      if (y > crotchY || y < 0.02 || Math.sign(x) !== side || Math.abs(x) > 0.35) continue
      // hands hang beside the thighs: skip anything near the arm line
      const ax = armX(y)
      if (ax !== null && Math.abs(x) > ax - rBiceps) continue
      const b = acc[Math.min(n - 1, Math.floor(y / BAND))]
      b.sx += x; b.sz += z; b.c++; b.pts.push(x, z)
    }
    return acc.map((b) => {
      if (b.c < 8) return null
      const cx = b.sx / b.c, cz = b.sz / b.c
      let r = 0
      for (let k = 0; k < b.pts.length; k += 2) r = Math.max(r, Math.hypot(b.pts[k] - cx, b.pts[k + 1] - cz))
      return { cx, cz, r }
    })
  })
  const legLine = (side: number) => new Polyline([
    new THREE.Vector3(side * Math.abs(upLeg.x), upLeg.y, upLeg.z),
    new THREE.Vector3(side * Math.abs(leg.x), leg.y, leg.z),
    new THREE.Vector3(side * Math.abs(foot.x), foot.y + 0.03, foot.z),
  ])
  const mirror = (v: THREE.Vector3, side: number) => new THREE.Vector3(side * Math.abs(v.x), v.y, v.z)
  const fit: Fit = {
    crotchY, hipY: final.hipY, waistY: final.waistY, chestY: final.chestY, shoulderY, neckY: neck.y + 0.02 * s,
    shoulderX: Math.abs(arm.x) + rBiceps * 0.6, rNeck: measurement(cm, "neck") / TAU,
    rBiceps, rWrist: measurement(cm, "wrist") / TAU, rThigh: measurement(cm, "upperLeg") / TAU, rAnkle: measurement(cm, "ankle") / TAU,
    section: (y) => sectionAt(final.sec, Math.max(crotchY, y)),
    legSection: (side, y) => {
      const bands = legBands[side < 0 ? 0 : 1]
      const i = Math.floor(y / BAND)
      return i >= 0 && i < bands.length ? bands[i] : null
    },
    hang: (() => {
      const h: Section = { a: 0, zf: 0, zb: 0, cz: 0 }
      let n = 0
      for (let y = lowY; y <= final.hipY; y += BAND) {
        const sc = sectionAt(final.sec, y)
        h.a = Math.max(h.a, sc.a)
        // depth measured from the hip section's centre so front/back bulges both count
        h.cz += sc.cz; n++
        h.zf = Math.max(h.zf, sc.cz + sc.zf)
        h.zb = Math.max(h.zb, sc.zb - sc.cz)
      }
      h.cz /= Math.max(1, n)
      h.zf -= h.cz
      h.zb += h.cz
      return h
    })(),
    shoulderTop: (x) => {
      const f = Math.abs(x) / 0.01
      const i = Math.min(38, Math.floor(f))
      const v = topBins[i] + (topBins[i + 1] - topBins[i]) * (f - i)
      return Number.isFinite(v) ? v : shoulderY + 0.03
    },
    arm: (side) => new Polyline([mirror(armLine.pts[0], side), mirror(armLine.pts[1], side), mirror(armLine.pts[2], side)]),
    leg: legLine,
  }
  // each arm's real centre-line and skin radius, from the mesh: the skeleton's arm
  // bones don't run down the middle of the arm's skin. Slice the arm every 1.5 cm along
  // its line, take each slice's centroid as the new line, then measure radii round it.
  const ARM_BAND = 0.015
  const sliceArm = (line: Polyline, side: number) => {
    const bins = Array.from({ length: Math.ceil(line.length / ARM_BAND) + 1 }, () => ({ sx: 0, sy: 0, sz: 0, d: [] as number[] }))
    const x0 = Math.abs(line.pts[0].x)
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      if (Math.sign(x) !== side || Math.abs(x) < x0 - 0.01) continue
      let best = Infinity, along = 0, acc = 0
      for (let k = 0; k + 1 < line.pts.length; k++) {
        const a = line.pts[k], b = line.pts[k + 1]
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
        const L2 = dx * dx + dy * dy + dz * dz || 1e-9
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy + (z - a.z) * dz) / L2))
        const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t, z - a.z - dz * t)
        if (d < best) { best = d; along = acc + Math.sqrt(L2) * t }
        acc += Math.sqrt(L2)
      }
      if (best > 0.13 || along >= line.length) continue
      const bin = bins[Math.floor(along / ARM_BAND)]
      bin.sx += x; bin.sy += y; bin.sz += z; bin.d.push(best)
    }
    return bins
  }
  const armLines = [-1, 1].map((side) => {
    const bone = fit.arm(side)
    const bins = sliceArm(bone, side)
    // centroids of well-filled slices, every ~6 cm, from the shoulder down to the wrist
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < bins.length; i += 4) {
      const grp = bins.slice(i, i + 4).filter((b) => b.d.length >= 6)
      const n = grp.reduce((c, b) => c + b.d.length, 0)
      if (!n) continue
      pts.push(new THREE.Vector3(grp.reduce((c, b) => c + b.sx, 0) / n, grp.reduce((c, b) => c + b.sy, 0) / n, grp.reduce((c, b) => c + b.sz, 0) / n))
    }
    if (pts.length < 3) return bone
    // keep the shoulder joint as the start (the slices there mix in torso skin)
    pts[0] = bone.pts[0].clone()
    return new Polyline(pts)
  })
  fit.arm = (side) => armLines[side < 0 ? 0 : 1]
  const armBands = [-1, 1].map((side) => sliceArm(fit.arm(side), side).map((b) => {
    if (b.d.length < 6) return 0
    b.d.sort((u, v) => u - v)
    // (a high percentile, not the max: torso skin under the armpit creeps in)
    return Math.min(b.d[Math.floor(b.d.length * 0.92)], rBiceps * 2.2)
  }))
  const idx = geo.index
  fit.mesh = {
    verts: Float32Array.from(pos),
    tris: idx ? Uint32Array.from({ length: idx.count }, (_, i) => idx.getX(i)) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i),
  }
  fit.armRadius = (side, along) => {
    const bands = armBands[side < 0 ? 0 : 1]
    const i = Math.floor(along / ARM_BAND)
    return i >= 0 && i < bands.length ? bands[i] : 0
  }
  return { root, fit }
}
