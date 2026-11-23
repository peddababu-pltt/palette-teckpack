// pattern-lock.mjs — one sewing pattern per input, kept through every redraft.
//
// A draft makes three AI calls: the garment read (analyzeGarment), the catalogue
// decision (match + pattern check) and, for a garment the catalogue can't build,
// the custom cut pieces. None of them is deterministic, so redrafting for a new
// size used to hand back a DIFFERENT pattern: on the puffer job one size change
// renamed "back" to "backBodice", added a back lining, dropped the placket, and
// another brought the placket back. The pattern the input was drafted with is the
// pattern; a size or measurement change must only grade it.
//
// The first draft for an input writes pattern-lock.json next to the pattern: the
// garment read, the decision, and (custom drafts) the pieces with the measurements
// they were drafted at. Later drafts of the SAME input (same file bytes) reuse
// all of it; custom pieces are graded to the new measurements. A new input image
// drafts fresh, as does FRESH_DRAFT=1.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

// 2: custom drafts keep { pieces, construction } and re-draft the body from a block
// (custom-block.mjs); a v1 lock's free-hand AI body outlines are discarded.
const LOCK_VERSION = 2

export function lockPathFor(outSvg) {
  return outSvg ? path.join(path.dirname(path.resolve(outSvg)), 'pattern-lock.json') : null
}

function inputKey(photo) {
  return crypto.createHash('sha1').update(fs.readFileSync(photo)).digest('hex')
}

/** The lock for this input, or null (no lock, other input, FRESH_DRAFT, unreadable). */
export function readLock(outSvg, photo) {
  const file = lockPathFor(outSvg)
  if (!file || process.env.FRESH_DRAFT === '1' || !fs.existsSync(file)) return null
  try {
    const lock = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (lock.version !== LOCK_VERSION || lock.input !== inputKey(photo)) return null
    return lock
  } catch {
    return null
  }
}

export function writeLock(outSvg, photo, data) {
  const file = lockPathFor(outSvg)
  if (!file) return
  fs.writeFileSync(file, JSON.stringify({ version: LOCK_VERSION, input: inputKey(photo), created: new Date().toISOString(), ...data }, null, 2))
}

// Which measurements grade a piece's width (x) and length (y), by what it is.
// Order matters: the first rule whose pattern matches the piece name wins.
const GRADE_RULES = [
  [/cuff|wristband/i, 'wrist', null],
  [/sleeve/i, 'biceps', 'shoulderToWrist'],
  [/collar|neckband|neckbinding|hood/i, 'neck', null],
  [/waistband/i, 'waist', null],
  [/pocket|flap|welt|tab|loop|patch|badge|strap|tie|zip/i, null, null],
  [/trouser|leg|pant|inseam/i, 'hips', 'inseam'],
  [/skirt/i, 'hips', 'waistToKnee'],
  [/hem.?band|rib/i, 'hips', null],
  [/placket|facing|front|back|bodice|yoke|side|panel|lining|body/i, 'chest', 'hpsToWaistBack'],
]

const ratio = (key, from, to) => (key && from[key] > 0 && to[key] > 0 ? to[key] / from[key] : 1)

/** The locked pieces graded from the measurements they were drafted at to `toCm`:
 *  each outline scaled about its own origin (a fold edge at x = 0 stays put). */
export function gradePieces(pieces, fromCm, toCm) {
  return pieces.map((p) => {
    const rule = GRADE_RULES.find(([re]) => re.test(`${p.name} ${p.title}`))
    const kx = rule ? ratio(rule[1], fromCm, toCm) : ratio('chest', fromCm, toCm)
    const ky = rule ? ratio(rule[2], fromCm, toCm) : 1
    return { ...p, outline: p.outline.map(([x, y]) => [x * kx, y * ky]) }
  })
}

// ---- seeding: lock the pattern a job already has (jobs drafted before locks) ----

// keys photo-draft adds to pattern-design.json on top of the garment read
const DESIGN_ONLY = new Set(['design', 'designKey', 'custom', 'size', 'sizes', 'measurements', 'sizeTable', 'extraPieces', 'patternCheck'])

/** Builds a lock from a job's current pattern.svg + pattern-design.json, keyed to
 *  the image its drafts read (sketch_regen > flat_sketch_upscaled > flat_sketch,
 *  as the API's effective_sketch picks it). Returns a one-line report. */
export function seedJob(jobDir) {
  const photo = ['sketch_regen.png', 'flat_sketch_upscaled.png', 'flat_sketch.png'].map((f) => path.join(jobDir, f)).find((f) => fs.existsSync(f))
  const designFile = path.join(jobDir, 'pattern-design.json'), svgFile = path.join(jobDir, 'pattern.svg')
  if (!photo || !fs.existsSync(designFile) || !fs.existsSync(svgFile)) return 'skipped (no pattern yet)'
  const out = path.join(jobDir, 'pattern.svg')
  if (readLock(out, photo)) return 'already locked'
  const design = JSON.parse(fs.readFileSync(designFile, 'utf8'))
  const attrs = Object.fromEntries(Object.entries(design).filter(([k]) => !DESIGN_ONLY.has(k)))
  const cm = Object.fromEntries((design.measurements || []).filter((m) => m.cm).map((m) => [m.key, m.cm]))
  if (!design.designKey) return 'skipped (design file predates designKey — redraft once to lock)'
  if (design.designKey !== 'custom') {
    writeLock(out, photo, { attrs, catalogueDesign: design.designKey, patternCheck: design.patternCheck ?? null, custom: null, seeded: true })
    return `locked catalogue pattern ${design.designKey}`
  }
  const svg = fs.readFileSync(svgFile, 'utf8')
  const pieces = []
  for (const m of svg.matchAll(/<g id="fs-stack-custom\.(\w+)"[\s\S]*?<!-- end of group #fs-stack-custom\.\1 -->/g)) {
    const name = m[1], stack = m[0]
    const d = stack.match(new RegExp(`id="xp-${name}-cut" d="([^"]+)"`))?.[1]
    if (!d) continue
    const outline = [...d.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)].map((p) => [+p[1], +p[2]])
    if (outline.length < 3) continue
    // title block, in pieceStack's order: number, title, cut line, notes
    const plain = [...stack.matchAll(/<tspan>([^<]*)<\/tspan>/g)].map((t) => t[1])
    const at = plain.findIndex((t) => /^\d+$/.test(t))
    const title = (at >= 0 && plain[at + 1]) || name
    const cut = (at >= 0 && plain[at + 2] && /^Cut /.test(plain[at + 2]) && plain[at + 2]) || 'Cut 1 from main fabric'
    const notes = at >= 0 && plain[at + 3] ? [plain[at + 3]] : []
    pieces.push({ name, title, outline, onFold: /cutonfoldFrom/.test(stack), cut, notes })
  }
  if (!pieces.length) return 'skipped (no custom pieces found in pattern.svg)'
  writeLock(out, photo, { attrs, catalogueDesign: null, patternCheck: design.patternCheck ?? null, custom: { pieces, cm, size: design.size }, seeded: true })
  return `locked ${pieces.length} custom pieces at size ${design.size}`
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname && process.argv[2] === 'seed') {
  for (const dir of process.argv.slice(3)) console.log(`${dir}: ${seedJob(dir)}`)
}
