// pattern-pieces.json -> PatternPiece[] -> PieceInstance[].
//
// Category / layer / side come from the AI classification (backend
// piece-placement.mjs) when present; otherwise from name rules, and anything those
// can't place is marked needs_review -- never guessed onto the body.
import type { PatternPieces3D, PatternPiece3D } from "../api"
import { bbox, centreSideFromShape, edgeSag, isSymmetric, labelEdges, normalizeRing, resplit, signedArea, splitEdge, unfold } from "./PatternGeometry"
import type { GarmentLayer, PatternPiece, PieceInstance, Side } from "./types"

type P = [number, number]

// pieces sewn inside another one, or stitched on top: listed, not simulated
export const INTERNAL = /^(facing|lining|interfacing|placket)$/
export const SURFACE = /^(pocket|pocket_flap|badge)$/
// halves that are cut on the fold get unfolded into full panels
const UNFOLD = /^(bodice_front|bodice_back|side_panel|skirt_front|skirt_back|skirt_side|yoke|collar|collar_stand)$/
const BANDS = /^(waistband|cuff|collar_stand|belt|strap)$/
const HALVES = /^(bodice_front|bodice_back|skirt_front|skirt_back|trouser_front|trouser_back|yoke)$/

function nameRule(suffix: string, lower: boolean): { category: string; layer: GarmentLayer | null; side: Side; sure: boolean } {
  const s = suffix.toLowerCase()
  const L = (category: string, layer: GarmentLayer | null, side: Side = "none", sure = true) => ({ category, layer, side, sure })
  if (/lining/.test(s)) return L("lining", lower ? "lower" : "upper")
  if (/interfacing/.test(s)) return L("interfacing", lower ? "lower" : "upper")
  if (/facing/.test(s)) return L("facing", lower ? "lower" : "upper")
  if (/placket|fly/.test(s)) return L("placket", lower ? "lower" : "upper")
  if (/pocketflap|flap/.test(s)) return L("pocket_flap", lower ? "lower" : "upper")
  if (/pocket|welt/.test(s)) return L("pocket", lower ? "lower" : "upper")
  if (/badge/.test(s)) return L("badge", "accessory")
  if (/waistband/.test(s)) return L("waistband", "lower")
  if (/beltloop|belt/.test(s)) return L("belt", "accessory")
  if (/cuff/.test(s)) return L("cuff", "upper")
  if (/collarstand|stand/.test(s)) return L("collar_stand", "upper")
  if (/collar/.test(s)) return L("collar", "upper")
  if (/hood/.test(s)) return L("hood", "upper")
  if (/yoke/.test(s)) return L("yoke", "upper", "back")
  if (/sleeve/.test(s)) return L("sleeve", "upper")
  // a side panel of a princess-seamed front/back ("sideBackPanel"): its own piece
  // beside the centre one, not the other half of the centre panel
  if (!lower && /side/.test(s) && /front|back/.test(s)) return L("side_panel", "upper", /back/.test(s) ? "back" : "front")
  if (/front/.test(s)) return lower ? L("trouser_front", "lower", "front") : L("bodice_front", "upper", "front")
  if (/back/.test(s)) return lower ? L("trouser_back", "lower", "back") : L("bodice_back", "upper", "back")
  return L("other", null, "none", false)
}

const LOWER_CATS = new Set(["trousers", "cycling_breeches", "shorts", "shorts_cargo", "leggings_capri", "leggings_full", "leggings", "underwear", "briefs"])
const SKIRT_CATS = new Set(["skirt_pencil", "skirt_circle", "skirt"])

export function loadPieces(index: PatternPieces3D, garmentCategory: string): PatternPiece[] {
  const region = index.garment?.region
  const lower = region ? region === "lower" : LOWER_CATS.has(garmentCategory) || SKIRT_CATS.has(garmentCategory)
  const skirt = SKIRT_CATS.has(garmentCategory)
  const out: PatternPiece[] = []
  index.pieces.forEach((p: PatternPiece3D & { polygon?: P[] | null; foldLine?: [P, P] | null }, i) => {
    if (!p.polygon || p.polygon.length < 3) return
    const ai = (p as any).place as undefined | {
      category?: string; garmentLayer?: GarmentLayer | null; side?: Side; centreEdge?: string; confidence?: number; status?: string; sewnOn?: string
    }
    let category: string, layer: GarmentLayer | null, side: Side, confidence: number, status: PatternPiece["status"]
    if (ai?.category) {
      category = ai.category
      layer = ai.garmentLayer ?? null
      side = ai.side || "none"
      confidence = ai.confidence ?? 0.5
      status = ai.status === "ok" ? "ok" : "needs_review"
    } else {
      const r = nameRule(p.suffix, lower)
      category = r.category
      if (skirt && /^trouser_/.test(category)) category = category.replace("trouser", "skirt")
      layer = r.layer
      side = r.side
      confidence = r.sure ? 0.7 : 0.45
      status = r.sure && layer ? "ok" : "needs_review"
    }
    // mm, y down, relative to the texture; the fold marker in the same space
    let ring = p.polygon.map(([x, y]) => [x, y] as P)
    const tb = bbox(ring)
    let centre: PatternPiece["centre"] = { kind: "none" }
    let unfolded = false
    if (p.foldLine && UNFOLD.test(category)) {
      const u = unfold(ring, p.foldLine)
      if (u) { ring = u.ring; centre = { kind: "full", x: u.centreX }; unfolded = true }
    } else if (p.foldLine && BANDS.test(category)) {
      // a band cut on the fold at one END is really twice as long; one folded along
      // its LENGTH (the fold on a long edge) folds back on itself -- keep as drafted
      const fb = bbox(ring)
      const [fa, fz] = p.foldLine
      const foldHorizontal = Math.abs(fz[0] - fa[0]) > Math.abs(fz[1] - fa[1])
      const standing = fb.h > fb.w
      if (standing === foldHorizontal) {
        const u = unfold(ring, p.foldLine, true)
        if (u) { ring = u.ring; unfolded = true }
      }
    }
    if (!unfolded) {
      ring = normalizeRing(ring)
      if ((HALVES.test(category) || /^trouser_/.test(category)) && !/^trouser_/.test(category) && isSymmetric(ring)) {
        // drafted full-width (a Simon yoke): centred, not a half
        centre = { kind: "full", x: bbox(ring).w / 2 }
      } else if (HALVES.test(category) || /^trouser_/.test(category)) {
        const shape = centreSideFromShape(ring, category)
        const aiSide = ai?.centreEdge === "left" || ai?.centreEdge === "right" ? ai.centreEdge : null
        centre = { kind: "half", side: shape.sure || !aiSide ? shape.side : (aiSide as "left" | "right") }
      }
    }
    void tb
    const b = bbox(ring)
    out.push({
      id: `P${String(i + 1).padStart(2, "0")}`,
      suffix: p.suffix,
      source: "draft",
      ring,
      unfolded,
      centre,
      width: b.w,
      height: b.h,
      area: Math.abs(signedArea(ring)),
      category,
      garmentLayer: layer,
      side,
      confidence,
      status,
      note: ai?.sewnOn || "",
      edges: labelEdges(ring, category, centre),
      image: p.file,
    })
  })
  // a trouser back's crotch point sits where its inseam matches the front's
  const tf = out.find((p) => p.category === "trouser_front"), tb = out.find((p) => p.category === "trouser_back")
  if (tf && tb) {
    const fIn = tf.edges.find((e) => e.kind === "inseam")
    const bIn = tb.edges.find((e) => e.kind === "inseam"), bCr = tb.edges.find((e) => e.kind === "crotch")
    if (fIn && bIn && bCr) {
      if (bCr.to === bIn.from) resplit(tb.ring, tb.edges, bCr, bIn, fIn.length)
      else if (bIn.to === bCr.from) resplit(tb.ring, tb.edges, bIn, bCr, bIn.length + bCr.length - fIn.length)
    }
  }
  // a hood side's back curve sews to the centre strip: it is as long as the strip's
  // long edge; whatever is left of that outline -- the straighter end -- is the face
  const strip = out.find((p) => p.category === "hood" && Math.max(p.width, p.height) > Math.min(p.width, p.height) * 4)
  const stripLen = strip?.edges.filter((e) => e.kind === "hood_back").reduce((m, e) => Math.max(m, e.length), 0) || 0
  for (const p of out) {
    if (p.category !== "hood" || p === strip || !stripLen) continue
    const e = p.edges.find((x) => x.kind === "hood_back")
    if (!e || e.length < stripLen * 1.15) continue
    // try the back curve at either end; keep the split whose leftover is straighter
    const tryAt = (fromStart: boolean) => {
      const edges = p.edges.map((x) => ({ ...x }))
      const target = edges.find((x) => x.from === e.from && x.to === e.to)!
      const pair = splitEdge(p.ring, edges, target, fromStart ? stripLen : e.length - stripLen)
      if (!pair) return null
      const [a, b] = pair
      const face = fromStart ? b : a
      ;(fromStart ? a : b).kind = "hood_back"
      face.kind = "hood_front"
      return { edges, sag: edgeSag(p.ring, face) }
    }
    const A = tryAt(true), B = tryAt(false)
    const best = A && B ? (A.sag <= B.sag ? A : B) : A || B
    if (best) p.edges = best.edges
  }
  return out
}

/**
 * Physical copies. A half panel / sleeve / cuff drafted once is cut twice (the second
 * mirrored); two pieces drafted as a left + right pair are each used once.
 */
export function instancesOf(pieces: PatternPiece[]): PieceInstance[] {
  const out: PieceInstance[] = []
  const active = pieces.filter((p) => p.status !== "ignored" && p.garmentLayer && !INTERNAL.test(p.category) && !SURFACE.test(p.category))
  const byCat = new Map<string, PatternPiece[]>()
  for (const p of active) byCat.set(p.category, [...(byCat.get(p.category) || []), p])
  // which body side a half naturally dresses, from where its centre edge is (seen
  // from outside: a front with its centre on the left of the image is the wearer's
  // left front; a back with its centre on the left is the wearer's right back)
  const naturalSide = (p: PatternPiece): -1 | 1 => {
    if (p.centre.kind !== "half") return 1
    const back = /back/.test(p.category)
    const cl = p.centre.side === "left"
    return (back ? !cl : cl) ? 1 : -1
  }
  for (const [cat, list] of byCat) {
    for (const p of list) {
      if (p.status === "needs_review") continue
      const hoodSide = cat === "hood" && Math.max(p.width, p.height) < Math.min(p.width, p.height) * 4
      const pairable = p.centre.kind === "half" || /^(sleeve|cuff|side_panel)$/.test(cat) || hoodSide
      if (/^(sleeve_left|sleeve_right)$/.test(cat)) {
        out.push({ key: `${p.id}:S`, piece: p, mirrored: false, bodySide: cat === "sleeve_left" ? 1 : -1 })
        continue
      }
      if (!pairable) {
        out.push({ key: `${p.id}:C`, piece: p, mirrored: false, bodySide: 0 })
        continue
      }
      const s = naturalSide(p)
      // a drafted left/right pair: two halves of the same category, each used once
      const pair = list.filter((q) => q.status !== "needs_review" && q.centre.kind === "half")
      if (pair.length >= 2 && p.centre.kind === "half") {
        const taken = out.some((o) => o.piece.category === cat && o.bodySide === s)
        out.push({ key: `${p.id}:S`, piece: p, mirrored: taken, bodySide: taken ? ((-s) as -1 | 1) : s })
        continue
      }
      out.push({ key: `${p.id}:A`, piece: p, mirrored: false, bodySide: s })
      out.push({ key: `${p.id}:B`, piece: p, mirrored: true, bodySide: (-s) as -1 | 1 })
    }
  }
  return out
}

/** Every piece enlarged evenly by k about its own origin (cloth size control). */
export function scaleIndex(index: PatternPieces3D, k: number): PatternPieces3D {
  if (k === 1) return index
  const sp = (q: [number, number]): [number, number] => [q[0] * k, q[1] * k]
  return {
    ...index,
    pieces: index.pieces.map((p: any) => ({
      ...p,
      wMm: p.wMm * k, hMm: p.hMm * k,
      cutMm: p.cutMm ? { x: p.cutMm.x * k, y: p.cutMm.y * k, w: p.cutMm.w * k, h: p.cutMm.h * k } : p.cutMm,
      polygon: p.polygon ? p.polygon.map(sp) : p.polygon,
      foldLine: p.foldLine ? p.foldLine.map(sp) : p.foldLine,
    })),
  }
}
