// Three.js side of the virtual try-on: the scanned body with the planned garments
// on it, all warped to the current measurements (imperative; React drives it).
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { ScanMesh } from "./assets"
import type { TryOnPlan } from "./plan"
import { projectUVs, type SketchViews } from "./sketch"
import { fitGenerated, garmentSpan } from "./generated"
import {
  BodyFrame, SCAN, SHOULDER, TPOSE_DEG, armWeight, clipBelow, fitTop, inflate, poseArms, ratiosFrom, shortsHem, skirtLoft,
  sleeveAngle, sleeveLofts, tposeWeight, warp, warpedFloor, weightsByNearest, type Loft, type Ratios,
} from "./shape"

export type Look = "input" | "scan" | "colour"

interface Part {
  mesh: THREE.Mesh
  base: Float32Array // fitted, scan space
  torsoOnly: boolean
  scan: ScanMesh | null // null = built here (sleeves, skirt): no texture
  projUv: Float32Array | null // the techpack's sketch projected on (input look)
  baseColour: string | null // set on the plain base clothes under the techpack's garment
  own?: boolean // carries its own material (the reconstructed 3D garment)
  pose?: Float32Array | null // per vertex: how much it turns with a raised arm (T-pose)
}

const SKIN = 0xd8b9a3
// the plain clothes the body always wears where the techpack's garment doesn't
// cover it (a skirt gets a tee, a hoodie gets shorts): never a bare mannequin
const BASE_TOP = { scan: "tshirt3", colour: "#ecebe7", tuckedCm: 47, looseCm: 64, easeCm: 0.6 }
const BASE_BOTTOM = { scan: "pant3", colour: "#8a8d93", lengthCm: 45, easeCm: 0.8 }
// top scans worn tucked into jeans (see fitTop)
const TUCKED = new Set(["tshirt1", "tshirt3"])

export class VtonScene {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50)
  private controls: OrbitControls
  private ro: ResizeObserver
  private raf = 0
  private figure = new THREE.Group()
  private body: Part | null = null
  private frame: BodyFrame | null = null
  private parts: Part[] = []
  private ratios: Ratios = ratiosFrom({})
  private look: Look = "input"
  private sketch: SketchViews | null = null
  private quilted = false
  private colour = "#4a6fa5"
  private spin = false
  private plan: TryOnPlan | null = null
  private generatedRoot: THREE.Object3D | null = null
  private generated: Part[] = []
  private easeCm = 2
  private bodyIndex: Uint32Array | null = null // the body's full triangle list
  // an upper garment is worn in a T-pose (arms out to the sides, as its 3D
  // reconstruction is made); lower garments keep the arms hanging
  private tpose = false
  private poseDeg = TPOSE_DEG
  private sleeveReach = 0 // the reconstruction's shoulder-to-cuff length (0 = none)

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.domElement.className = "vt-canvas"
    host.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color(0xe7e8eb)
    // the scans carry their own baked light: keep the lighting soft and even
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8bcc4, 2.2))
    const key = new THREE.DirectionalLight(0xffffff, 1.1)
    key.position.set(1.2, 3, 2.4)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    Object.assign(key.shadow.camera, { left: -1, right: 1, top: 2.1, bottom: -0.2 })
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

  setBody(scan: ScanMesh) {
    this.frame = new BodyFrame(scan.pos)
    const mesh = this.makeMesh(scan.pos, scan.index, new THREE.MeshStandardMaterial({ color: SKIN, roughness: 0.75 }), scan.uv)
    if (this.body) this.dropPart(this.body)
    const pose = new Float32Array(scan.pos.length / 3)
    for (let v = 0; v < pose.length; v++) pose[v] = tposeWeight(scan.pos[v * 3], scan.pos[v * 3 + 1])
    this.body = { mesh, base: scan.pos, torsoOnly: false, scan: null, projUv: null, baseColour: null, pose }
    this.bodyIndex = scan.index
    this.figure.add(mesh)
    this.update()
  }

  /** Dress the body for a plan; `cm` are the pattern's measurements. */
  dress(plan: TryOnPlan, scans: Map<string, ScanMesh>, cm: Record<string, number>, easeCm = 2, sketch: SketchViews | null = null) {
    this.sketch = sketch
    this.quilted = plan.quilted
    this.plan = plan
    this.easeCm = easeCm
    this.tpose = !!plan.top
    this.poseDeg = TPOSE_DEG
    if (!this.body || !this.frame) return
    for (const p of this.parts) this.dropPart(p)
    this.parts = []
    this.ratios = ratiosFrom(cm)
    const f = this.frame
    // garments are cut to the pattern as drafted: lengths are read at the draft's
    // measurements, then everything follows the live ones through the warp
    const bottomScan = plan.bottom && scans.get(plan.bottom.variant)
    if (plan.bottom && bottomScan) {
      const s = bottomScan
      const cut = plan.bottom.lengthCm ? clipBelow(s.pos, s.index, shortsHem(plan.bottom.lengthCm, this.ratios)) : s
      this.addPart(inflate(cut.pos, easeCm, f), cut.index, s, false)
    }
    if (plan.skirt) {
      const loft = skirtLoft(plan.skirt.lengthCm, plan.skirt.hemGirthCm, plan.skirt.pencil, this.ratios, f, plan.skirt.hemRatio)
      this.addLoft(loft, true)
    }
    const topScan = plan.top && scans.get(plan.top.variant)
    if (plan.top && topScan) this.addTop(topScan, plan.top.lengthCm, plan.top.longSleeve, easeCm, null)
    // base clothes for whatever the techpack's garment leaves bare
    const baseTop = scans.get(BASE_TOP.scan)
    if (!plan.top && baseTop) {
      const tucked = !!(plan.skirt || plan.bottom)
      this.addTop(baseTop, tucked ? BASE_TOP.tuckedCm : BASE_TOP.looseCm, false, BASE_TOP.easeCm, BASE_TOP.colour)
    }
    const baseBottom = scans.get(BASE_BOTTOM.scan)
    if (!plan.bottom && !plan.skirt && baseBottom) {
      const cut = clipBelow(baseBottom.pos, baseBottom.index, shortsHem(BASE_BOTTOM.lengthCm, this.ratios))
      this.addPart(inflate(cut.pos, BASE_BOTTOM.easeCm, f), cut.index, baseBottom, false, BASE_BOTTOM.colour)
    }
    this.projectSketch()
    this.applyLook()
    this.fitGeneratedGarment()
    this.update()
  }

  /** The reconstructed 3D garment (three.ws) worn in place of the built one;
   *  null goes back to the built garment. The base clothes stay either way. */
  setGenerated(root: THREE.Object3D | null) {
    this.generatedRoot = root
    this.fitGeneratedGarment()
    this.update()
  }

  private fitGeneratedGarment() {
    for (const p of this.generated) this.dropPart(p, false)
    this.generated = []
    const root = this.generatedRoot
    for (const p of this.parts) if (!p.baseColour) p.mesh.visible = !root
    this.poseDeg = TPOSE_DEG
    this.sleeveReach = 0
    this.showBody(null)
    if (!root || !this.plan || !this.frame || !this.body || !this.bodyIndex) return
    const span = garmentSpan(this.plan, this.ratios)
    const pieces = fitGenerated(root, span, this.frame, Math.max(1, this.easeCm * 0.6))
    // the arms go up to the reconstruction's own sleeves, so it wraps them
    const sleeves = this.tpose ? sleeveAngle(pieces.map((p) => p.pos)) : null
    if (sleeves) { this.poseDeg = sleeves.deg; this.sleeveReach = sleeves.reach }
    // the reconstruction is a closed solid: the body it covers is hidden rather than
    // left to poke through (scanned shoulders and arms are broader than the garment's)
    this.showBody(span)
    for (const piece of pieces) {
      const mesh = this.makeMesh(piece.pos, piece.index, piece.material, piece.uv ?? undefined)
      this.generated.push({ mesh, base: piece.pos, torsoOnly: !!this.plan.skirt && !this.plan.top, scan: null, projUv: null, baseColour: null, own: true })
      this.figure.add(mesh)
    }
  }

  /** The body without the part a reconstructed garment covers (`span`, minus the
   *  neck above it and the hands below the wrists); null shows all of it. */
  private showBody(span: { top: number; bottom: number } | null) {
    const body = this.body, full = this.bodyIndex
    if (!body || !full) return
    let index = full
    if (span) {
      const pos = body.base, keep: number[] = []
      const covered = (v: number) => {
        const x = pos[v * 3], y = pos[v * 3 + 1]
        if (y > span.top - 0.03 || y < span.bottom + 0.01) return false
        const hand = Math.abs(x) > SCAN.armX - 0.02 && y < SCAN.wristY
        if (hand) return false
        // raised arms: covered only as far as the sleeves reach
        if (this.tpose && this.sleeveReach && body.pose![v] > 0.5)
          return Math.hypot(Math.abs(x) - SHOULDER.x, y - SHOULDER.y) < this.sleeveReach - 0.04
        return true
      }
      for (let t = 0; t < full.length; t += 3)
        if (!(covered(full[t]) && covered(full[t + 1]) && covered(full[t + 2]))) keep.push(full[t], full[t + 1], full[t + 2])
      index = Uint32Array.from(keep)
    }
    body.mesh.geometry.setIndex(new THREE.BufferAttribute(index, 1))
  }

  /** Live measurement change: re-warp body and garments. */
  setMeasurements(cm: Record<string, number>) {
    this.ratios = ratiosFrom(cm)
    this.update()
  }

  setLook(look: Look, colour: string) {
    this.look = look
    this.colour = colour
    this.applyLook()
  }

  setSpin(on: boolean) {
    this.spin = on
    if (!on) this.figure.rotation.y = 0
  }

  view(v: "front" | "side" | "back") {
    this.setSpin(false)
    const d = 4.2, y = 0.88
    const p = v === "front" ? [0, y, d] : v === "side" ? [d, y, 0] : [0, y, -d]
    this.camera.position.set(p[0], p[1] + 0.1, p[2])
    this.controls.target.set(0, y, 0)
    this.controls.update()
  }

  resetCamera() {
    this.camera.position.set(1.0, 1.05, 4.1)
    this.controls.target.set(0, 0.88, 0)
    this.controls.update()
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.controls.dispose()
    for (const p of this.parts) this.dropPart(p)
    for (const p of this.generated) this.dropPart(p)
    if (this.body) this.dropPart(this.body)
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  // ---- internals ----

  // a top scan cut to length, with the tube that lengthens it and long sleeves if asked
  private addTop(s: ScanMesh, lengthCm: number, longSleeve: boolean, easeCm: number, baseColour: string | null) {
    const f = this.frame!, body = this.body!
    const top = fitTop(s.pos, s.index, s.uv, s.colourAt, TUCKED.has(s.name), lengthCm, this.ratios, f)
    const fitted = inflate(top.pos, easeCm, f)
    // weights from the scan as worn (before the ease moves it off the skin)
    this.addPart(fitted, top.index, s, false, baseColour, weightsByNearest(top.pos, body.base, body.pose!))
    if (top.extension) {
      top.extension.pos = inflate(top.extension.pos, easeCm, f)
      this.addLoft(top.extension, true, clothColour(s, top.pos, top.index, (x, y) => armWeight(x, y) < 0.3 && y > top.cut + 0.01 && y < top.cut + 0.08), baseColour)
    }
    if (longSleeve) {
      const colour = clothColour(s, fitted, top.index, (x, y) => Math.abs(x) > SCAN.armX + 0.03 && y < SCAN.shoulderY - 0.04 && y > -0.2)
      for (const l of sleeveLofts(fitted, body.base)) this.addLoft(l, false, colour, baseColour, weightsByNearest(l.pos, body.base, body.pose!))
    }
  }

  private addPart(base: Float32Array, index: Uint32Array, scan: ScanMesh, torsoOnly: boolean, baseColour: string | null = null, pose: Float32Array | null = null) {
    const mesh = this.makeMesh(base, index, new THREE.MeshStandardMaterial({ roughness: 1, side: THREE.DoubleSide }), scan.uv)
    this.parts.push({ mesh, base, torsoOnly, scan, projUv: null, baseColour, pose })
    this.figure.add(mesh)
  }

  // built parts take the scan garment's mean colour, so a lofted sleeve reads as the same cloth
  private addLoft(l: Loft, torsoOnly: boolean, scanColour?: string, baseColour: string | null = null, pose: Float32Array | null = null) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.9, side: THREE.DoubleSide })
    mat.userData.scanColour = scanColour ?? null
    const mesh = this.makeMesh(l.pos, l.index, mat)
    this.parts.push({ mesh, base: l.pos, torsoOnly, scan: null, projUv: null, baseColour, pose })
    this.figure.add(mesh)
  }

  private makeMesh(base: Float32Array, index: Uint32Array, mat: THREE.Material, uv?: Float32Array) {
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(base.length), 3))
    if (uv) g.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
    g.setIndex(new THREE.BufferAttribute(index, 1))
    const mesh = new THREE.Mesh(g, mat)
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  // `material`: false keeps a shared material (the GLB's) for the next fit
  private dropPart(p: Part, material = true) {
    this.figure.remove(p.mesh)
    p.mesh.geometry.dispose()
    if (material) (p.mesh.material as THREE.Material).dispose()
  }

  // the sketch's front/back views laid over the whole garment's extent
  private projectSketch() {
    const s = this.sketch, f = this.frame
    if (!s || !f || !this.parts.length) return
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity }
    const garment = this.parts.filter((p) => !p.baseColour)
    for (const p of garment) {
      const idx = p.mesh.geometry.getIndex()!.array
      for (const v of idx) {
        const x = p.base[v * 3], y = p.base[v * 3 + 1]
        if (x < b.x0) b.x0 = x
        if (x > b.x1) b.x1 = x
        if (y < b.y0) b.y0 = y
        if (y > b.y1) b.y1 = y
      }
    }
    for (const p of garment) p.projUv = projectUVs(p.base, s, b, (x, y) => f.centreZ(x, y))
    // the design's lines as real relief: cloth rises off every seam / stitch line
    // (quilted cells into full cushions), so the garment is shaped, not drawn on
    const amp = this.quilted ? 0.026 : 0.004
    for (const p of garment) {
      const uv = p.projUv!
      p.base = inflate(p.base, 0, f, (i) => amp * s.heightAt(uv[i * 2], uv[i * 2 + 1]))
    }
  }

  private applyLook() {
    for (const p of this.parts) {
      // base clothes are always plain: their colour over the scan's folds
      const look: Look = p.baseColour ? "colour" : this.look
      const tint = new THREE.Color(p.baseColour ?? this.colour)
      const input = look === "input" && !!this.sketch
      const m = p.mesh.material as THREE.MeshStandardMaterial
      const g = p.mesh.geometry
      if (input && p.projUv) {
        // plain fabric; the design shows as the cloth's relief (normal map + shape)
        g.setAttribute("uv", new THREE.BufferAttribute(p.projUv, 2))
        m.map = null
        m.normalMap = this.sketch!.normalMap
        m.normalScale.set(1, 1)
        m.roughness = this.quilted ? 0.42 : 0.88
        m.color.copy(tint)
        m.onBeforeCompile = () => {}
        m.customProgramCacheKey = () => "input"
        m.needsUpdate = true
        continue
      }
      m.normalMap = null
      m.roughness = p.scan ? 1 : 0.9
      if (p.baseColour) {
        // base clothes: plain cloth, no scan texture (those atlases carry other
        // garments' prints, e.g. a tucked shirt at the trousers' waist)
        m.map = null
        m.color.copy(tint)
        m.roughness = 0.9
        m.onBeforeCompile = () => {}
        m.customProgramCacheKey = () => "base"
        m.needsUpdate = true
        continue
      }
      if (p.scan) g.setAttribute("uv", new THREE.BufferAttribute(p.scan.uv, 2))
      else { g.deleteAttribute("uv"); m.map = null }
      if (p.scan) {
        m.map = p.scan.texture
        // "colour": the scan's folds and seams kept as shading under the chosen colour
        m.color.set(look === "colour" ? tint.clone().multiplyScalar(2.2) : 0xffffff)
        m.onBeforeCompile = (sh) => {
          if (look !== "colour") return
          sh.fragmentShader = sh.fragmentShader.replace(
            "#include <map_fragment>",
            `#include <map_fragment>
             diffuseColor.rgb = diffuseColor.rgb / max(sampledDiffuseColor.rgb, vec3(1e-3)) * vec3(dot(sampledDiffuseColor.rgb, vec3(0.299, 0.587, 0.114)));`,
          )
        }
        m.customProgramCacheKey = () => look
      } else {
        m.color.set(look === "colour" || !m.userData.scanColour ? tint : m.userData.scanColour)
      }
      m.needsUpdate = true
    }
  }

  private update() {
    const f = this.frame
    if (!f || !this.body) return
    // the shoulder joints through the same warp, so the arms turn about them
    let pivots: [number, number, number, number] | null = null
    if (this.tpose) {
      const j = new Float32Array(6)
      const src = new Float32Array([SHOULDER.x, SHOULDER.y, f.torsoZ[f.bin(SHOULDER.y)], -SHOULDER.x, SHOULDER.y, f.torsoZ[f.bin(SHOULDER.y)]])
      warp(src, j, this.ratios, f)
      pivots = [j[0], j[1], j[3], j[4]]
    }
    for (const p of [this.body, ...this.parts, ...this.generated]) {
      const attr = p.mesh.geometry.getAttribute("position") as THREE.BufferAttribute
      warp(p.base, attr.array as Float32Array, this.ratios, f, p.torsoOnly)
      // the reconstruction is already in its pose; everything else is raised to it
      if (pivots && p.pose) poseArms(attr.array as Float32Array, p.pose, this.poseDeg, pivots)
      attr.needsUpdate = true
      p.mesh.geometry.computeVertexNormals()
      p.mesh.geometry.computeBoundingSphere()
    }
    // feet on the ground
    this.figure.position.y = -warpedFloor(this.ratios)
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }
}

/** A garment region's own cloth colour (mean of its texels), so a built part
 *  (long sleeve, longer body) continues it. */
function clothColour(s: ScanMesh, pos: Float32Array, index: Uint32Array, where: (x: number, y: number) => boolean): string {
  let r = 0, g = 0, b = 0, n = 0
  const seen = new Uint8Array(pos.length / 3)
  for (const v of index) {
    if (seen[v]) continue
    seen[v] = 1
    if (!where(pos[v * 3], pos[v * 3 + 1])) continue
    const c = s.colourAt(s.uv[v * 2], s.uv[v * 2 + 1])
    r += c[0]; g += c[1]; b += c[2]; n++
  }
  if (!n) return s.avgColour
  return "#" + [r, g, b].map((x) => Math.round(x / n).toString(16).padStart(2, "0")).join("")
}
