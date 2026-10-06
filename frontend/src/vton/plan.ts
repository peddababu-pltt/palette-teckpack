// What to put on the body for a pattern: which garment scans, how long, which
// sleeves -- read from the design's garment category and the drafted pieces.
import type { PatternDesign, PatternPieces3D } from "../api"

export interface TopPlan {
  variant: string // scan name (tshirt1..3)
  lengthCm: number // HPS to hem
  longSleeve: boolean
}

export interface BottomPlan {
  variant: string // scan name (pant1..3)
  lengthCm: number | null // waist to hem; null = full length
}

export interface SkirtPlan {
  lengthCm: number // waist to hem
  hemGirthCm: number | null // null = straight from the hips
  pencil: boolean
  hemRatio?: number // hem width over waist width, read off the input sketch
}

export interface TryOnPlan {
  label: string
  quilted: boolean // puffer / padded: the sketch's stitch lines puff into cushions
  colour: string // a believable default fabric colour for the garment type
  top: TopPlan | null
  bottom: BottomPlan | null
  skirt: SkirtPlan | null
}

export const TOP_VARIANTS = ["tshirt1", "tshirt2", "tshirt3"]
export const BOTTOM_VARIANTS = ["pant1", "pant2", "pant3"]

interface PieceLike {
  suffix?: string
  wMm?: number
  hMm?: number
  onFold?: boolean
  place?: { category?: string; role?: string } | null
}

function role(p: PieceLike): string {
  return String(p.place?.category || p.place?.role || p.suffix || "").toLowerCase()
}

function tallest(pieces: PieceLike[], re: RegExp): PieceLike | null {
  let best: PieceLike | null = null
  for (const p of pieces) if (re.test(role(p)) && (p.hMm || 0) > (best?.hMm || 0)) best = p
  return best
}

/** `input` describes the techpack's input garment (its classification). */
export function planFromPattern(design: PatternDesign | null, index: PatternPieces3D | null, input = ""): TryOnPlan {
  const garment = (index?.garment || {}) as Record<string, unknown>
  const text = [input, design?.garmentCategory, garment.type, design?.designKey, design?.design]
    .filter(Boolean).join(" ").toLowerCase()
  const pieces = ((index?.pieces || []) as PieceLike[]).filter((p) => !/interfacing|facing|pocket|loop|fly/.test(role(p)))
  const label = String(design?.design || design?.garmentCategory || garment.type || "")

  const isDress = /dress|gown/.test(text)
  const isSkirt = !isDress && /skirt/.test(text)
  const isShorts = /short/.test(text)
  const isTrousers = !isShorts && /trouser|pant|jean|legging|jogger|chino/.test(text)
  const isJumpsuit = /jumpsuit|overall|romper/.test(text)
  const lowerOnly = isSkirt || isShorts || isTrousers || garment.region === "lower"

  let top: TopPlan | null = null
  if (!lowerOnly || isJumpsuit) {
    const bodice = tallest(pieces, /bodice|^front$|front/)
    const sleeve = tallest(pieces, /sleeve/)
    const shortSleeveType = /tee|t-shirt|tshirt|polo|tank|camisole|vest/.test(text)
    const said = String(design?.sleeveLength || "").toLowerCase()
    const longSleeve = /long|full|3\/4|three/.test(said) ? true
      : /short|cap|sleeveless|none/.test(said) ? false
      : sleeve?.hMm ? sleeve.hMm > 420 : !shortSleeveType && !/sleeveless/.test(text)
    const defaultLen = /hoodie|sweat/.test(text) ? 66 : /jacket|coat|blazer|outerwear|puffer/.test(text) ? 72 : /shirt/.test(text) ? 76 : 68
    top = {
      // tshirt1: grey button-up · tshirt2: hooded camo pullover · tshirt3: navy polo
      variant: /hoodie|sweat/.test(text) ? "tshirt2" : /shirt|jacket|coat|blazer|blouse|outerwear/.test(text) && !shortSleeveType ? "tshirt1" : "tshirt3",
      // a dress bodice stops at the waist, under the skirt
      lengthCm: isDress ? 47 : bodice?.hMm && !isJumpsuit ? bodice.hMm / 10 : defaultLen,
      longSleeve,
    }
  }

  let bottom: BottomPlan | null = null
  if (isShorts || isTrousers || isJumpsuit) {
    const leg = tallest(pieces, /leg|front|back/)
    bottom = {
      // pant1: light jeans · pant2: dark trousers · pant3: dark jeans
      variant: /jean|denim/.test(text) ? "pant1" : isShorts ? "pant3" : "pant2",
      lengthCm: isShorts ? (leg?.hMm ? leg.hMm / 10 : 35) : null,
    }
  }

  let skirt: SkirtPlan | null = null
  if (isSkirt || isDress) {
    const panels = pieces.filter((p) => /skirt/.test(role(p)))
    const panel = tallest(panels, /skirt/)
    const bodice = tallest(pieces, /bodice/)
    // the panels' combined width at the hem; a single front piece stands for front + back
    let hem = 0
    for (const p of panels) hem += (p.wMm || 0) / 10 * (p.onFold ? 2 : 1)
    if (panels.length === 1 && !/wrap|circle|panel/.test(role(panels[0]))) hem *= 2
    const lengthCm = panel?.hMm ? panel.hMm / 10 : isDress && bodice?.hMm ? Math.max(40, bodice.hMm / 10 - 45) : 55
    skirt = { lengthCm, hemGirthCm: hem > 0 ? hem : null, pencil: /pencil|straight|tube/.test(text) }
  }

  // nothing recognised: show it as a top
  if (!top && !bottom && !skirt) top = { variant: "tshirt3", lengthCm: 68, longSleeve: true }
  const quilted = /puffer|quilt|down|padded/.test(text)
  const colour = quilted ? "#2f3b4d"
    : /jean|denim/.test(text) ? "#4b6a8f"
    : /hoodie|sweat/.test(text) ? "#8f979f"
    : /skirt|dress/.test(text) ? "#3a3640"
    : /shirt|blouse/.test(text) ? "#e9e6df"
    : /short|trouser|pant|chino/.test(text) ? "#6b6250"
    : /jacket|coat|outerwear|blazer/.test(text) ? "#4a4f44"
    : "#cfc8b8"
  return { label, quilted, colour, top, bottom, skirt }
}
