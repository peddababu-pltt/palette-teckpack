// Body <-> garment sizing: measure the garment itself (chest / waist / hip round the
// pieces, their length), work out the body it was cut for (garment minus wearing
// ease), and size the 3D body to that -- so the humanoid always matches the clothes
// it's wearing, whatever size the pattern was drafted in.
import { instancesOf } from "./PatternPiece"
import type { PatternPiece } from "./types"

export type FitKey = "chest" | "waist" | "hips"

export interface FitRow {
  key: FitKey
  garmentCm: number
  bodyCm: number // the body the 3D model is sized to
  easeCm: number
  status: "tight" | "ok" | "loose"
}

export interface GarmentSizing {
  rows: FitRow[]
  bodyCm: Record<string, number> // overrides for the body fit
  adjusted: FitKey[] // girths where the garment disagreed with the size chart
  lengthCm: { upper: number; lower: number } // garment lengths (0 = none)
}

// minimum wearing ease (cm) by girth -- a fitted woven garment
const EASE: Record<FitKey, number> = { chest: 8, waist: 2, hips: 4 }
const LOOSE: Record<FitKey, number> = { chest: 25, waist: 15, hips: 20 }
const SA = 20 // mm: two seam allowances per piece across a row

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

const top = (p: PatternPiece) => Math.min(...p.ring.map((q) => q[1]))

export function garmentSizing(pieces: PatternPiece[], chartCm: Record<string, number>): GarmentSizing {
  const inst = instancesOf(pieces)
  const of = (re: RegExp) => inst.filter((i) => re.test(i.piece.category))
  // girth (cm) round a set of piece copies at a row picked per piece
  const round = (list: typeof inst, row: (p: PatternPiece) => number) =>
    list.reduce((s, i) => s + Math.max(0, spanAt(i.piece.ring, row(i.piece)) - SA), 0) / 10
  const edgeLen = (list: typeof inst, kind: string) =>
    list.reduce((s, i) => s + i.piece.edges.filter((e) => e.kind === kind).reduce((a, e) => a + e.length, 0), 0) / 10

  const garment: Partial<Record<FitKey, number>> = {}
  const bodice = of(/^(bodice_front|bodice_back|side_panel)$/)
  if (bodice.length) {
    // chest: the row just under the armhole
    garment.chest = round(bodice, (p) => {
      const arm = p.edges.filter((e) => e.kind === "armhole")
      const y = arm.length ? Math.max(...arm.flatMap((e) => [p.ring[e.from]?.[1] ?? 0, p.ring[e.to]?.[1] ?? 0])) : top(p) + p.height * 0.3
      return y + 15
    })
  }
  const lower = of(/^(skirt_front|skirt_back|skirt_side|trouser_front|trouser_back)$/)
  const band = of(/^waistband$/).find((i) => i.piece.garmentLayer !== "upper")
  if (lower.length) {
    const bandEdge = band?.piece.edges.find((e) => e.kind === "attach")
    garment.waist = bandEdge ? bandEdge.length / 10 : edgeLen(lower, "waist")
    // hips: ~20 cm below the waist (above a trouser's crotch point)
    garment.hips = round(lower, (p) => top(p) + Math.min(200, p.height * 0.35))
  }

  const rows: FitRow[] = []
  const bodyCm: Record<string, number> = {}
  const adjusted: FitKey[] = []
  for (const key of ["chest", "waist", "hips"] as FitKey[]) {
    const g = garment[key]
    if (!g || !isFinite(g) || g < 30) continue
    const chart = chartCm[key]
    const implied = g - EASE[key]
    // the garment governs when the size chart disagrees with what was actually cut
    // (lower-body girths only: a skirt's / trousers' waist + hip rows are read reliably
    // off the pieces; a bodice's chest row isn't, with plackets / princess panels)
    const trusted = key !== "chest" && !(key === "waist" && garment.hips && g > garment.hips)
    let body = chart > 0 ? chart : trusted ? implied : 0
    if (trusted && chart > 0 && implied < chart - 3 && implied > chart - 12) { body = implied; adjusted.push(key) }
    if (!body) continue
    if (trusted || chart > 0) bodyCm[key] = +body.toFixed(1)
    const ease = g - body
    rows.push({ key, garmentCm: +g.toFixed(1), bodyCm: +body.toFixed(1), easeCm: +ease.toFixed(1), status: ease < EASE[key] * 0.5 ? "tight" : ease > LOOSE[key] ? "loose" : "ok" })
  }
  const len = (list: typeof inst) => Math.max(0, ...list.map((i) => i.piece.height / 10))
  return { rows, bodyCm, adjusted, lengthCm: { upper: len(of(/^bodice_front$/)), lower: len(lower) } }
}
