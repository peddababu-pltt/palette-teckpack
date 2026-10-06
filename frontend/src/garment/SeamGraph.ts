// Seam graph: which edges of which piece copies are sewn together.
//
// Rules come from garment construction (a bodice side seam joins front and back on
// the same body side, a sleeve cap sews into the front + back armhole, a waistband's
// attach edge takes every waist edge, dart legs close onto each other...). Every
// candidate is then checked by edge length: a mismatch beyond tolerance marks the seam
// needs_review, and a pairing the rules can't make is simply not made -- nothing is
// stitched on a guess.
import type { EdgeKind, PieceInstance, Seam, SeamEnd } from "./types"
import { panelLayout } from "./Panels"

const TOL_REVIEW = 0.8 // min/max length ratio below which a seam is flagged
const TOL_DROP = 0.45 // below this the pairing is clearly wrong: not sewn

function isFront(i: PieceInstance) { return /front/.test(i.piece.category) }
// worn on the back, so seen from behind (a yoke sits across the upper back)
function isBack(i: PieceInstance) { return /back|yoke/.test(i.piece.category) }

// Body side (+1 = wearer's left, +x) of a full panel's "l"/"r" half: seen from the
// front the panel's left half is the wearer's right; seen from behind it's the left.
export function halfSide(inst: PieceInstance, half: "l" | "r" | ""): -1 | 0 | 1 {
  if (!half) return inst.bodySide
  const front = !isBack(inst)
  return (half === "l") === front ? -1 : 1
}

function edgeIds(inst: PieceInstance, kind: EdgeKind, side?: -1 | 1): number[] {
  return inst.piece.edges
    .filter((e) => e.kind === kind && (side === undefined || halfSide(inst, e.half) === side || halfSide(inst, e.half) === 0))
    .map((e) => e.id)
}

function lengthOf(inst: PieceInstance, ids: number[]) {
  return ids.reduce((s, id) => s + (inst.piece.edges.find((e) => e.id === id)?.length || 0), 0)
}

export function buildSeams(instances: PieceInstance[]): Seam[] {
  const seams: Seam[] = []
  let n = 0
  const add = (kind: string, a: PieceInstance[], aIds: number[][], b: PieceInstance[], bIds: number[][]) => {
    // multi-piece chains allowed on either end (a cap across two armholes)
    const ea: SeamEnd[] = a.map((inst, i) => ({ instance: inst.key, edges: aIds[i], reverse: false })).filter((e) => e.edges.length)
    const eb: SeamEnd[] = b.map((inst, i) => ({ instance: inst.key, edges: bIds[i], reverse: false })).filter((e) => e.edges.length)
    if (!ea.length || !eb.length) return
    const la = a.reduce((s, inst, i) => s + lengthOf(inst, aIds[i]), 0)
    const lb = b.reduce((s, inst, i) => s + lengthOf(inst, bIds[i]), 0)
    const ratio = Math.min(la, lb) / Math.max(la, lb || 1)
    if (ratio < TOL_DROP) return
    // a chain of several ends is represented as consecutive seams sharing the id
    const id = `S${String(++n).padStart(2, "0")}`
    seams.push({
      id, a: ea[0], b: eb[0], kind, confidence: Math.round(ratio * 90) / 100, needsReview: ratio < TOL_REVIEW, source: "rule",
      lengthA: la, lengthB: lb,
      ...(ea.length > 1 || eb.length > 1 ? { chainA: ea, chainB: eb } : {}),
    } as Seam)
  }
  const of = (re: RegExp) => instances.filter((i) => re.test(i.piece.category))
  const fronts = of(/^bodice_front$/), backs = of(/^bodice_back$/)
  const sleeves = of(/^sleeve(_left|_right)?$/), cuffs = of(/^cuff$/)
  const yoke = of(/^yoke$/)[0]
  const stand = of(/^collar_stand$/)[0], collar = of(/^collar$/)[0]
  const onSide = (list: PieceInstance[], s: -1 | 1) =>
    list.filter((i) => i.bodySide === s || i.bodySide === 0)

  // ---- upper ----
  const panels = panelLayout(instances)
  for (const s of [-1, 1] as const) {
    const f = onSide(fronts, s)[0], b = onSide(backs, s)[0]
    // panelled bodice: centre front -> side front -> side back -> centre back
    const pan = [...panels.entries()].map(([k, info]) => ({ inst: instances.find((i) => i.key === k)!, info })).filter((x) => x.inst.bodySide === s)
    const fp = pan.find((x) => x.info.front), bp = pan.find((x) => !x.info.front)
    if (f && fp) add("princess seam (front)", [f], [edgeIds(f, "side", s)], [fp.inst], [fp.info.innerIds])
    if (b && bp) add("princess seam (back)", [b], [edgeIds(b, "side", s)], [bp.inst], [bp.info.innerIds])
    const sideF = fp ? { inst: fp.inst, ids: fp.info.outerIds } : f ? { inst: f, ids: edgeIds(f, "side", s) } : null
    const sideB = bp ? { inst: bp.inst, ids: bp.info.outerIds } : b ? { inst: b, ids: edgeIds(b, "side", s) } : null
    if (sideF && sideB) add("side seam", [sideF.inst], [sideF.ids], [sideB.inst], [sideB.ids])
    const frontParts = [f, fp?.inst].filter(Boolean) as PieceInstance[]
    const backParts = [bp?.inst, b].filter(Boolean) as PieceInstance[]
    if (f && yoke) add("shoulder to yoke", [f], [edgeIds(f, "shoulder", s)], [yoke], [edgeIds(yoke, "yoke_front", s)])
    else if (frontParts.length && backParts.length) add("shoulder", frontParts, frontParts.map((i) => edgeIds(i, "shoulder", s)), backParts, backParts.map((i) => edgeIds(i, "shoulder", s)))
    const sl = onSide(sleeves, s).find((i) => i.bodySide === s)
    if (sl && frontParts.length && backParts.length) {
      // front armhole -> (yoke's bit of armhole) -> back armhole
      const holes = [...frontParts, ...(yoke ? [yoke] : []), ...backParts]
      add("sleeve cap", [sl], [edgeIds(sl, "cap")], holes, holes.map((h) => edgeIds(h, "armhole", s)))
      const ua = edgeIds(sl, "underarm")
      if (ua.length >= 2) add("sleeve underarm", [sl], [[ua[0]]], [sl], [[ua[ua.length - 1]]])
      const cf = cuffs.find((c) => c.bodySide === s)
      if (cf) {
        add("cuff", [cf], [edgeIds(cf, "attach")], [sl], [edgeIds(sl, "hem")])
        const ends = edgeIds(cf, "band_end")
        if (ends.length >= 2) add("cuff ends", [cf], [[ends[0]]], [cf], [[ends[ends.length - 1]]])
      }
    }
  }
  // centre seams between two halves
  for (const list of [fronts, backs]) {
    const l = list.find((i) => i.bodySide === 1 && i.piece.centre.kind === "half")
    const r = list.find((i) => i.bodySide === -1 && i.piece.centre.kind === "half")
    if (l && r) add(isFront(l) ? "centre front" : "centre back", [l], [edgeIds(l, "center")], [r], [edgeIds(r, "center")])
  }
  if (yoke && backs.length) {
    // the back's top edge (drafted as shoulder/neckline when a yoke sits above it)
    add("yoke to back", [yoke], [edgeIds(yoke, "yoke_back")], backs, backs.map((b) => [...edgeIds(b, "shoulder"), ...edgeIds(b, "neckline")]))
  }
  // collar onto the neckline chain: fronts + (yoke | back)
  // (raglan sleeves carry part of the neckline)
  const neckOwners = [...fronts, ...(yoke ? [yoke] : backs), ...sleeves.filter((sl) => sl.piece.edges.some((e) => e.kind === "neckline"))]
  const neckIds = neckOwners.map((i) => edgeIds(i, "neckline"))
  const hoods = of(/^hood$/)
  const hoodSides = hoods.filter((h) => h.bodySide !== 0), hoodCentre = hoods.find((h) => h.bodySide === 0)
  const binding = of(/^neckline$/)[0]
  if (hoodSides.length) {
    add("hood to neckline", hoodSides, hoodSides.map((h) => edgeIds(h, "neckline")), neckOwners, neckIds)
    if (hoodCentre) {
      const long = edgeIds(hoodCentre, "hood_back")
      hoodSides.forEach((h, i) => { if (long[i] !== undefined) add("hood centre", [h], [edgeIds(h, "hood_back")], [hoodCentre], [[long[i]]]) })
    } else if (hoodSides.length === 2) {
      add("hood centre back", [hoodSides[0]], [edgeIds(hoodSides[0], "hood_back")], [hoodSides[1]], [edgeIds(hoodSides[1], "hood_back")])
    }
  }
  if (binding && !stand && !collar && !hoodSides.length) add("neck binding", [binding], [edgeIds(binding, "attach")], neckOwners, neckIds)
  if (stand) {
    add("collar stand to neckline", [stand], [edgeIds(stand, "attach")], neckOwners, neckIds)
    if (collar) add("collar to stand", [collar], [edgeIds(collar, "attach")], [stand], [edgeIds(stand, "band_free")])
  } else if (collar) {
    add("collar to neckline", [collar], [edgeIds(collar, "attach")], neckOwners, neckIds)
  }

  // ---- lower ----
  const skirtF = of(/^skirt_front$/), skirtB = of(/^skirt_back$/)
  const trF = of(/^trouser_front$/), trB = of(/^trouser_back$/)
  // on a top, a "waistband" is the hem band: sewn to the bodice hem
  const hemBand = instances.find((i) => i.piece.category === "waistband" && i.piece.garmentLayer === "upper")
  if (hemBand && (fronts.length || backs.length)) {
    const owners = [...fronts, ...backs]
    add("hem band", [hemBand], [edgeIds(hemBand, "attach")], owners, owners.map((o) => edgeIds(o, "hem")))
    // a closed hem band on a pullover: its two ends sew together (at a side / the back)
    const ends = hemBand.piece.edges.filter((e) => e.kind === "band_end")
    const openFront = fronts.some((f) => f.piece.centre.kind === "half")
    if (!openFront && ends.length === 2) add("hem band ends", [hemBand], [[ends[0].id]], [hemBand], [[ends[1].id]])
  }
  const band = of(/^waistband$/).find((i) => i.piece.garmentLayer !== "upper")
  for (const s of [-1, 1] as const) {
    const f = onSide(skirtF, s)[0], b = onSide(skirtB, s)[0]
    if (f && b) add("skirt side seam", [f], [edgeIds(f, "side", s)], [b], [edgeIds(b, "side", s)])
    const tf = trF.find((i) => i.bodySide === s), tb = trB.find((i) => i.bodySide === s)
    if (tf && tb) {
      add("outseam", [tf], [edgeIds(tf, "outseam")], [tb], [edgeIds(tb, "outseam")])
      add("inseam", [tf], [edgeIds(tf, "inseam")], [tb], [edgeIds(tb, "inseam")])
    }
  }
  for (const list of [skirtF, skirtB, trF, trB]) {
    const l = list.find((i) => i.bodySide === 1), r = list.find((i) => i.bodySide === -1)
    if (!l || !r) continue
    const kind: EdgeKind = /trouser/.test(l.piece.category) ? "crotch" : "center"
    add(kind === "crotch" ? (isFront(l) ? "front crotch" : "back crotch") : isFront(l) ? "centre front" : "centre back",
      [l], [edgeIds(l, kind)], [r], [edgeIds(r, kind)])
  }
  if (band) {
    const owners = [...skirtF, ...skirtB, ...trF, ...trB]
    if (owners.length) add("waistband", [band], [edgeIds(band, "attach")], owners, owners.map((o) => edgeIds(o, "waist")))
    // the band's two ends are fastened (hook / button over the opening)
    const ends = band.piece.edges.filter((e) => e.kind === "band_end")
    if (owners.length && ends.length === 2) add("waistband closure", [band], [[ends[0].id]], [band], [[ends[1].id]])
    // a band cut double depth folds in half: its free edge is sewn down inside, onto
    // the waist seam (otherwise the loose half rolls up)
    const depth = Math.min(band.piece.width, band.piece.height)
    if (owners.length && depth > 45) add("waistband fold", [band], [edgeIds(band, "band_free")], [band], [edgeIds(band, "attach")])
  }

  // ---- darts: each pair of dart legs meeting at a tip closes onto itself ----
  for (const inst of instances) {
    const ds = inst.piece.edges.filter((e) => e.kind === "dart")
    for (let i = 0; i + 1 < ds.length; i++) {
      if (ds[i].to === ds[i + 1].from) {
        add("dart", [inst], [[ds[i].id]], [inst], [[ds[i + 1].id]])
        i++
      }
    }
  }
  return seams
}

export type SeamWithChains = Seam & { chainA?: SeamEnd[]; chainB?: SeamEnd[] }
