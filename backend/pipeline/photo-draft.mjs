// photo-draft.mjs — garment photo + measurements (cm) → made-to-measure pattern SVG
// Usage: node photo-draft.mjs <photo.jpg> <measurements.json> [output.svg]
// Same core pipeline as freesewing/pattern-via-io, extended with a vision stage.
import fs from 'fs'
try { process.loadEnvFile(new URL('./.env', import.meta.url)) } catch {}
import { analyzeGarment } from './analyze.mjs'
import {
  findStacks, injectIntoStack,
  drawPocketOverlay, NO_POCKET_OVERLAY,
  drawWaistbandOverlay, NO_WAISTBAND_OVERLAY, WAISTBAND_CATEGORIES,
  drawCuffOverlay, CUFF_PIECE_DESIGNS, RIBBED_CUFF_PIECE_DESIGNS,
  drawZipOverlay, JACKET_BUTTON_DESIGNS,
  drawCollarOverlay, COLLAR_STYLE_BY_DESIGN,
  drawBadgeOverlay,
  removeStacks,
} from './photo-draft.helpers.mjs'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { Resvg } from '@resvg/resvg-js'
import { generatePieceInstructions } from './instructions.mjs'
import { pluginTheme } from '@freesewing/plugin-theme'
import {
  DESIGNS, CATEGORY_TO_DESIGN, DEDICATED_CATEGORIES,
  HOW_TO_MEASURE, defaultMeasurements,
} from './designs.mjs'
import { i18n as annI18n } from '@freesewing/plugin-annotations'

// attribute → option mapping. lo/hi pick within each option's [min,max] range.
const T = (opt, t) => ({ opt, t }) // t: 0=min .. 1=max, null=skip
const FIT_T = { fitted: 0.1, regular: null, relaxed: 0.65, oversized: 1.0 }
const LEN_T = { cropped: 0.1, regular: null, long: 0.85, 'n/a': null }
const SLEEVE_T = { sleeveless: 0.0, short: 0.25, elbow: 0.45, three_quarter: 0.7, long: 1.0, 'n/a': null }

function buildOptions(Design, attrs, applied, skipped) {
  const cfg = Design.patternConfig.options
  const options = {}
  const trySet = (name, t, source) => {
    const o = cfg[name]
    if (!o || typeof o !== 'object' || !('pct' in o) || t === null) {
      if (t !== null) skipped.push(`${source} → ${name} (design has no such option)`)
      return
    }
    const val = (o.min + t * (o.max - o.min)) / 100
    options[name] = val
    applied.push(`${source} → ${name} = ${(val * 100).toFixed(0)}%`)
  }
  // fit → ease options (whichever exist on this design)
  for (const name of ['chestEase', 'waistEase', 'hipsEase', 'seatEase', 'bicepsEase', 'kneeEase', 'sleeveEase'])
    trySet(name, FIT_T[attrs.fit], `fit:${attrs.fit}`)
  // garment length
  trySet('lengthBonus', LEN_T[attrs.garmentLength], `length:${attrs.garmentLength}`)
  // sleeve length (teagan: sleeveLength option)
  trySet('sleeveLength', SLEEVE_T[attrs.sleeveLength], `sleeve:${attrs.sleeveLength}`)
  // neckline depth/bend (teagan-style options)
  if (attrs.neckline === 'v') {
    trySet('necklineDepth', 0.75, 'neckline:v')
    trySet('necklineBend', 0.05, 'neckline:v') // low bend = straighter = V shape
  }
  if (attrs.neckline === 'scoop') {
    trySet('necklineDepth', 0.6, 'neckline:scoop')
    trySet('necklineBend', 0.9, 'neckline:scoop')
  }
  if (attrs.neckline === 'crew') trySet('necklineDepth', 0.15, 'neckline:crew')
  // first-button placement (Simon's buttonFreeLength is a plain pct option — trySet
  // handles it directly, no special-casing needed)
  if (attrs.closure === 'button' && attrs.buttonCount > 0)
    trySet('buttonFreeLength', attrs.buttonTopFraction, `buttonTop:${attrs.buttonTopFraction}`)
  // button count — Simon/Simone/Wahid expose it as a count option (raw integer) named
  // "buttons"; Jett names the same kind of option "closureCount" instead. Some designs
  // instead expose it as a list option (a fixed set of string choices). None of these
  // shapes are covered by trySet's pct handling, so all are wired directly here.
  // (Carlita/Carlton/Devon/Simone draft a fixed button count with no exposed option at
  // all — vision's buttonCount has nothing to apply to there; that's a freesewing
  // design limitation, not a gap in this wiring.)
  if (attrs.closure === 'button' && attrs.buttonCount > 0) {
    const optionName = cfg.buttons ? 'buttons' : cfg.closureCount ? 'closureCount' : null
    const o = optionName && cfg[optionName]
    if (o && typeof o === 'object' && typeof o.count !== 'undefined') {
      const clamped = Math.min(o.max, Math.max(o.min, attrs.buttonCount))
      options[optionName] = clamped
      applied.push(`buttons:${attrs.buttonCount} → ${optionName} = ${clamped}${clamped !== attrs.buttonCount ? ` (clamped from ${attrs.buttonCount})` : ''}`)
    } else if (o && typeof o === 'object' && Array.isArray(o.list)) {
      const nearest = o.list.reduce((best, v) => Math.abs(+v - attrs.buttonCount) < Math.abs(+best - attrs.buttonCount) ? v : best, o.list[0])
      options[optionName] = nearest
      applied.push(`buttons:${attrs.buttonCount} → ${optionName} = ${nearest}${+nearest !== attrs.buttonCount ? ` (nearest of ${o.list.join('/')})` : ''}`)
    } else {
      skipped.push(`buttons:${attrs.buttonCount} → buttons (design has no such option)`)
    }
  }
  return options
}

// Inlines resolved fill/stroke onto path/circle elements so pattern pieces render
// correctly (white background, black cutlines) even in viewers that ignore
// the embedded <style> block — without it they fall back to SVG's own default
// (fill=black, stroke=none), which paints every piece as a solid black shape.
// The real cutline (the "fabric" class — what you actually cut fabric along) is
// colored red so it stands out from every other black annotation/guideline on the
// sheet; everything else stays black-on-white.
const CUTLINE_COLOR = '#e2231a'

// All layer colors are forced to black here (instead of freesewing's default
// fabric/lining/note/mark/contrast palette) so every line in the output reads
// as a plain black-on-white cutting pattern, except the cutline itself (see
// CUTLINE_COLOR above).
function inlineFillStroke(svg) {
  const FILL_CLASS = {
    'fill-fabric': '#000', 'fill-lining': '#000', 'fill-interfacing': '#000',
    'fill-canvas': '#000', 'fill-various': '#000', 'fill-note': '#000',
    'fill-mark': '#000', 'fill-contrast': '#000',
  }
  const STROKE_CLASS = {
    fabric: CUTLINE_COLOR, lining: '#000', interfacing: '#000', canvas: '#000',
    various: '#000', note: '#000', mark: '#000', contrast: '#000', bartack: '#000',
  }
  return svg.replace(/<(path|circle)\b([^>]*?)(\/?)>/gs, (m, tag, attrsRaw, selfClose) => {
    const attrs = attrsRaw
    const classMatch = attrs.match(/class\s*=\s*"([^"]*)"/)
    const classes = classMatch ? classMatch[1].split(/\s+/) : []
    let add = ''
    if (!/\bfill\s*=/.test(attrs) && !/style\s*=\s*"[^"]*fill\s*:/.test(attrs)) {
      let fill = 'none'
      for (const c of classes) if (FILL_CLASS[c]) fill = FILL_CLASS[c]
      add += ` fill="${fill}"`
    }
    if (!/\bstroke\s*=/.test(attrs) && !/style\s*=\s*"[^"]*stroke\s*:/.test(attrs)) {
      let stroke = classes.includes('hidden') || classes.includes('no-stroke') ? 'none' : '#000'
      for (const c of classes) if (STROKE_CLASS[c]) stroke = STROKE_CLASS[c]
      add += ` stroke="${stroke}"`
    }
    if (!add) return m
    return `<${tag}${attrs}${add}${selfClose}>`
  })
}

// The freesewing "title" macro bundles part nr / date / part name / brand+version /
// cutlist notes (the "Cut 2, mirrored from fabric" line) into one block, gated by the
// same complete-flag as grainline/cutonfold/dimensions — so complete must stay true to
// get grainline arrows and measurement dimensions at all. Strip only the logo snippet
// and the date line; keep the part nr/title/cutlist text, since that's what says how
// many of each piece to cut and whether it's mirrored — needed to actually cut fabric.
function stripTitleAndLogo(svg) {
  svg = svg.replace(/<use[^>]*xlink:href="#logo"[^>]*>\s*<\/use>/g, '')
  return svg.replace(/<text[^>]*class="text-sm fill-current(?: (?:left|right|center))?"[^>]*>[\s\S]*?<\/text>/g, '')
}

// Two more freesewing extras clutter the sheet and overlap other labels:
//   1. A "FreeSewing Design vX.Y.Z (ephemeral)" watermark repeated on every single
//      piece (own class, not caught by stripTitleAndLogo above).
//   2. A one-off patron-ad block ("Support FreeSewing, become a patron" + join
//      link) plus its accompanying print-scale calibration note ("The (white)
//      inside of this box should measure...") and the two nested calibration-
//      square paths that note refers to — dropped as a set since the note is
//      meaningless once its box is gone and vice versa.
// Neither is needed to actually cut fabric, unlike the part nr/title/cutlist
// text stripTitleAndLogo deliberately keeps.
function stripBranding(svg) {
  svg = svg.replace(/<path\b[^>]*\bclass="[^"]*\bscalebox\b[^"]*"[^>]*\/>\s*/g, '')
  return svg.replace(/<text\b[^>]*>(?:(?!<\/text>)[\s\S])*?<\/text>\s*/g, (m) =>
    /FreeSewing|should measure/i.test(m) ? '' : m
  )
}

// freesewing's embedded <style> block (its own theme CSS) defines .fabric/.lining/
// .note/.mark/.contrast/.canvas/.various/grid colors — and in SVG, a stylesheet class
// rule beats a presentation attribute, so inlineFillStroke's inline stroke="#000"
// doesn't actually win against these. Some marker templates (note/mark arrowheads)
// also hardcode color as attributes directly, bypassing inlineFillStroke entirely.
// Blanket-blacken every such hex color (keeping only white/black and the grayscale
// hardware-icon shading for buttons/snaps, which isn't a "line") + drop in an
// opaque white background rect so transparent-SVG viewers show a clean white sheet.
function blackOnWhite(svg) {
  const KEEP = new Set(['#000', '#000000', '#fff', '#ffffff', '#666', '#bbbbbb', '#dddddd', CUTLINE_COLOR])
  svg = svg.replace(/(stroke|fill)(:\s*|="\s*)(#[0-9a-fA-F]{3,6})/g, (m, prop, sep, hex) =>
    KEEP.has(hex.toLowerCase()) ? m : `${prop}${sep}#000`
  )
  // Sharper corners: round caps/joins read soft/blurry at small scale — square
  // caps + miter joins give crisp, print-ready cutlines instead.
  svg = svg.replace(/stroke-linecap:\s*round/g, 'stroke-linecap: square')
  svg = svg.replace(/stroke-linejoin:\s*round/g, 'stroke-linejoin: miter')
  // The main fabric cutline is the line that matters most when cutting — make it
  // visibly heavier than the internal notes/marks/grid lines, and colored so it
  // stands out from every other (black) annotation on the sheet. freesewing's own
  // theme CSS sets `.fabric { stroke: #000 }`, which — being a <style> rule — beats
  // any inline stroke="..." attribute on the path, so the color must be overridden
  // here too, not just via inlineFillStroke's STROKE_CLASS map above.
  svg = svg.replace(/(\.fabric\s*\{[^}]*stroke-width:\s*)0\.6/, '$1 0.9')
  svg = svg.replace(/(\.fabric\s*\{[^}]*stroke:\s*)#000\b/, `$1${CUTLINE_COLOR}`)
  const vb = svg.match(/viewBox="[-\d.]+ [-\d.]+ ([-\d.]+) ([-\d.]+)"/)
  const [w, h] = vb ? [vb[1], vb[2]] : ['100%', '100%']
  return svg.replace(/(<svg\b[^>]*>)/, `$1\n<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`)
}

// Titan's front/back are drafted as one half only (center-seam at local x=0, cut 2
// mirrored) — good for cutting, but reads as a lopsided sliver on screen. Overlay a
// scale(-1,1) clone at the same seam line so the rendered view shows the full
// left+right silhouette, the way the wearer will actually see the finished piece.
function mirrorHalfParts(svg, suffixes) {
  if (!suffixes?.length) return svg
  const suffixPattern = suffixes.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const re = new RegExp(
    `(<!-- Start of group #fs-stack-([\\w]+\\.(?:${suffixPattern})) -->\\s*<g id="fs-stack-\\2"\\s+transform="([^"]*)">)([\\s\\S]*?)(<\\/g>\\s*<!-- end of group #fs-stack-\\2 -->)`,
    'g'
  )
  // Track how far each mirrored part reaches in global x, so the canvas can grow
  // to fit both halves instead of clipping the mirrored copy off the page.
  const reach = []
  svg = svg.replace(re, (m, openBlock, name, transform, content, closeBlock) => {
    const tx = parseFloat(transform.match(/translate\(\s*([-\d.]+)/)?.[1] ?? '0')
    const nums = [...content.matchAll(/\bd="([^"]*)"/g)].flatMap((d) => [...d[1].matchAll(/-?\d+\.?\d*/g)].map(Number))
    const maxAbs = nums.length ? Math.max(...nums.map(Math.abs)) : 0
    reach.push(tx - maxAbs, tx + maxAbs)
    const mirroredContent = content.replace(/id="([^"]+)"/g, (mm, id) => `id="${id}-mirror"`)
    return `${openBlock}${content}\n<g transform="scale(-1,1)">${mirroredContent}</g>\n${closeBlock}`
  })
  if (!reach.length) return svg
  const vb = svg.match(/viewBox="([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+)"/)
  if (!vb) return svg
  const [, vx, vy, vw, vh] = vb.map(Number)
  const minX = Math.min(vx, ...reach)
  const maxX = Math.max(vx + vw, ...reach)
  const newVb = `viewBox="${minX} ${vy} ${maxX - minX} ${vh}"`
  svg = svg.replace(/viewBox="[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+"/, newVb)
  svg = svg.replace(/width="[-\d.]+mm"/, `width="${(maxX - minX).toFixed(2)}mm"`)
  return svg
}

// freesewing's default packer bin-fits pieces in declaration order, which doesn't
// guarantee front lands left of back. Re-place both explicitly, front-left/back-right
// (matching the reference photo's FRONT | BACK layout) and waistband below, using each
// piece's actual bounding box so the new slots can't overlap — a plain coordinate swap
// isn't safe here since front/back have different shapes/sizes.
//
// Every OTHER piece (sleeve, collar, cuffs, pockets, lining, yoke, tail, ...) is left by
// freesewing at its auto-packed spot, which was computed assuming front/back sat at
// their ORIGINAL position -- once front/back move above, those pieces silently overlap
// them. Shelf-pack every remaining stack into further rows below instead, and size the
// final canvas from ALL placed pieces (not just front/back/waistband), so nothing
// overlaps and nothing gets clipped out of the viewBox.
// Regex-matches every top-level `<g id="fs-stack-NAME.suffix">` piece group and computes
// its bounding box, used both to re-lay pieces out on the combined canvas (layoutFrontBack)
// and to cut each piece out onto its own page (writePartsPdf).
function extractStacks(svg) {
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

function layoutFrontBack(svg) {
  const stacks = extractStacks(svg)
  if (!stacks.front || !stacks.back) return svg
  const { front, back, waistband } = stacks
  const MARGIN = 20, GAP = 30
  const place = {}
  place.front = { tx: MARGIN - front.minX, ty: MARGIN - front.minY }
  const frontGlobalMaxX = place.front.tx + front.maxX
  place.back = { tx: frontGlobalMaxX + GAP - back.minX, ty: MARGIN - back.minY }
  let rowBottom = Math.max(place.front.ty + front.maxY, place.back.ty + back.maxY)
  if (waistband) {
    place.waistband = { tx: MARGIN - waistband.minX, ty: rowBottom + GAP - waistband.minY }
    rowBottom = place.waistband.ty + waistband.maxY
  }

  // Shelf-pack every remaining piece below, left-to-right, wrapping to a new row
  // whenever a row would run wider than the front+back row above.
  const pageWidth = frontGlobalMaxX + GAP + (back.maxX - back.minX)
  const rest = Object.keys(stacks).filter((s) => s !== 'front' && s !== 'back' && s !== 'waistband')
  let rowX = MARGIN, rowH = 0, rowY = rowBottom + GAP
  for (const suffix of rest) {
    const s = stacks[suffix]
    const w = s.maxX - s.minX, h = s.maxY - s.minY
    if (rowX > MARGIN && rowX + w > pageWidth) {
      rowY += rowH + GAP
      rowX = MARGIN
      rowH = 0
    }
    place[suffix] = { tx: rowX - s.minX, ty: rowY - s.minY }
    rowX += w + GAP
    rowH = Math.max(rowH, h)
  }

  let svgOut = svg
  for (const [suffix, s] of Object.entries(stacks)) {
    svgOut = svgOut.replace(
      `<g id="fs-stack-${s.name}"  transform="translate(${s.tx}, ${s.ty})">`,
      `<g id="fs-stack-${s.name}"  transform="translate(${place[suffix].tx}, ${place[suffix].ty})">`
    )
  }
  // Recompute the canvas to fit EVERY repositioned piece, not just front/back/waistband.
  let maxX = 0, maxY = 0
  for (const [suffix, s] of Object.entries(stacks)) {
    maxX = Math.max(maxX, place[suffix].tx + s.maxX)
    maxY = Math.max(maxY, place[suffix].ty + s.maxY)
  }
  maxX += MARGIN
  maxY += MARGIN
  svgOut = svgOut.replace(/viewBox="[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+"/, `viewBox="0 0 ${maxX} ${maxY}"`)
  svgOut = svgOut.replace(/width="[-\d.]+mm"/, `width="${maxX.toFixed(2)}mm"`)
  svgOut = svgOut.replace(/height="[-\d.]+mm"/, `height="${maxY.toFixed(2)}mm"`)
  return svgOut
}

// The combined pattern.svg packs every piece onto one shared canvas (see layoutFrontBack
// above) — good for a quick on-screen look, but useless for printing since pieces overlap
// across sheets with no page breaks. This cuts each piece back out into its own single-piece
// SVG (reusing the same header/defs/style so class-based strokes and symbols still resolve)
// and rasterizes + embeds each as its own page in a multi-page PDF, one page per cut piece.
// Every page is the same fixed sheet and the piece is scaled to fit the room beside its
// instruction card; each page states the scale it ended up at (see PAGE_W_PT below).
const MM_TO_PT = 2.834645669
const PART_PAGE_ORDER = ['front', 'back', 'waistband']

function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/)
  const lines = []
  let line = ''
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (line && font.widthOfTextAtSize(test, size) > maxWidth) {
      lines.push(line)
      line = w
    } else {
      line = test
    }
  }
  if (line) lines.push(line)
  return lines
}

const GUTTER_MM = 12, PAD_PT = 8
const TITLE_SIZE = 26, TEXT_SIZE = 18, LINE_HEIGHT = TEXT_SIZE * 1.45, PARA_GAP = 14
// Every piece page is ONE fixed sheet, A4 landscape, and the piece is scaled to
// fit the box left over beside the instruction column.
//
// Sizing the page from the piece instead (the old behaviour, piece at a flat
// PIECE_SCALE of 0.4) made the sheet as big as whatever it held: the ribbing
// waistband on f26c040d5b81 measures 87cm, so its page came out ~2.5m tall
// carrying five lines of text in the top corner, and every page in the document
// was a different size. Fitting to a fixed sheet shrinks each piece to the room
// available and keeps the pages uniform and printable.
//
// The pieces were already NOT at cutting size (that flat 0.4), so nothing that
// could be cut has been lost -- but since the fitted scale now differs per piece,
// each page states its own scale (see writePartsPdf).
const PAGE_W_PT = 841.89, PAGE_H_PT = 595.28   // A4 landscape
const PAGE_MARGIN_PT = 34
const TEXT_COL_FRAC = 0.46                     // share of the sheet width for text
const SCALE_NOTE_SIZE = 9

// instructionText is the AI-generated plain-text instruction card for this piece (numbered
// lines) — turns it into draw-ready blocks (a bold piece-name heading + wrapped body lines)
// plus the total height they need, so the page height can be sized to fit BEFORE drawing.
function buildInstructionBlocks(suffix, instructionText, font, boldFont) {
  const maxTextWidth = PAGE_W_PT * TEXT_COL_FRAC - PAGE_MARGIN_PT - PAD_PT * 2
  const blocks = []
  let height = 0
  blocks.push({ kind: 'text', text: `How to sew: ${suffix}`, size: TITLE_SIZE, font: boldFont, gapAfter: PARA_GAP * 1.5 })
  height += TITLE_SIZE + PARA_GAP * 1.5
  const paras = instructionText.split(/\n+/).map((p) => p.trim()).filter(Boolean)
  for (const para of paras) {
    const wrapped = wrapText(para, font, TEXT_SIZE, maxTextWidth)
    wrapped.forEach((line, i) => {
      const isLast = i === wrapped.length - 1
      const gapAfter = isLast ? PARA_GAP : LINE_HEIGHT - TEXT_SIZE
      blocks.push({ kind: 'text', text: line, size: TEXT_SIZE, font, gapAfter })
      height += isLast ? TEXT_SIZE + PARA_GAP : LINE_HEIGHT
    })
  }
  return { blocks, height }
}

const COVER_PAGE_W = 595.28, COVER_PAGE_H = 841.89 // A4 portrait, pt
const COVER_MARGIN = 36
const COVER_PHOTO_MAX_H = 420
const COVER_FRAME_INSET = 12
const COVER_THUMB_GUTTER = 12
const COVER_THUMB_LABEL_H = 12

// Builds page 1 of pattern-pages.pdf: the input photo (with a decorative red
// dashed frame — NOT a garment-traced outline, see design spec's Non-goals)
// on top, and a labeled thumbnail grid of every cut piece below it. Returns
// null (logging why) instead of throwing whenever the photo can't be embedded,
// so a bad/missing photo never breaks the piece pages that already exist.
async function buildCoverPage(pdfDoc, font, boldFont, photoPath, thumbs) {
  const ext = (photoPath || '').split('.').pop()?.toLowerCase()
  if (!['jpg', 'jpeg', 'png'].includes(ext || '')) {
    console.log(`Note: cover page skipped — input "${photoPath}" isn't a .jpg/.jpeg/.png, can't embed it in the PDF.`)
    return
  }

  try {
    const bytes = fs.readFileSync(photoPath)
    const photoImage = ext === 'png' ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes)

    const contentW = COVER_PAGE_W - COVER_MARGIN * 2
    const photoScale = Math.min(contentW / photoImage.width, COVER_PHOTO_MAX_H / photoImage.height)
    const photoW = photoImage.width * photoScale
    const photoH = photoImage.height * photoScale
    const photoX = COVER_MARGIN + (contentW - photoW) / 2
    const photoY = COVER_PAGE_H - COVER_MARGIN - photoH

    const page = pdfDoc.insertPage(0, [COVER_PAGE_W, COVER_PAGE_H])
    page.drawImage(photoImage, { x: photoX, y: photoY, width: photoW, height: photoH })
    page.drawRectangle({
      x: photoX + COVER_FRAME_INSET,
      y: photoY + COVER_FRAME_INSET,
      width: Math.max(0, photoW - COVER_FRAME_INSET * 2),
      height: Math.max(0, photoH - COVER_FRAME_INSET * 2),
      borderColor: rgb(1, 0, 0),
      borderWidth: 1.5,
      borderDashArray: [6, 4],
    })

    const titleY = photoY - 24
    page.drawText('Cut pattern pieces', { x: COVER_MARGIN, y: titleY, size: 13, font: boldFont })

    if (!thumbs.length) return
    const cols = Math.min(4, thumbs.length)
    const rows = Math.ceil(thumbs.length / cols)
    const cellW = (contentW - COVER_THUMB_GUTTER * (cols - 1)) / cols
    const gridTop = titleY - 16
    const gridBottom = COVER_MARGIN
    const cellH = (gridTop - gridBottom - COVER_THUMB_GUTTER * (rows - 1)) / rows

    thumbs.forEach((t, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const cellX = COVER_MARGIN + col * (cellW + COVER_THUMB_GUTTER)
      const cellTop = gridTop - row * (cellH + COVER_THUMB_GUTTER)
      const imgAreaH = cellH - COVER_THUMB_LABEL_H
      const scale = Math.min(cellW / t.w, imgAreaH / t.h)
      const drawW = t.w * scale, drawH = t.h * scale
      const drawX = cellX + (cellW - drawW) / 2
      const drawY = cellTop - imgAreaH + (imgAreaH - drawH) / 2
      page.drawImage(t.pngImage, { x: drawX, y: drawY, width: drawW, height: drawH })
      const labelWidth = font.widthOfTextAtSize(t.suffix, 8)
      page.drawText(t.suffix, {
        x: cellX + (cellW - labelWidth) / 2,
        y: cellTop - imgAreaH - 2,
        size: 8,
        font,
      })
    })
  } catch (e) {
    console.log(`Note: cover page skipped — couldn't build it from "${photoPath}" (${e.message}).`)
  }
}

// Cuts each piece back out onto its own page (see comment above layoutFrontBack) and lays
// out an AI-generated "how to sew this piece" instruction card in a left column next to the
// cut piece on the right — so a page tells you both what to cut AND how to sew it, instead
// of leaving construction order to guesswork. Falls back to a plain full-width piece page
// (same as before this feature) whenever no API key is configured or generation fails.
async function writePartsPdf(svg, outPath, designLabel, attrs, photoPath) {
  const stacks = extractStacks(svg)
  const containerOpen = svg.indexOf('<g id="fs-container">')
  if (containerOpen === -1 || !Object.keys(stacks).length) return
  let header = svg.slice(0, containerOpen)
  header = header.replace(/<rect x="0" y="0" width="[-\d.]+" height="[-\d.]+" fill="#ffffff"\/>\n?/, '')

  const suffixes = Object.keys(stacks).sort((a, b) => {
    const pa = PART_PAGE_ORDER.indexOf(a), pb = PART_PAGE_ORDER.indexOf(b)
    if (pa === -1 && pb === -1) return a.localeCompare(b)
    return (pa === -1 ? PART_PAGE_ORDER.length : pa) - (pb === -1 ? PART_PAGE_ORDER.length : pb)
  })

  const pdfDoc = await PDFDocument.create()
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  const MARGIN = 20
  const GUTTER_PT = GUTTER_MM * MM_TO_PT
  // The fixed sheet, split into a text column and the box the piece fits inside.
  const textColPt = PAGE_W_PT * TEXT_COL_FRAC
  const pieceBoxX = textColPt + GUTTER_PT
  const pieceBoxW = PAGE_W_PT - pieceBoxX - PAGE_MARGIN_PT
  const pieceBoxH = PAGE_H_PT - PAGE_MARGIN_PT * 2

  const thumbs = []

  for (const suffix of suffixes) {
    const s = stacks[suffix]
    const w = s.maxX - s.minX + MARGIN * 2
    const h = s.maxY - s.minY + MARGIN * 2
    const tx = MARGIN - s.minX, ty = MARGIN - s.minY
    const piece = s.full.replace(
      `transform="translate(${s.tx}, ${s.ty})"`,
      `transform="translate(${tx}, ${ty})"`
    )
    let pageSvg = header
      .replace(/width="[-\d.]+mm"/, `width="${w.toFixed(2)}mm"`)
      .replace(/height="[-\d.]+mm"/, `height="${h.toFixed(2)}mm"`)
      .replace(/viewBox="[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+"/, `viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}"`)
    pageSvg += `<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>\n`
    pageSvg += `<g id="fs-container">\n${piece}\n</g>\n</svg>`

    const DPI = 200
    const resvg = new Resvg(pageSvg, { fitTo: { mode: 'width', value: Math.max(1, Math.round(w * DPI / 25.4)) } })
    const png = resvg.render().asPng()
    const pngImage = await pdfDoc.embedPng(png)
    // Fit the piece into the box beside the text, keeping its aspect ratio, and
    // never enlarge a small piece past its true size.
    const trueWpt = w * MM_TO_PT, trueHpt = h * MM_TO_PT
    const fit = Math.min(pieceBoxW / trueWpt, pieceBoxH / trueHpt, 1)
    const pieceWidthPt = trueWpt * fit, pieceHeightPt = trueHpt * fit
    thumbs.push({ suffix, pngImage, w: pieceWidthPt, h: pieceHeightPt })

    const instructionText = await generatePieceInstructions(designLabel, suffix, attrs)
    const instr = instructionText ? buildInstructionBlocks(suffix, instructionText, font, boldFont) : null

    const page = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT])
    // centred in its box, so a narrow piece does not hug the gutter
    const pieceX = pieceBoxX + (pieceBoxW - pieceWidthPt) / 2
    const pieceY = PAGE_MARGIN_PT + (pieceBoxH - pieceHeightPt) / 2
    page.drawImage(pngImage, { x: pieceX, y: pieceY, width: pieceWidthPt, height: pieceHeightPt })
    page.drawText(suffix, { x: pieceX, y: pieceY - SCALE_NOTE_SIZE - 3, size: 10, font })
    // The fitted scale differs per piece now, so say what it is on the page --
    // a pattern piece with no stated scale invites someone to cut from it.
    page.drawText(`shown at ${(fit * 100).toFixed(0)}% of full size (${w.toFixed(0)} x ${h.toFixed(0)} mm) — reference, not for cutting`,
      { x: pieceBoxX, y: PAGE_MARGIN_PT - SCALE_NOTE_SIZE - 2, size: SCALE_NOTE_SIZE, font })

    if (instr) {
      // Text runs down the fixed column and continues onto extra sheets when it
      // does not fit -- the sheet no longer grows to swallow it.
      const leftX = PAGE_MARGIN_PT + PAD_PT
      const bottomY = PAGE_MARGIN_PT
      let target = page
      let cursorY = PAGE_H_PT - PAGE_MARGIN_PT
      for (const b of instr.blocks) {
        const need = (b.kind === 'text' ? b.size : b.h) + b.gapAfter
        if (cursorY - need < bottomY) {
          target = pdfDoc.addPage([PAGE_W_PT, PAGE_H_PT])
          cursorY = PAGE_H_PT - PAGE_MARGIN_PT
          target.drawText(`How to sew: ${suffix} (cont.)`,
            { x: leftX, y: cursorY - TITLE_SIZE, size: TITLE_SIZE, font: boldFont })
          cursorY -= TITLE_SIZE + PARA_GAP
        }
        if (b.kind === 'text') {
          cursorY -= b.size
          target.drawText(b.text, { x: leftX, y: cursorY, size: b.size, font: b.font })
        } else {
          cursorY -= b.h
          target.drawImage(b.embedded, { x: leftX, y: cursorY, width: b.w, height: b.h })
        }
        cursorY -= b.gapAfter
      }
    }
  }

  await buildCoverPage(pdfDoc, font, boldFont, photoPath, thumbs)

  fs.writeFileSync(outPath, await pdfDoc.save())
}

function fixLabels(svg, designI18n) {
  const dicts = [designI18n?.en, annI18n?.en].filter(Boolean)
  const flat = {}
  for (const d of dicts)
    for (const [ns, entries] of Object.entries(d))
      if (entries && typeof entries === 'object')
        for (const [k, v] of Object.entries(entries)) flat[`${ns}:${k}`] = typeof v === 'string' ? v : (v.t || k)
  // also handle single-level dicts { key: "text" }
  for (const d of dicts)
    for (const [k, v] of Object.entries(d)) if (typeof v === 'string') flat[k] = v
  const translate = (text) =>
    text.replace(/\b([a-zA-Z-]+):([a-zA-Z][a-zA-Z0-9.]*)\b/g, (m, ns, key) => {
      if (ns === 'xmlns' || ns === 'xlink' || ns === 'xml' || ns === 'http' || ns === 'https') return m
      if (flat[`${ns}:${key}`]) return flat[`${ns}:${key}`]
      if (flat[key]) return flat[key]
      // strip namespace, split camelCase into words
      return key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
    })
  // only translate text nodes (between > and <), never tag attributes
  return svg.replace(/>([^<>]+)</g, (m, text) => '>' + translate(text) + '<')
}

// freesewing's rendered SVG occasionally carries a bare "&" (branding link query
// strings, a label built from free text) that's valid in a JS string but not in
// XML — resvg's strict parser throws "malformed entity reference" on it. Escape
// any "&" that isn't already a real entity (&amp; &lt; &#160; etc) before doing
// anything else with the markup.
function escapeBareAmpersands(svg) {
  return svg.replace(/&(?!amp;|lt;|gt;|quot;|apos;|#[0-9]+;|#x[0-9a-fA-F]+;)/g, '&amp;')
}

// freesewing tiles each guideline's label (chest line, waist line, etc) many times
// along the dashed line as one literal repeated string, so the label stays visible
// wherever you look along the line — but on a printed/on-screen sheet it just reads
// as clutter. Collapse any text node that's the same phrase repeated 3+ times
// (separated by the nbsp padding freesewing uses) down to a single instance; leaves
// every other label (piece names, cut counts, part numbers) untouched since those
// never repeat this way.
function collapseRepeatedLabels(svg) {
  return svg.replace(/>([^<>]+)</g, (m, text) => {
    const parts = text.split(/(?:&#160;)+|\s{2,}/).map((s) => s.trim()).filter(Boolean)
    if (parts.length > 2 && parts.every((p) => p === parts[0])) return `>${parts[0]}<`
    return m
  })
}

// ---------------- main ----------------
const args = process.argv.slice(2)
const photo = args[0]
const measFile = args[1] && args[1].endsWith('.json') ? args[1] : null
const outArg = measFile ? args[2] : args[1]
// Usually the same file as `photo` — separate only when the caller analyzes/drafts off
// one image (e.g. a flattened sketch) but wants the PDF cover page to show a different,
// truer-to-life one (e.g. the original garment photo). See app.py's stage 3 call.
const coverPhotoArg = measFile ? args[3] : args[2]
if (!photo) {
  console.error('Usage: node photo-draft.mjs <photo.jpg|png> [measurements.json] [output.svg] [coverPhoto.jpg|png]')
  console.error("  Measurements file is optional: without it, defaults matching the garment's apparent size are used.")
  console.error('  A partial file works too — your values override the defaults.')
  process.exit(1)
}

const attrs = await analyzeGarment(photo)
console.log(`Detected: ${attrs.notes}`)
console.log(`  category=${attrs.garmentCategory} fit=${attrs.fit} sleeves=${attrs.sleeveLength} neckline=${attrs.neckline} closure=${attrs.closure}${attrs.closure === 'button' ? ` buttons=${attrs.buttonCount}` : ''} length=${attrs.garmentLength} size=${attrs.apparentSize} confidence=${attrs.confidence}`)

const mappedCategory = CATEGORY_TO_DESIGN[attrs.garmentCategory]
if (!mappedCategory || attrs.confidence < 0.5) {
  console.error(`\nCannot draft this garment. Recognized types: ${Object.keys(CATEGORY_TO_DESIGN).join(', ')}`)
  process.exit(1)
}
if (!DEDICATED_CATEGORIES.has(attrs.garmentCategory))
  console.log(`Note: "${attrs.garmentCategory}" has no dedicated block — using ${DESIGNS[mappedCategory].label} as the closest sloper.`)

const { Design, i18n, label } = DESIGNS[mappedCategory]
const required = Design.patternConfig.measurements || []

// defaults matched to the garment's apparent size, overridden by any user-provided values
const size = attrs.apparentSize || 'M'
const defaults = defaultMeasurements(size)
let raw = {}
if (measFile) {
  if (!fs.existsSync(measFile)) {
    console.error(`Measurements file not found: ${measFile}`)
    process.exit(1)
  }
  raw = JSON.parse(fs.readFileSync(measFile, 'utf8'))
}
const userCm = raw.measurements || (measFile ? raw : {})
const overridden = Object.keys(userCm).filter((k) => typeof userCm[k] === 'number')
const cm = { ...defaults, ...Object.fromEntries(overridden.map((k) => [k, userCm[k]])) }

console.log(`Measurements: size-${size === 'unknown' ? 'M (size unclear in photo)' : size} defaults${overridden.length ? `, ${overridden.length} overridden by you (${overridden.join(', ')})` : ' (no user values given)'}`)

const measurements = {}
for (const [k, v] of Object.entries(cm)) measurements[k] = k === 'shoulderSlope' ? v : v * 10

const missing = required.filter((m) => !(m in measurements))
if (missing.length) {
  console.error(`\nMissing measurements for ${label} (not covered by defaults):`)
  for (const m of missing) console.error(`  ${m} — ${HOW_TO_MEASURE[m] || 'see freesewing.org/docs/measurements'}`)
  process.exit(1)
}

const applied = [], skipped = []
const options = { ...buildOptions(Design, attrs, applied, skipped), ...(raw.options || {}) }

const pattern = new Design({ measurements, options, sa: raw.sa ?? 10, units: 'metric', paperless: true }).use(pluginTheme)
pattern.draft()
const errors = pattern.setStores?.[0]?.logs?.error || []
if (errors.length) {
  console.error('Drafting errors:', errors)
  process.exit(1)
}

let svg = inlineFillStroke(stripBranding(stripTitleAndLogo(collapseRepeatedLabels(fixLabels(escapeBareAmpersands(pattern.render()), i18n)))))
// A design with no sleeveLength option (buildOptions already logged this to `skipped`)
// always drafts a full sleeve, even for a photo that's actually sleeveless — remove the
// sleeve (and its cuff/placket-overlap pieces) entirely instead of shipping an unwanted
// long sleeve on a sleeveless pattern. Front/back keep their original armhole curve
// (bind or face it directly; it isn't redrafted as a dedicated sleeveless armhole).
const noSleeveOption = !Design.patternConfig.options.sleeveLength
const sleevesRemoved = attrs.sleeveLength === 'sleeveless' && noSleeveOption
if (sleevesRemoved) svg = removeStacks(svg, /sleeve|cuff/i)
svg = mirrorHalfParts(svg, DESIGNS[mappedCategory].mirrorParts)
svg = layoutFrontBack(svg)
svg = blackOnWhite(svg)
// Simon/Simone, Carlita/Carlton, Devon, and Wahid all stamp `<use xlink:href="#button">`
// (Simon/Simone also `#buttonhole`) snippets for their button-front closures — a fixed
// default that doesn't match a photo showing an actual zip/snap front. drawZipOverlay
// strips those marks and draws a zip/snap placement line instead whenever the photo
// shows zip/snap, regardless of which of those designs drafted the buttons.
// Any other design: no dedicated cuff piece at all, so drawCuffOverlay stamps a
// placement marking whenever the photo shows a cuff finish — same condition
// drawCuffOverlay itself uses to decide whether to draw anything.
const cuffOverlayAdded = !(RIBBED_CUFF_PIECE_DESIGNS.has(mappedCategory) && attrs.cuffs === 'ribbed') &&
  !CUFF_PIECE_DESIGNS.has(mappedCategory) &&
  (attrs.cuffs === 'ribbed' || attrs.cuffs === 'buttoned')
const zipOverlayAdded = JACKET_BUTTON_DESIGNS.has(mappedCategory) && (attrs.closure === 'zipper' || attrs.closure === 'snap')
svg = drawPocketOverlay(svg, attrs, mappedCategory)
svg = drawWaistbandOverlay(svg, attrs, mappedCategory)
svg = drawCuffOverlay(svg, attrs, mappedCategory)
svg = drawZipOverlay(svg, attrs, mappedCategory)
svg = drawCollarOverlay(svg, attrs, mappedCategory)
svg = drawBadgeOverlay(svg, attrs)
const out = outArg || `${attrs.garmentCategory}-pattern.svg`
fs.writeFileSync(out, svg)

// The vision stage's read of the garment (fit, closure, pockets, collar, sleeves,
// apparent size) is the only place those attributes exist -- the classify stage's
// JSON has category/block/POMs but none of them. Persist it next to the pattern so
// the UI can show what the draft was actually based on.
const designOut = out.replace(/\.svg$/i, '') + '-design.json'
fs.writeFileSync(designOut, JSON.stringify({ ...attrs, design: label, size }, null, 2))
console.log(`design attributes → ${designOut}`)

const pagesOut = out.replace(/\.svg$/i, '') + '-pages.pdf'
await writePartsPdf(svg, pagesOut, label, attrs, coverPhotoArg || photo)

const wh = svg.match(/width="([\d.]+)(mm)?".*?height="([\d.]+)(mm)?"/s)
console.log(`\nDesign: ${label}`)
console.log(`Options applied:${applied.length ? '' : ' (none — design defaults)'}`)
for (const a of applied) console.log(`  ${a}`)
for (const s of skipped) console.log(`  skipped: ${s}`)
console.log(`Pieces: ${(svg.match(/class="fs-part"/g) || svg.match(/<g[^>]*part/g) || []).length || 'see file'}`)
if (cuffOverlayAdded)
  console.log(`Cuffs: ${label} has no cuff piece of its own — a ${attrs.cuffs} cuff marking was added at the sleeve hem as a placement guide, not a real cut piece.`)
if (zipOverlayAdded)
  console.log(`Closure: photo shows ${attrs.closure}, not buttons — ${label}'s button marks were removed and a ${attrs.closure} placement line added down the front instead. Sew in a ${attrs.closure} there; the front seamline itself still stands in for the real closure.`)
if (attrs.pockets && attrs.pockets.type !== 'none' && !NO_POCKET_OVERLAY.has(mappedCategory))
  console.log(`Pockets: ${label} has no pocket pieces of its own — a ${attrs.pockets.type} pocket marking was added to the front piece(s) as a placement guide, not a real cut piece.`)
if (WAISTBAND_CATEGORIES.has(attrs.garmentCategory) && attrs.waistband && attrs.waistband !== 'none' && attrs.waistband !== 'n/a' && !NO_WAISTBAND_OVERLAY.has(mappedCategory))
  console.log(`Waistband: ${label} has no waistband piece — a marking was added at the waist line; cut a separate ${attrs.waistband} strip to match your waist measurement plus ease.`)
if (attrs.collarStyle && attrs.collarStyle !== 'none' && attrs.collarStyle !== 'n/a' && COLLAR_STYLE_BY_DESIGN[mappedCategory] !== attrs.collarStyle) {
  const expected = COLLAR_STYLE_BY_DESIGN[mappedCategory]
  console.log(expected
    ? `Collar: photo shows a ${attrs.collarStyle} collar but ${label} drafts a ${expected} one — a replacement marking was added, not a re-cut piece.`
    : `Collar: photo shows a ${attrs.collarStyle} collar — ${label} has no collar piece at all; a placement marking was added, not a real cut piece.`)
}
if (attrs.badge && attrs.badge.present)
  console.log(`Badge: a chest applique/patch was detected — a placement marking was added to the front piece, not a real cut piece.`)
if (sleevesRemoved)
  console.log(`Sleeves: photo is sleeveless but ${label} has no sleeveless option — the sleeve/cuff pieces were removed; bind or face the drafted armhole directly.`)
if (wh) console.log(`Size: ${(wh[1] / 10).toFixed(1)} × ${(wh[3] / 10).toFixed(1)} cm — print at 100%`)
console.log(`Saved: ${out}`)
console.log(`Saved (one page per part): ${pagesOut}`)
