// Shapes the try-on: fits the garment scans to the pattern (length, sleeves, a
// skirt built around the body) and warps body + garments together to the
// pattern's measurements, so the cloth follows every measurement change.
// Everything works in the scan's own space (metres, y up, feet at y = -1.16).

// Landmarks of the scanned body, from the slice profile written by
// scripts/extract-vton-assets.py.
export const SCAN = {
  hpsY: 0.29,
  shoulderY: 0.05,
  chestY: -0.03,
  waistY: -0.15,
  hipY: -0.27,
  crotchY: -0.42,
  thighY: -0.52,
  kneeY: -0.73,
  ankleY: -1.03,
  floorY: -1.16,
  wristY: -0.27,
  armX: 0.2, // |x| past which the hanging arms start (torso is narrower)
  armCX: 0.265, // arms' centre line
  legSplit: -0.045, // the gap between the legs (the scan stands slightly off-centre)
  pantsTopY: -0.2,
}

// The scanned man's own measurements (cm): each ratio is taken against these.
const SCAN_CM = {
  neck: 40, shoulder: 45, chest: 95, waist: 97, hip: 102, thigh: 49, knee: 35, ankle: 23, arm: 30,
  torsoLen: 44, legLen: 101,
}
type RatioKey = keyof typeof SCAN_CM
export type Ratios = Record<RatioKey, number>

// pattern measurement keys for each ratio, first found wins
const KEYS: Record<RatioKey, string[]> = {
  neck: ["neck"],
  shoulder: ["shoulderToShoulder", "shoulderWidth", "acrossBack"],
  chest: ["chest", "bust"],
  waist: ["waist"],
  hip: ["hips", "seat", "hip"],
  thigh: ["upperLeg", "thigh"],
  knee: ["knee"],
  ankle: ["ankle"],
  arm: ["biceps", "upperArm"],
  torsoLen: ["hpsToWaistBack", "hpsToWaistFront"],
  legLen: ["waistToFloor"],
}
const GIRTHS: RatioKey[] = ["neck", "shoulder", "chest", "waist", "hip", "thigh", "knee", "ankle", "arm"]

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

export function ratiosFrom(cm: Record<string, number>): Ratios {
  const found: Partial<Ratios> = {}
  for (const k of Object.keys(KEYS) as RatioKey[]) {
    const v = KEYS[k].map((key) => cm[key]).find((x) => Number.isFinite(x) && x > 0)
    if (v) found[k] = clamp(v / SCAN_CM[k], 0.55, 1.8)
  }
  // a girth the pattern doesn't measure follows the ones it does (a skirt pattern
  // has no chest: the body still slims or grows with its waist and hips)
  const known = GIRTHS.map((k) => found[k]).filter((x): x is number => x != null)
  const mean = known.length ? known.reduce((a, b) => a + b, 0) / known.length : 1
  const out = {} as Ratios
  for (const k of Object.keys(SCAN_CM) as RatioKey[]) out[k] = found[k] ?? (GIRTHS.includes(k) ? mean : 1)
  return out
}

// ---- the body's frame: per-height centres of the torso and of each leg ----

const BIN = 0.01
const Y0 = SCAN.floorY - 0.03
const NB = Math.ceil((0.62 - Y0) / BIN)
const ANG = 72
const binOf = (y: number) => clamp(Math.floor((y - Y0) / BIN), 0, NB - 1)
const handBand = (y: number) => y < -0.31 && y > -0.58

export class BodyFrame {
  torsoZ = new Float32Array(NB)
  legX = [new Float32Array(NB), new Float32Array(NB)]
  legZ = [new Float32Array(NB), new Float32Array(NB)]
  // torso/leg outline: max radius from (0, torsoZ) per height and angle (NaN = none)
  outline = new Float32Array(NB * ANG).fill(NaN)

  constructor(pos: Float32Array) {
    const tz = new Float64Array(NB), tn = new Float64Array(NB)
    const lx = [new Float64Array(NB), new Float64Array(NB)], lz = [new Float64Array(NB), new Float64Array(NB)], ln = [new Float64Array(NB), new Float64Array(NB)]
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2], b = binOf(y)
      if (Math.abs(x) < 0.15) { tz[b] += z; tn[b]++ }
      if (y < SCAN.crotchY + 0.03 && !(handBand(y) && Math.abs(x) > 0.17)) {
        const s = x < SCAN.legSplit ? 0 : 1
        lx[s][b] += x; lz[s][b] += z; ln[s][b]++
      }
    }
    fill(this.torsoZ, tz, tn)
    for (const s of [0, 1]) { fill(this.legX[s], lx[s], ln[s]); fill(this.legZ[s], lz[s], ln[s]) }
    // per-centimetre means jitter with the scan's sampling: smooth them along the body
    for (const arr of [this.torsoZ, ...this.legX, ...this.legZ]) smoothAlong(arr, 6)
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2]
      if (y > SCAN.chestY + 0.02 || handBand(y)) continue
      if (Math.abs(x) > (y < -0.58 ? 0.32 : 0.17)) continue // arms / hands
      const b = binOf(y), dz = z - this.torsoZ[b]
      const a = angBin(Math.atan2(dz, x))
      const r = Math.hypot(x, dz), k = b * ANG + a
      if (!(this.outline[k] >= r)) this.outline[k] = r
    }
    // close angular gaps in each ring
    for (let b = 0; b < NB; b++) {
      const ring = this.outline.subarray(b * ANG, (b + 1) * ANG)
      if (ring.every((v) => Number.isNaN(v))) continue
      for (let pass = 0; pass < 3; pass++)
        for (let a = 0; a < ANG; a++)
          if (Number.isNaN(ring[a])) {
            const l = ring[(a + ANG - 1) % ANG], r = ring[(a + 1) % ANG]
            ring[a] = Number.isNaN(l) ? r : Number.isNaN(r) ? l : (l + r) / 2
          }
    }
  }

  radius(y: number, angle: number): number {
    const v = this.outline[binOf(y) * ANG + angBin(angle)]
    return Number.isNaN(v) ? 0 : v
  }

  bin(y: number) {
    return binOf(y)
  }

  /** Front/back divide for a point: the torso's centre, or its leg's below the crotch. */
  centreZ(x: number, y: number): number {
    const b = binOf(y)
    if (y < SCAN.crotchY && armWeight(x, y) < 0.5) return this.legZ[x < SCAN.legSplit ? 0 : 1][b]
    return this.torsoZ[b]
  }
}

function angBin(a: number) {
  return ((Math.round((a / (Math.PI * 2)) * ANG) % ANG) + ANG) % ANG
}

function smoothAlong(arr: Float32Array, half: number) {
  const src = arr.slice()
  for (let b = 0; b < arr.length; b++) {
    let sum = 0, n = 0
    for (let k = -half; k <= half; k++) if (b + k >= 0 && b + k < arr.length) { sum += src[b + k]; n++ }
    arr[b] = sum / n
  }
}

function fill(out: Float32Array, sum: Float64Array, n: Float64Array) {
  let last = NaN
  for (let b = 0; b < NB; b++) if (n[b]) { last = sum[b] / n[b]; break }
  for (let b = 0; b < NB; b++) {
    if (n[b]) last = sum[b] / n[b]
    out[b] = Number.isNaN(last) ? 0 : last
  }
}

// ---- the measurement warp ----

type Key = [number, RatioKey | 1]
const TORSO_KEYS: Key[] = [
  [0.42, 1], [0.3, "neck"], [0.12, "shoulder"], [SCAN.chestY, "chest"], [SCAN.waistY, "waist"],
  [SCAN.hipY, "hip"], [SCAN.floorY, "hip"],
]
const LEG_KEYS: Key[] = [
  [SCAN.crotchY, "hip"], [SCAN.thighY, "thigh"], [SCAN.kneeY, "knee"], [SCAN.ankleY, "ankle"], [SCAN.floorY, "ankle"],
]

function along(keys: Key[], r: Ratios, y: number): number {
  const v = (k: RatioKey | 1) => (k === 1 ? 1 : r[k])
  if (y >= keys[0][0]) return v(keys[0][1])
  for (let i = 1; i < keys.length; i++) {
    const [ya, ka] = keys[i - 1], [yb, kb] = keys[i]
    if (y >= yb) {
      const t = (ya - y) / (ya - yb)
      return v(ka) + (v(kb) - v(ka)) * t
    }
  }
  return v(keys[keys.length - 1][1])
}

const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** How much of a point belongs to a hanging arm (0 = torso). */
export function armWeight(x: number, y: number): number {
  if (y < -0.55) return 0
  return smooth(SCAN.armX - 0.015, SCAN.armX + 0.02, Math.abs(x)) * smooth(SCAN.shoulderY + 0.1, SCAN.shoulderY, y)
}

/** Body + garments through the same warp keep their fit. `torsoOnly` keeps a
 *  skirt one tube instead of following each leg. */
export function warp(src: Float32Array, dst: Float32Array, r: Ratios, f: BodyFrame, torsoOnly = false) {
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2], b = f.bin(y)
    const cz = f.torsoZ[b]
    const kT = along(TORSO_KEYS, r, y)
    let nx = x * kT, nz = cz + (z - cz) * kT
    const aw = armWeight(x, y)
    if (aw > 0) {
      const acx = Math.sign(x) * SCAN.armCX
      nx += aw * (acx * kT + (x - acx) * r.arm - nx)
      nz += aw * (cz + (z - cz) * r.arm - nz)
    }
    if (!torsoOnly && y < SCAN.crotchY + 0.03) {
      const lw = smooth(SCAN.crotchY + 0.03, SCAN.crotchY - 0.05, y) * (1 - aw)
      const s = x < SCAN.legSplit ? 0 : 1
      const cx = f.legX[s][b], lz = f.legZ[s][b], kL = along(LEG_KEYS, r, y)
      nx += lw * (cx * r.hip + (x - cx) * kL - nx)
      nz += lw * (lz + (z - lz) * kL - nz)
    }
    dst[i] = nx
    dst[i + 1] = y > SCAN.waistY ? SCAN.waistY + (y - SCAN.waistY) * r.torsoLen : SCAN.waistY + (y - SCAN.waistY) * r.legLen
    dst[i + 2] = nz
  }
}

export function warpedFloor(r: Ratios) {
  return SCAN.waistY + (SCAN.floorY - SCAN.waistY) * r.legLen
}

// ---- fitting the scans to the pattern (scan space, before the warp) ----

/** Top: cut where the scan is whole all round, or at the pattern's hem if that's
 *  higher. The scans were shirts tucked into jeans, so the jeans left above the cut
 *  go and a longer pattern continues as a tube of the same cloth: it starts under
 *  the shirt (showing where the jeans were) and runs down to the pattern's hem. */
export function fitTop(
  pos: Float32Array, index: Uint32Array, uv: Float32Array, colourAt: (u: number, v: number) => [number, number, number],
  tucked: boolean, lengthCm: number, r: Ratios, f: BodyFrame,
): { pos: Float32Array; index: Uint32Array; cut: number; extension: Loft | null } {
  const clean = cleanHem(pos, index, f)
  const target = SCAN.hpsY - lengthCm / 100 / r.torsoLen
  const cut = Math.max(clean, target)
  const top = clipBelow(pos, index, cut, (x, y) => armWeight(x, y) < 0.5)
  const OVERLAP = 0.1
  if (tucked) top.index = untuck(top.pos, uv, top.index, cut + OVERLAP, colourAt)
  if (target > clean - 0.015) return { ...top, cut, extension: null }
  const from = tucked ? cut + OVERLAP : cut
  // the tube's opening: the shirt's outline at that height, a touch inside it
  const start = new Float32Array(ANG)
  for (let i = 0; i < top.pos.length; i += 3) {
    const x = top.pos[i], y = top.pos[i + 1], z = top.pos[i + 2]
    if (Math.abs(y - from) > 0.015 || armWeight(x, y) > 0.3) continue
    const cz = f.torsoZ[f.bin(y)], a = angBin(Math.atan2(z - cz, x))
    start[a] = Math.max(start[a], Math.hypot(x, z - cz) - 0.004)
  }
  for (let pass = 0; pass < 4; pass++)
    for (let a = 0; a < ANG; a++) if (!start[a]) start[a] = Math.max(start[(a + ANG - 1) % ANG], start[(a + 1) % ANG])
  return { ...top, cut, extension: bodyTube(from, target, f, { hemGirth: null, pencil: false, start }) }
}

/** Lowest level at which the torso part of a garment is intact all round. */
function cleanHem(pos: Float32Array, index: Uint32Array, f: BodyFrame): number {
  const BINS = 36, low = new Float32Array(BINS).fill(Infinity)
  for (let t = 0; t < index.length; t++) {
    const i = index[t] * 3, x = pos[i], y = pos[i + 1], z = pos[i + 2]
    if (y > SCAN.chestY || armWeight(x, y) > 0.3) continue
    const a = ((Math.round((Math.atan2(z - f.torsoZ[f.bin(y)], x) / (Math.PI * 2)) * BINS) % BINS) + BINS) % BINS
    low[a] = Math.min(low[a], y)
  }
  let clean = -Infinity
  for (const v of low) if (Number.isFinite(v)) clean = Math.max(clean, v)
  return Number.isFinite(clean) ? clean + 0.01 : SCAN.waistY
}

/** Shorts from trousers: triangles wholly below `minY` dropped and the corners
 *  of those crossing it lifted onto it, so the hem is a clean straight line. */
export function clipBelow(pos: Float32Array, index: Uint32Array, minY: number, applies: (x: number, y: number) => boolean = () => true): { pos: Float32Array; index: Uint32Array } {
  const out = pos.slice()
  const keep: number[] = []
  const below = (i: number) => pos[i * 3 + 1] < minY && applies(pos[i * 3], pos[i * 3 + 1])
  for (let t = 0; t < index.length; t += 3) {
    if (!below(index[t]) || !below(index[t + 1]) || !below(index[t + 2])) keep.push(index[t], index[t + 1], index[t + 2])
  }
  for (let i = 0; i < out.length; i += 3) if (below(i / 3)) out[i + 1] = minY
  return { pos: out, index: Uint32Array.from(keep) }
}

/** Cloth ease: every garment point moved `cm` further out from the body part it
 *  covers (torso, a leg or an arm), so the scan sits clear of the skin. A
 *  per-point `amount` (metres) does the same for relief. */
export function inflate(pos: Float32Array, cm: number, f: BodyFrame, amount?: (i: number) => number): Float32Array {
  const out = pos.slice()
  for (let i = 0; i < out.length; i += 3) {
    const d = amount ? amount(i / 3) : cm / 100
    if (!d) continue
    const x = out[i], y = out[i + 1], z = out[i + 2], b = f.bin(y)
    let cx = 0, cz = f.torsoZ[b]
    if (armWeight(x, y) > 0.5) cx = Math.sign(x) * SCAN.armCX
    else if (y < SCAN.crotchY - 0.02) {
      const side = x < SCAN.legSplit ? 0 : 1
      cx = f.legX[side][b]
      cz = f.legZ[side][b]
    }
    const dx = x - cx, dz = z - cz, r = Math.hypot(dx, dz)
    if (r < 1e-4) continue
    out[i] = x + (dx / r) * d
    out[i + 2] = z + (dz / r) * d
  }
  return out
}

/** The top scans were shirts tucked into jeans: triangles of denim-blue or
 *  belt-brown texels below `maxY` go (the extension tube under the shirt shows there). */
export function untuck(pos: Float32Array, uv: Float32Array, index: Uint32Array, maxY: number, colourAt: (u: number, v: number) => [number, number, number]): Uint32Array {
  const tucked = (i: number) => {
    if (pos[i * 3 + 1] > maxY || uv[i * 2] > 0.66) return false
    const [r, g, b] = colourAt(uv[i * 2], uv[i * 2 + 1])
    return (b - r > 30 && b > 75 && g > r) || (r > b + 12 && r > 55)
  }
  const keep: number[] = []
  for (let t = 0; t < index.length; t += 3) {
    const n = +tucked(index[t]) + +tucked(index[t + 1]) + +tucked(index[t + 2])
    if (n < 2) keep.push(index[t], index[t + 1], index[t + 2])
  }
  return Uint32Array.from(keep)
}

export function shortsHem(lengthCm: number, r: Ratios) {
  return SCAN.pantsTopY - lengthCm / 100 / r.legLen
}

export interface Loft {
  pos: Float32Array
  index: Uint32Array
}

function ringsToMesh(rings: number[][], seg: number): Loft {
  const pos = new Float32Array(rings.length * seg * 3)
  rings.forEach((ring, j) => pos.set(ring, j * seg * 3))
  const idx: number[] = []
  for (let j = 0; j < rings.length - 1; j++)
    for (let a = 0; a < seg; a++) {
      const p = j * seg + a, q = j * seg + ((a + 1) % seg), p2 = p + seg, q2 = q + seg
      idx.push(p, p2, q, q, p2, q2)
    }
  return { pos, index: Uint32Array.from(idx) }
}

/** Long sleeves: a tube down each arm from the scan's short sleeve to the wrist. */
export function sleeveLofts(top: Float32Array, body: Float32Array): Loft[] {
  const SEG = 24, out: Loft[] = []
  for (const side of [-1, 1]) {
    let end = Infinity
    for (let i = 0; i < top.length; i += 3) if (side * top[i] > 0.23 && top[i + 1] > -0.2) end = Math.min(end, top[i + 1])
    if (!Number.isFinite(end) || end < SCAN.wristY + 0.05) continue
    // starts up inside the short sleeve (hidden there) and comes out below it
    const startY = Math.min(end + 0.06, SCAN.shoulderY - 0.02)
    const rings: number[][] = []
    const steps = Math.ceil((startY - SCAN.wristY) / 0.015)
    let centre = { x: side * SCAN.armCX, z: 0 }
    for (let j = 0; j <= steps; j++) {
      const y = startY - ((startY - SCAN.wristY) * j) / steps
      const arm = slab(body, y, (x) => side * x > 0.19)
      if (arm.length) centre = mean(arm)
      const ease = 0.016 - 0.008 * (j / steps)
      const rad = radial(arm, centre, SEG).map((v) => v + ease)
      const ring: number[] = []
      for (let a = 0; a < SEG; a++) {
        const th = (a / SEG) * Math.PI * 2
        ring.push(centre.x + Math.cos(th) * rad[a], y, centre.z + Math.sin(th) * rad[a])
      }
      rings.push(ring)
    }
    out.push(ringsToMesh(rings, SEG))
  }
  return out
}

/** Skirt (or a dress's skirt): rings from the waist down, hugging the hips and
 *  hanging straight past the legs, flaring out to the pattern's hem width. */
export function skirtLoft(lengthCm: number, hemGirthCm: number | null, pencil: boolean, r: Ratios, f: BodyFrame, hemRatio?: number): Loft {
  const top = SCAN.waistY + 0.012
  return bodyTube(top, top - lengthCm / 100 / r.legLen, f, { hemGirth: hemGirthCm ? hemGirthCm / 100 / r.hip : null, pencil, hemRatio })
}

/** A tube of cloth around the body from `top` down to `hem` (scan space). `start`
 *  (radius per outline angle) is the opening it continues from, e.g. a top's hem. */
function bodyTube(top: number, hem: number, f: BodyFrame, opts: { hemGirth: number | null; pencil: boolean; start?: Float32Array; hemRatio?: number }): Loft {
  const SEG = ANG, pencil = opts.pencil
  const steps = Math.max(2, Math.ceil((top - hem) / 0.012))
  const radii: Float32Array[] = []
  const floors: Float32Array[] = [] // body + ease: no ring may sink below this
  let prev: Float32Array | null = null
  for (let j = 0; j <= steps; j++) {
    const y = top - ((top - hem) * j) / steps
    const ease = y > SCAN.hipY ? 0.008 + 0.012 * smooth(top, SCAN.hipY, y) : 0.02
    const ring = new Float32Array(SEG), floor = new Float32Array(SEG)
    for (let a = 0; a < SEG; a++) {
      const body = handBand(y) ? 0 : f.radius(y, (a / SEG) * Math.PI * 2)
      const hang = prev && y < SCAN.hipY ? prev[a] * (pencil ? 0.997 : 1) : 0
      floor[a] = body > 0 ? body + ease * 0.6 : 0
      ring[a] = Math.max(body > 0 ? body + ease : 0, hang)
    }
    floors.push(floor)
    // a gap left by the hand band / leg split: borrow from neighbours
    for (let a = 0; a < SEG; a++) if (!ring[a]) ring[a] = prev?.[a] || 0.15
    radii.push(ring)
    prev = ring
  }
  // the scan's outline is noisy from one centimetre to the next: smooth it around
  // and down, then hang straight again below the hips
  for (const ring of radii) {
    const src = ring.slice()
    for (let a = 0; a < SEG; a++) {
      let sum = 0
      for (let k = -3; k <= 3; k++) sum += src[(a + k + SEG) % SEG]
      ring[a] = sum / 7
    }
  }
  const raw = radii.map((r) => r.slice())
  for (let j = 0; j < radii.length; j++)
    for (let a = 0; a < SEG; a++) {
      let sum = 0, n = 0
      for (let k = -4; k <= 4; k++) {
        const r = raw[j + k]
        if (r) { sum += r[a]; n++ }
      }
      radii[j][a] = sum / n
    }
  for (let j = 1; j < radii.length; j++) {
    const y = top - ((top - hem) * j) / steps
    if (y < SCAN.hipY) for (let a = 0; a < SEG; a++) radii[j][a] = Math.max(radii[j][a], radii[j - 1][a] * (pencil ? 0.997 : 1))
  }
  // rows where the hands hide the thighs: floor interpolated between the rows around
  for (let j = 0; j < floors.length; j++) {
    if (floors[j].some((v) => v > 0)) continue
    let up = j - 1, dn = j + 1
    while (up >= 0 && !floors[up].some((v) => v > 0)) up--
    while (dn < floors.length && !floors[dn].some((v) => v > 0)) dn++
    if (up < 0 || dn >= floors.length) continue
    const t = (j - up) / (dn - up)
    for (let a = 0; a < SEG; a++) floors[j][a] = floors[up][a] * (1 - t) + floors[dn][a] * t
  }
  // floors smoothed around too (a single spiky vertex shouldn't dent the cloth)
  for (let j = 0; j < radii.length; j++)
    for (let a = 0; a < SEG; a++) {
      const fl = Math.max(floors[j][(a + SEG - 1) % SEG], floors[j][a], floors[j][(a + 1) % SEG])
      radii[j][a] = Math.max(radii[j][a], fl)
    }
  for (let j = 1; j < radii.length; j++) {
    const y = top - ((top - hem) * j) / steps
    if (y < SCAN.hipY) for (let a = 0; a < SEG; a++) radii[j][a] = Math.max(radii[j][a], radii[j - 1][a] * (pencil ? 0.997 : 1))
  }
  // the first rings ease out of the opening this tube continues
  if (opts.start) {
    const blend = Math.min(6, radii.length)
    for (let j = 0; j < blend; j++) {
      const t = j / blend
      for (let a = 0; a < SEG; a++) radii[j][a] = Math.max(radii[j][a], opts.start[a] * (1 - t) + radii[j][a] * t)
    }
  }
  // flare: hem girth from the pattern, growing in from the hips
  const hemRing = radii[radii.length - 1]
  let perim = 0
  for (let a = 0; a < SEG; a++) perim += hemRing[a] * ((Math.PI * 2) / SEG)
  // a sketch's hem/waist width ratio wins: the hem is that many waists round
  let waistPerim = 0
  for (let a = 0; a < SEG; a++) waistPerim += radii[0][a] * ((Math.PI * 2) / SEG)
  const want = opts.hemRatio ? waistPerim * opts.hemRatio : opts.hemGirth ?? perim
  const flare = pencil ? 1 : clamp(want / perim, 1, 2.6)
  const rings: number[][] = []
  radii.forEach((ring, j) => {
    const y = top - ((top - hem) * j) / steps
    const t = clamp((SCAN.hipY - y) / Math.max(0.05, SCAN.hipY - hem), 0, 1)
    const k = 1 + (flare - 1) * Math.pow(t, 1.3)
    const fold = Math.min(0.09, 0.22 * (flare - 1)) * t
    const cz = f.torsoZ[f.bin(y)]
    const pts: number[] = []
    for (let a = 0; a < SEG; a++) {
      const th = (a / SEG) * Math.PI * 2
      const rr = ring[a] * k * (1 + fold * (0.6 * Math.sin(th * 11 + 0.7) + 0.4 * Math.sin(th * 17 + 2.1)))
      pts.push(Math.cos(th) * rr, y, cz + Math.sin(th) * rr)
    }
    rings.push(pts)
  })
  return ringsToMesh(rings, SEG)
}

function slab(pos: Float32Array, y: number, keep: (x: number) => boolean, half = 0.007) {
  const pts: { x: number; z: number }[] = []
  for (let i = 0; i < pos.length; i += 3) if (Math.abs(pos[i + 1] - y) < half && keep(pos[i])) pts.push({ x: pos[i], z: pos[i + 2] })
  return pts
}

function mean(pts: { x: number; z: number }[]) {
  let x = 0, z = 0
  for (const p of pts) { x += p.x; z += p.z }
  return { x: x / pts.length, z: z / pts.length }
}

/** Max distance from `c` per angle bin; empty bins take their neighbours'. */
function radial(pts: { x: number; z: number }[], c: { x: number; z: number }, seg: number): number[] {
  const out = new Array(seg).fill(0)
  for (const p of pts) {
    const a = ((Math.round((Math.atan2(p.z - c.z, p.x - c.x) / (Math.PI * 2)) * seg) % seg) + seg) % seg
    out[a] = Math.max(out[a], Math.hypot(p.x - c.x, p.z - c.z))
  }
  const avg = out.filter((v) => v > 0)
  const base = avg.length ? avg.reduce((s, v) => s + v, 0) / avg.length : 0.04
  for (let pass = 0; pass < 3; pass++)
    for (let a = 0; a < seg; a++)
      if (!out[a]) out[a] = Math.max(out[(a + seg - 1) % seg], out[(a + 1) % seg]) || 0
  return out.map((v) => v || base)
}

// ---- T-pose: an upper garment is worn with the arms raised out to the sides,
// the pose its reconstruction (garment3d.py) is photographed in, so the sleeves
// wrap the arms instead of hanging over them ----

/** Shoulder joint (scan space, right side; the left mirrors it). */
export const SHOULDER = { x: 0.215, y: 0.13 }
export const TPOSE_DEG = 85

/** How much of a body point turns with its arm when raised (0 = torso, 1 = arm).
 *  Below the armpit arm and torso are apart (the cut sits in the gap between
 *  them); over the shoulder cap the turn fades out towards the neck. */
export function tposeWeight(x: number, y: number): number {
  if (y < -0.5 || y > 0.24) return 0
  const t = smooth(0, 0.08, y)
  return smooth(0.18 - 0.01 * t, 0.19 + 0.06 * t, Math.abs(x)) * smooth(0.22, 0.03, y)
}

/** Garment weights from the body under it: each point turns like its nearest
 *  skin point, so a sleeve goes with the arm and the side seam stays put. */
export function weightsByNearest(pos: Float32Array, body: Float32Array, bodyW: Float32Array): Float32Array {
  const C = 0.02, key = (i: number, j: number, k: number) => `${i},${j},${k}`
  const grid = new Map<string, number[]>()
  for (let v = 0; v < body.length / 3; v++) {
    const k = key(Math.floor(body[v * 3] / C), Math.floor(body[v * 3 + 1] / C), Math.floor(body[v * 3 + 2] / C))
    let cell = grid.get(k)
    if (!cell) grid.set(k, (cell = []))
    cell.push(v)
  }
  const out = new Float32Array(pos.length / 3)
  for (let v = 0; v < out.length; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2]
    if (y < -0.5 || y > 0.26) continue
    const ci = Math.floor(x / C), cj = Math.floor(y / C), ck = Math.floor(z / C)
    let best = Infinity, w = tposeWeight(x, y)
    for (let r = 1; r <= 3 && best === Infinity; r++)
      for (let i = -r; i <= r; i++)
        for (let j = -r; j <= r; j++)
          for (let k = -r; k <= r; k++)
            for (const b of grid.get(key(ci + i, cj + j, ck + k)) || []) {
              const d = (body[b * 3] - x) ** 2 + (body[b * 3 + 1] - y) ** 2 + (body[b * 3 + 2] - z) ** 2
              if (d < best) { best = d; w = bodyW[b] }
            }
    out[v] = w
  }
  return out
}

/** Raises the arms in place: each point turns `weight × deg` about its side's
 *  shoulder joint (`pivots`: right x, y then left x, y, in the same space as `pos`). */
export function poseArms(pos: Float32Array, weight: Float32Array, deg: number, pivots: [number, number, number, number]) {
  const rad = (deg * Math.PI) / 180
  for (let v = 0; v < weight.length; v++) {
    const w = weight[v]
    if (!w) continue
    const i = v * 3, x = pos[i], y = pos[i + 1]
    const right = x > 0, px = right ? pivots[0] : pivots[2], py = right ? pivots[1] : pivots[3]
    const a = (right ? 1 : -1) * w * rad, c = Math.cos(a), s = Math.sin(a)
    const dx = x - px, dy = y - py
    pos[i] = px + dx * c - dy * s
    pos[i + 1] = py + dx * s + dy * c
  }
}

/** A worn garment's sleeve angle (degrees from hanging straight down) and
 *  reach (shoulder joint to cuff), read off the points out past the shoulders. */
export function sleeveAngle(pieces: Float32Array[]): { deg: number; reach: number } | null {
  let sx = 0, sy = 0, n = 0, reach = 0
  for (const pos of pieces)
    for (let i = 0; i < pos.length; i += 3) {
      const ax = Math.abs(pos[i]), y = pos[i + 1]
      if (ax < 0.3 || y < -0.5) continue
      sx += ax; sy += y; n++
      reach = Math.max(reach, Math.hypot(ax - SHOULDER.x, y - SHOULDER.y))
    }
  if (n < 30) return null
  const deg = (Math.atan2(sx / n - SHOULDER.x, SHOULDER.y - sy / n) * 180) / Math.PI
  return { deg: clamp(deg, 30, 100), reach }
}
