// The pattern view's pieces resized to the size panel's values at once: each
// piece scaled across / down by how much the measurement it follows changed
// (the same grading pattern-lock.mjs applies to a custom pattern), so a size or
// measurement edit shows on the pieces without waiting for a redraft.
import type { PatternPiece } from "../garment/types"
import type { PaperSrc } from "./patternLayout"

type P = [number, number]

// Same as backend designs.mjs SIZE_FACTOR / defaultMeasurements and
// pattern-lock.mjs GRADE_RULES: a custom (AI) pattern is graded exactly this
// way, a catalogue one is redrafted from formulas, which this only approximates.
const SIZE_FACTOR: Record<string, number> = { XS: 0.88, S: 0.94, M: 1, L: 1.06, XL: 1.13, "2XL": 1.2, "3XL": 1.27, "4XL": 1.34 }

const GRADE_RULES: [RegExp, string | null, string | null][] = [
  [/cuff|wristband/i, "wrist", null],
  [/sleeve/i, "biceps", "shoulderToWrist"],
  [/collar|neckband|neckbinding|hood/i, "neck", null],
  [/waistband/i, "waist", null],
  [/pocket|flap|welt|tab|loop|patch|badge|strap|tie|zip/i, null, null],
  [/trouser|leg|pant|inseam/i, "hips", "inseam"],
  [/skirt/i, "hips", "waistToKnee"],
  [/hem.?band|rib/i, "hips", null],
  [/placket|facing|front|back|bodice|yoke|side|panel|lining|body/i, "chest", "hpsToWaistBack"],
]

export type GradeInput = { fromCm: Record<string, number>; toCm: Record<string, number>; fromSize: string; toSize: string }

/** How much a piece grows across (kx) and down (ky) from the drafted
 *  measurements to the ones on screen. */
export function gradeFactors(pieceName: string, g: GradeInput): { kx: number; ky: number } {
  const rule = GRADE_RULES.find(([re]) => re.test(pieceName))
  const [xKey, yKey] = rule ? [rule[1], rule[2]] : ["chest", null]
  const fFrom = SIZE_FACTOR[g.fromSize] ?? 1, fTo = SIZE_FACTOR[g.toSize] ?? 1
  const ratio = (key: string | null, girth: boolean) => {
    if (!key) return 1
    const a = g.fromCm[key], b = g.toCm[key]
    if (a > 0 && b > 0) return b / a
    // the design doesn't take this measurement: follow the size change alone
    return girth ? fTo / fFrom : (1 + fTo) / (1 + fFrom)
  }
  return { kx: ratio(xKey, true), ky: ratio(yKey, false) }
}


export type Scale = { kx: number; ky: number }

/** Pieces (and their papers) scaled across / down per piece name; names with
 *  no entry, or an entry of 1, come back as they were. */
export function scalePieces(
  pieces: PatternPiece[] | null,
  papers: Map<string, PaperSrc>,
  scaleOf: (suffix: string) => Scale | undefined,
): { pieces: PatternPiece[] | null; papers: Map<string, PaperSrc> } {
  if (!pieces) return { pieces, papers }
  const outPapers = new Map(papers)
  const out = pieces.map((p) => {
    const k = scaleOf(p.suffix)
    if (!k || (Math.abs(k.kx - 1) < 0.002 && Math.abs(k.ky - 1) < 0.002)) return p
    const { kx, ky } = k
    const scale = (ring: P[]) => ring.map(([x, y]) => [x * kx, y * ky] as P)
    const paper = papers.get(p.suffix)
    if (paper) {
      outPapers.set(p.suffix, {
        ...paper, ring: scale(paper.ring), w: paper.w * kx, h: paper.h * ky, foldX: paper.foldX == null ? null : paper.foldX * kx,
      })
    }
    return {
      ...p,
      ring: scale(p.ring),
      width: p.width * kx,
      height: p.height * ky,
      area: p.area * kx * ky,
      centre: p.centre.kind === "full" ? { kind: "full" as const, x: p.centre.x * kx } : p.centre,
    }
  })
  return { pieces: out, papers: outPapers }
}

/** The pattern graded from the drafted measurements / size to the panel's. */
export function gradePattern(
  pieces: PatternPiece[] | null,
  papers: Map<string, PaperSrc>,
  fromCm: Record<string, number>,
  toCm: Record<string, number>,
  fromSize: string,
  toSize: string,
): { pieces: PatternPiece[] | null; papers: Map<string, PaperSrc> } {
  return scalePieces(pieces, papers, (suffix) => gradeFactors(suffix, { fromCm, toCm, fromSize, toSize }))
}
