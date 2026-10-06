// Initial garment assembly: every piece copy is placed around the body region it
// belongs to -- derived from body landmarks, never fixed coordinates -- a few cm off
// the skin, bent to roughly the body's shape. This is the cloth simulation's starting
// state (like pattern pieces arranged around an avatar before sewing); the seams +
// gravity + collision then pull it into the garment.
import * as THREE from "three"
import { GAP, TAU, girthOf, type Fit } from "../components/pattern3d/body"
import type { Mesh2D } from "./PatternGeometry"
import type { BodyLandmarks, BodyMeasurements, PieceInstance } from "./types"
import { panelLayout, type PanelInfo } from "./Panels"

export interface Placement {
  targetRegion: "torso" | "yoke" | "arm" | "wrist" | "neck" | "waist" | "hips" | "legs" | "none"
  position: THREE.Vector3 // centre of the placed piece (debug / inspector)
  fitConfidence: number
  scale: number // 1 = true drafted size (pieces are never rescaled)
  warnings: string[]
}

export interface GarmentContext {
  circUpper: number // garment circumference of the upper body pieces (m)
  circLower: number
  yokeDepth: number // m (0 = no yoke)
  sleeveLen: number // m, for cuff placement
  bodiceLen: number // m, neck point to hem of the main bodice panels
  hasUpper: boolean
  panels: Map<string, PanelInfo> // side / princess panels, by instance key
  lowerOpening: "front" | "back" // where the lower garment's centre seam / opening is
  lowerCircAt: (vMm: number) => number // skirt circumference (m) v mm below its waist, from the pieces
}

// width of an outline across the row at height y (mm)
function spanAt(ring: [number, number][], y: number): number {
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
    if ((y1 - y) * (y2 - y) > 0 || y1 === y2) continue
    const x = x1 + ((x2 - x1) * (y - y1)) / (y2 - y1)
    lo = Math.min(lo, x); hi = Math.max(hi, x)
  }
  return hi > lo ? hi - lo : 0
}

const DEFAULT_OFFSET = 0.035 // start this far off the body
let OFFSET = DEFAULT_OFFSET

function clothSection(fit: Fit, y: number, hug: boolean) {
  const s = fit.section(Math.max(y, hug ? fit.crotchY : fit.hipY))
  if (!hug) {
    const t = Math.max(0, Math.min(1, (fit.hipY + 0.1 - y) / 0.15))
    if (t > 0) {
      const hg = fit.hang
      const mix = (cur: number, env: number) => cur + (Math.max(cur, env) - cur) * t
      s.a = mix(s.a, hg.a)
      const front = mix(s.cz + s.zf, hg.cz + hg.zf), back = mix(s.zb - s.cz, hg.zb - hg.cz)
      s.cz = (front - back) / 2
      s.zf = front - s.cz
      s.zb = back + s.cz
    }
  }
  return s
}

// A point on an ellipse around the torso at height y: arc u from centre front/back,
// the section grown to the garment's own circumference (ease) + the start offset.
function aroundTorso(fit: Fit, u: number, y: number, back: boolean, circ: number, hug = false, extra = OFFSET, maxTh = 0.8) {
  const s = clothSection(fit, y, hug)
  const body = girthOf(s)
  // a closed ring (maxTh ~ 1: a waistband) lies at its own length -- it can't be
  // larger than itself; the body collider keeps it off the skin
  const k = maxTh > 0.95 && circ ? Math.max(circ / body, 0.9) : Math.max((body + TAU * (GAP + extra)) / body, circ ? circ / body : 0)
  const a = s.a * k, d = (back ? s.zb : s.zf) * k
  const quarter = circ ? Math.max(circ, body * k) / 4 : ((a + d) / 2) * (Math.PI / 2)
  const th = Math.max(-Math.PI * maxTh, Math.min(Math.PI * maxTh, (u / quarter) * (Math.PI / 2)))
  const z = d * Math.cos(th)
  return new THREE.Vector3(a * Math.sin(th) * (back ? -1 : 1), y, s.cz + (back ? -z : z))
}

// Around a limb line: `along` from its top, u around (0 = the outside of the limb).
function aroundLimb(line: ReturnType<Fit["arm"]>, side: number, u: number, along: number, R: number, face: "out" | "front" | "back") {
  const { p, dir } = line.at(along)
  const outward = new THREE.Vector3(side, 0, 0)
  outward.addScaledVector(dir, -outward.dot(dir)).normalize()
  const fwd = new THREE.Vector3().crossVectors(dir, outward).normalize()
  if (fwd.z < 0) fwd.negate()
  const c0 = face === "out" ? outward : face === "front" ? fwd : fwd.clone().negate()
  const t0 = new THREE.Vector3().crossVectors(dir, c0).normalize()
  const th = u / R
  return p.addScaledVector(c0, R * Math.cos(th)).addScaledVector(t0, R * Math.sin(th))
}

// x of the outline on one side at height y (the real edge where it curves, e.g. a
// trouser's crotch curve above the crotch point)
function ringSideX(ring: [number, number][], y: number, side: "left" | "right"): number | null {
  let best: number | null = null
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
    if ((y1 - y) * (y2 - y) > 0 || y1 === y2) continue
    const x = x1 + ((x2 - x1) * (y - y1)) / (y2 - y1)
    if (best === null || (side === "left" ? x < best : x > best)) best = x
  }
  return best
}

/** (u, v) in metres: u across from the piece's centre / centre edge, v down from its top. */
function localUV(inst: PieceInstance, x: number, y: number, w: number): [number, number] {
  const c = inst.piece.centre
  let u: number
  if (c.kind === "full") u = x - c.x
  else if (c.kind === "half" && /^trouser_|^leg_panel$/.test(inst.piece.category)) {
    // measured from the centre edge on this row, not from the outline's box
    const ex = ringSideX(inst.piece.ring, y, c.side) ?? (c.side === "left" ? 0 : w)
    u = Math.max(0, c.side === "left" ? x - ex : ex - x)
  } else if (c.kind === "half") u = c.side === "left" ? x : w - x
  else u = x - w / 2
  if (inst.mirrored && c.kind !== "half") u = -u
  return [u / 1000, y / 1000]
}

// mm from a sleeve's top down to its underarm corners (the bottom of the cap)
function sleeveUnder(inst: PieceInstance): number {
  const ends = inst.piece.edges.filter((e) => e.kind === "cap").flatMap((e) => [inst.piece.ring[e.from][1], inst.piece.ring[e.to][1]])
  const top = Math.min(...inst.piece.ring.map((q) => q[1]))
  return ends.length ? Math.max(...ends) - top : 175
}

export function garmentContext(instances: PieceInstance[]): GarmentContext {
  const width = (re: RegExp) => instances.filter((i) => re.test(i.piece.category)).reduce((s, i) => {
    const c = i.piece.centre
    // a full panel counts whole; a half counts once per copy
    return s + (c.kind === "full" ? i.piece.width : i.piece.width - 20) / 1000
  }, 0)
  const yoke = instances.find((i) => i.piece.category === "yoke")
  const sleeve = instances.find((i) => /^sleeve/.test(i.piece.category))
  return {
    circUpper: width(/^(bodice_(front|back)|side_panel)$/),
    panels: panelLayout(instances),
    circLower: width(/^skirt_(front|back|side)$/),
    yokeDepth: yoke ? yoke.piece.height / 1000 : 0,
    // how far down the arm line the sleeve's hem lands (its underarm point at the armpit)
    sleeveLen: sleeve ? (sleeve.piece.height - sleeveUnder(sleeve)) / 1000 + 0.1 : 0,
    bodiceLen: Math.max(0, ...instances.filter((i) => /^bodice_front$/.test(i.piece.category)).map((i) => i.piece.height / 1000)) || 0.65,
    hasUpper: instances.some((i) => i.piece.garmentLayer === "upper"),
    // a skirt with a centre-back seam (back cut in halves) opens at the back
    lowerCircAt: (v: number) => instances.filter((i) => /^(skirt_(front|back|side)|trouser_(front|back))$/.test(i.piece.category)).reduce((sum, i) => {
      const r = i.piece.ring
      const top = Math.min(...r.map((p) => p[1])), bot = Math.max(...r.map((p) => p[1]))
      const span = spanAt(r, Math.min(bot - 1, top + Math.max(1, v)))
      // seam allowances off the joined sides (a half has one seamed side + its centre)
      return sum + Math.max(0, span - 20) / 1000
    }, 0),
    lowerOpening: instances.some((i) => i.piece.category === "skirt_back" && i.piece.centre.kind === "half")
      && !instances.some((i) => i.piece.category === "skirt_front" && i.piece.centre.kind === "half") ? "back" : "front",
  }
}

/**
 * fitPatternPiece: where + how this piece copy starts on the body, and the initial 3D
 * position of every mesh vertex (metres).
 */
export function fitPatternPiece(
  inst: PieceInstance, mesh: Mesh2D, fit: Fit, _m: BodyMeasurements, _lm: BodyLandmarks, ctx: GarmentContext,
  offset = DEFAULT_OFFSET,
): { positions: Float32Array; placement: Placement } {
  OFFSET = offset
  const cat = inst.piece.category
  const n = mesh.pos.length / 2
  const out = new Float32Array(n * 3)
  const w = inst.piece.width, h = inst.piece.height
  const side = inst.bodySide || 1
  const warnings: string[] = []
  let region: Placement["targetRegion"] = "none"
  let conf = 0.8
  const neckTop = fit.shoulderY + 0.045
  const waistTop = fit.waistY + 0.03
  const put = (i: number, v: THREE.Vector3) => { out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z }

  // the portion of a bodice above the shoulders folds over them toward the other side
  const bodice = (u: number, y: number, back: boolean) => {
    const base = fit.shoulderY - 0.06
    if (y <= base) return aroundTorso(fit, u, y, back, ctx.circUpper)
    const p = aroundTorso(fit, u, base, back, ctx.circUpper)
    const top = fit.shoulderTop(p.x) + GAP + OFFSET
    const climb = y - base, rise = Math.max(0, top - base)
    if (climb <= rise) return new THREE.Vector3(p.x, base + climb, p.z)
    const sec = fit.section(fit.shoulderY - 0.03)
    const over = Math.min(climb - rise, (back ? sec.zb : sec.zf) + OFFSET)
    return new THREE.Vector3(p.x, top, p.z + (back ? over : -over))
  }

  for (let i = 0; i < n; i++) {
    const [u0, v] = localUV(inst, mesh.pos[i * 2], mesh.pos[i * 2 + 1], w)
    const panel = ctx.panels.get(inst.key)
    const back = panel ? !panel.front : /back/.test(cat)
    if (/^bodice_(front|back)$|^side_panel$/.test(cat)) {
      region = "torso"
      // a side panel sits beside its centre panel, inner edge toward the centre line
      const x = mesh.pos[i * 2]
      const u = panel ? (panel.offset + (panel.innerLeft ? x - w / 2 : w / 2 - x) / 1000) * side * (back ? -1 : 1)
        : inst.piece.centre.kind === "half" ? u0 * side * (back ? -1 : 1) : u0
      const top = back && ctx.yokeDepth ? neckTop - ctx.yokeDepth * 0.8 : neckTop
      put(i, bodice(u, top - v, back))
    } else if (cat === "yoke") {
      region = "yoke"
      const u = inst.piece.centre.kind === "half" ? u0 * side * -1 : u0
      put(i, bodice(u, neckTop - v, true))
    } else if (/^sleeve/.test(cat)) {
      region = "arm"
      const line = fit.arm(side)
      // the underarm corners (bottom of the cap) sit at the armpit, ~10 cm down the arm
      // line; what's above them runs back up over the shoulder (a raglan's reaches the neck)
      const top = Math.min(...inst.piece.ring.map((q) => q[1]))
      const along = v - (top + sleeveUnder(inst)) / 1000 + 0.1
      const skin = Math.max(fit.rBiceps, fit.armRadius?.(side, Math.max(0, along)) || 0)
      const R = Math.max(skin + GAP + OFFSET * 0.6, (w / 1000 / TAU) * 0.95)
      put(i, aroundLimb(line, side, u0 * side, along, R, "out"))
    } else if (cat === "cuff") {
      region = "wrist"
      const line = fit.arm(side)
      const standing = h > w
      const [uu, vv] = standing ? [(mesh.pos[i * 2 + 1] - h / 2) / 1000, mesh.pos[i * 2] / 1000] : [u0, v]
      const len = standing ? h / 1000 : w / 1000
      const R = Math.max(fit.rWrist + GAP + OFFSET * 0.5, len / TAU)
      const start = ctx.sleeveLen ? Math.min(line.length, ctx.sleeveLen - 0.06) : line.length - 0.07
      put(i, aroundLimb(line, side, uu * side, start + vv * 0.6, R, "out"))
    } else if (cat === "hood" && inst.bodySide !== 0) {
      region = "neck"
      // a hood side stands beside the head: its bottom edge at the neckline, the face
      // opening toward the front, the back curve behind the head
      const [hx, hy, hz] = [0, fit.neckY + 0.12, fit.section(fit.neckY).cz + 0.01]
      const x2 = mesh.pos[i * 2] / w, y2 = mesh.pos[i * 2 + 1] / h
      const mirrorX = inst.mirrored ? 1 - x2 : x2
      const ang = (mirrorX - 0.5) * Math.PI * 0.9 // around the side of the head
      const R = 0.13 + OFFSET * 0.5
      const y = fit.neckY + (1 - y2) * (h / 1000) * 0.85
      put(i, new THREE.Vector3(side * R * Math.cos(ang), y, hz + R * Math.sin(ang) * 1.1))
      void hx; void hy
    } else if (cat === "hood") {
      region = "neck"
      // the centre strip runs over the top of the head, forehead to nape
      const along = (h > w ? mesh.pos[i * 2 + 1] / h : mesh.pos[i * 2] / w)
      const across = (h > w ? mesh.pos[i * 2] - w / 2 : mesh.pos[i * 2 + 1] - h / 2) / 1000
      const th = Math.PI * (0.1 + 0.9 * along)
      const R = 0.14 + OFFSET * 0.5
      const cz = fit.section(fit.neckY).cz
      put(i, new THREE.Vector3(across, fit.neckY + 0.1 + R * Math.sin(th), cz + R * Math.cos(th)))
    } else if (/^(collar|collar_stand|neckline)$/.test(cat)) {
      region = "neck"
      const standing = h > w
      const [uu, vv] = standing ? [(mesh.pos[i * 2 + 1] - h / 2) / 1000, mesh.pos[i * 2] / 1000] : [u0, v]
      const R = fit.rNeck + GAP + OFFSET * 0.6
      const th = Math.PI + uu / R
      const c = fit.section(fit.shoulderY).cz
      // attach edge (bottom) at the neckline, the rest standing up
      const y = fit.neckY + 0.005 + ((standing ? w : h) / 1000 - vv) * 0.9
      put(i, new THREE.Vector3(R * Math.sin(th), y, c + R * Math.cos(th)))
    } else if (cat === "waistband" && inst.piece.garmentLayer === "upper") {
      // a top's hem band: round the body just below the bodice hem
      region = "torso"
      const standing = h > w
      const [uu, vv] = standing ? [(mesh.pos[i * 2 + 1] - h / 2) / 1000, mesh.pos[i * 2] / 1000] : [u0, v]
      const hemY = neckTop - ctx.bodiceLen
      put(i, aroundTorso(fit, uu, hemY - vv * 0.5, true, ctx.circUpper))
    } else if (cat === "waistband") {
      region = "waist"
      const standing = h > w
      const [uu, vv] = standing ? [(mesh.pos[i * 2 + 1] - h / 2) / 1000, mesh.pos[i * 2] / 1000] : [u0, v]
      // the band's ends meet at the garment's opening (a skirt's centre-back zip, a
      // trouser fly): centred on the opposite side, laid round at its own length
      const openBack = ctx.lowerOpening === "back"
      const len = (standing ? h : w) / 1000, depth = (standing ? w : h) / 1000
      // a double-depth band starts folded in half along its length (attach edge at the
      // waist seam, the fold on top, the free half inside)
      const d = depth - vv // up from the attach edge
      const folded = depth > 0.045
      const up = folded ? (d < depth / 2 ? d : depth - d) : d * 0.5
      const inside = folded && d > depth / 2 ? 0.004 : 0
      const p = aroundTorso(fit, uu, waistTop + up, !openBack, len, true, OFFSET * 0.7, 0.99)
      if (inside) { const r = Math.hypot(p.x, p.z) || 1; p.x -= (p.x / r) * inside; p.z -= (p.z / r) * inside }
      put(i, p)
    } else if (/^skirt_/.test(cat)) {
      region = "hips"
      const u = inst.piece.centre.kind === "half" ? u0 * side * (back ? -1 : 1) : u0
      // round the body at the skirt's own width on this row (waist small, hem wide)
      const top = Math.min(...inst.piece.ring.map((p) => p[1]))
      put(i, aroundTorso(fit, u, waistTop - v, back, ctx.lowerCircAt(v * 1000 - top) || ctx.circLower))
    } else if (/^trouser_|^leg_panel$/.test(cat)) {
      region = "legs"
      const y = waistTop - v
      const au = Math.abs(u0)
      // above the crotch: round the body at the trousers' own width on this row
      const top = Math.min(...inst.piece.ring.map((p) => p[1]))
      if (y > fit.crotchY) put(i, aroundTorso(fit, (back ? -1 : 1) * side * au, y, back, ctx.lowerCircAt(v * 1000 - top), true))
      else {
        const R = Math.max(fit.rThigh + GAP + OFFSET * 0.5, (w / 1000 * 1.9) / TAU)
        // the centre (inseam) side of the panel goes to the inner leg
        const lu = (au - w / 2000) * side * (back ? 1 : -1)
        put(i, aroundLimb(fit.leg(side), side, lu, fit.crotchY + 0.05 - y, R, back ? "back" : "front"))
      }
    } else {
      region = "none"
      conf = 0
    }
  }
  if (region === "none") warnings.push(`${inst.piece.id} (${cat}) has no body region -- not placed`)
  // centre for the inspector / debug
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < n; i++) { cx += out[i * 3]; cy += out[i * 3 + 1]; cz += out[i * 3 + 2] }
  return {
    positions: out,
    placement: { targetRegion: region, position: new THREE.Vector3(cx / n, cy / n, cz / n), fitConfidence: conf, scale: 1, warnings },
  }
}
