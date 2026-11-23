// custom-block.mjs — body pieces for garments the catalogue doesn't have, drafted
// from a real pattern block instead of free-hand AI coordinates.
//
// The AI used to return every piece's outline as raw points. Vision models can't
// draft geometry: fronts came back with no neckline, backs as plain rectangles with
// no armhole, sleeves whose cap didn't fit the armhole. Now the AI only describes
// the CONSTRUCTION (opening, yokes, length, hem shape, sleeve, cuffs, bands), and the
// body comes from freesewing's own blocks -- Brian (upper body: front, back, sleeve)
// and Titan (trousers: front, back leg) -- drafted to the measurements, then cut and
// shaped by the style lines. Pieces that sew onto the body (collar, stand, cuffs,
// bands, facings, linings, interfacings) are sized from the drafted seams so they
// actually fit. Only free-standing small pieces (pockets, flaps, tabs, hoods...)
// keep the AI's own outline.
//
// All geometry in mm, y down, matching freesewing's metric output.
import { Brian } from '@freesewing/brian'
import { Titan } from '@freesewing/titan'
import { flattenPath } from './svg-flatten.mjs'

export { Brian, Titan }

const ON = 0.6 // mm: a point this close to x = 0 sits on the centre line
const SLEEVE_FRACTION = { long: 1, three_quarter: 0.72, elbow: 0.52, short: 0.3, sleeveless: 0 }

// ---------------------------------------------------------------- geometry

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const bbox = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}
const translate = (pts, dx, dy) => pts.map(([x, y]) => [x + dx, y + dy])
const toOrigin = (pts) => { const b = bbox(pts); return translate(pts, -b.minX, -b.minY) }

function dedupe(pts) {
  const out = []
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) > 0.05) out.push(p)
  if (out.length > 2 && dist(out[0], out[out.length - 1]) < 0.05) out.pop()
  return out
}

function nearestIdx(pts, p) {
  let best = 0, d = Infinity
  pts.forEach((q, i) => { const e = dist(q, p); if (e < d) { d = e; best = i } })
  return best
}

/** Length along the outline between the points nearest a and b (the shorter way round). */
export function arcLen(pts, a, b) {
  const n = pts.length
  let i = nearestIdx(pts, a), j = nearestIdx(pts, b)
  const walk = (s, e) => { let L = 0; for (let k = s; k !== e; k = (k + 1) % n) L += dist(pts[k], pts[(k + 1) % n]); return L }
  return Math.min(walk(i, j), walk(j, i))
}

/** Keeps the part of the polygon above (y <= cut) or below the horizontal line y = cut. */
export function clipY(pts, cut, keepAbove) {
  const inside = (p) => (keepAbove ? p[1] <= cut : p[1] >= cut)
  const out = []
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    const ia = inside(a), ib = inside(b)
    if (ia) out.push(a)
    if (ia !== ib) {
      const t = (cut - a[1]) / (b[1] - a[1])
      out.push([a[0] + (b[0] - a[0]) * t, cut])
    }
  }
  return dedupe(out)
}

/** Stretches (or shrinks) everything below y0 so the lowest point lands on newBottom. */
function stretchBelow(pts, y0, newBottom) {
  const oldBottom = bbox(pts).maxY
  if (oldBottom - y0 < 1) return pts
  const k = (newBottom - y0) / (oldBottom - y0)
  return pts.map(([x, y]) => (y > y0 ? [x, y0 + (y - y0) * k] : [x, y]))
}

/** Replaces the straight hem (the bottom edge) with a shirt-tail curve rising `drop`
 *  mm towards the side seam; the centre line end stays at full length. */
function curveHem(pts, drop) {
  const { maxY } = bbox(pts)
  const n = pts.length
  const onHem = pts.map((p) => maxY - p[1] < 1)
  // the hem run: consecutive bottom points (cyclic)
  let start = onHem.findIndex((v, i) => v && !onHem[(i - 1 + n) % n])
  if (start < 0) return pts
  let end = start
  while (onHem[(end + 1) % n] && (end + 1) % n !== start) end = (end + 1) % n
  const a = pts[start], b = pts[end]
  const cx = Math.abs(a[0]) < Math.abs(b[0]) ? a[0] : b[0] // the centre-line end
  const sx = cx === a[0] ? b[0] : a[0]
  const span = sx - cx || 1
  const curveY = (x) => maxY - drop * Math.pow(Math.max(0, (x - cx) / span), 2.2)
  const steps = 16
  const curve = []
  for (let k = 0; k <= steps; k++) {
    const x = a[0] + ((b[0] - a[0]) * k) / steps
    curve.push([x, curveY(x)])
  }
  // the side seam now ends at the lifted corner: drop its points that hang below it
  const corner = maxY - drop
  const rebuilt = []
  for (let k = 0; k < n; k++) {
    if (onHem[k]) {
      if (k === start) rebuilt.push(...curve)
      continue
    }
    const p = pts[k]
    if (p[1] > corner + 0.5 && Math.abs(p[0] - sx) < 40) continue
    rebuilt.push(p)
  }
  return dedupe(rebuilt)
}

/** Reorders a piece cut on the fold so its first edge is the fold line (x = 0),
 *  collapsing the points along it into one straight edge. */
function foldFirst(pts) {
  const n = pts.length
  const on = pts.map((p) => Math.abs(p[0]) < ON)
  let start = on.findIndex((v, i) => v && !on[(i - 1 + n) % n])
  if (start < 0) return pts
  let end = start
  while (on[(end + 1) % n] && (end + 1) % n !== start) end = (end + 1) % n
  // edge 0 = the whole run along x = 0, then the rest of the outline in its own order
  const rest = []
  for (let k = (end + 1) % n; k !== start; k = (k + 1) % n) rest.push(pts[k])
  return dedupe([[0, pts[start][1]], [0, pts[end][1]], ...rest])
}

/** Adds a button stand: the centre front moves out by w (pieces then start at x = 0 again). */
function extendCentre(pts, w) {
  return toOrigin(pts.map(([x, y]) => (Math.abs(x) < ON ? [-w, y] : [x, y])))
}

function seamPts(part) {
  const d = part.paths?.seam?.asPathstring?.()
  if (!d) return null
  return dedupe(flattenPath(d)[0] || [])
}

const P = (part, name) => (part.points[name] ? [part.points[name].x, part.points[name].y] : null)


// ---------------------------------------------------------------- raglan

// Points along the outline from index i to index j, the shorter way round.
function pathBetween(pts, i, j) {
  const n = pts.length
  const fwd = [], back = []
  for (let k = i; ; k = (k + 1) % n) { fwd.push(pts[k]); if (k === j) break }
  for (let k = i; ; k = (k - 1 + n) % n) { back.push(pts[k]); if (k === j) break }
  const len = (path) => path.slice(1).reduce((a, p, k) => a + dist(path[k], p), 0)
  return len(fwd) <= len(back) ? fwd : back
}
// The complementary way round: from i to j NOT passing through `avoid`.
function pathAvoiding(pts, i, j, avoid) {
  const n = pts.length
  for (const step of [1, -1]) {
    const path = []
    let hit = false
    for (let k = i; ; k = (k + step + n) % n) {
      path.push(pts[k])
      if (k === avoid && k !== i && k !== j) hit = true
      if (k === j) break
    }
    if (!hit) return path
  }
  return null
}
const polyLen = (path) => path.slice(1).reduce((a, p, k) => a + dist(path[k], p), 0)
// The path cut at length d: the points up to there plus the interpolated end point.
function cutAt(path, d) {
  const out = [path[0]]
  let run = 0
  for (let k = 1; k < path.length; k++) {
    const seg = dist(path[k - 1], path[k])
    if (run + seg >= d) {
      const t = seg ? (d - run) / seg : 0
      out.push([path[k - 1][0] + (path[k][0] - path[k - 1][0]) * t, path[k - 1][1] + (path[k][1] - path[k - 1][1]) * t])
      return out
    }
    run += seg
    out.push(path[k])
  }
  return out
}

const RAGLAN_NECK_MM = { front: 30, back: 25 } // raglan line starts this far down the neckline from the HPS
const RAGLAN_ARMHOLE_FRAC = 0.4                // ...and meets the armhole this far up from the underarm

// Cuts the shoulder off a body block along a raglan line (neckline -> armhole).
// Returns the new body outline plus the raglan seam length (raglan line + the
// armhole below it) and the neck length the sleeve takes over.
function raglanBody(pts, neckPt, hpsPt, shoulderPt, underarmPt, neckMm) {
  const iNeck = nearestIdx(pts, neckPt), iHps = nearestIdx(pts, hpsPt)
  const iSh = nearestIdx(pts, shoulderPt), iArm = nearestIdx(pts, underarmPt)
  const neck = pathBetween(pts, iNeck, iHps)        // centre neck -> HPS
  const arm = pathBetween(pts, iArm, iSh)           // underarm -> shoulder point
  const side = pathAvoiding(pts, iArm, iNeck, iHps) // underarm -> side -> hem -> centre -> centre neck
  if (!side || neck.length < 2 || arm.length < 2) return null
  const neckLen = polyLen(neck)
  const taken = Math.min(neckMm, neckLen * 0.6)
  const neckKeep = cutAt(neck, neckLen - taken)     // centre neck -> raglan neck point N
  const armKeep = cutAt(arm, polyLen(arm) * RAGLAN_ARMHOLE_FRAC) // underarm -> raglan armhole point A
  const N = neckKeep[neckKeep.length - 1], A = armKeep[armKeep.length - 1]
  const outline = dedupe([...armKeep.slice().reverse(), ...side.slice(1), ...neckKeep.slice(1)])
  // the raglan seam as sewn: N -> A, then down the armhole to the underarm
  const seamPath = [N, ...armKeep.slice().reverse()]
  return { outline, seamPath, seam: polyLen(seamPath), chord: dist(N, underarmPt), neckTaken: taken }
}

// Lays a body raglan seam path (N ... underarm) onto the sleeve between `from`
// and `to`: rotated so its ends land there, and flipped so its curve bulges OUT of
// the sleeve -- the sleeve's edge is then exactly as long as the body's seam.
function placeSeam(path, from, to, inside) {
  const [p0, pn] = [path[0], path[path.length - 1]]
  const a0 = Math.atan2(pn[1] - p0[1], pn[0] - p0[0]), a1 = Math.atan2(to[1] - from[1], to[0] - from[0])
  const place = (flip) => path.map(([x, y]) => {
    let dx = x - p0[0], dy = y - p0[1]
    // into the chord's frame, optionally mirror across it, then onto the sleeve
    const u = dx * Math.cos(-a0) - dy * Math.sin(-a0)
    let v = dx * Math.sin(-a0) + dy * Math.cos(-a0)
    if (flip) v = -v
    return [from[0] + u * Math.cos(a1) - v * Math.sin(a1), from[1] + u * Math.sin(a1) + v * Math.cos(a1)]
  })
  // which side of the chord the curve sits on, vs the sleeve's inside
  const side = (pts) => {
    const [ex, ey] = [to[0] - from[0], to[1] - from[1]]
    const cross = (q) => ex * (q[1] - from[1]) - ey * (q[0] - from[0])
    return Math.sign(pts.reduce((acc, q) => acc + cross(q), 0)) * Math.sign(cross(inside))
  }
  const a = place(false)
  return side(a) > 0 ? place(true) : a
}

// A one-piece raglan sleeve whose two raglan edges are the body's raglan seams
// laid on it (same length, same curve, mirrored): top edge = the neck the body
// gave up, underarm points at the block's bicep width, then the arm to the hem.
// Front edge on +x.
function raglanSleeve({ front, back, frontNeck, backNeck, bicep, hemW, lengthMm }) {
  const cf = front.chord, cb = back.chord
  const width = (h) => frontNeck + backNeck + Math.sqrt(Math.max(0, cf ** 2 - h ** 2)) + Math.sqrt(Math.max(0, cb ** 2 - h ** 2))
  // cap height: the one at which the sleeve is bicep wide at the underarm
  let lo = 0, hi = Math.min(cf, cb)
  for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (width(mid) > bicep) lo = mid; else hi = mid }
  const capH = Math.max(lo, Math.min(cf, cb) * 0.35)
  const xf = frontNeck + Math.sqrt(Math.max(0, cf ** 2 - capH ** 2))
  const xb = -(backNeck + Math.sqrt(Math.max(0, cb ** 2 - capH ** 2)))
  const cx = (xf + xb) / 2
  const bottom = Math.max(capH + 40, lengthMm)
  const inside = [cx, capH + 10]
  const frontEdge = placeSeam(front.seamPath, [frontNeck, 0], [xf, capH], inside)
  const backEdge = placeSeam(back.seamPath, [-backNeck, 0], [xb, capH], inside).reverse()
  const outline = dedupe([[-backNeck, 0], ...frontEdge.map((p, k) => (k === 0 ? [frontNeck, 0] : p)),
    [cx + hemW / 2, bottom], [cx - hemW / 2, bottom], ...backEdge.slice(0, -1)])
  return { outline: toOrigin(outline), capH }
}

// ---------------------------------------------------------------- construction

export function normalizeConstruction(raw, attrs) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, lo, hi, d) => (Number.isFinite(+v) && +v >= lo && +v <= hi ? +v : d)
  const pick = (v, list, d) => (list.includes(v) ? v : d)
  const closure = attrs?.closure
  return {
    body: pick(c.body, ['upper', 'lower', 'none'], 'upper'),
    frontOpening: pick(c.frontOpening, ['zip', 'button', 'snap', 'none'],
      closure === 'zipper' ? 'zip' : closure === 'button' ? 'button' : closure === 'snap' ? 'snap' : 'none'),
    buttonStandCm: num(c.buttonStandCm, 0, 6, closure === 'button' || closure === 'snap' ? 1.8 : 0),
    backYokeCm: num(c.backYokeCm, 0, 30, 0),
    frontYokeCm: num(c.frontYokeCm, 0, 30, 0),
    bodyLengthCm: num(c.bodyLengthCm, 25, 140, 0), // 0 = the block's own length
    hem: pick(c.hem, ['straight', 'curved'], 'straight'),
    hemDropCm: num(c.hemDropCm, 0, 20, 6),
    hemBandCm: num(c.hemBandCm, 0, 20, 0),
    sleeve: pick(c.sleeve, ['setin', 'raglan', 'dropped', 'none'], attrs?.sleeveLength === 'sleeveless' ? 'none' : 'setin'),
    sleeveLengthCm: num(c.sleeveLengthCm, 5, 95, 0), // 0 = from attrs.sleeveLength
    cuffDepthCm: num(c.cuffDepthCm, 0, 25, attrs?.cuffs && attrs.cuffs !== 'none' ? (attrs.cuffWidthCm || 6) : 0),
    legLengthCm: num(c.legLengthCm, 10, 130, 0), // 0 = full length
    waistbandCm: num(c.waistbandCm, 0, 15, 0),
  }
}

// Body pieces + the drafted seam lengths the attached pieces are sized from.
export function draftBlock(cm, attrs, construction, options = {}) {
  const c = construction
  const mm = Object.fromEntries(Object.entries(cm).map(([k, v]) => [k, k === 'shoulderSlope' ? v : v * 10]))
  const pieces = []
  const seams = {}
  const notes = []
  if (c.body === 'upper') draftUpper(mm, cm, attrs, c, options, pieces, seams, notes)
  else if (c.body === 'lower') draftLower(mm, cm, c, options, pieces, seams, notes)
  return { pieces, seams, notes }
}

function draftUpper(mm, cm, attrs, c, options, pieces, seams, notes) {
  const pattern = new Brian({ measurements: mm, options, units: 'metric', sa: 0 })
  pattern.draft()
  const parts = pattern.parts[0]
  const front = parts['brian.front'], back = parts['brian.back']
  const sleevePart = Object.entries(parts).find(([k]) => /sleeve$/.test(k))?.[1]
  let f = seamPts(front), b = seamPts(back)
  if (!f || !b) throw new Error('block draft produced no front/back')

  const hps = P(back, 'hps'), waist = P(back, 'waist') || P(back, 'cbWaist')
  const armhole = P(back, 'armhole'), shoulder = P(back, 'shoulder')
  const bandMm = c.hemBandCm * 10
  if (c.bodyLengthCm > 0) {
    const target = hps[1] + c.bodyLengthCm * 10 - bandMm
    f = stretchBelow(f, waist[1], target)
    b = stretchBelow(b, waist[1], target)
  } else if (bandMm > 0) {
    const bottom = bbox(b).maxY - bandMm
    f = stretchBelow(f, waist[1], bottom)
    b = stretchBelow(b, waist[1], bottom)
  }
  if (c.hem === 'curved' && c.hemDropCm > 0 && bandMm === 0) {
    f = curveHem(f, c.hemDropCm * 10)
    b = curveHem(b, c.hemDropCm * 10)
  }

  // seam lengths, measured on the full block before any yoke split
  const frontNeck = arcLen(f, P(front, 'cfNeck'), P(front, 'hps'))
  const backNeck = arcLen(b, P(back, 'cbNeck'), P(back, 'hps'))
  seams.neck = 2 * (frontNeck + backNeck)
  const fb = bbox(f)
  seams.cfLength = fb.maxY - P(front, 'cfNeck')[1]
  const hemWidth = (pts) => { const bb = bbox(pts); return Math.max(...pts.filter((p) => bb.maxY - p[1] < 60).map((p) => p[0])) - bb.minX }
  seams.hem = 2 * (hemWidth(f) + hemWidth(b))

  // Raglan: the shoulder comes off the body along a line from the neckline to the
  // armhole and becomes the top of the sleeve (raglanSleeve below). Without this the
  // body kept a full set-in shoulder the garment doesn't have.
  let raglan = null
  if (c.sleeve === 'raglan') {
    const rf = raglanBody(f, P(front, 'cfNeck'), P(front, 'hps'), P(front, 'shoulder'), P(front, 'armhole'), RAGLAN_NECK_MM.front)
    const rb = raglanBody(b, P(back, 'cbNeck'), P(back, 'hps'), P(back, 'shoulder'), P(back, 'armhole'), RAGLAN_NECK_MM.back)
    if (rf && rb) {
      f = rf.outline
      b = rb.outline
      raglan = { front: rf, back: rb, frontNeck: rf.neckTaken, backNeck: rb.neckTaken,
        shoulderLen: dist(P(back, 'hps'), P(back, 'shoulder')) }
    } else notes.push('raglan line could not be placed on the block — drafted as a set-in sleeve')
  }

  // yokes: a horizontal style line below the shoulder, above the underarm
  const yokeY = (depthCm) => Math.min(Math.max(hps[1] + depthCm * 10, shoulder[1] + 25), armhole[1] - 25)
  if (c.backYokeCm > 0) {
    const y = yokeY(c.backYokeCm)
    pieces.push({ role: 'backYoke', outline: foldFirst(clipY(b, y, true)), onFold: true, cutCount: 1 })
    b = clipY(b, y, false)
  }
  let frontYoke = null
  if (c.frontYokeCm > 0) {
    const y = yokeY(c.frontYokeCm)
    frontYoke = clipY(f, y, true)
    f = clipY(f, y, false)
  }
  const openFront = c.frontOpening !== 'none'
  const stand = openFront && c.frontOpening !== 'zip' ? c.buttonStandCm * 10 : 0
  const frontPiece = (pts) => (openFront
    ? { outline: toOrigin(stand ? extendCentre(pts, stand) : pts), onFold: false, cutCount: 2 }
    : { outline: foldFirst(pts), onFold: true, cutCount: 1 })
  if (frontYoke) pieces.push({ role: 'frontYoke', ...frontPiece(frontYoke) })
  pieces.push({ role: 'front', ...frontPiece(f) })
  pieces.push({ role: 'back', outline: foldFirst(b), onFold: true, cutCount: 1 })
  seams.standWidth = stand

  if (c.sleeve !== 'none' && sleevePart) {
    let s = seamPts(sleevePart)
    const sb = bbox(s)
    const fraction = SLEEVE_FRACTION[attrs?.sleeveLength] ?? 1
    const wantCm = c.sleeveLengthCm > 0 ? c.sleeveLengthCm : (cm.shoulderToWrist || 60) * fraction
    const target = sb.minY + Math.max(8, wantCm - c.cuffDepthCm) * 10
    // the cap stays exactly as drafted (it must match the armhole); only the arm lengthens/shortens
    const capBase = sb.minY + (sb.maxY - sb.minY) * 0.3
    s = stretchBelow(s, capBase, Math.max(capBase + 40, target))
    s = toOrigin(s)
    const bottom = bbox(s).maxY
    const low = s.filter((p) => bottom - p[1] < 2).map((p) => p[0])
    seams.sleeveHem = Math.max(...low) - Math.min(...low)
    if (raglan) {
      // sleeve length runs from the neck: the shoulder the body gave up, then the arm
      const r = raglanSleeve({ ...raglan, bicep: sb.maxX - sb.minX, hemW: seams.sleeveHem,
        lengthMm: raglan.shoulderLen + Math.max(8, wantCm - c.cuffDepthCm) * 10 })
      s = r.outline
      notes.push('raglan sleeve: front raglan edge on the right, back on the left; its top edge joins the neckline')
    }
    pieces.push({ role: 'sleeve', outline: s, onFold: false, cutCount: 2 })
    if (c.sleeve === 'dropped')
      notes.push('dropped sleeve drafted as a set-in sleeve from the block (no dropped-shoulder block yet) — extend the shoulder when cutting')
  }
}

function draftLower(mm, cm, c, options, pieces, seams, notes) {
  const pattern = new Titan({ measurements: mm, options, units: 'metric', sa: 0 })
  pattern.draft()
  const parts = pattern.parts[0]
  for (const [role, key] of [['frontLeg', 'titan.front'], ['backLeg', 'titan.back']]) {
    let pts = seamPts(parts[key])
    if (!pts) throw new Error(`block draft produced no ${key}`)
    pts = toOrigin(pts)
    if (c.legLengthCm > 0) pts = clipY(pts, c.legLengthCm * 10 + 15, true)
    pieces.push({ role, outline: pts, onFold: false, cutCount: 2 })
  }
  seams.waist = (cm.waist || 80) * 10 + 40
  if (c.waistbandCm > 0) notes.push(`waistband ${c.waistbandCm}cm deep`)
}

// ---------------------------------------------------------------- attaching pieces

const ROLE_RE = [
  ['backYoke', /back.?yoke/i], ['frontYoke', /front.?yoke/i],
  ['collarStand', /stand/i], ['collar', /collar|neckband|neck.?band/i],
  ['cuff', /cuff|wristband/i], ['hemBand', /hem.?band|waist.?band.*rib|bottom.?band|rib.?hem/i],
  ['waistband', /waistband/i], ['frontFacing', /front.*(facing|placket)|placket|zip.*facing/i],
  ['sleeve', /sleeve/i], ['frontLeg', /front.*(leg|trouser|pant)/i], ['backLeg', /back.*(leg|trouser|pant)/i],
  ['front', /front|bodice.*front/i], ['back', /back/i],
]
const BODY_ROLES = new Set(['front', 'back', 'backYoke', 'frontYoke', 'sleeve', 'frontLeg', 'backLeg'])

/** The role an AI piece plays: its own `role` if valid, else guessed from its name. */
export function pieceRole(p) {
  const text = `${p.name} ${p.title}`
  const lining = /lining/i.test(text), interfacing = /interfacing|fusing/i.test(text)
  let base = typeof p.role === 'string' ? p.role.replace(/^(lining|interfacing):/, '') : ''
  if (!base || base === 'other') base = (ROLE_RE.find(([, re]) => re.test(text.replace(/lining|interfacing|fusing/gi, ''))) || ['other'])[0]
  return { base, lining: lining || /^lining:/.test(p.role || ''), interfacing: interfacing || /^interfacing:/.test(p.role || '') }
}

function scaleTo(outline, wantW, wantH) {
  const b = bbox(outline)
  const kx = wantW && b.maxX - b.minX > 1 ? wantW / (b.maxX - b.minX) : 1
  const ky = wantH && b.maxY - b.minY > 1 ? wantH / (b.maxY - b.minY) : 1
  return outline.map(([x, y]) => [(x - b.minX) * kx, (y - b.minY) * ky])
}

const BLOCK_TITLES = {
  front: 'Front', back: 'Back', backYoke: 'Back yoke', frontYoke: 'Front yoke', sleeve: 'Sleeve',
  frontLeg: 'Front leg', backLeg: 'Back leg',
}

function cutText(count, onFold, material) {
  return `Cut ${count}${onFold ? ' on fold' : ''} from ${material === 'main' ? 'main fabric' : material}`
}

/**
 * The full piece list: block-drafted body pieces in place of the AI's body outlines,
 * attached pieces re-sized to the drafted seams, the rest as the AI drew them.
 * aiPieces: validated AI pieces ({name, title, outline mm, onFold, cutCount, material, notes, role}).
 */
export function assemblePieces(aiPieces, cm, attrs, construction, options = {}) {
  const { pieces: block, seams, notes } = draftBlock(cm, attrs, construction, options)
  const byRole = new Map(block.map((p) => [p.role, p]))
  const out = []
  const used = new Set()
  const shapeOf = new Map() // role -> final outline, for linings / interfacings

  // body pieces: the block's shape, the AI's name/title where it gave one
  for (const bp of block) {
    const ai = aiPieces.find((p) => { const r = pieceRole(p); return r.base === bp.role && !r.lining && !r.interfacing && !used.has(p) })
    if (ai) used.add(ai)
    shapeOf.set(bp.role, bp.outline)
    out.push({
      name: ai?.name || bp.role, title: ai?.title || BLOCK_TITLES[bp.role], outline: bp.outline, onFold: bp.onFold,
      cut: cutText(bp.cutCount, bp.onFold, 'main'), notes: ai?.notes?.length ? ai.notes : [], drafted: 'block',
    })
  }
  // an AI body piece the block has no counterpart for (e.g. a front yoke the
  // construction didn't ask for) is dropped rather than printed with made-up geometry
  for (const p of aiPieces) {
    if (used.has(p)) continue
    const r = pieceRole(p)
    if (BODY_ROLES.has(r.base) && !r.lining && !r.interfacing && !byRole.has(r.base)) {
      notes.push(`"${p.title}" left out: the drafted body has no ${r.base} for it`)
      used.add(p)
    }
  }
  // attached pieces sized to the seams they sew onto
  const neck = seams.neck, sleeveHem = seams.sleeveHem, hem = seams.hem
  for (const p of aiPieces) {
    if (used.has(p)) continue
    const r = pieceRole(p)
    if (r.lining || r.interfacing) continue // after their base pieces exist
    let outline = p.outline, why = null
    const half = p.onFold ? 0.5 : 1
    if ((r.base === 'collar' || r.base === 'collarStand') && neck) {
      outline = scaleTo(outline, (neck + 2 * (seams.standWidth || 0)) * half, null)
      why = `length = drafted neckline ${(neck / 10).toFixed(1)}cm`
    } else if (r.base === 'cuff' && sleeveHem) {
      const rib = /rib/i.test(`${p.name} ${p.title} ${p.material}`) || attrs?.cuffs === 'ribbed'
      // cuffs are cut double depth and folded
      outline = scaleTo(outline, (rib ? sleeveHem * 0.82 : sleeveHem + 25) * half,
        construction.cuffDepthCm > 0 ? construction.cuffDepthCm * 20 : null)
      why = `width from the drafted sleeve opening ${(sleeveHem / 10).toFixed(1)}cm`
    } else if (r.base === 'hemBand' && hem) {
      outline = scaleTo(outline, hem * 0.88 * half, construction.hemBandCm > 0 ? construction.hemBandCm * 20 : null)
      why = `length from the drafted hem ${(hem / 10).toFixed(1)}cm`
    } else if (r.base === 'waistband' && seams.waist) {
      outline = scaleTo(outline, seams.waist * half, construction.waistbandCm > 0 ? construction.waistbandCm * 20 : null)
      why = 'length from the waist'
    } else if (r.base === 'frontFacing' && seams.cfLength) {
      outline = scaleTo(outline, null, seams.cfLength)
      why = `length = drafted centre front ${(seams.cfLength / 10).toFixed(1)}cm`
    }
    used.add(p)
    shapeOf.set(r.base, outline)
    if (!shapeOf.has(p.name)) shapeOf.set(p.name, outline)
    out.push({ ...p, outline, drafted: why ? 'sized' : 'ai', ...(why ? { sizing: why } : {}) })
  }
  // linings take their body piece's shape; interfacings the piece they stiffen
  for (const p of aiPieces) {
    if (used.has(p)) continue
    const r = pieceRole(p)
    const target = typeof p.of === 'string' && shapeOf.has(p.of) ? shapeOf.get(p.of) : shapeOf.get(r.base)
    out.push({ ...p, outline: target || p.outline, drafted: target ? 'copied' : 'ai' })
    used.add(p)
  }
  return { pieces: out.map(({ role, of, material, cutCount, ...rest }) => rest), notes, seams }
}
