// Pattern view: every cut piece of the drafted pattern, flat and at true size,
// floating where it is worn on the figure -- fronts in front of the chest, backs
// behind it, sleeves along the arms, cuffs at the wrists, collars behind the
// neck, linings / facings / interfacing on an inner layer under the piece they
// line -- and only pieces with no recognisable place on a rack beside it. Each piece is drawn exactly as the
// sewing pattern draws it (its paper texture: cutline, seam allowance, notches,
// grainline, name and cut text). Rebuilt on every body reshape and every
// redraft, so size and measurement edits move and resize the pieces live.
import * as THREE from "three"
import { INTERNAL, SURFACE, instancesOf } from "../garment/PatternPiece"
import type { PatternPiece } from "../garment/types"

/** Where the posed figure is, world space (+x = the figure's left, +z = front). */
export interface Anchors {
  neckY: number
  waistY: number
  hipY: number
  frontZ: number // chest front surface
  backZ: number // chest back surface
  hipFrontZ: number
  hipBackZ: number
  /** shoulder joint and wrist, per side (+1 = figure's left) */
  arms: Map<1 | -1, { shoulder: THREE.Vector3; wrist: THREE.Vector3 }>
  reachX: number // half the hand span
}

type Pt = [number, number]

/** A piece as drafted, in its paper texture's own frame (mm, y down). */
export interface PaperSrc {
  ring: Pt[] // the cutline, texture mm
  w: number // texture size, mm
  h: number
  tex: THREE.Texture | null // the sewing pattern's drawing of it (piece-paper.mjs)
  foldX: number | null // a cut-on-fold piece's fold line (vertical), texture mm
}

const GAP = 0.16 // m between a piece and the skin it covers
// Pieces read as fabric, not white paper: a two-tone check, light pink for an
// upper garment's pieces and light green for a lower garment's. The paper's
// own lines and text multiply over it, so they stay as dark as before.
const CHECK_MM = 50
const CHECKS = {
  upper: [new THREE.Color("#f4b6c8"), new THREE.Color("#fde6ee")],
  lower: [new THREE.Color("#a8dcb5"), new THREE.Color("#e4f5e8")],
}
function checkered(mat: THREE.MeshBasicMaterial, tw: number, th: number, lower: boolean) {
  const [a, b] = CHECKS[lower ? "lower" : "upper"]
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uChecks = { value: new THREE.Vector2(tw / CHECK_MM, th / CHECK_MM) }
    sh.uniforms.uCheckA = { value: a }
    sh.uniforms.uCheckB = { value: b }
    sh.fragmentShader = "uniform vec2 uChecks;\nuniform vec3 uCheckA;\nuniform vec3 uCheckB;\n" + sh.fragmentShader.replace(
      "#include <map_fragment>",
      "#include <map_fragment>\n  vec2 ck = floor(vMapUv * uChecks);\n  diffuseColor.rgb *= mix(uCheckA, uCheckB, mod(ck.x + ck.y, 2.0));",
    )
  }
  mat.customProgramCacheKey = () => `checks-${lower ? "lower" : "upper"}`
}

function ringBox(ring: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2 }
}

/** What the layout works on: the drafted ring (in the paper's frame when there
 *  is a paper) and where its centre line is in that frame. */
interface Work {
  p: PatternPiece
  ring: Pt[]
  paper: PaperSrc | null
  centre: { kind: "half"; side: "left" | "right"; x: number } | { kind: "full"; x: number }
  foldPair: boolean // a panel half cut on the fold: shown as both halves
}

function workOf(p: PatternPiece, paper: PaperSrc | undefined): Work {
  if (!paper) {
    const b = ringBox(p.ring)
    const centre: Work["centre"] = p.centre.kind === "half"
      ? { kind: "half", side: p.centre.side, x: p.centre.side === "left" ? b.x0 : b.x1 }
      : { kind: "full", x: p.centre.kind === "full" ? p.centre.x : b.cx }
    return { p, ring: p.ring, paper: null, centre, foldPair: false }
  }
  const b = ringBox(paper.ring)
  if (paper.foldX != null && /^(bodice_front|bodice_back|yoke|skirt_front|skirt_back)$/.test(p.category)) {
    const side = Math.abs(paper.foldX - b.x0) <= Math.abs(paper.foldX - b.x1) ? "left" : "right"
    return { p, ring: paper.ring, paper, centre: { kind: "half", side, x: paper.foldX }, foldPair: true }
  }
  // normalizeRing only translates, so the centre side read off the classified
  // ring holds in the paper's frame too
  if (p.centre.kind === "half") return { p, ring: paper.ring, paper, centre: { kind: "half", side: p.centre.side, x: p.centre.side === "left" ? b.x0 : b.x1 }, foldPair: false }
  return { p, ring: paper.ring, paper, centre: { kind: "full", x: b.cx }, foldPair: false }
}

/** A piece the classifier gave no centre line (a lining, a facing): its centre
 *  edge is the longer straight vertical run of its outline on the box's left or
 *  right side -- a half panel is cut with its centre front/back dead straight. */
function withCentre(w: Work): Work {
  if (w.centre.kind === "half" || w.foldPair) return w
  const b = ringBox(w.ring)
  const run = (edgeX: number) => {
    let len = 0
    for (let i = 0; i < w.ring.length; i++) {
      const [x0, y0] = w.ring[i], [x1, y1] = w.ring[(i + 1) % w.ring.length]
      if (Math.abs(x0 - edgeX) < 3 && Math.abs(x1 - edgeX) < 3) len += Math.abs(y1 - y0)
    }
    return len
  }
  const l = run(b.x0), r = run(b.x1)
  if (Math.max(l, r) < b.h * 0.5) return w // no straight centre edge: a full piece
  const side = l >= r ? "left" : "right"
  return { ...w, centre: { kind: "half", side, x: side === "left" ? b.x0 : b.x1 } }
}

/** One piece in world space, `map` taking its frame (mm, y down) to world. The
 *  paper is a quad over the whole texture (transparent outside the piece), so
 *  seam allowance, marks and text all show; without one, a plain coloured panel. */
function drawPiece(w: Work, map: (x: number, y: number) => THREE.Vector3, internal: boolean, lower: boolean): THREE.Object3D {
  const grp = new THREE.Group()
  grp.userData.piece = w.p.suffix
  if (w.paper?.tex) {
    const { w: tw, h: th } = w.paper
    const corners: Pt[] = [[0, 0], [tw, 0], [tw, th], [0, th]]
    const pos = new Float32Array(12), uv = new Float32Array(8)
    corners.forEach(([x, y], i) => {
      const v = map(x, y)
      pos.set([v.x, v.y, v.z], i * 3)
      uv.set([x / tw, y / th], i * 2) // ImageBitmap textures: no flipY, row 0 = v 0
    })
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2))
    g.setIndex([0, 2, 1, 0, 3, 2])
    g.computeVertexNormals()
    const mat = new THREE.MeshBasicMaterial({
      map: w.paper.tex, side: THREE.DoubleSide, transparent: true, alphaTest: 0.04,
      opacity: internal ? 0.75 : 1,
    })
    checkered(mat, tw, th, lower)
    grp.add(new THREE.Mesh(g, mat))
    return grp
  }
  const pts = w.ring.map(([x, y]) => map(x, y))
  const tris = THREE.ShapeUtils.triangulateShape(w.ring.map(([x, y]) => new THREE.Vector2(x, -y)), [])
  const pos = new Float32Array(pts.length * 3)
  pts.forEach((v, i) => pos.set([v.x, v.y, v.z], i * 3))
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3))
  g.setIndex(tris.flat())
  g.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({
    color: CHECKS[lower ? "lower" : "upper"][0], side: THREE.DoubleSide, roughness: 0.85,
    transparent: true, opacity: internal ? 0.55 : 0.88, depthWrite: !internal,
  })
  const outline = new THREE.BufferGeometry().setFromPoints(pts)
  grp.add(new THREE.Mesh(g, mat), new THREE.LineLoop(outline, new THREE.LineBasicMaterial({ color: 0x1d2733 })))
  return grp
}

function label(text: string, at: THREE.Vector3): THREE.Sprite {
  const c = document.createElement("canvas")
  const ctx = c.getContext("2d")!
  ctx.font = "600 44px system-ui, sans-serif"
  c.width = Math.ceil(ctx.measureText(text).width) + 24
  c.height = 64
  ctx.font = "600 44px system-ui, sans-serif"
  ctx.fillStyle = "rgba(255,255,255,0.85)"
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.fillStyle = "#1d2733"
  ctx.textBaseline = "middle"
  ctx.fillText(text, 12, c.height / 2)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  // depth-tested: an inner piece's label hides behind the outer piece, like the piece
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }))
  const h = 0.035
  s.scale.set(h * c.width / c.height, h, 1)
  s.position.copy(at)
  s.renderOrder = 10
  return s
}

/** A half panel (or full one) hung on the body's centre line: its centre edge
 *  on x = 0, extending toward `side`, its cutline's top at `topY`, at depth `z`. */
function centreHung(w: Work, side: -1 | 0 | 1, topY: number, z: number) {
  const b = ringBox(w.ring)
  if (side === 0 || w.centre.kind !== "half") {
    const cx = w.centre.x
    const off = side * (b.w / 2) / 1000 // a pairable full piece (side panel) sits off-centre
    return (x: number, y: number) => new THREE.Vector3((x - cx) / 1000 + off, topY - (y - b.y0) / 1000, z)
  }
  const ext = w.centre.side === "left" ? 1 : -1 // the ring runs away from its centre edge
  const cEdge = w.centre.x
  return (x: number, y: number) => new THREE.Vector3(side * ext * (x - cEdge) / 1000, topY - (y - b.y0) / 1000, z)
}

/** A band (waistband, hem band, casing) laid across the body: its long side
 *  horizontal, centred on x = 0, its top edge at `topY` -- turned a quarter
 *  turn when it was drafted standing upright. */
function acrossBody(w: Work, topY: number, z: number) {
  const b = ringBox(w.ring)
  return b.w >= b.h
    ? (x: number, y: number) => new THREE.Vector3((x - b.cx) / 1000, topY - (y - b.y0) / 1000, z)
    : (x: number, y: number) => new THREE.Vector3((y - (b.y0 + b.y1) / 2) / 1000, topY - (b.x1 - x) / 1000, z)
}

/** Laid along an arm: the cutline's top edge at `start`, its length down the arm. */
function alongArm(w: Work, start: THREE.Vector3, dir: THREE.Vector3, z: number) {
  const b = ringBox(w.ring)
  const perp = new THREE.Vector3(-dir.y, dir.x, 0)
  return (x: number, y: number) => {
    const v = start.clone().addScaledVector(dir, (y - b.y0) / 1000).addScaledVector(perp, (x - b.cx) / 1000)
    v.z = z
    return v
  }
}

export function buildPatternGroup(pieces: PatternPiece[], papers: Map<string, PaperSrc>, a: Anchors): THREE.Group {
  const root = new THREE.Group()
  root.name = "pattern-view"
  const placed = new Set<string>()
  const works = new Map(pieces.map((p) => [p.id, workOf(p, papers.get(p.suffix))]))
  // Every piece on its own depth step: pieces that overlap (back yoke over the
  // back panels, side panels over the centre one) were coplanar, and the GPU
  // flickered them into each other in speckles. 3mm per piece, outward from
  // the body's centre plane, so later pieces sit on top.
  let layer = 0
  const add = (w: Work, rawMap: (x: number, y: number) => THREE.Vector3, tag = "", internal = false) => {
    const dz = ++layer * 0.003
    const map = (x: number, y: number) => {
      const v = rawMap(x, y)
      v.z += v.z >= 0 ? dz : -dz
      return v
    }
    // trousers / skirts / their waistband and fly: the lower garment's colour
    // (only when the pattern has a lower garment: a jacket's hip welt pocket was
    // matched as "waist" and came out green)
    const lower = /^(skirt_|trouser_)/.test(w.p.category)
      || (garmentLower && !/^(bodice_|sleeve|collar|cuff|hood)/.test(w.p.category))
    const piece = drawPiece(w, map, internal, lower)
    const b = ringBox(w.ring)
    const top = map(b.cx, b.y0 - 25) // above the seam allowance
    root.add(piece, label(tag ? `${w.p.suffix} ${tag}` : w.p.suffix, top.clone().add(new THREE.Vector3(0, 0.02, 0.01 * Math.sign(top.z || 1)))))
    placed.add(w.p.id)
  }

  // ---- body pieces, by their worn place ----
  const collarRow: Work[] = []
  let hemY = a.hipY - 0.05 // the bodice's hem line, once a front bodice is placed
  // backings (lining / facing / interfacing) are hidden duplicates of the piece
  // they back, whatever category the classifier filed them under
  // (a pocket bag hangs inside the garment the same way)
  const backing = (p: PatternPiece) => /lining|facing|interfacing|pocket_?bag|(^|[_\s])bag([_\s]|$)/i.test(`${p.suffix} ${p.category}`)
  // Which side a yoke belongs to, from the pieces themselves: the body panel it
  // sits on is shorter than the other by about the yoke's own height (a back
  // yoke: back panel + yoke = front panel). The name or the classifier's side
  // only decides when the heights don't (both panels yoked, or no panels).
  const panelH = (cat: string) => Math.max(0, ...[...works.values()].filter((w) => w.p.category === cat && !backing(w.p)).map((w) => ringBox(w.ring).h))
  const frontH = panelH("bodice_front"), backH = panelH("bodice_back")
  const yokeSide = (p: PatternPiece): "front" | "back" => {
    if (/back/i.test(p.suffix)) return "back"
    if (/front/i.test(p.suffix)) return "front"
    const yh = ringBox(works.get(p.id)!.ring).h
    if (frontH > 0 && backH > 0 && yh > 0) {
      const onBack = Math.abs(backH + yh - frontH), onFront = Math.abs(frontH + yh - backH)
      if (Math.min(onBack, onFront) < yh * 0.6) return onBack <= onFront ? "back" : "front"
    }
    return p.side === "front" ? "front" : "back"
  }
  const isBack = (p: PatternPiece) => /_back$/.test(p.category)
    || (p.category === "yoke" ? yokeSide(p) === "back" : p.side === "back" && /^(side_panel|shoulder)$/.test(p.category))
  // A front/back built from several panels: the yoke takes the top, the body
  // panels hang from its lower edge, and side panels sit beside the centre
  // panel -- not every piece hung from the neck on the centre line.
  const yokeH = { front: 0, back: 0 }, centreW = { front: 0, back: 0 }
  // Trousers / shorts / skirts: their yoke and side panels belong at the waist,
  // not at the shoulders -- a shorts back yoke was floating at chest height.
  const garmentLower = [...works.values()].some((w) => /^(skirt_|trouser_)/.test(w.p.category))
  for (const w of works.values()) {
    if (backing(w.p)) continue
    const key = isBack(w.p) ? "back" : "front"
    const b = ringBox(w.ring)
    if (w.p.category === "yoke") yokeH[key] = Math.max(yokeH[key], b.h / 1000)
    if (/^bodice_(front|back)$/.test(w.p.category))
      centreW[key] = Math.max(centreW[key], (w.centre.kind === "half" ? b.w : b.w / 2) / 1000)
  }
  // A pattern can carry a whole front AND its yoke + lower split (a bomber's
  // "front" 59cm beside frontYoke 19cm + frontLower 42cm). Hanging every panel
  // under the yoke dropped the whole front 19cm, leaving the shoulders bare.
  // Only a panel that needs the yoke to reach full length hangs below it.
  const fullH = Math.max(frontH, backH) / 1000
  const underYoke = (key: "front" | "back", h: number) =>
    yokeH[key] > 0 && h + yokeH[key] <= fullH * 1.12 ? yokeH[key] : 0
  // a two-piece sleeve: the under sleeve runs beside the upper one along the arm
  const mainSleeves = [...works.values()].filter((w) => w.p.category === "sleeve" && !/under/i.test(w.p.suffix) && !backing(w.p))
  const sleeveW = Math.max(0, ...mainSleeves.map((w) => ringBox(w.ring).w / 1000))
  const sleeveLen = Math.max(0, ...mainSleeves.map((w) => ringBox(w.ring).h / 1000))
  const SLEEVE_START = 0.1 // past the bodice's armhole, so the wide cap doesn't cover the front
  // where a cuff starts on an arm: the end of the sleeve (the wrist when there's no sleeve)
  const cuffStart = (arm: { shoulder: THREE.Vector3; wrist: THREE.Vector3 }, dir: THREE.Vector3, len: number) =>
    sleeveLen > 0
      ? arm.shoulder.clone().addScaledVector(dir, SLEEVE_START + sleeveLen + 0.01)
      : arm.wrist.clone().addScaledVector(dir, -len - 0.02)
  let cuffLen = 0
  for (const inst of instancesOf(pieces)) {
    if (backing(inst.piece)) continue
    const w = works.get(inst.piece.id)!
    const p = w.p, cat = p.category, s = inst.bodySide
    const back = isBack(p)
    if (/^(bodice_front|bodice_back|side_panel|yoke|shoulder|skirt_front|skirt_back|skirt_side|trouser_front|trouser_back)$/.test(cat)) {
      const lower = /^(skirt_|trouser_)/.test(cat) || (garmentLower && /^(yoke|side_panel)$/.test(cat))
      const key = back ? "back" : "front"
      const z = lower ? (back ? a.hipBackZ - GAP : a.hipFrontZ + GAP) : back ? a.backZ - GAP : a.frontZ + GAP
      // a lower garment hangs from the waist; its panels from the yoke's lower edge
      const b = ringBox(w.ring)
      const top = lower
        ? a.waistY + 0.02 - (cat === "yoke" ? 0 : yokeH[key])
        : a.neckY + 0.02 - (cat === "yoke" ? 0 : underYoke(key, b.h / 1000))
      if (cat === "side_panel" && centreW[key] > 0) {
        // outward from the centre panel's edge, on its own side
        const side = s === 0 ? 1 : s
        add(w, (x, y) => new THREE.Vector3(side * (centreW[key] + (x - b.x0) / 1000), top - (y - b.y0) / 1000, z))
      } else {
        // a half cut on the fold: the drafted half on each side of the centre line
        const sides: (-1 | 0 | 1)[] = w.foldPair ? [1, -1] : [s]
        for (const side of sides) add(w, centreHung(w, side, top, z))
      }
      if (cat === "bodice_front") hemY = top - b.h / 1000
    } else if (/^(sleeve|sleeve_left|sleeve_right|cuff)$/.test(cat)) {
      const arm = a.arms.get(s === -1 ? -1 : 1)
      if (!arm) continue
      const dir = arm.wrist.clone().sub(arm.shoulder).setZ(0).normalize()
      const len = ringBox(w.ring).h / 1000
      if (cat === "cuff") cuffLen = Math.max(cuffLen, len)
      let start = cat === "cuff" ? cuffStart(arm, dir, len) : arm.shoulder.clone().addScaledVector(dir, SLEEVE_START)
      if (/under/i.test(p.suffix) && sleeveW > 0) {
        // the under sleeve beside the upper one (below it, across the arm)
        const across = new THREE.Vector3(-dir.y, dir.x, 0)
        const down = across.y > 0 ? across.negate() : across // below the arm, either side
        start = start.clone().addScaledVector(down, (sleeveW + ringBox(w.ring).w / 1000) / 2 + 0.02)
      }
      add(w, alongArm(w, start, dir, Math.max(arm.shoulder.z, arm.wrist.z) + GAP + (cat === "cuff" ? 0.03 : 0)))
      // and behind the arm: a sleeve wraps it, and the back view had bare arms
      add(w, alongArm(w, start, dir, Math.min(arm.shoulder.z, arm.wrist.z) - GAP - (cat === "cuff" ? 0.03 : 0)), "back")
    } else if (/^(collar|collar_stand|hood|neckline)$/.test(cat)) {
      if (!collarRow.includes(w)) collarRow.push(w)
    } else if (cat === "waistband") {
      const b = ringBox(w.ring)
      add(w, acrossBody(w, a.waistY + 0.04, a.hipFrontZ + GAP + 0.05))
    }
  }
  // collar pieces in a row behind the neck, bottom edges at the neckline
  if (collarRow.length) {
    const boxes = collarRow.map((w) => ringBox(w.ring))
    const total = boxes.reduce((t, b) => t + b.w, 0) / 1000 + 0.06 * (boxes.length - 1)
    let x = -total / 2
    collarRow.forEach((w, i) => {
      const b = boxes[i], left = x
      // seen from behind (-z), so laid out mirrored to read left-to-right there
      add(w, (px, py) => new THREE.Vector3(-(left + (px - b.x0) / 1000), a.neckY + 0.08 + (b.y1 - py) / 1000, a.backZ - GAP - 0.08))
      x += b.w / 1000 + 0.06
    })
  }
  // pockets / flaps / badges on the front at the hip, one per side
  for (const p of pieces.filter((q) => SURFACE.test(q.category) && q.status !== "ignored" && !backing(q))) {
    const w = works.get(p.id)!, b = ringBox(w.ring)
    // a back pocket on the seat, read from behind; the rest on the front hip
    const onBack = /back/i.test(p.suffix)
    for (const s of [1, -1] as const) {
      const cx = s * 0.13, flap = p.category === "pocket_flap" ? 0.06 : 0
      const z = onBack ? a.hipBackZ - GAP - 0.05 - flap * 0.3 : a.hipFrontZ + GAP + 0.05 + flap * 0.3
      add(w, (x, y) => new THREE.Vector3(cx + (onBack ? -s : s) * (x - b.cx) / 1000, a.hipY + 0.12 + flap - (y - b.y0) / 1000, z))
    }
  }

  // ---- add-on pieces, where they're worn ----
  // A lining, facing or interfacing is the same shape in the same place as the
  // piece it backs: drawn there it only stacked a hidden duplicate behind that
  // piece. It is left out of this view (it stays in the sewing pattern). Pieces
  // seen on the outside -- plackets, straps, casings, bands, welts -- go where
  // they're sewn on, both sides where the garment has two.
  for (const p of pieces) {
    if (placed.has(p.id) || p.status === "ignored") continue
    const n = `${p.suffix} ${p.category}`.toLowerCase()
    if (backing(p)) { placed.add(p.id); continue }
    const w = withCentre(works.get(p.id)!)
    const b = ringBox(w.ring)
    const outer = GAP + 0.03 // on top of the piece it's sewn to
    if (/cuff|wrist/.test(n)) {
      for (const s of [1, -1] as const) {
        const arm = a.arms.get(s)
        if (!arm) continue
        const dir = arm.wrist.clone().sub(arm.shoulder).setZ(0).normalize()
        // a strap / tab after the cuff (beyond the sleeve's end), not on top of it
        const start = cuffStart(arm, dir, b.h / 1000).addScaledVector(dir, cuffLen > 0 ? cuffLen + 0.01 : 0)
        add(w, alongArm(w, start, dir, Math.max(arm.shoulder.z, arm.wrist.z) + GAP))
        add(w, alongArm(w, start, dir, Math.min(arm.shoulder.z, arm.wrist.z) - GAP), "back")
      }
    } else if (/loop/.test(n) && garmentLower) {
      // belt loops on the waistband, two at the front
      for (const s of [1, -1] as const)
        add(w, (x, y) => new THREE.Vector3(s * 0.11 + (x - b.cx) / 1000, a.waistY + 0.06 - (y - b.y0) / 1000, a.hipFrontZ + outer + 0.06))
    } else if (/fly/.test(n)) {
      // the fly shield down the centre front from the waist
      add(w, centreHung(w, 1, a.waistY + 0.0, a.hipFrontZ + outer))
    } else if (/hem|casing|band|drawcord/.test(n) && !/waist/.test(n)) {
      add(w, acrossBody(w, hemY + 0.02, a.frontZ + outer)) // along the hem
    } else if (/waist/.test(n)) {
      add(w, acrossBody(w, a.waistY + 0.04, a.hipFrontZ + outer))
    } else if (/pocket|welt/.test(n)) {
      for (const s of [1, -1] as const)
        add(w, (x, y) => new THREE.Vector3(s * 0.13 + s * (x - b.cx) / 1000, a.hipY + 0.12 - (y - b.y0) / 1000, a.hipFrontZ + outer + 0.02))
    } else if (/placket|front/.test(n)) {
      // down the centre front, over the front panels
      for (const s of [1, -1] as const) add(w, centreHung(w, s, a.neckY + 0.02, a.frontZ + outer))
    } else continue
    placed.add(p.id)
  }

  // ---- the rack: only what has no place on the figure ----
  const rack = pieces.filter((p) => !placed.has(p.id) && p.status !== "ignored")
  const rackTop = a.neckY + 0.15
  let colX = a.reachX + 0.25, y = rackTop, colW = 0
  for (const p of rack) {
    const w = works.get(p.id)!
    // the whole paper (seam allowance + marks) takes the space, not just the cutline
    const fx0 = w.paper ? 0 : ringBox(w.ring).x0, fy0 = w.paper ? 0 : ringBox(w.ring).y0
    const fw = (w.paper ? w.paper.w : ringBox(w.ring).w) / 1000, fh = (w.paper ? w.paper.h : ringBox(w.ring).h) / 1000
    if (y - fh < 0.1 && y < rackTop) { colX += colW + 0.1; y = rackTop; colW = 0 } // column full
    const top = y, x0 = colX
    add(w, (px, py) => new THREE.Vector3(x0 + (px - fx0) / 1000, top - (py - fy0) / 1000, 0), INTERNAL.test(p.category) ? "· inner" : "", INTERNAL.test(p.category))
    colW = Math.max(colW, fw)
    y -= fh + 0.06
  }
  return root
}

export function disposeGroup(g: THREE.Object3D) {
  g.traverse((o) => {
    const m = o as THREE.Mesh
    m.geometry?.dispose()
    const mat = m.material as THREE.Material | THREE.Material[] | undefined
    for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      // piece papers are owned by the viewer (reused across rebuilds); labels are ours
      if (x instanceof THREE.SpriteMaterial) x.map?.dispose()
      x.dispose()
    }
  })
}
