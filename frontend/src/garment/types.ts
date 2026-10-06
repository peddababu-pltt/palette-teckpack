// Data model of the 3D garment pipeline.
//
//   pattern-pieces.json  ->  PatternPiece[]  ->  PieceInstance[] (left/right copies)
//        -> SeamGraph -> initial assembly on the body -> cloth simulation -> garment
//
// 2D pattern space: millimetres, y DOWN (as drafted / as in the piece image).
// 3D world: metres, y up, the body faces +z, floor at y = 0.

export type GarmentLayer = "upper" | "lower" | "accessory"
export type Side = "front" | "back" | "left" | "right" | "none"
export type PieceStatus = "ok" | "needs_review" | "ignored"

export type EdgeKind =
  | "neckline" | "shoulder" | "armhole" | "side" | "hem" | "center"
  | "cap" | "underarm" | "waist" | "crotch" | "inseam" | "outseam"
  | "attach" | "band_end" | "band_free" | "yoke_front" | "yoke_back" | "dart"
  | "hood_back" | "hood_front" | "unknown"

export interface PieceEdge {
  id: number
  kind: EdgeKind
  /** vertex indices into the piece ring, in canonical direction */
  from: number
  to: number
  length: number // mm
  /** "l" / "r" half of a full panel, or "" */
  half: "l" | "r" | ""
}

export interface PatternPiece {
  id: string // "P01"
  suffix: string // the pattern's own piece name
  source: "draft" | "image"
  /** closed outline, mm, y down, piece-local (0,0 = top-left of the outline box) */
  ring: [number, number][]
  /** true when `ring` was unfolded from a cut-on-fold half */
  unfolded: boolean
  /** centre line x (mm) for a full panel; the centre edge side for a half */
  centre: { kind: "full"; x: number } | { kind: "half"; side: "left" | "right" } | { kind: "none" }
  width: number // mm
  height: number // mm
  area: number // mm^2
  category: string
  garmentLayer: GarmentLayer | null
  side: Side
  confidence: number
  status: PieceStatus
  note: string
  edges: PieceEdge[]
  image?: string // job-relative texture path (inspector thumbnail)
}

/** One physical copy of a piece in the garment (a sleeve piece gives a left + a right). */
export interface PieceInstance {
  key: string // "P03:L"
  piece: PatternPiece
  mirrored: boolean // reflected about its own vertical axis
  bodySide: -1 | 0 | 1 // -1 = body's right (-x), 1 = body's left (+x), 0 = centred
}

export interface SeamEnd {
  instance: string
  edges: number[] // edge ids, concatenated in order
  reverse: boolean
}

export interface Seam {
  id: string
  a: SeamEnd
  b: SeamEnd
  kind: string // "side seam", "shoulder", ...
  confidence: number
  needsReview: boolean
  source: "rule" | "length"
  lengthA: number // mm
  lengthB: number
}

export interface BodyLandmarks {
  head: V3; neck: V3; chest: V3; waist: V3; hip: V3
  shoulderL: V3; shoulderR: V3; elbowL: V3; elbowR: V3; wristL: V3; wristR: V3
  kneeL: V3; kneeR: V3; ankleL: V3; ankleR: V3
}
export type V3 = [number, number, number]

export interface BodyMeasurements {
  height: number
  shoulderWidth: number
  chest: number
  waist: number
  hip: number
  torsoLength: number
  armLength: number
  upperArm: number
  forearm: number
  legLength: number
  thigh: number
  knee: number
  ankle: number
}

export type Stage = "pieces" | "upper" | "lower" | "full" | "final"

export interface FabricSpec {
  name: string
  baseColor: string
  roughness: number
  sheen: number
  normalStrength: number
  fabricScale: number // weave repeats per 10 cm
  stretch: number // 0 stiff .. 1 stretchy (sim)
  bend: number // 0 limp .. 1 stiff (sim)
  thickness: number // m
}
