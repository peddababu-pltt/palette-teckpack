// The try-on on a humanoid: three.ws's CC0 MakeHuman figure (backend/assets/
// mannequin.glb, a man or a woman by its gender morphs, shaped to the pattern's
// measurements) wearing the garment reconstructed from the techpack's input
// (garment3d.glb). An upper garment is reconstructed in a T-pose, so the figure's
// arms are raised to the same pose through its rig and the sleeves slide over
// them; a lower garment keeps the figure's own relaxed A-pose.
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { Fit } from "../components/pattern3d/body"
import type { PatternPiece } from "../garment/types"
import { buildPatternGroup, disposeGroup, type Anchors, type PaperSrc } from "./patternLayout"

export type Gender = "male" | "female"
export type Region = "upper" | "lower"
/** "3d": the reconstructed garment worn; "pattern": its flat cut pieces where they're worn */
export type ViewMode = "3d" | "pattern"

const SKIN = 0xd8b9a3

/** The figure a garment is shown on, from its type words. */
export function genderFor(text: string): Gender {
  return /dress|gown|skirt|blouse|bikini|briefs|swimsuit|corset|camisole|bodice|bra\b|women|ladies|female|girl/i.test(text) ? "female" : "male"
}

interface BodySurface {
  verts: Float32Array // world, posed
  normals: Float32Array
  grid: Map<string, number[]>
}

const CELL = 0.03
const cellKey = (i: number, j: number, k: number) => `${i},${j},${k}`

export class HumanoidScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50)
  private controls: OrbitControls
  private ro: ResizeObserver
  private raf = 0
  private figure = new THREE.Group()
  private body: THREE.Object3D | null = null
  private fit: Fit | null = null
  private surface: BodySurface | null = null
  private garment: THREE.Group | null = null
  private garmentSrc: THREE.Object3D | null = null
  private region: Region = "upper"
  private easeCm = 2
  private garmentScale = 1 // the garment's size over the figure's (size changes grow the garment, not the body)
  private spin = false
  private pattern: PatternPiece[] | null = null
  private papers = new Map<string, PaperSrc>()
  private patternGroup: THREE.Group | null = null
  private covered: Float32Array[] = [] // the fitted garment's vertices, for tintUnderGarment
  private fabric: THREE.Color | null = null
  private mode: ViewMode = "3d"

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.domElement.className = "vt-canvas"
    host.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color(0xe7e8eb)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 2.0))
    const key = new THREE.DirectionalLight(0xffffff, 1.3)
    key.position.set(1.2, 3, 2.4)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 2.2, bottom: -0.2 })
    key.shadow.bias = -0.0005
    this.scene.add(key)
    const ground = new THREE.Mesh(new THREE.CircleGeometry(2.5, 64), new THREE.ShadowMaterial({ opacity: 0.16 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground, this.figure)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.minDistance = 0.8
    this.controls.maxDistance = 7
    this.resetCamera()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      if (this.spin) this.figure.rotation.y += 0.01
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }

  /** A fitted figure (from loadBody); `region` picks its pose. */
  setBody(root: THREE.Object3D, fit: Fit, region: Region) {
    if (this.body) { this.figure.remove(this.body); disposeTree(this.body) }
    this.body = root
    this.fit = fit
    this.region = region
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = true
      const mat = m.material as THREE.MeshStandardMaterial
      if (mat?.isMeshStandardMaterial && /body/i.test(m.name) && !mat.map) mat.color.set(SKIN)
    })
    if (region === "upper") tPose(root)
    this.figure.add(root)
    this.surface = bakeSurface(root)
    this.dressGarment()
    this.layoutPattern()
  }

  /** The drafted pattern's pieces (loadPieces) and, by piece name, each one as
   *  the sewing pattern draws it -- for the pattern view. */
  setPattern(pieces: PatternPiece[] | null, papers = new Map<string, PaperSrc>()) {
    this.pattern = pieces
    this.papers = papers
    this.layoutPattern()
  }

  setViewMode(mode: ViewMode) {
    if (mode === this.mode) return
    this.mode = mode
    if (this.garment) this.garment.visible = mode === "3d"
    if (this.patternGroup) this.patternGroup.visible = mode === "pattern"
    if (this.body && this.covered.length) tintUnderGarment(this.body, mode === "3d" ? this.covered : [], this.surface, this.fabric)
    // the rack sits beside the figure: step back and over so all of it is in view
    if (mode === "pattern") {
      this.camera.position.set(0.45, 1.2, 6.2)
      this.controls.target.set(0.4, 1.0, 0)
      this.controls.update()
    } else this.resetCamera()
  }

  /** The reconstructed garment (garment3d.glb's scene); null takes it off. */
  setGarment(root: THREE.Object3D | null, easeCm = this.easeCm, scale = this.garmentScale) {
    this.garmentSrc = root
    this.easeCm = easeCm
    this.garmentScale = scale
    this.dressGarment()
  }

  setSpin(on: boolean) {
    this.spin = on
    if (!on) this.figure.rotation.y = 0
  }

  view(v: "front" | "side" | "back") {
    this.setSpin(false)
    const d = 4.4, y = 0.95
    const p = v === "front" ? [0, y, d] : v === "side" ? [d, y, 0] : [0, y, -d]
    this.camera.position.set(p[0], p[1] + 0.1, p[2])
    this.controls.target.set(0, y, 0)
    this.controls.update()
  }

  resetCamera() {
    this.camera.position.set(1.0, 1.15, 4.3)
    this.controls.target.set(0, 0.95, 0)
    this.controls.update()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.controls.dispose()
    if (this.garment) this.dropGarment()
    if (this.patternGroup) disposeGroup(this.patternGroup)
    if (this.body) disposeTree(this.body)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ---- internals ----

  private dropGarment() {
    if (this.body && this.covered.length) tintUnderGarment(this.body, [], null, null)
    this.covered = []
    if (!this.garment) return
    this.figure.remove(this.garment)
    // the GLB's materials stay with its scene for the next fit
    this.garment.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose() })
    this.garment = null
  }

  private dressGarment() {
    this.dropGarment()
    const src = this.garmentSrc, fit = this.fit, surf = this.surface, body = this.body
    if (!src || !fit || !surf || !body) return
    const gap = Math.max(0.6, this.easeCm * 0.6) / 100
    const placed = placeOnBody(src, body, fit, surf, this.region, gap, this.garmentScale)
    if (this.region === "upper") {
      // Arms into the sleeves as the reconstruction actually made them (they
      // droop ~10-15 deg below level even when asked for a T-pose); a level
      // T-pose left the arms bare above the sleeves. Re-bake the skin after,
      // so the push-out below collides with the arms where they now are.
      tPose(body)
      armsIntoSleeves(body, placed.positions)
      this.surface = bakeSurface(body)
    }
    const group = new THREE.Group()
    for (const { geometry, material } of finishFit(placed, this.surface!, gap)) {
      const mesh = new THREE.Mesh(geometry, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }
    group.visible = this.mode === "3d"
    this.garment = group
    this.figure.add(group)
    this.covered = placed.positions
    this.fabric = fabricColour(group)
    if (this.mode === "3d") tintUnderGarment(body, this.covered, this.surface, this.fabric)

    // the arms may have moved into the sleeves: the sleeve pieces follow them
    this.layoutPattern()
  }

  private layoutPattern() {
    if (this.patternGroup) { this.figure.remove(this.patternGroup); disposeGroup(this.patternGroup); this.patternGroup = null }
    const pieces = this.pattern, body = this.body, fit = this.fit, surf = this.surface
    if (!pieces?.length || !body || !fit || !surf) return
    const g = buildPatternGroup(pieces, this.papers, anchorsOf(body, fit, surf))
    g.visible = this.mode === "pattern"
    this.patternGroup = g
    this.figure.add(g)
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }
}

// ---- pose ----

function boneOf(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let found: THREE.Object3D | null = null
  const want = name.toLowerCase()
  root.traverse((o) => { if (!found && o.name.replace(/[:_]/g, "").toLowerCase().endsWith(want)) found = o })
  return found
}

/** Turns `bone` (about its own joint) so the line to `child` points along `dir` (world). */
function aim(bone: THREE.Object3D, child: THREE.Object3D, dir: THREE.Vector3) {
  bone.updateWorldMatrix(true, true)
  const a = bone.getWorldPosition(new THREE.Vector3()), b = child.getWorldPosition(new THREE.Vector3())
  const now = b.sub(a).normalize()
  if (now.lengthSq() < 0.5) return
  const turn = new THREE.Quaternion().setFromUnitVectors(now, dir)
  const world = bone.getWorldQuaternion(new THREE.Quaternion())
  const parent = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion()
  bone.quaternion.copy(parent.invert().multiply(turn.multiply(world)))
  bone.updateWorldMatrix(false, true)
}

/** Arms straight out to the sides, level (upper arm, then forearm). */
function tPose(root: THREE.Object3D) {
  root.updateMatrixWorld(true)
  for (const side of ["Left", "Right"]) {
    const arm = boneOf(root, `${side}Arm`), fore = boneOf(root, `${side}ForeArm`), hand = boneOf(root, `${side}Hand`)
    if (!arm || !fore || !hand) continue
    const x = Math.sign(fore.getWorldPosition(new THREE.Vector3()).x) || (side === "Left" ? 1 : -1)
    const out = new THREE.Vector3(x, 0, 0)
    aim(arm, fore, out)
    aim(fore, hand, out)
  }
  root.updateMatrixWorld(true)
}

// ---- the posed skin, for the cloth to sit on ----

function bakeSurface(root: THREE.Object3D): BodySurface {
  root.updateMatrixWorld(true)
  const all: number[] = [], nrm: number[] = []
  const v = new THREE.Vector3()
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh
    if (!m.isMesh || !m.visible || !/body/i.test(m.name)) return
    const src = m.geometry.getAttribute("position")
    const pos = new Float32Array(src.count * 3)
    for (let i = 0; i < src.count; i++) {
      m.getVertexPosition(i, v)
      v.applyMatrix4(m.matrixWorld)
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    if (m.geometry.getIndex()) g.setIndex(m.geometry.getIndex()!.clone())
    g.computeVertexNormals()
    const n = g.getAttribute("normal")
    for (let i = 0; i < src.count; i++) {
      all.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
      nrm.push(n.getX(i), n.getY(i), n.getZ(i))
    }
    g.dispose()
  })
  const verts = Float32Array.from(all), normals = Float32Array.from(nrm)
  const grid = new Map<string, number[]>()
  for (let i = 0; i < verts.length / 3; i++) {
    const k = cellKey(Math.floor(verts[i * 3] / CELL), Math.floor(verts[i * 3 + 1] / CELL), Math.floor(verts[i * 3 + 2] / CELL))
    let c = grid.get(k)
    if (!c) grid.set(k, (c = []))
    c.push(i)
  }
  return { verts, normals, grid }
}

function nearest(s: BodySurface, x: number, y: number, z: number, cells = 2): number {
  const ci = Math.floor(x / CELL), cj = Math.floor(y / CELL), ck = Math.floor(z / CELL)
  let best = -1, bd = Infinity
  for (let i = -cells; i <= cells; i++)
    for (let j = -cells; j <= cells; j++)
      for (let k = -cells; k <= cells; k++)
        for (const b of s.grid.get(cellKey(ci + i, cj + j, ck + k)) || []) {
          const d = (s.verts[b * 3] - x) ** 2 + (s.verts[b * 3 + 1] - y) ** 2 + (s.verts[b * 3 + 2] - z) ** 2
          if (d < bd) { bd = d; best = b }
        }
  return best
}

/** Half-width and centre depth of the torso skin in a 2cm band at `y`. */
function torsoBand(s: BodySurface, y: number, maxX: number): { half: number; cz: number; depth: number } | null {
  let half = 0, z0 = Infinity, z1 = -Infinity
  for (let i = 0; i < s.verts.length; i += 3) {
    const x = Math.abs(s.verts[i]), yy = s.verts[i + 1], z = s.verts[i + 2]
    if (Math.abs(yy - y) > 0.01 || x > maxX) continue
    half = Math.max(half, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z)
  }
  return half > 0 ? { half, cz: (z0 + z1) / 2, depth: z1 - z0 } : null
}

// ---- the pattern view's landmarks ----

function anchorsOf(body: THREE.Object3D, fit: Fit, surf: BodySurface): Anchors {
  body.updateMatrixWorld(true)
  const wp = (n: string) => boneOf(body, n)?.getWorldPosition(new THREE.Vector3()) ?? null
  const armX = Math.abs(wp("LeftArm")?.x ?? fit.shoulderX)
  const chest = torsoBand(surf, fit.chestY, armX * 0.95)
  const hip = torsoBand(surf, fit.hipY, armX * 1.2)
  const arms: Anchors["arms"] = new Map()
  let reachX = armX + 0.6
  for (const name of ["Left", "Right"]) {
    const sh = wp(`${name}Arm`), wr = wp(`${name}Hand`)
    if (!sh || !wr) continue
    // keyed by where the arm actually is, not by the rig's bone name
    arms.set(Math.sign(wr.x) >= 0 ? 1 : -1, { shoulder: sh, wrist: wr })
    reachX = Math.max(reachX, Math.abs(wr.x) + 0.1)
  }
  const neck = wp("Neck")
  return {
    neckY: neck ? neck.y : fit.neckY,
    waistY: fit.waistY,
    hipY: fit.hipY,
    frontZ: chest ? chest.cz + chest.depth / 2 : 0.12,
    backZ: chest ? chest.cz - chest.depth / 2 : -0.12,
    hipFrontZ: hip ? hip.cz + hip.depth / 2 : 0.12,
    hipBackZ: hip ? hip.cz - hip.depth / 2 : -0.12,
    arms,
    reachX,
  }
}

// ---- the garment onto the figure ----

interface Placed {
  pieces: { g: THREE.BufferGeometry; material: THREE.Material }[]
  positions: Float32Array[]
}

/** Scales and places the garment on the figure (no collision yet). */
function placeOnBody(src: THREE.Object3D, body: THREE.Object3D, fit: Fit, surf: BodySurface, region: Region, gap: number, scale = 1): Placed {
  src.updateMatrixWorld(true)
  const pieces: { g: THREE.BufferGeometry; material: THREE.Material }[] = []
  src.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh || !m.geometry?.getAttribute("position")) return
    const g = m.geometry.clone()
    g.applyMatrix4(m.matrixWorld)
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material
    if (mat instanceof THREE.MeshStandardMaterial) { mat.side = THREE.DoubleSide; mat.metalness = 0 }
    pieces.push({ g, material: mat })
  })
  if (!pieces.length) return { pieces, positions: [] }
  const box = new THREE.Box3()
  for (const p of pieces) { p.g.computeBoundingBox(); box.union(p.g.boundingBox!) }
  const size = box.getSize(new THREE.Vector3())
  const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2
  const points = (fn: (x: number, y: number, z: number) => void) => {
    for (const p of pieces) {
      const a = p.g.getAttribute("position")
      for (let i = 0; i < a.count; i++) fn(a.getX(i), a.getY(i), a.getZ(i))
    }
  }
  // the garment's width across a band `t` (0 = top) of its height, in its own units
  const widthAt = (t: number) => {
    const y = box.max.y - size.y * t
    let w = 0
    points((x, yy) => { if (Math.abs(yy - y) < size.y * 0.02) w = Math.max(w, Math.abs(x - cx)) })
    return w
  }
  body.updateMatrixWorld(true)
  const wp = (n: string) => boneOf(body, n)?.getWorldPosition(new THREE.Vector3()) ?? null
  const neck = wp("Neck"), arm = wp("LeftArm")
  const neckY = neck ? neck.y : fit.neckY
  const armX = Math.abs(arm?.x ?? fit.shoulderX)

  let s: number, top: number
  if (region === "upper") {
    top = neckY + 0.03 // the collar stands a little above the neck's base
    // in a T-pose the sleeves fill the top third of the garment's height, so its
    // body is read below them (lower bands, median) and wrapped round the chest
    const bands = [0.7, 0.8, 0.9].map(widthAt).filter((w) => w > 0).sort((a, b) => a - b)
    const torsoW = bands.length ? bands[Math.floor(bands.length / 2)] : 0
    const chest = torsoBand(surf, fit.chestY, armX * 0.95)
    s = chest && torsoW ? (chest.half + gap) * 1.1 / torsoW : 0.7 / size.y // else: a 70cm top
    // sleeves end at the wrists at most, not past the fingers
    const hl = wp("LeftHand"), hr = wp("RightHand")
    const span = hl && hr ? Math.abs(hl.x - hr.x) : 0
    if (span && size.x * s > span * 1.02) s = span * 1.02 / size.x
    // Height from the sleeves, not the collar. "Neck + 3cm" assumes a 3cm
    // collar stand; a puffer's mandarin collar stands ~10cm, so the whole
    // garment hung ~8cm low -- its shoulders sat inside the figure's (torn
    // into shards by the push-out) and the arms came out above the sleeves.
    // Lift (or drop) it so the sleeve's top edge 8cm out from the shoulder
    // joint clears the skin over the arm there.
    if (arm) {
      const X = Math.abs(arm.x) + 0.08
      let gTop = -Infinity
      points((x, y) => { if (Math.abs(Math.abs((x - cx) * s) - X) < 0.01) gTop = Math.max(gTop, y) })
      let skinTop = -Infinity
      for (let i = 0; i < surf.verts.length; i += 3) {
        const vx = Math.abs(surf.verts[i]), vy = surf.verts[i + 1]
        if (Math.abs(vx - X) < 0.01 && Math.abs(vy - arm.y) < 0.15) skinTop = Math.max(skinTop, vy)
      }
      if (gTop > -Infinity && skinTop > -Infinity) {
        const sleeveTop = top - (box.max.y - gTop) * s
        top += Math.min(0.15, Math.max(-0.03, skinTop + gap - sleeveTop))
      }
    }
  } else {
    top = fit.waistY + 0.03
    const waist = torsoBand(surf, fit.waistY, armX * 0.9)
    s = waist ? (waist.half + gap) * 1.06 / Math.max(1e-4, widthAt(0.02)) : 1
  }
  const band = torsoBand(surf, region === "upper" ? fit.chestY : fit.hipY, armX * 0.95)
  const midZ = band ? band.cz : 0

  const positions = pieces.map(({ g }) => {
    const a = g.getAttribute("position")
    const pos = new Float32Array(a.count * 3)
    for (let i = 0; i < a.count; i++) {
      pos[i * 3] = (a.getX(i) - cx) * s
      pos[i * 3 + 1] = top - (box.max.y - a.getY(i)) * s
      pos[i * 3 + 2] = (a.getZ(i) - cz) * s + midZ
    }
    return pos
  })
  widenTorso(positions, surf, fit, armX, region, gap)
  // A bigger (or smaller) size than the figure wears: the whole garment grows
  // about the body's axis and its own top edge, so it hangs looser and longer
  // on the same body instead of the body growing with it.
  if (scale !== 1) {
    const k = Math.min(1.5, Math.max(0.7, scale))
    for (const pos of positions)
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] *= k
        pos[i + 1] = top - (top - pos[i + 1]) * k
        pos[i + 2] = midZ + (pos[i + 2] - midZ) * k
      }
  }
  return { pieces, positions }
}

/** Collides the placed garment with the (posed) skin and builds its meshes. */
function finishFit({ pieces, positions }: Placed, surf: BodySurface, gap: number) {
  return pieces.map(({ g, material }, i) => {
    const buried = pushOut(positions[i], surf, gap)
    if (buried.some(Boolean)) dropBuried(g, buried, positions[i].length / 3)
    g.setAttribute("position", new THREE.BufferAttribute(positions[i], 3))
    g.computeVertexNormals()
    g.computeBoundingBox()
    g.computeBoundingSphere()
    return { geometry: g, material }
  })
}

/** One width factor for the torso (sleeves keep their length and just move
 *  out with the side seams), so the garment wraps this body at `gap`. */
function widenTorso(positions: Float32Array[], surf: BodySurface, fit: Fit, armX: number, region: Region, gap: number) {
  const yLo = region === "upper" ? fit.waistY - 0.05 : fit.crotchY - 0.05
  const yHi = region === "upper" ? fit.chestY + 0.02 : fit.waistY
  const bands = new Map<number, { half: number; cz: number; depth: number } | null>()
  const bandAt = (y: number) => {
    const k = Math.round(y / 0.02)
    if (!bands.has(k)) bands.set(k, torsoBand(surf, k * 0.02, armX * 0.95))
    return bands.get(k)!
  }
  const need: number[] = [], needZ: number[] = []
  for (const pos of positions)
    for (let i = 0; i < pos.length; i += 9) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      if (y < yLo || y > yHi) continue
      const b = bandAt(y)
      if (!b || Math.abs(x) > b.half * 1.4) continue
      if (Math.abs(x) > b.half * 0.7 && Math.abs(x) > 0.02) need.push((b.half + gap) / Math.abs(x))
      if (Math.abs(x) < b.half * 0.4 && Math.abs(z - b.cz) > 0.02) needZ.push((b.depth / 2 + gap) / Math.abs(z - b.cz))
    }
  const pick = (v: number[]) => {
    if (!v.length) return 1
    v.sort((a, b) => a - b)
    return Math.min(1.6, Math.max(0.85, v[Math.floor(v.length * 0.85)]))
  }
  const kx = pick(need), kz = pick(needZ)
  const reach = armX * 1.05 // past this the sleeves start: shifted, not stretched
  const b0 = bandAt((yLo + yHi) / 2)
  const cz = b0 ? b0.cz : 0
  for (const pos of positions)
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], ax = Math.abs(x)
      pos[i] = ax <= reach ? x * kx : Math.sign(x) * (reach * kx + (ax - reach))
      pos[i + 2] = cz + (pos[i + 2] - cz) * kz
    }
}

/** Cloth below the skin (plus `gap`) is lifted out along the skin's normal.
 *  Cloth BURIED deeper than BURIED_M is not cloth the body presses on: it is
 *  the reconstruction's closed-over neck opening and inner collar, which the
 *  neck and shoulders pass straight through. Lifting those vertices threw
 *  neighbours out along different skin normals and tore the collar into
 *  black shards; they are returned flagged instead, for dropBuried. */
const BURIED_M = 0.05
function pushOut(pos: Float32Array, surf: BodySurface, gap: number): boolean[] {
  const buried = new Array<boolean>(pos.length / 3).fill(false)
  for (let pass = 0; pass < 2; pass++)
    for (let i = 0; i < pos.length; i += 3) {
      if (buried[i / 3]) continue
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      const b = nearest(surf, x, y, z)
      if (b < 0) continue
      const nx = surf.normals[b * 3], ny = surf.normals[b * 3 + 1], nz = surf.normals[b * 3 + 2]
      const d = (x - surf.verts[b * 3]) * nx + (y - surf.verts[b * 3 + 1]) * ny + (z - surf.verts[b * 3 + 2]) * nz
      if (d >= gap || d < -0.12) continue
      if (pass === 0 && d < -BURIED_M) { buried[i / 3] = true; continue }
      const lift = gap - d
      pos[i] = x + nx * lift; pos[i + 1] = y + ny * lift; pos[i + 2] = z + nz * lift
    }
  return buried
}

/** Where the reconstructed garment is thin or turned in (the centre front, seams,
 *  pocket edges come back that way) the skin underneath showed through as if
 *  the cloth were torn. The skin the garment covers is coloured as the
 *  garment's own fabric instead, so those spots read as cloth. Covered means
 *  inside the garment's height range in its column (2cm across x, 6cm deep in
 *  z: the neck above the front of the collar, the belly below the hem and the
 *  hands past the cuffs keep their colour) with cloth within COVER_M out along
 *  the skin's normal. `positions` empty clears it. */
const COVER_M = 0.1
function tintUnderGarment(body: THREE.Object3D, positions: Float32Array[], surf: BodySurface | null, fabric: THREE.Color | null) {
  const COL = 0.02, DEPTH = 0.06
  const colKey = (x: number, z: number) => `${Math.floor(x / COL)},${Math.floor(z / DEPTH)}`
  const span = new Map<string, [number, number]>()
  const grid = new Map<string, number[]>()
  for (const pos of positions)
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      const c = colKey(x, z)
      const r = span.get(c)
      if (!r) span.set(c, [y, y])
      else { if (y < r[0]) r[0] = y; if (y > r[1]) r[1] = y }
      const k = cellKey(Math.floor(x / COVER_M), Math.floor(y / COVER_M), Math.floor(z / COVER_M))
      let cell = grid.get(k)
      if (!cell) grid.set(k, (cell = []))
      if (cell.length < 192) cell.push(x, y, z) // enough to tell cloth is near
    }
  // cloth near (x, y, z) and out along the normal (within ~70 deg of it)
  const near = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
    const ci = Math.floor(x / COVER_M), cj = Math.floor(y / COVER_M), ck = Math.floor(z / COVER_M)
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const cell = grid.get(cellKey(ci + i, cj + j, ck + k))
          if (!cell) continue
          for (let n = 0; n < cell.length; n += 3) {
            const dx = cell[n] - x, dy = cell[n + 1] - y, dz = cell[n + 2] - z
            const d2 = dx * dx + dy * dy + dz * dz
            if (d2 < COVER_M * COVER_M && dx * nx + dy * ny + dz * nz > 0.35 * Math.sqrt(d2)) return true
          }
        }
    return false
  }
  body.updateMatrixWorld(true)
  const v = new THREE.Vector3()
  let base = 0 // this mesh's first vertex in surf (bakeSurface walks the same meshes)
  body.traverse((o) => {
    const m = o as THREE.SkinnedMesh
    if (!m.isMesh || !m.visible || !/body/i.test(m.name)) return
    const count = m.geometry.getAttribute("position").count
    const mats = (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]
    // vertex colours multiply the skin colour: divide it out so covered skin shows the fabric
    const skin = mats[0]?.color ?? new THREE.Color(1, 1, 1)
    const tint = fabric ? new THREE.Color(
      Math.min(1, fabric.r / Math.max(0.05, skin.r)), Math.min(1, fabric.g / Math.max(0.05, skin.g)), Math.min(1, fabric.b / Math.max(0.05, skin.b)),
    ) : null
    const colors = new Float32Array(count * 3).fill(1)
    let any = false
    if (positions.length && surf && tint)
      for (let i = 0; i < count; i++) {
        m.getVertexPosition(i, v)
        v.applyMatrix4(m.matrixWorld)
        const r = span.get(colKey(v.x, v.z))
        const n = (base + i) * 3
        if (!r || v.y < r[0] + 0.01 || v.y > r[1] - 0.01) continue
        if (!near(v.x, v.y, v.z, surf.normals[n], surf.normals[n + 1], surf.normals[n + 2])) continue
        colors[i * 3] = tint.r; colors[i * 3 + 1] = tint.g; colors[i * 3 + 2] = tint.b
        any = true
      }
    base += count
    m.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3))
    for (const mat of mats) if (mat.vertexColors !== any) { mat.vertexColors = any; mat.needsUpdate = true }
  })
}

/** The garment's average fabric colour: its texture (small sample) times its
 *  material colour, or null when it has neither. */
function fabricColour(group: THREE.Object3D): THREE.Color | null {
  let out: THREE.Color | null = null
  group.traverse((o) => {
    const m = o as THREE.Mesh
    if (out || !m.isMesh) return
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial
    const c = mat.color ? mat.color.clone() : new THREE.Color(1, 1, 1)
    const img = mat.map?.image as CanvasImageSource | undefined
    if (img) {
      try {
        const cv = document.createElement("canvas")
        cv.width = cv.height = 32
        const ctx = cv.getContext("2d", { willReadFrequently: true })!
        ctx.drawImage(img, 0, 0, 32, 32)
        const px = ctx.getImageData(0, 0, 32, 32).data
        let r = 0, g = 0, b = 0, n = 0
        for (let i = 0; i < px.length; i += 4) {
          if (px[i + 3] < 128) continue
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++
        }
        // the texture is sRGB: the average goes back through the same colour space
        if (n) c.multiply(new THREE.Color().setRGB(r / n / 255, g / n / 255, b / n / 255, THREE.SRGBColorSpace))
      } catch {
        // unreadable texture: the material colour alone
      }
    }
    out = c
  })
  return out
}

/** Removes every triangle touching a buried vertex (hidden inside the body). */
function dropBuried(g: THREE.BufferGeometry, buried: boolean[], count: number) {
  const idx = g.getIndex()
  const src = idx ? (idx.array as ArrayLike<number>) : Uint32Array.from({ length: count }, (_, i) => i)
  const keep: number[] = []
  for (let t = 0; t + 2 < src.length; t += 3) {
    const a = src[t], b = src[t + 1], c = src[t + 2]
    if (!buried[a] && !buried[b] && !buried[c]) keep.push(a, b, c)
  }
  g.setIndex(keep)
}

/** Aims each arm down its sleeve: the upper arm at the sleeve's centre half
 *  way out, the forearm at the centre near the cuff. Centres are read off
 *  the placed garment (mid of its vertical and depth extent in a 1cm slice). */
function armsIntoSleeves(body: THREE.Object3D, positions: Float32Array[]) {
  body.updateMatrixWorld(true)
  const centreAt = (side: number, x: number) => {
    let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
    for (const pos of positions)
      for (let i = 0; i < pos.length; i += 3) {
        if (Math.sign(pos[i]) !== side || Math.abs(pos[i] - x) > 0.01) continue
        y0 = Math.min(y0, pos[i + 1]); y1 = Math.max(y1, pos[i + 1])
        z0 = Math.min(z0, pos[i + 2]); z1 = Math.max(z1, pos[i + 2])
      }
    return y1 > y0 ? new THREE.Vector3(x, (y0 + y1) / 2, (z0 + z1) / 2) : null
  }
  for (const name of ["Left", "Right"]) {
    const arm = boneOf(body, `${name}Arm`), fore = boneOf(body, `${name}ForeArm`), hand = boneOf(body, `${name}Hand`)
    if (!arm || !fore || !hand) continue
    const a = arm.getWorldPosition(new THREE.Vector3())
    const side = Math.sign(fore.getWorldPosition(new THREE.Vector3()).x) || (name === "Left" ? 1 : -1)
    let reach = 0
    for (const pos of positions)
      for (let i = 0; i < pos.length; i += 3) if (Math.sign(pos[i]) === side) reach = Math.max(reach, Math.abs(pos[i]))
    const len = reach - Math.abs(a.x)
    if (len < 0.1) continue // sleeveless, or sleeves not out to the side
    const elbow = centreAt(side, side * (Math.abs(a.x) + len * 0.5))
    const cuff = centreAt(side, side * (Math.abs(a.x) + len * 0.92))
    if (!elbow || !cuff) continue
    aim(arm, fore, elbow.clone().sub(a).normalize())
    const f = fore.getWorldPosition(new THREE.Vector3())
    aim(fore, hand, cuff.clone().sub(f).normalize())
  }
  body.updateMatrixWorld(true)
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    m.geometry.dispose()
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.dispose()
  })
}
