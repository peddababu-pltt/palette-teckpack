// extra-pieces.mjs — real cut pieces the freesewing design itself doesn't draft.
//
// Two jobs, both producing freesewing-shaped `<g id="fs-stack-NAME.suffix">` groups so
// every downstream step (layoutFrontBack, blackOnWhite, writePartsPdf's one-page-per-
// piece split, the per-piece AI instructions) treats them exactly like drafted pieces:
//
//   1. buildFeaturePieces — the photo shows a feature (patch/flap/welt pocket, separate
//      waistband, ribbed/buttoned cuff, collar, chest badge) that the matched catalogue
//      design has no piece for. The overlays in photo-draft.helpers.mjs only MARK where
//      it goes on the front/sleeve; this adds the actual piece to cut, sized from the
//      vision estimate + the body measurements.
//   2. draftCustomPieces — the garment matches nothing in the catalogue (vision says
//      "other", or it is too unsure of the match). AI lists every cut piece with its
//      outline in cm, sized to the measurements, instead of the run failing outright.
//
// All geometry is in mm, in each piece's own local space (origin top-left, y down),
// matching freesewing's own `units: 'metric'` output.
import fs from 'fs'
import path from 'path'
import { GoogleGenAI } from '@google/genai'
import { findStacks, NO_POCKET_OVERLAY, NO_WAISTBAND_OVERLAY, WAISTBAND_CATEGORIES,
  CUFF_PIECE_DESIGNS, RIBBED_CUFF_PIECE_DESIGNS, COLLAR_STYLE_BY_DESIGN } from './photo-draft.helpers.mjs'

const SA_MM = 10
const fmt = (n) => +n.toFixed(2)
const cmText = (mm) => `${(mm / 10).toFixed(2).replace(/\.?0+$/, '')}cm`

// Offsets a simple polygon outward, one distance per edge (edge i runs point i ->
// point i+1). Each vertex of the result is the intersection of its two neighbouring
// offset edges — the same miter a pattern maker draws by hand. A 0 distance keeps the
// edge on the seamline (a cut-on-fold edge gets no seam allowance).
function offsetPolygon(pts, dists) {
  const n = pts.length
  let area = 0
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n]
    area += x1 * y2 - x2 * y1
  }
  // y-down space: positive shoelace area = clockwise on screen, whose outward
  // normal of edge (dx, dy) is (dy, -dx)
  const sign = area > 0 ? 1 : -1
  const lines = pts.map((p, i) => {
    const q = pts[(i + 1) % n]
    const dx = q[0] - p[0], dy = q[1] - p[1]
    const len = Math.hypot(dx, dy) || 1
    const nx = (sign * dy) / len, ny = (-sign * dx) / len
    const d = dists[i]
    return { p: [p[0] + nx * d, p[1] + ny * d], dir: [dx, dy] }
  })
  const maxD = Math.max(...dists, 1)
  return pts.map((pt, i) => {
    const a = lines[(i - 1 + n) % n], b = lines[i]
    const cross = a.dir[0] * b.dir[1] - a.dir[1] * b.dir[0]
    if (Math.abs(cross) < 1e-9) return b.p
    const t = ((b.p[0] - a.p[0]) * b.dir[1] - (b.p[1] - a.p[1]) * b.dir[0]) / cross
    const q = [a.p[0] + a.dir[0] * t, a.p[1] + a.dir[1] * t]
    // miter limit: a very sharp corner would shoot the seam allowance out to a
    // spike -- cap it at 3x the allowance from the corner
    const d = Math.hypot(q[0] - pt[0], q[1] - pt[1])
    if (d > maxD * 3) {
      const f = (maxD * 3) / d
      return [pt[0] + (q[0] - pt[0]) * f, pt[1] + (q[1] - pt[1]) * f]
    }
    return q
  })
}

function pointIn(r, x, y) {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside
  }
  return inside
}

function ringDist(r, x, y) {
  let d = Infinity
  for (let i = 0; i < r.length; i++) {
    const [ax, ay] = r[i], [bx, by] = r[(i + 1) % r.length]
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-12
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L))
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy))
  }
  return d
}

const pathD = (pts) => `M ${pts.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L ')} z`

// One freesewing-shaped stack. spec: { outline: [[x,y]...] mm, number, title, cut,
// onFold (edge 0 is the fold), notes: [string], foldLines: [[[x,y],[x,y]]] }
export function pieceStack(design, suffix, spec) {
  const name = `${design}.${suffix}`
  const id = (k) => `xp-${suffix}-${k}`
  const pts = spec.outline
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const w = maxX - minX, h = maxY - minY
  const dists = pts.map((_, i) => (spec.onFold && i === 0 ? 0 : SA_MM))
  const sa = offsetPolygon(pts, dists)

  let body = ''
  body += `<path  class="fabric" id="${id('cut')}" d="${pathD(pts)}"  fill="none" stroke="#000"/>\n`
  body += `<path  class="fabric sa" id="${id('sa')}" d="${pathD(sa)}"  fill="none" stroke="#000"/>\n`
  for (const [i, [a, b]] of (spec.foldLines || []).entries())
    body += `<path  class="mark dashed" id="${id(`fold${i}`)}" d="M ${fmt(a[0])},${fmt(a[1])} L ${fmt(b[0])},${fmt(b[1])}"  fill="none" stroke="#000"/>\n`
  if (spec.onFold) {
    const [a, b] = [pts[0], pts[1]]
    const inset = 12
    body += `<path  class="note" marker-start="url(#cutonfoldFrom)" marker-end="url(#cutonfoldTo)" id="${id('fold')}" d="M ${fmt(a[0] + inset)},${fmt(a[1] + (b[1] - a[1]) * 0.15)} L ${fmt(b[0] + inset)},${fmt(a[1] + (b[1] - a[1]) * 0.85)}"  fill="none" stroke="#000"/>\n`
    body += `<text><textPath xlink:href="#${id('fold')}"  startOffset="50%" ><tspan  class="center fill-note">Cut on fold</tspan></textPath>\n</text>\n`
  }
  // width + height dimensions, outside the seam allowance
  const dimY = maxY + SA_MM + 20, dimX = maxX + SA_MM + 20
  body += `<path  class="mark" data-text="${cmText(w)}" marker-start="url(#dimensionFrom)" marker-end="url(#dimensionTo)" id="${id('w')}" d="M ${fmt(minX)},${fmt(dimY)} L ${fmt(maxX)},${fmt(dimY)}"  fill="none" stroke="#000"/>\n`
  body += `<text><textPath xlink:href="#${id('w')}"  startOffset="50%" ><tspan  class="fill-mark center">${cmText(w)}</tspan></textPath>\n</text>\n`
  body += `<path  class="mark" data-text="${cmText(h)}" marker-start="url(#dimensionFrom)" marker-end="url(#dimensionTo)" id="${id('h')}" d="M ${fmt(dimX)},${fmt(maxY)} L ${fmt(dimX)},${fmt(minY)}"  fill="none" stroke="#000"/>\n`
  body += `<text><textPath xlink:href="#${id('h')}"  startOffset="50%" ><tspan  class="fill-mark center">${cmText(h)}</tspan></textPath>\n</text>\n`

  // title block: centred on the roomiest spot inside the outline (furthest from every
  // edge, fold marker included), shrunk until it fits there -- never on top of the
  // fold label or the grainline
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const inside = (x, y) => pointIn(pts, x, y)
  const edgeDist = (x, y) => ringDist(pts, x, y) - (spec.onFold ? 0 : 0)
  let ax = minX + w / 2, ay = minY + h / 2, ad = -1
  for (let gy = 1; gy < 24; gy++) for (let gx = 1; gx < 24; gx++) {
    const x = minX + (w * gx) / 24, y = minY + (h * gy) / 24
    if (!inside(x, y)) continue
    const d = edgeDist(x, y) - (spec.onFold ? Math.max(0, 40 - Math.abs(x - pts[0][0])) : 0)
    if (d > ad) { ad = d; ax = x; ay = y }
  }
  const lines = [
    { t: String(spec.number), size: 22, bold: true, cls: 'fill-note' },
    { t: spec.title, size: 11, bold: true, cls: 'fill-current' },
    { t: spec.cut, size: 7.5, bold: false, cls: 'fill-current' },
    ...(spec.notes || []).map((n) => ({ t: n, size: 6, bold: false, cls: 'fill-note' })),
  ]
  const blockH = lines.reduce((a, l) => a + l.size * 1.35, 0)
  const blockW = Math.max(...lines.map((l) => l.t.length * l.size * 0.56))
  const room = Math.max(8, ad) * 2 * 0.9
  let k = Math.min(1.6, room / blockH, (Math.min(w, room * 1.4) * 0.92) / blockW)
  // too thin for a readable label inside (a facing, a strap): put it just above the
  // piece instead of on top of its edges / fold marker
  const outside = k * 11 < 5
  if (outside) {
    k = 0.6
    ax = minX + (blockW * k) / 2
    ay = minY - SA_MM - 6 - (blockH * k) / 2
  }
  // keep the whole label clear of the cut-on-fold marker along edge 0
  if (spec.onFold && !outside) {
    const foldX = Math.min(pts[0][0], pts[1][0])
    ax = Math.max(ax, foldX + 24 + (blockW * k) / 2)
  }
  // the page crop only sees path coordinates: an invisible box makes the label count
  body += `<path  class="hidden" d="M ${fmt(ax - (blockW * k) / 2)},${fmt(ay - (blockH * k) / 2 - 2)} L ${fmt(ax + (blockW * k) / 2)},${fmt(ay + (blockH * k) / 2 + 2)}"  fill="none" stroke="none"/>\n`
  let cy = ay - (blockH * k) / 2
  for (const l of lines) {
    const fs = l.size * k
    cy += fs * 1.1
    body += `<text  class="${l.cls}${l.bold ? ' font-bold' : ''} center" text-anchor="middle" style="font-size:${fmt(fs)}px" x="${fmt(ax)}" y="${fmt(cy)}"><tspan>${esc(l.t)}</tspan>\n</text>\n`
    cy += fs * 0.25
  }
  const textHalfW = outside ? -1 : (blockW * k) / 2 + 10
  // grainline: a vertical line inside the piece, beside (not through) the title
  const span = h * 0.7
  let gxBest = null, gScore = -Infinity
  for (let c = 1; c < 20; c++) {
    const x = minX + (w * c) / 20
    if (Math.abs(x - ax) < textHalfW) continue
    let ok = 0
    for (let t = 0; t <= 10; t++) if (inside(x, ay - span / 2 + (span * t) / 10)) ok++
    const score = ok * 100 - Math.abs(x - ax)
    if (ok >= 9 && score > gScore) { gScore = score; gxBest = x }
  }
  if (gxBest !== null) {
    body += `<path  class="note" marker-start="url(#grainlineFrom)" marker-end="url(#grainlineTo)" id="${id('grain')}" d="M ${fmt(gxBest)},${fmt(ay + span / 2 - 8)} L ${fmt(gxBest)},${fmt(ay - span / 2 + 8)}"  fill="none" stroke="#000"/>\n`
    body += `<text><textPath xlink:href="#${id('grain')}"  startOffset="50%" ><tspan  class="center fill-note">Grainline</tspan></textPath>\n</text>\n`
  } else {
    // no room beside the title: a short grain arrow under it instead
    const gy0 = outside ? minY + h * 0.3 : ay + (blockH * k) / 2 + 6, gy1 = Math.min(maxY - 6, gy0 + Math.min(60, h * 0.25))
    if (gy1 - gy0 > 12) body += `<path  class="note" marker-start="url(#grainlineFrom)" marker-end="url(#grainlineTo)" id="${id('grain')}" d="M ${fmt(ax)},${fmt(gy1)} L ${fmt(ax)},${fmt(gy0)}"  fill="none" stroke="#000"/>\n`
  }

  return `<!-- Start of group #fs-stack-${name} -->\n<g id="fs-stack-${name}"  transform="translate(0, 0)">\n\n` +
    `<!-- Start of group #fs-stack-${name}-part-${name} -->\n<g id="fs-stack-${name}-part-${name}"  transform="translate(0, 0)">\n` +
    body +
    `</g>\n<!-- end of group #fs-stack-${name}-part-${name} -->\n</g>\n<!-- end of group #fs-stack-${name} -->\n`
}

const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]]
// cut-on-fold variant: edge 0 (the fold) must run down the left side, x = 0
const foldRect = (w, h) => [[0, h], [0, 0], [w, 0], [w, h]]

function appendStacks(svg, stacks) {
  const closeRe = /<\/g>\s*<!-- end of group #fs-container -->/
  if (!closeRe.test(svg)) return svg
  return svg.replace(closeRe, (m) => `${stacks.join('\n')}\n${m}`)
}

function designName(svg) {
  return svg.match(/<g id="fs-stack-(\w+)\.\w+"/)?.[1] || 'extra'
}

// Hem width freesewing itself printed on a sleeve's dimension marks (wCuff for
// Teagan-style sleeves, wAtHem as a fallback), in mm — so a cuff band matches the
// real sleeve opening instead of a guess.
function sleeveOpeningMm(svg) {
  for (const macro of ['wCuff', 'wAtHem', 'wWrist']) {
    const m = svg.match(new RegExp(`data-text="([\\d.]+)cm"[^>]*data-macro-id="${macro}"`))
    if (m) return +m[1] * 10
  }
  return null
}

// Adds real pieces for every detected feature the matched design can't draft.
// Returns the new svg plus a human list of what was added (for the log + design.json).
export function buildFeaturePieces(svg, attrs, mappedCategory, cm) {
  const design = designName(svg)
  const existing = findStacks(svg, /.*/).map((s) => s.suffix)
  const has = (re) => existing.some((s) => re.test(s))
  let number = existing.length + 1
  const pieces = []
  const add = (suffix, spec, what) => {
    if (existing.includes(suffix)) return
    pieces.push({ suffix, what, markup: pieceStack(design, suffix, { ...spec, number: number++ }) })
    existing.push(suffix)
  }

  // --- pockets ---
  const p = attrs.pockets
  if (p && p.type !== 'none' && !NO_POCKET_OVERLAY.has(mappedCategory) && !has(/pocket/i)) {
    const count = Math.max(1, p.count || 1)
    const w = p.widthCm > 0 ? p.widthCm * 10 : 140
    if (p.type === 'patch') {
      const h = p.heightCm > 0 ? p.heightCm * 10 : 160
      const facing = 30
      add('patchPocket', {
        outline: rect(w, h + facing), title: 'patch pocket', cut: `Cut ${count} from main fabric`,
        foldLines: [[[0, facing], [w, facing]]], notes: ['fold top facing along dashed line'],
      }, `patch pocket (${cmText(w)} x ${cmText(h)}) x${count}`)
    } else if (p.type === 'flap') {
      const h = p.heightCm > 0 ? p.heightCm * 10 : 150
      add('flapPocketBag', { outline: rect(w, h), title: 'pocket', cut: `Cut ${count} from main fabric` },
        `flap pocket bag (${cmText(w)} x ${cmText(h)}) x${count}`)
      const fh = Math.max(40, Math.round(h * 0.35))
      add('pocketFlap', { outline: rect(w + 4, fh), title: 'pocket flap', cut: `Cut ${count * 2} (outer + facing)` },
        `pocket flap (${cmText(w + 4)} x ${cmText(fh)}) x${count * 2}`)
    } else if (p.type === 'welt') {
      const weltH = p.heightCm > 0 && p.heightCm < 5 ? p.heightCm * 10 : 15
      add('welt', {
        outline: rect(w + 30, weltH * 2 + 20), title: 'welt', cut: `Cut ${count} from main fabric, ${count} interfacing`,
        foldLines: [[[0, weltH + 10], [w + 30, weltH + 10]]], notes: ['fold in half lengthwise'],
      }, `welt strip x${count}`)
      add('weltPocketBag', { outline: rect(w + 40, 180), title: 'pocket bag', cut: `Cut ${count * 2} from lining` },
        `welt pocket bag x${count * 2}`)
    }
  }

  // --- waistband ---
  const wb = attrs.waistband
  if (WAISTBAND_CATEGORIES.has(attrs.garmentCategory) && (wb === 'banded' || wb === 'elastic') &&
      !NO_WAISTBAND_OVERLAY.has(mappedCategory) && !has(/waistband/i)) {
    const finished = wb === 'banded' ? 40 : 35
    // banded: waist + 3cm button overlap; elastic casing: must pull over the hips
    const length = wb === 'banded' ? cm.waist * 10 + 30 : cm.hips * 10
    add('waistband', {
      outline: rect(length, finished * 2), title: `${wb} waistband`, cut: 'Cut 1 from main fabric' + (wb === 'banded' ? ', 1 interfacing' : ''),
      foldLines: [[[0, finished], [length, finished]]],
      notes: wb === 'elastic' ? [`insert ${cmText(cm.waist * 10 * 0.9)} of ${cmText(finished - 5)} elastic`] : ['fold in half lengthwise'],
    }, `${wb} waistband (${cmText(length)} x ${cmText(finished * 2)})`)
  }

  // --- cuffs ---
  const cuffNeeded = !(RIBBED_CUFF_PIECE_DESIGNS.has(mappedCategory) && attrs.cuffs === 'ribbed') &&
    !CUFF_PIECE_DESIGNS.has(mappedCategory) && (attrs.cuffs === 'ribbed' || attrs.cuffs === 'buttoned')
  if (cuffNeeded && has(/sleeve/i) && !has(/cuff/i)) {
    const ribbed = attrs.cuffs === 'ribbed'
    const band = attrs.cuffWidthCm > 0 ? attrs.cuffWidthCm * 10 : ribbed ? 30 : 60
    const opening = sleeveOpeningMm(svg) ?? cm.wrist * 10 + 60
    // rib knit is stretched ~15% onto the opening; a buttoned cuff wraps the wrist + overlap
    const length = ribbed ? opening * 0.85 : cm.wrist * 10 + 60 + 25
    add('cuff', {
      outline: rect(length, band * 2), title: `${attrs.cuffs} cuff`,
      cut: ribbed ? 'Cut 2 from rib knit' : 'Cut 2 from main fabric, 2 interfacing',
      foldLines: [[[0, band], [length, band]]], notes: ['fold in half lengthwise'],
    }, `${attrs.cuffs} cuff (${cmText(length)} x ${cmText(band * 2)}) x2`)
  }

  // --- collar ---
  const style = attrs.collarStyle
  if (style && !['none', 'n/a'].includes(style) && COLLAR_STYLE_BY_DESIGN[mappedCategory] !== style) {
    const half = (cm.neck * 10) / 2 + 10 // half neckline + ease, cut on the CB fold
    const replaces = COLLAR_STYLE_BY_DESIGN[mappedCategory]
    const notes = replaces ? [`use instead of the drafted ${replaces} collar`] : []
    if (style === 'mandarin' || style === 'spread') {
      const standH = style === 'mandarin' ? 35 : 30
      add('collarBand', {
        outline: [[0, standH], [0, 0], [half - 8, 0], [half + 15, standH]], onFold: true,
        title: style === 'mandarin' ? 'mandarin collar' : 'collar stand', cut: 'Cut 2 on fold, 1 interfacing', notes,
      }, `${style === 'mandarin' ? 'mandarin collar' : 'collar stand'} x2`)
    }
    if (style === 'spread') {
      add('collarLeaf', {
        outline: [[0, 60], [0, 0], [half, 0], [half + 25, 70]], onFold: true,
        title: 'collar', cut: 'Cut 2 on fold, 1 interfacing', notes,
      }, 'spread collar leaf x2')
    }
    if (style === 'shawl' || style === 'notch_lapel') {
      add('undercollar', {
        outline: [[0, 80], [0, 0], [half, 0], [half + 35, 80]], onFold: true,
        title: style === 'shawl' ? 'shawl collar' : 'undercollar', cut: 'Cut 2 on fold, 1 interfacing',
        notes: [...notes, 'true up the lapel roll line on the front'],
      }, `${style.replace('_', ' ')} collar x2`)
    }
  }

  // --- badge ---
  if (attrs.badge?.present) {
    const w = attrs.badge.widthCm > 0 ? attrs.badge.widthCm * 10 : 70
    const h = attrs.badge.heightCm > 0 ? attrs.badge.heightCm * 10 : 70
    add('badge', { outline: rect(w, h), title: 'badge', cut: 'Cut 1 from contrast fabric', notes: ['turn edges under, topstitch in place'] },
      `badge appliqué (${cmText(w)} x ${cmText(h)})`)
  }

  if (!pieces.length) return { svg, added: [] }
  return { svg: appendStacks(svg, pieces.map((x) => x.markup)), added: pieces.map((x) => x.what) }
}

// ---------------- garments not in the catalogue ----------------

export const CUSTOM_MEASUREMENTS = [
  'chest', 'waist', 'hips', 'neck', 'shoulderToShoulder', 'hpsToWaistBack',
  'biceps', 'wrist', 'shoulderToWrist', 'waistToKnee', 'waistToFloor', 'inseam',
]

const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

const CUSTOM_HINT = `Respond with ONLY a raw JSON object, no prose, no markdown fences:
{
  "pieces": [
    {
      "name": "<camelCase id, letters only, e.g. front, back, sleeve, hood, pocket, waistband>",
      "title": "<short human name>",
      "cutCount": <integer 1..8>,
      "material": "main | lining | interfacing | contrast | rib",
      "onFold": <bool>  <- true when the piece is cut on a fold; then its FIRST edge (point 0 -> point 1) must be the fold line, running straight down x = 0,
      "outline": [[x, y], ...]  <- 4 to 60 points, in CENTIMETRES, the piece's own frame (origin top-left, y grows downward), the SEAMLINE only (no seam allowance), in drawing order. Trace curved seams (neckline, armhole, sleeve cap, crotch, collar edge, rounded hems) with a point every 2-3 cm so they stay smooth curves; straight seams need only their end points,
      "notes": "<one short sewing note>"
    }
  ]
}`

// Smooths an AI outline: sharp corners (turn > ~35 degrees: shoulder point, hem
// corners, collar points) stay exact, and every run of points between them becomes
// a centripetal Catmull-Rom curve sampled every ~5mm -- so a neckline / armhole /
// sleeve cap given as a handful of points reads as a drafted curve, not facets.
function smoothOutline(pts) {
  const n = pts.length
  if (n < 4) return pts
  const corner = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], c = pts[(i + 1) % n]
    const v1 = [p[0] - a[0], p[1] - a[1]], v2 = [c[0] - p[0], c[1] - p[1]]
    const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2)
    if (!l1 || !l2) return true
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)
    return cos < Math.cos((35 * Math.PI) / 180)
  })
  const out = []
  for (let i = 0; i < n; i++) {
    const p1 = pts[i], p2 = pts[(i + 1) % n]
    out.push(p1)
    // a segment touching a corner on either end stays straight
    if (corner[i] && corner[(i + 1) % n]) continue
    const p0 = corner[i] ? p1 : pts[(i - 1 + n) % n]
    const p3 = corner[(i + 1) % n] ? p2 : pts[(i + 2) % n]
    const steps = Math.max(1, Math.round(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 5))
    for (let k = 1; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t
      out.push([0, 1].map((j) =>
        0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3)))
    }
  }
  return out
}

// True when any two non-adjacent edges of the closed outline cross.
function selfIntersects(pts) {
  const n = pts.length
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const c = pts[j], d = pts[(j + 1) % n]
      const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d)
      if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
    }
  }
  return false
}

// `crossed` collects the names of pieces whose outline crosses itself (they're left
// out of the result) so the caller can ask the model to redraw just those.
function validatePieces(obj, crossed = []) {
  if (!obj || !Array.isArray(obj.pieces) || !obj.pieces.length) throw new Error('no pieces')
  const seen = new Set()
  return obj.pieces.slice(0, 20).map((p) => {
    let name = String(p.name || '').replace(/[^a-zA-Z]/g, '')
    if (!name) throw new Error('piece without a name')
    while (seen.has(name)) name += 'B'
    seen.add(name)
    if (!Array.isArray(p.outline) || p.outline.length < 3) throw new Error(`piece ${name}: bad outline`)
    const outline = p.outline.map((pt) => {
      if (!Array.isArray(pt) || pt.length !== 2 || !pt.every((v) => Number.isFinite(v) && v >= -5 && v <= 400))
        throw new Error(`piece ${name}: bad point ${JSON.stringify(pt)}`)
      return [pt[0] * 10, pt[1] * 10]
    })
    if (selfIntersects(outline)) {
      crossed.push(name)
      return null
    }
    const cutCount = Number.isInteger(p.cutCount) && p.cutCount > 0 ? Math.min(p.cutCount, 8) : 1
    const material = ['main', 'lining', 'interfacing', 'contrast', 'rib'].includes(p.material) ? p.material : 'main'
    return {
      name, title: String(p.title || name).slice(0, 40), outline: smoothOutline(outline), onFold: !!p.onFold,
      cut: `Cut ${cutCount}${p.onFold ? ' on fold' : ''} from ${material === 'main' ? 'main fabric' : material}`,
      notes: p.notes ? [String(p.notes).slice(0, 80)] : [],
    }
  }).filter(Boolean)
}

// Asks the vision model for the garment's full cut-piece list, sized to `cm`.
// MOCK_CUSTOM_PIECES='{"pieces":[...]}' short-circuits it for offline tests.
export async function draftCustomPieces(photoPath, attrs, cm, size, reference = '') {
  if (process.env.MOCK_CUSTOM_PIECES) return validatePieces(JSON.parse(process.env.MOCK_CUSTOM_PIECES))
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  const mediaType = MEDIA[path.extname(photoPath).toLowerCase()]
  if (!mediaType) throw new Error(`unsupported image type: ${path.extname(photoPath)}`)
  const data = fs.readFileSync(photoPath).toString('base64')
  const client = new GoogleGenAI({ apiKey })
  const body = CUSTOM_MEASUREMENTS.map((k) => `${k}=${cm[k]}`).join(', ')
  const prompt = `You are an expert garment pattern maker. This garment ("${attrs.notes}") is not a standard block, ` +
    `so draft its sewing pattern from scratch. List EVERY separate piece that must be cut to sew it exactly as shown ` +
    `(bodice/front/back panels, sleeves, collar, hood, facings, yokes, pockets, flaps, bands, cuffs, ties, straps...). ` +
    `Size ${size}, fit "${attrs.fit}". Body measurements in cm: ${body}. ` +
    `Size each outline to those measurements plus ease that matches the fit — e.g. a front bodice half is about chest/4 + ease wide. ` +
    `Draw half pieces on the fold where the garment is symmetric. ` +
    (reference ? `The closest pattern in our catalogue is: ${reference}. Follow the same drafting conventions as that pattern (its standard pieces, seam placement, block proportions), but draw THIS garment's own pieces for every way it differs. ` : '') +
    `Include every piece a real production pattern would: main panels, facings, linings, collar pieces, pocket pieces, bands, cuffs.\n${CUSTOM_HINT}`
  const ask = async (extra = '') => {
    const res = await client.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mediaType, data } }, { text: `${prompt} ${extra}` }] }],
    })
    return JSON.parse(res.text.replace(/```json|```/g, '').trim())
  }
  let first
  try {
    first = await ask()
  } catch {
    first = await ask('Your previous answer was invalid. Follow the schema EXACTLY.')
  }
  const crossed = []
  const pieces = validatePieces(first, crossed)
  if (!crossed.length) return pieces
  // one redraw for pieces whose outline crossed itself; any still crossed are dropped
  // (logged) rather than printed as an impossible shape
  try {
    const again = await ask(`In your previous answer these pieces' outlines cross over themselves, which is impossible to cut: ${crossed.join(', ')}. ` +
      `Return ONLY those pieces again, each outline a simple closed shape traced in one direction around its edge.`)
    const still = []
    const fixed = validatePieces(again, still).filter((p) => crossed.includes(p.name))
    for (const n of still) console.log(`Note: AI piece "${n}" still crosses itself after a redraw — left out.`)
    return [...pieces, ...fixed]
  } catch {
    for (const n of crossed) console.log(`Note: AI piece "${n}" crosses itself — left out.`)
    return pieces
  }
}

// Builds a full pattern SVG for AI-drafted pieces, borrowing `headerSvg`'s freesewing
// header (theme <style>, grainline/dimension/cut-on-fold markers) so it styles and
// post-processes exactly like a drafted design.
export function customPatternSvg(headerSvg, pieces) {
  const open = headerSvg.indexOf('<!-- Start of group #fs-container -->')
  const header = open === -1 ? headerSvg.slice(0, headerSvg.indexOf('<g id="fs-container">')) : headerSvg.slice(0, open)
  const stacks = pieces.map((p, i) => pieceStack('custom', p.name, { ...p, number: i + 1 }))
  return `${header}<!-- Start of group #fs-container -->\n<g id="fs-container">\n${stacks.join('\n')}\n</g>\n<!-- end of group #fs-container -->\n</svg>`
}
