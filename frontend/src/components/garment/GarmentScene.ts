// Three.js side of the garment workspace (imperative; the React component drives it).
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"
import type { Assembly } from "../../garment/GarmentAssembly"
import type { ClothSim } from "../../garment/ClothSim"
import { fabricMaterial, fabricUVs } from "../../garment/FabricMaterial"
import type { FabricSpec, Stage } from "../../garment/types"

const LAYER_COLOUR = { upper: 0x5b8def, lower: 0xe8924a, accessory: 0x54b37a }
const SEAM_COLOURS = [0xe63946, 0xf4a261, 0x2a9d8f, 0x9b5de5, 0xf15bb5, 0x00bbf9, 0xfee440, 0x8ac926]

export interface Toggles {
  mannequin: boolean
  pieces: boolean // ghost of the initial layout
  seams: boolean
  wireframe: boolean
  realistic: boolean
  debug: boolean
}

interface PartView {
  key: string
  layer: "upper" | "lower"
  mesh: THREE.Mesh
  pos: Float32Array // own copy shown on screen
  offset: number
  n: number
}

function labelSprite(text: string, colour = "#111") {
  const c = document.createElement("canvas")
  const g = c.getContext("2d")!
  g.font = "600 28px system-ui, sans-serif"
  const w = Math.ceil(g.measureText(text).width) + 20
  c.width = w
  c.height = 40
  const g2 = c.getContext("2d")!
  g2.font = "600 28px system-ui, sans-serif"
  g2.fillStyle = "rgba(255,255,255,0.85)"
  g2.fillRect(0, 0, w, 40)
  g2.fillStyle = colour
  g2.fillText(text, 10, 29)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }))
  s.scale.set((w / 40) * 0.035, 0.035, 1)
  s.renderOrder = 10
  return s
}

export class GarmentScene {
  renderer: THREE.WebGLRenderer
  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50)
  controls: OrbitControls
  private host: HTMLElement
  private ro: ResizeObserver
  private raf = 0
  private body: THREE.Object3D | null = null
  private parts: PartView[] = []
  private ghost = new THREE.Group()
  private seamGroup = new THREE.Group()
  private debugGroup = new THREE.Group()
  private garmentGroup = new THREE.Group()
  private fabricMat: THREE.MeshPhysicalMaterial | null = null
  private layerMats = {
    upper: new THREE.MeshStandardMaterial({ color: LAYER_COLOUR.upper, roughness: 0.85, side: THREE.DoubleSide }),
    lower: new THREE.MeshStandardMaterial({ color: LAYER_COLOUR.lower, roughness: 0.85, side: THREE.DoubleSide }),
  }
  private selected: THREE.Mesh | null = null
  stage: Stage = "pieces"
  private garmentHidden = false
  toggles: Toggles = { mannequin: true, pieces: false, seams: true, wireframe: false, realistic: true, debug: false }
  onPick: ((key: string | null) => void) | null = null

  constructor(host: HTMLElement) {
    this.host = host
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.domElement.className = "gw-canvas"
    host.appendChild(this.renderer.domElement)
    this.scene.background = new THREE.Color(0xe9ebef)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa0a8, 1.1))
    const key = new THREE.DirectionalLight(0xffffff, 2.2)
    key.position.set(1.5, 3, 2.2)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: 2.2, bottom: -0.2 })
    key.shadow.bias = -0.0004
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0xdfe8ff, 0.9)
    rim.position.set(-2, 2, -2.5)
    this.scene.add(rim)
    const ground = new THREE.Mesh(new THREE.CircleGeometry(3, 64), new THREE.ShadowMaterial({ opacity: 0.18 }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground, this.garmentGroup, this.ghost, this.seamGroup, this.debugGroup)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.target.set(0, 1.05, 0)
    this.camera.position.set(0.9, 1.35, 3.4)
    this.controls.update()
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(host)
    this.resize()
    this.renderer.domElement.addEventListener("pointerdown", this.onDown)
    this.renderer.domElement.addEventListener("pointerup", this.onUp)
    const loop = () => {
      this.raf = requestAnimationFrame(loop)
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    }
    loop()
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private down: { x: number; y: number } | null = null
  private onDown = (e: PointerEvent) => { this.down = { x: e.clientX, y: e.clientY } }
  private onUp = (e: PointerEvent) => {
    if (!this.down || Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) return
    const r = this.renderer.domElement.getBoundingClientRect()
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera)
    const hit = ray.intersectObjects(this.parts.filter((p) => p.mesh.visible).map((p) => p.mesh), false)[0]
    this.select(hit ? (hit.object.userData.key as string) : null)
    this.onPick?.(hit ? (hit.object.userData.key as string) : null)
  }

  select(key: string | null) {
    if (this.selected) (this.selected.material as THREE.Material & { emissive?: THREE.Color }).emissive?.set(0x000000)
    this.selected = null
    const p = this.parts.find((q) => q.key === key)
    if (!p) return
    // selection highlight on its own material copy
    const m = (p.mesh.material as THREE.MeshStandardMaterial).clone()
    m.emissive = new THREE.Color(0x3355ff)
    m.emissiveIntensity = 0.35
    p.mesh.material = m
    this.selected = p.mesh
  }

  setBody(root: THREE.Object3D) {
    if (this.body) this.scene.remove(this.body)
    this.body = root
    root.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true; m.receiveShadow = true
      // draw the skin a few mm inside itself: the cloth rests on a slightly simplified
      // collision body, and this keeps skin from poking through where the two differ
      if (/eye|teeth|tongue/i.test(m.name)) return
      for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.Material[]) {
        mat.onBeforeCompile = (sh) => {
          sh.vertexShader = sh.vertexShader.replace("#include <skinning_vertex>", "#include <skinning_vertex>\n  transformed -= normalize(objectNormal) * 0.004;")
        }
        mat.needsUpdate = true
      }
    })
    this.scene.add(root)
    this.applyVisibility()
  }

  setFabric(spec: FabricSpec, colour: string) {
    this.fabricMat?.dispose()
    this.fabricMat = fabricMaterial(spec, colour)
    for (const p of this.parts) {
      const uv = fabricUVs(p.mesh.userData.pos2d, spec, p.mesh.userData.mirrored)
      p.mesh.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
    }
    this.applyMaterials()
  }

  /** Build one cloth mesh per placed piece copy (positions = the initial layout). */
  build(a: Assembly) {
    for (const p of this.parts) { this.garmentGroup.remove(p.mesh); p.mesh.geometry.dispose() }
    this.parts = []
    this.ghost.clear()
    let offset = 0
    for (const part of a.parts) {
      const n = part.mesh.pos.length / 2
      const pos = part.initial.slice()
      const geo = new THREE.BufferGeometry()
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3))
      geo.setIndex(new THREE.BufferAttribute(part.tris, 1))
      geo.computeVertexNormals()
      const mesh = new THREE.Mesh(geo, this.layerMats[part.layer])
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.frustumCulled = false
      mesh.userData = { key: part.inst.key, pos2d: part.mesh.pos, mirrored: part.inst.mirrored }
      this.garmentGroup.add(mesh)
      this.parts.push({ key: part.inst.key, layer: part.layer, mesh, pos, offset, n })
      // ghost of the initial layout
      const g = new THREE.Mesh(geo.clone(), new THREE.MeshBasicMaterial({ color: LAYER_COLOUR[part.layer], wireframe: true, transparent: true, opacity: 0.15 }))
      this.ghost.add(g)
      offset += n
    }
    this.buildDebug(a)
    this.applyMaterials()
    this.applyVisibility()
  }

  private buildDebug(a: Assembly) {
    this.debugGroup.clear()
    const lm = a.landmarks
    const dot = new THREE.MeshBasicMaterial({ color: 0xff3366, depthTest: false })
    for (const [name, p] of Object.entries(lm)) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), dot)
      s.position.set(p[0], p[1], p[2] + 0.02)
      s.renderOrder = 9
      this.debugGroup.add(s)
      const l = labelSprite(name, "#c2185b")
      l.position.set(p[0] + 0.06, p[1], p[2] + 0.04)
      this.debugGroup.add(l)
    }
    // measurement rings at chest / waist / hip
    const fit = a.collider.bodyFit
    for (const [name, y] of [["chest", fit.chestY], ["waist", fit.waistY], ["hip", fit.hipY]] as const) {
      const s = fit.section(y)
      const pts: THREE.Vector3[] = []
      for (let k = 0; k <= 64; k++) {
        const t = (k / 64) * Math.PI * 2
        const z = Math.cos(t) >= 0 ? s.zf : s.zb
        pts.push(new THREE.Vector3(Math.sin(t) * s.a, y, s.cz + Math.cos(t) * z))
      }
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x1d4ed8, depthTest: false }))
      line.renderOrder = 8
      this.debugGroup.add(line)
      const cm = (a.measurements as any)[name === "hip" ? "hip" : name] * 100
      const l = labelSprite(`${name} ${cm.toFixed(0)} cm`, "#1d4ed8")
      l.position.set(-s.a - 0.12, y, s.cz)
      this.debugGroup.add(l)
    }
    // piece ids + bounding boxes + target regions at their initial placement
    for (const part of a.parts) {
      const pl = a.placements.get(part.inst.key)
      if (!pl) continue
      const l = labelSprite(`${part.inst.piece.id} ${part.inst.piece.category} · ${pl.targetRegion}`, part.layer === "upper" ? "#1e40af" : "#9a3412")
      l.position.copy(pl.position).add(new THREE.Vector3(0, 0, 0.05))
      this.debugGroup.add(l)
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.BufferAttribute(part.initial, 3))
      const box = new THREE.Box3().setFromBufferAttribute(g.attributes.position as THREE.BufferAttribute)
      this.debugGroup.add(new THREE.Box3Helper(box, new THREE.Color(LAYER_COLOUR[part.layer])))
    }
  }

  /** Seam lines along each stitched edge (coloured per seam in debug). */
  buildSeams(sim: ClothSim) {
    this.seamGroup.clear()
    const bySeam = new Map<string, number[]>()
    for (const st of sim.stitches) bySeam.set(st.seam, [...(bySeam.get(st.seam) || []), st.a])
    let k = 0
    for (const [id, verts] of bySeam) {
      const pos = new Float32Array(verts.length * 3)
      const g = new THREE.BufferGeometry()
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: SEAM_COLOURS[k++ % SEAM_COLOURS.length], transparent: true, opacity: 0.9 }))
      line.userData = { id, verts }
      line.frustumCulled = false
      this.seamGroup.add(line)
    }
    this.updateSeams(sim.x)
  }

  private updateSeams(x: Float32Array) {
    for (const line of this.seamGroup.children as THREE.Line[]) {
      const verts: number[] = line.userData.verts
      const pos = (line.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array
      verts.forEach((v, i) => { pos[i * 3] = x[v * 3]; pos[i * 3 + 1] = x[v * 3 + 1]; pos[i * 3 + 2] = x[v * 3 + 2] })
      line.geometry.attributes.position.needsUpdate = true
    }
  }

  /** Show a full particle state (live sim or a stored snapshot). */
  showState(x: Float32Array) {
    for (const p of this.parts) {
      p.pos.set(x.subarray(p.offset * 3, (p.offset + p.n) * 3))
      p.mesh.geometry.attributes.position.needsUpdate = true
      p.mesh.geometry.computeVertexNormals()
      p.mesh.geometry.computeBoundingSphere()
    }
    this.updateSeams(x)
  }

  showInitial(a: Assembly) {
    for (const p of this.parts) {
      const part = a.parts.find((q) => q.inst.key === p.key)!
      p.pos.set(part.initial)
      p.mesh.geometry.attributes.position.needsUpdate = true
      p.mesh.geometry.computeVertexNormals()
    }
  }

  setStage(stage: Stage) {
    this.stage = stage
    this.applyMaterials()
    this.applyVisibility()
  }

  /** Hide the garment while it's being sewn. */
  setGarmentHidden(hidden: boolean) {
    this.garmentHidden = hidden
    this.applyVisibility()
  }

  setToggles(t: Partial<Toggles>) {
    Object.assign(this.toggles, t)
    this.applyMaterials()
    this.applyVisibility()
  }

  private applyMaterials() {
    const realistic = this.fabricMat && (this.stage === "final" || (this.stage === "full" && this.toggles.realistic))
    for (const p of this.parts) {
      const m = realistic ? this.fabricMat! : this.layerMats[p.layer]
      p.mesh.material = m
      ;(m as THREE.MeshStandardMaterial).wireframe = this.toggles.wireframe
    }
    this.selected = null
  }

  private applyVisibility() {
    const st = this.stage
    for (const p of this.parts) {
      p.mesh.visible = !this.garmentHidden && (st === "pieces" || st === "full" || st === "final" || (st === "upper" && p.layer === "upper") || (st === "lower" && p.layer === "lower"))
    }
    if (this.body) this.body.visible = this.toggles.mannequin
    this.ghost.visible = this.toggles.pieces && st !== "pieces"
    this.seamGroup.visible = this.toggles.seams && !this.garmentHidden
    for (const l of this.seamGroup.children as THREE.Line[]) {
      const m = l.material as THREE.LineBasicMaterial
      m.opacity = st === "final" ? 0.35 : 0.9
      if (st === "final") m.color.set(0x222222)
    }
    this.debugGroup.visible = this.toggles.debug && st !== "final"
  }

  view(which: "front" | "side" | "back" | "360") {
    this.controls.autoRotate = which === "360"
    this.controls.autoRotateSpeed = 2
    if (which === "360") return
    const t = this.controls.target
    const d = 3.4
    const pos = which === "front" ? [0, 1.25, d] : which === "side" ? [d, 1.25, 0] : [0, 1.25, -d]
    this.camera.position.set(pos[0], pos[1], pos[2])
    this.camera.lookAt(t)
  }

  resetCamera() {
    this.controls.autoRotate = false
    this.controls.target.set(0, 1.05, 0)
    this.camera.position.set(0.9, 1.35, 3.4)
  }

  dispose() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.controls.dispose()
    this.renderer.domElement.removeEventListener("pointerdown", this.onDown)
    this.renderer.domElement.removeEventListener("pointerup", this.onUp)
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) m.geometry.dispose()
    })
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }
}
