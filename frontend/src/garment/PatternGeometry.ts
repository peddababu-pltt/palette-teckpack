// Pattern piece geometry: the true cutline polygon, unfolded where it's cut on the
// fold, split into labelled edges (neckline, shoulder, armhole, side, hem, cap...),
// and meshed into an even triangle mesh -- boundary resampled + interior lattice,
// Delaunay-triangulated -- so the cloth solver has real fabric to work with instead
// of a rectangle. All 2D maths in mm, y DOWN.
import type { EdgeKind, PieceEdge } from "./types"

type P = [number, number]

export function signedArea(r: P[]): number {
  let a = 0
  for (let i = 0; i < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]
    a += x1 * y2 - x2 * y1
  }
  return a / 2
}

export function bbox(r: P[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y) }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 }
}

/** Translate to a 0-origin box and make the winding consistent (positive area, y down). */
export function normalizeRing(ring: P[]): P[] {
  const b = bbox(ring)
  let r = ring.map(([x, y]) => [x - b.x0, y - b.y0] as P)
  if (signedArea(r) < 0) r = r.reverse()
  return r
}

export function pointInPolygon(p: P, r: P[]): boolean {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi || 1e-12) + xi) inside = !inside
  }
  return inside
}

function distToSeg(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const L = dx * dx + dy * dy || 1e-12
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

export function distToRing(p: P, r: P[]): number {
  let d = Infinity
  for (let i = 0; i < r.length; i++) d = Math.min(d, distToSeg(p, r[i], r[(i + 1) % r.length]))
  return d
}

/**
 * Unfold a half cut on a vertical fold line: reflect the non-fold outline across
 * the fold and join. Returns null when the fold isn't a vertical edge of the ring.
 */
export function unfold(ring: P[], fold: [P, P], allowHorizontal = false): { ring: P[]; centreX: number } | null {
  const [a, b] = fold
  if (Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1])) {
    if (!allowHorizontal) return null
    // horizontal fold line: unfold in transposed space, transpose back
    const t = unfold(ring.map(([x, y]) => [y, x] as P), [[a[1], a[0]], [b[1], b[0]]])
    return t ? { ring: normalizeRing(t.ring.map(([x, y]) => [y, x] as P)), centreX: NaN } : null
  }
  const bx = bbox(ring)
  const fx = Math.abs((a[0] + b[0]) / 2 - bx.x0) < Math.abs((a[0] + b[0]) / 2 - bx.x1) ? bx.x0 : bx.x1
  const on = ring.map(([x]) => Math.abs(x - fx) < 2.5)
  if (on.filter(Boolean).length < 2) return null
  // rotate so the fold run is contiguous at the end: find a non-fold -> fold transition
  const n = ring.length
  let start = -1
  for (let i = 0; i < n; i++) if (on[i] && !on[(i - 1 + n) % n]) { start = i; break }
  if (start < 0) return null
  let end = start
  while (on[(end + 1) % n] && (end + 1) % n !== start) end = (end + 1) % n
  // path from fold-run end, round the outside, back to fold-run start
  const path: P[] = []
  for (let k = 0, i = end; k < n; k++, i = (i + 1) % n) {
    path.push(ring[i])
    if (i === start) break
  }
  const mirrored = path.slice(1, -1).reverse().map(([x, y]) => [2 * fx - x, y] as P)
  const full = normalizeRing([...path, ...mirrored])
  const nb = bbox([...path, ...mirrored])
  return { ring: full, centreX: fx - nb.x0 }
}

/** True when the outline is mirror-symmetric about its vertical centre line (a full panel). */
export function isSymmetric(r: P[]): boolean {
  const b = bbox(r)
  const cx = (b.x0 + b.x1) / 2
  let worst = 0
  for (let i = 0; i < r.length; i += Math.max(1, Math.floor(r.length / 60))) {
    const m: P = [2 * cx - r[i][0], r[i][1]]
    worst = Math.max(worst, distToRing(m, r))
  }
  return worst < Math.max(4, b.w * 0.02)
}

/** Indices of sharp corners (turn > deg). */
export function corners(r: P[], deg = 35): number[] {
  const out: number[] = []
  const n = r.length
  const cosT = Math.cos((deg * Math.PI) / 180)
  for (let i = 0; i < n; i++) {
    const a = r[(i - 1 + n) % n], p = r[i], c = r[(i + 1) % n]
    const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [c[0] - p[0], c[1] - p[1]]
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1])
    if (!l1 || !l2) continue
    if ((v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2) < cosT) out.push(i)
  }
  return out
}

function segLen(r: P[], from: number, to: number) {
  let L = 0
  const n = r.length
  for (let i = from; i !== to; i = (i + 1) % n) {
    const j = (i + 1) % n
    L += Math.hypot(r[j][0] - r[i][0], r[j][1] - r[i][1])
  }
  return L
}

function segPoints(r: P[], from: number, to: number): P[] {
  const out: P[] = []
  const n = r.length
  for (let i = from; ; i = (i + 1) % n) {
    out.push(r[i])
    if (i === to) break
  }
  return out
}

interface Seg { from: number; to: number; pts: P[]; len: number; mid: P; chord: P; sag: number; vertical: boolean }

// The point halfway along a polyline (not its middle entry: a straight edge is just
// its two corners).
function halfway(pts: P[]): P {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    if (acc + l >= len / 2) {
      const t = l ? (len / 2 - acc) / l : 0
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]
    }
    acc += l
  }
  return pts[0]
}

function segments(r: P[]): Seg[] {
  let cs = corners(r)
  if (cs.length === 2) {
    // a two-corner shape (a curved collar stand): its two long sides are its edges
  } else if (cs.length < 3) {
    // smooth outline (a round piece): split into 4 by extremes
    const b = bbox(r)
    const pick = (f: (p: P) => number) => r.reduce((bi, p, i) => (f(p) < f(r[bi]) ? i : bi), 0)
    cs = [...new Set([pick((p) => p[1]), pick((p) => -p[0]), pick((p) => -p[1]), pick((p) => p[0])])].sort((x, y) => x - y)
    void b
  }
  const out: Seg[] = []
  for (let k = 0; k < cs.length; k++) {
    const from = cs[k], to = cs[(k + 1) % cs.length]
    const pts = segPoints(r, from, to)
    const len = segLen(r, from, to)
    const a = r[from], b = r[to]
    const chord: P = [b[0] - a[0], b[1] - a[1]]
    const cl = Math.hypot(chord[0], chord[1]) || 1
    const mid = halfway(pts)
    let sag = 0
    for (const p of pts) sag = Math.max(sag, distToSeg(p, a, b))
    out.push({ from, to, pts, len, mid, chord, sag: sag / cl, vertical: Math.abs(chord[1]) > Math.abs(chord[0]) })
  }
  return out
}

// Split a segment at vertex index k (ring index), keeping both halves' metrics.
function splitSeg(r: P[], s: Seg, k: number): Seg[] {
  const mk = (from: number, to: number): Seg => {
    const pts = segPoints(r, from, to)
    const a = r[from], b = r[to]
    const chord: P = [b[0] - a[0], b[1] - a[1]]
    const cl = Math.hypot(chord[0], chord[1]) || 1
    let sag = 0
    for (const p of pts) sag = Math.max(sag, distToSeg(p, a, b))
    return { from, to, pts, len: segLen(r, from, to), mid: halfway(pts), chord, sag: sag / cl, vertical: Math.abs(chord[1]) > Math.abs(chord[0]) }
  }
  if (k === s.from || k === s.to) return [s]
  return [mk(s.from, k), mk(k, s.to)]
}

// Dart: a very sharp corner whose tip points INTO the piece, between two short legs.
function dartTips(r: P[], segsIdx: number[], b: ReturnType<typeof bbox>): Set<number> {
  const tips = new Set<number>()
  const n = r.length
  for (const i of segsIdx) {
    const a = r[(i - 1 + n) % n], p = r[i], c = r[(i + 1) % n]
    const v1 = [a[0] - p[0], a[1] - p[1]], v2 = [c[0] - p[0], c[1] - p[1]]
    const l1 = Math.hypot(v1[0], v1[1]), l2 = Math.hypot(v2[0], v2[1])
    if (!l1 || !l2) continue
    const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2))))
    if (ang > (40 * Math.PI) / 180) continue
    // tip inside: the midpoint of the dart mouth is outside the piece (the V opens outward)
    const mouth: P = [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]
    if (!pointInPolygon(mouth, r) && Math.max(l1, l2) < b.h * 0.35) tips.add(i)
  }
  return tips
}

const PANEL = /^(bodice_front|bodice_back|side_panel|skirt_front|skirt_back|skirt_side|shoulder)$/
const TROUSER = /^(trouser_front|trouser_back|leg_panel)$/
const BAND = /^(waistband|cuff|collar|collar_stand|placket|belt|strap|tie|neckline)$/

/**
 * Label a piece's edges by category + geometry. `centre`: where the body centre line
 * is on this piece (full panel: x; half: which side; none).
 */
export function labelEdges(
  r: P[], category: string,
  centre: { kind: "full"; x: number } | { kind: "half"; side: "left" | "right" } | { kind: "none" },
): PieceEdge[] {
  const b = bbox(r)
  let segs = segments(r)
  const nx = (x: number) => (x - b.x0) / (b.w || 1)
  const ny = (y: number) => (y - b.y0) / (b.h || 1)
  // distance of x from the centre line, 0..1 (1 = outermost)
  const out = (x: number) => {
    if (centre.kind === "full") return Math.abs(x - centre.x) / Math.max(centre.x - b.x0, b.x1 - centre.x, 1)
    if (centre.kind === "half") return centre.side === "left" ? nx(x) : 1 - nx(x)
    return Math.abs(nx(x) - 0.5) * 2
  }
  const half = (x: number): "l" | "r" | "" => (centre.kind === "full" ? (x < centre.x ? "l" : "r") : "")
  // curve-into-straight transitions have no corner: split the outer contour of a
  // bodice at the underarm (widest point in the upper body) and a trouser leg's centre
  // contour at the crotch point (the point furthest toward the centre)
  const splitAtExtreme = (test: (s: Seg) => boolean, score: (p: P) => number, yMin: number, yMax: number) => {
    const next: Seg[] = []
    for (const s of segs) {
      if (!test(s)) { next.push(s); continue }
      let best = -Infinity, bi = -1
      const n = r.length
      for (let i = s.from; i !== s.to; i = (i + 1) % n) {
        const y = ny(r[i][1])
        if (y < yMin || y > yMax) continue
        const sc = score(r[i])
        if (sc > best) { best = sc; bi = i }
      }
      next.push(...(bi >= 0 ? splitSeg(r, s, bi) : [s]))
    }
    segs = next
  }
  if (/^(bodice_front|bodice_back|side_panel)$/.test(category)) {
    splitAtExtreme((s) => ny(r[s.from][1]) < 0.3 && ny(r[s.to][1]) > 0.5 && out(s.mid[0]) > 0.5, (p) => out(p[0]) - ny(p[1]) * 0.02, 0.12, 0.6)
    splitAtExtreme((s) => ny(r[s.to][1]) < 0.3 && ny(r[s.from][1]) > 0.5 && out(s.mid[0]) > 0.5, (p) => out(p[0]) - ny(p[1]) * 0.02, 0.12, 0.6)
  }
  if (/^sleeve/.test(category)) {
    // a sleeve's side runs from the top of the cap to the hem with no corner at the
    // underarm: split at its widest point
    const outX = (p: P) => Math.abs(nx(p[0]) - 0.5) * 2
    splitAtExtreme((s) => Math.abs(ny(r[s.from][1]) - ny(r[s.to][1])) > 0.6, outX, 0.15, 0.7)
  }
  if (TROUSER.test(category) && centre.kind === "half") {
    // the crotch point: furthest toward the centre, in the upper half of the leg
    splitAtExtreme((s) => out(s.mid[0]) < 0.6 && (ny(r[s.from][1]) < 0.35 || ny(r[s.to][1]) < 0.35) && Math.abs(ny(r[s.from][1]) - ny(r[s.to][1])) > 0.4, (p) => 1 - out(p[0]), 0.15, 0.5)
  }
  const tips = dartTips(r, corners(r, 60), b)
  const kinds: EdgeKind[] = segs.map((s) => {
    if (tips.has(s.from) || tips.has(s.to)) return "dart"
    if (/^skirt/.test(category) && !s.vertical && ny(s.mid[1]) < 0.25) return "waist"
    const my = ny(s.mid[1]), mo = out(s.mid[0])
    const horiz = !s.vertical
    if (/^skirt/.test(category)) {
      // a skirt has only waist, hem, centre and side seams -- its curved hip line is a
      // side seam, never an armhole
      if (horiz && my > 0.7) return "hem"
      if (horiz && my < 0.3) return "waist"
      if (s.vertical && mo < 0.15 && centre.kind === "half") return "center"
      return "side"
    }
    if (PANEL.test(category)) {
      if (horiz && my > 0.8) return "hem"
      if (s.vertical && mo < 0.12 && centre.kind === "half") return "center"
      const yLow = Math.max(ny(r[s.from][1]), ny(r[s.to][1]))
      // (a side panel never reaches the neck: its top is a piece of shoulder)
      if (category === "side_panel" && horiz && my < 0.15) return "shoulder"
      if (my < 0.3 && yLow < 0.35 && s.sag > 0.06 && mo < 0.55) return "neckline"
      if (my < 0.3 && s.sag <= 0.06 && horiz) return "shoulder"
      // curved, upper, outer: the armhole (checked before the straight side seam) --
      // or a straight raglan line running from the neckline down to the underarm
      if (s.sag > 0.04 && mo > 0.45 && my < 0.5) return "armhole"
      const yTop = Math.min(ny(r[s.from][1]), ny(r[s.to][1])), yBot = Math.max(ny(r[s.from][1]), ny(r[s.to][1]))
      if (mo > 0.35 && yTop < 0.2 && yBot < 0.65 && Math.abs(s.chord[0]) > b.w * 0.08) return "armhole"
      // the short top edge between two raglan lines is the neckline
      if (!s.vertical && my < 0.15) return "neckline"
      if (s.vertical && mo > 0.6 && my > 0.3) return "side"
      if (/skirt/.test(category) && horiz && my < 0.2) return "waist"
      if (horiz && my < 0.2) return "waist"
      return s.vertical && mo > 0.5 ? "side" : "unknown"
    }
    if (category === "sleeve" || category === "sleeve_left" || category === "sleeve_right") {
      if (horiz && my > 0.8) return "hem"
      // a raglan sleeve's short flat top (between its two raglan lines) is part of the
      // neckline
      const yTop = Math.min(ny(r[s.from][1]), ny(r[s.to][1]))
      const yEnd = Math.max(ny(r[s.from][1]), ny(r[s.to][1]))
      if (horiz && yEnd < 0.06 && s.len < b.w * 0.2) return "neckline"
      // anything that starts near the top (set-in cap or raglan lines) is the cap
      if (yTop < 0.3 && (my < 0.55 || s.sag > 0.05 || horiz)) return "cap"
      if (s.vertical) return "underarm"
      return "unknown"
    }
    if (category === "hood") {
      const strip = Math.max(b.w, b.h) > Math.min(b.w, b.h) * 4
      if (strip) return s.len > Math.max(b.w, b.h) * 0.6 ? "hood_back" : "band_end"
      if (horiz && my > 0.75) return "neckline" // bottom: sewn into the neckline
      if (s.sag > 0.03 || my < 0.5) return "hood_back" // curved back/top: to the centre strip
      return "hood_front" // straight face opening
    }
    if (TROUSER.test(category)) {
      if (horiz && my > 0.85) return "hem"
      if (horiz && my < 0.15) return "waist"
      const toCentre = centre.kind === "half" ? out(s.mid[0]) < 0.5 : false
      const yTop = Math.min(ny(r[s.from][1]), ny(r[s.to][1])), yBot = Math.max(ny(r[s.from][1]), ny(r[s.to][1]))
      // the crotch curve runs from the waist down to the crotch point (high on a
      // trouser leg, low on shorts); the inseam from there to the hem
      if (toCentre && (yBot < 0.4 || (yTop < 0.2 && yBot < 0.85))) return "crotch"
      if (toCentre) return "inseam"
      return "outseam"
    }
    if (category === "yoke") {
      if (horiz && my > 0.55) return "yoke_back"
      if (horiz && my < 0.45 && s.sag > 0.04) return "neckline"
      // the sloped shoulder line joins the front; the steep bit below the shoulder
      // point is part of the armhole
      return s.vertical ? "armhole" : "yoke_front"
    }
    if (BAND.test(category)) {
      const long = s.len > Math.max(b.w, b.h) * 0.6
      return long ? "band_free" : "band_end"
    }
    return "attach"
  })
  // bands: the long edge nearest the bottom (or the right, for standing strips) attaches
  if (BAND.test(category)) {
    const longs = segs.map((s, i) => ({ s, i })).filter(({ i }) => kinds[i] === "band_free")
    if (longs.length) {
      const standing = b.h > b.w
      const pick = longs.reduce((best, cur) =>
        (standing ? cur.s.mid[0] > best.s.mid[0] : cur.s.mid[1] > best.s.mid[1]) ? cur : best)
      kinds[pick.i] = "attach"
    }
    // the longest edge other than the attach edge is the free edge (a collar stand's
    // top, where the collar sews on) -- even when it's curved and short-looking
    if (!kinds.includes("band_free")) {
      let bi = -1
      segs.forEach((s, i) => { if (kinds[i] !== "attach" && (bi < 0 || s.len > segs[bi].len)) bi = i })
      if (bi >= 0) kinds[bi] = "band_free"
    }
  }
  // raglan bodice: the armhole lines run up to the neck, so a top edge between two
  // of them is the neckline, not a shoulder
  if (PANEL.test(category) && category !== "side_panel") {
    const armTop = segs.map((s, i) => ({ s, i })).filter(({ i }) => kinds[i] === "armhole")
      .filter(({ s }) => Math.min(ny(r[s.from][1]), ny(r[s.to][1])) < 0.12)
    if (armTop.length >= 1) {
      segs.forEach((s, i) => {
        // (only an edge reaching the centre line: a real shoulder starts at the neck
        // point, away from it -- e.g. a front under a yoke, whose armhole also runs up
        // to the top)
        if (kinds[i] === "shoulder" && Math.max(ny(r[s.from][1]), ny(r[s.to][1])) < 0.15 &&
          Math.min(...s.pts.map((q) => out(q[0]))) < 0.12) kinds[i] = "neckline"
      })
    }
  }
  // a tiny unlabelled piece of outline between two same-kind edges (a notch, a hip
  // corner) belongs to them
  const perim = segs.reduce((a, s) => a + s.len, 0)
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== "unknown" || segs[i].len > perim * 0.04) continue
    const prev = kinds[(i - 1 + kinds.length) % kinds.length], next = kinds[(i + 1) % kinds.length]
    if (prev === next && prev !== "dart") kinds[i] = prev
  }
  // merge consecutive same-kind segments (a cap split by a notch, a curved hem)
  const edges: PieceEdge[] = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    const h = half(s.mid[0])
    const last = edges[edges.length - 1]
    if (last && last.kind === kinds[i] && kinds[i] !== "dart" && last.half === h && last.to === s.from) {
      last.to = s.to
      last.length += s.len
      continue
    }
    edges.push({ id: edges.length, kind: kinds[i], from: s.from, to: s.to, length: s.len, half: h })
  }
  // wrap-around merge
  if (edges.length > 1) {
    const f = edges[0], l = edges[edges.length - 1]
    if (f.kind === l.kind && f.kind !== "dart" && f.half === l.half && l.to === f.from) {
      f.from = l.from
      f.length += l.length
      edges.pop()
    }
  }
  edges.forEach((e, i) => (e.id = i))
  return edges
}

/** Which side of a half panel is its centre edge: the side whose cutline starts higher. */
export function centreSideFromShape(r: P[], category: string): { side: "left" | "right"; sure: boolean } {
  const b = bbox(r)
  const topAt = (fx: number) => {
    const x = b.x0 + fx * b.w
    let best = Infinity
    for (let i = 0; i < r.length; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[(i + 1) % r.length]
      if ((x1 - x) * (x2 - x) <= 0 && x1 !== x2) {
        const y = y1 + ((y2 - y1) * (x - x1)) / (x2 - x1)
        best = Math.min(best, y)
      }
    }
    return best
  }
  const l = topAt(0.06), rr = topAt(0.94)
  const trouser = TROUSER.test(category)
  // bodice: centre starts at the neckline, above the underarm side; trouser: the
  // crotch point on the centre side sits LOWER than the waist corner
  const leftIsCentre = trouser ? l > rr : l < rr
  return { side: leftIsCentre ? "left" : "right", sure: Math.abs(l - rr) > b.h * 0.04 }
}

// ---------------- meshing ----------------

export interface Mesh2D {
  pos: Float32Array // x,y mm (y down), per vertex
  tris: Uint32Array
  boundary: number[] // vertex indices around the outline, in ring order
  /** ring vertex index -> mesh vertex index (corners and every ring point kept) */
  ringToVert: Map<number, number>
  /** per edge id: mesh vertex indices along it, from -> to */
  edgeVerts: Map<number, number[]>
}

function circum(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-12) return null
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  return { x: ux, y: uy, r2: (ax - ux) ** 2 + (ay - uy) ** 2 }
}

/** Bowyer-Watson Delaunay triangulation. */
function delaunay(pts: P[]): number[] {
  const b = bbox(pts)
  const s = Math.max(b.w, b.h) * 20
  const all: P[] = [...pts, [b.x0 - s, b.y0 - s], [b.x0 + 2 * s, b.y0 - s], [b.x0 - s, b.y0 + 2 * s]]
  const N = pts.length
  type T = { a: number; b: number; c: number; cc: { x: number; y: number; r2: number } }
  const mk = (a: number, bb: number, c: number): T | null => {
    const cc = circum(all[a][0], all[a][1], all[bb][0], all[bb][1], all[c][0], all[c][1])
    return cc ? { a, b: bb, c, cc } : null
  }
  let tris: T[] = [mk(N, N + 1, N + 2)!]
  for (let i = 0; i < N; i++) {
    const [px, py] = all[i]
    const bad: T[] = [], keep: T[] = []
    for (const t of tris) ((px - t.cc.x) ** 2 + (py - t.cc.y) ** 2 < t.cc.r2 ? bad : keep).push(t)
    const edgeCount = new Map<string, [number, number]>()
    for (const t of bad) {
      for (const [u, v] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
        const k = u < v ? `${u},${v}` : `${v},${u}`
        if (edgeCount.has(k)) edgeCount.delete(k)
        else edgeCount.set(k, [u, v])
      }
    }
    tris = keep
    for (const [u, v] of edgeCount.values()) {
      const t = mk(u, v, i)
      if (t) tris.push(t)
    }
  }
  const out: number[] = []
  for (const t of tris) if (t.a < N && t.b < N && t.c < N) out.push(t.a, t.b, t.c)
  return out
}

/**
 * Even cloth mesh of a piece: every ring point kept (so labelled edges map to mesh
 * vertices), long straight runs subdivided to `spacing`, a triangular lattice inside.
 */
export function meshPiece(ring: P[], edges: PieceEdge[], spacing: number): Mesh2D {
  const pts: P[] = []
  const boundary: number[] = []
  const ringToVert = new Map<number, number>()
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n]
    ringToVert.set(i, pts.length)
    boundary.push(pts.length)
    pts.push(a)
    const L = Math.hypot(c[0] - a[0], c[1] - a[1])
    const k = Math.floor(L / spacing)
    for (let j = 1; j < k; j++) {
      boundary.push(pts.length)
      pts.push([a[0] + ((c[0] - a[0]) * j) / k, a[1] + ((c[1] - a[1]) * j) / k])
    }
  }
  // drop near-duplicate boundary points (dense curve flattening)
  const nb = pts.length
  const b = bbox(ring)
  const hStep = (spacing * Math.sqrt(3)) / 2
  for (let row = 0, y = b.y0 + spacing / 2; y < b.y1; y += hStep, row++) {
    for (let x = b.x0 + (row % 2 ? spacing / 2 : 0); x < b.x1; x += spacing) {
      const p: P = [x, y]
      if (pointInPolygon(p, ring) && distToRing(p, ring) > spacing * 0.55) pts.push(p)
    }
  }
  const raw = delaunay(pts)
  const tris: number[] = []
  for (let t = 0; t < raw.length; t += 3) {
    const A = pts[raw[t]], B = pts[raw[t + 1]], C = pts[raw[t + 2]]
    const cen: P = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3]
    if (!pointInPolygon(cen, ring)) continue
    // an edge between two boundary points must lie inside (concave corners)
    let ok = true
    for (const [u, v] of [[raw[t], raw[t + 1]], [raw[t + 1], raw[t + 2]], [raw[t + 2], raw[t]]]) {
      if (u < nb && v < nb) {
        const m: P = [(pts[u][0] + pts[v][0]) / 2, (pts[u][1] + pts[v][1]) / 2]
        if (!pointInPolygon(m, ring) && distToRing(m, ring) > spacing * 0.15) { ok = false; break }
      }
    }
    if (ok) tris.push(raw[t], raw[t + 1], raw[t + 2])
  }
  const edgeVerts = new Map<number, number[]>()
  for (const e of edges) {
    const a = ringToVert.get(e.from)!, z = ringToVert.get(e.to)!
    const ai = boundary.indexOf(a), zi = boundary.indexOf(z)
    const list: number[] = []
    for (let i = ai; ; i = (i + 1) % boundary.length) {
      list.push(boundary[i])
      if (i === zi) break
    }
    edgeVerts.set(e.id, list)
  }
  const pos = new Float32Array(pts.length * 2)
  pts.forEach(([x, y], i) => { pos[i * 2] = x; pos[i * 2 + 1] = y })
  return { pos, tris: new Uint32Array(tris), boundary, ringToVert, edgeVerts }
}


/**
 * Move the shared vertex of two consecutive edges (e1.to === e2.from) so that e2 gets
 * `targetLen2` mm of their combined outline (used to put a trouser back's crotch
 * point where its inseam matches the front's). Returns false when not applicable.
 */
export function resplit(r: P[], edges: PieceEdge[], e1: PieceEdge, e2: PieceEdge, targetLen2: number): boolean {
  if (e1.to !== e2.from) return false
  const n = r.length
  const total = e1.length + e2.length
  if (targetLen2 <= 0 || targetLen2 >= total) return false
  // walk from e2.to backwards until targetLen2 is covered
  let acc = 0, i = e2.to
  while (i !== e1.from) {
    const j = (i - 1 + n) % n
    const d = Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1])
    if (acc + d >= targetLen2) { i = j; break }
    acc += d
    i = j
  }
  e1.to = i
  e2.from = i
  e1.length = segLen(r, e1.from, i)
  e2.length = segLen(r, i, e2.to)
  void edges
  return true
}

/** Split edge `e` at `len` mm from its start into two edges; returns the new pair. */
export function splitEdge(r: P[], edges: PieceEdge[], e: PieceEdge, len: number): [PieceEdge, PieceEdge] | null {
  const n = r.length
  let acc = 0, i = e.from
  while (i !== e.to) {
    const j = (i + 1) % n
    const d = Math.hypot(r[j][0] - r[i][0], r[j][1] - r[i][1])
    if (acc + d >= len) { i = j; break }
    acc += d
    i = j
  }
  if (i === e.from || i === e.to) return null
  const a: PieceEdge = { ...e, to: i, length: segLen(r, e.from, i) }
  const b: PieceEdge = { ...e, from: i, length: segLen(r, i, e.to) }
  const k = edges.indexOf(e)
  edges.splice(k, 1, a, b)
  edges.forEach((x, idx) => (x.id = idx))
  return [a, b]
}

/** Max deviation of an edge from its chord, relative to the chord (0 = straight). */
export function edgeSag(r: P[], e: PieceEdge): number {
  const pts = segPoints(r, e.from, e.to)
  const a = r[e.from], b = r[e.to]
  const cl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
  let m = 0
  for (const p of pts) m = Math.max(m, distToSeg(p, a, b))
  return m / cl
}