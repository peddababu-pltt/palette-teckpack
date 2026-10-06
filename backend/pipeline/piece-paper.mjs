// piece-paper.mjs — each cut piece drawn exactly as the sewing pattern shows it
// (white paper, cutline, seam-allowance line, notches, grainline, name and cut
// text), transparent outside, for the 3D try-on's pattern view.
//
// Same standalone-piece frame as photo-draft's 3D texture (MARGIN mm around the
// stack's box), so pattern-pieces.json's polygon / cutMm locate it exactly and
// the viewer can lay the paper over the piece's true shape.
//
// Backfill an existing job (no redraft):
//   node piece-paper.mjs <job_dir>
import fs from 'fs'
import path from 'path'
import { Resvg } from '@resvg/resvg-js'

export const PIECE_MARGIN = 20 // mm, must match photo-draft's writePartsPdf
const PAPER_DPI = 100 // labels stay readable when the camera comes close

// Regex-matches every top-level `<g id="fs-stack-NAME.suffix">` piece group and computes
// its bounding box, used both to re-lay pieces out on the combined canvas (layoutFrontBack)
// and to cut each piece out onto its own page (writePartsPdf).
export function extractStacks(svg) {
  const stackRe = /<g id="fs-stack-([\w]+\.([\w]+))"\s+transform="translate\(([-\d.]+), ([-\d.]+)\)">([\s\S]*?)<\/g>\s*<!-- end of group #fs-stack-\1 -->/g
  const stacks = {}
  for (const m of svg.matchAll(stackRe)) {
    const [full, name, suffix, tx, ty, content] = m
    // freesewing nests each stack's actual artwork inside one more <g id="fs-stack-
    // NAME-part-NAME" transform="translate(px, py)">, and that inner offset is not
    // always (0, 0) — e.g. Carlton/Carlita/Charlie's front, Simon/Aaron's back all draft
    // with a non-zero part-level translate. The path coordinates matched below live in
    // that inner part's local space, so they must be shifted by (px, py) before taking
    // min/max — otherwise the computed bbox is wrong relative to the stack's own origin,
    // and re-placing stacks by (only) their outer transform below silently puts the
    // piece's real artwork off-canvas by exactly (px, py).
    const partM = content.match(/<g id="fs-stack-[\w.]+-part-[\w.]+"\s+transform="translate\(([-\d.]+),\s*([-\d.]+)\)">/)
    const [ptx, pty] = partM ? [+partM[1], +partM[2]] : [0, 0]
    const pairs = [...content.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)]
    if (!pairs.length) continue
    const xs = pairs.map((p) => +p[1] + ptx), ys = pairs.map((p) => +p[2] + pty)
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
    // freesewing always names every part its pattern *could* draw, even ones
    // the chosen options skip (e.g. a placket style not used this draft) --
    // those come through as a real stack with a null "M 0,0 L 0,0 ... z" path
    // instead of being left out. 1mm is well under any real cut piece, so
    // this only drops those placeholders, not a legitimately tiny trim.
    if (maxX - minX < 1 && maxY - minY < 1) continue
    stacks[suffix] = { name, suffix, full, tx: +tx, ty: +ty, minX, maxX, minY, maxY }
  }
  return stacks
}

/** The piece as the sewing pattern draws it, minus the page grid, with its
 *  cutline filled white (paper) and nothing behind it. */
export function renderPaperTexture(header, piece, w, h) {
  let body = piece
    .replace(/<path\s+class="grid"[^>]*\/>\s*/g, '')
    .replace(/<path(\s+)class="(fabric|various|contrast|lining|canvas|interfacing)"(?=[\s>])/g, '<path$1style="fill:#ffffff;fill-opacity:1" class="$2"')
  // the seam-allowance band is paper too: a white copy of the SA outline under
  // everything else in the part (filling the drawn SA path would cover the piece)
  const sa = body.match(/<path\s+class="[^"]*\bsa\b[^"]*"[^>]*\bd="([^"]+)"/)?.[1]
  if (sa) body = body.replace(/(<g id="fs-stack-[\w.]+-part-[\w.]+"[^>]*>)/, `$1<path d="${sa}" style="fill:#ffffff;stroke:none"/>`)
  const svg = header
    .replace(/width="[-\d.]+mm"/, `width="${w.toFixed(2)}mm"`)
    .replace(/height="[-\d.]+mm"/, `height="${h.toFixed(2)}mm"`)
    .replace(/viewBox="[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+"/, `viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}"`) +
    `<g id="fs-container">\n${body}\n</g>\n</svg>`
  return new Resvg(svg, { fitTo: { mode: 'width', value: Math.max(1, Math.round(w * PAPER_DPI / 25.4)) } }).render().asPng()
}

/** The pattern.svg's header (defs, styles, markers) and each piece re-placed in
 *  its own standalone frame -- the frame pattern-pieces.json's textures use. */
export function standalonePieces(svg) {
  const containerOpen = svg.indexOf('<g id="fs-container">')
  if (containerOpen === -1) return null
  const header = svg.slice(0, containerOpen).replace(/<rect x="0" y="0" width="[-\d.]+" height="[-\d.]+" fill="#ffffff"\/>\n?/, '')
  const out = []
  for (const s of Object.values(extractStacks(svg))) {
    const w = s.maxX - s.minX + PIECE_MARGIN * 2
    const h = s.maxY - s.minY + PIECE_MARGIN * 2
    const piece = s.full.replace(
      `transform="translate(${s.tx}, ${s.ty})"`,
      `transform="translate(${PIECE_MARGIN - s.minX}, ${PIECE_MARGIN - s.minY})"`,
    )
    out.push({ suffix: s.suffix, piece, w, h })
  }
  return { header, pieces: out }
}

/** Writes <suffix>.paper.png next to each piece texture of a job and records it
 *  as `paperFile` in pattern-pieces.json. Returns how many were written. */
export function backfillJob(jobDir) {
  const svgPath = path.join(jobDir, 'pattern.svg')
  const idxPath = path.join(jobDir, 'pattern-pieces.json')
  if (!fs.existsSync(svgPath) || !fs.existsSync(idxPath)) return 0
  const sp = standalonePieces(fs.readFileSync(svgPath, 'utf8'))
  if (!sp) return 0
  const index = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
  const bySuffix = new Map(sp.pieces.map((p) => [p.suffix, p]))
  let n = 0
  for (const entry of index.pieces || []) {
    const p = bySuffix.get(entry.suffix)
    // only when the frame matches the texture the polygon was measured in
    if (!p || Math.abs(p.w - entry.wMm) > 0.5 || Math.abs(p.h - entry.hMm) > 0.5) continue
    const rel = entry.file.replace(/\.png$/i, '.paper.png')
    fs.writeFileSync(path.join(jobDir, rel), renderPaperTexture(sp.header, p.piece, p.w, p.h))
    entry.paperFile = rel
    n++
  }
  fs.writeFileSync(idxPath, JSON.stringify(index, null, 2))
  return n
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  for (const dir of process.argv.slice(2)) console.log(`${dir}: ${backfillJob(dir)} paper textures`)
}
