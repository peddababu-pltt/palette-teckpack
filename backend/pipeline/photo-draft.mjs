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
import { pluginTheme } from '@freesewing/plugin-theme'
import {
  DESIGNS, CATEGORY_TO_DESIGN, DEDICATED_CATEGORIES,
  HOW_TO_MEASURE, defaultMeasurements, SIZE_KEYS, humanLabel,
} from './designs.mjs'
import { i18n as annI18n } from '@freesewing/plugin-annotations'
import { buildFeaturePieces, draftCustomPieces, customPatternSvg, CUSTOM_MEASUREMENTS } from './extra-pieces.mjs'
import { addPiecePlacement } from './piece-placement.mjs'
import { extractStacks } from './piece-paper.mjs'
import { writePartsPdf, renderPieceThumbs } from './pattern-pages.mjs'
import { readLock, writeLock, gradePieces } from './pattern-lock.mjs'
import { CATALOGUE, CATALOGUE_MATCH_MIN } from './catalogue.mjs'
import { checkCataloguePattern } from './pattern-check.mjs'

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
function layoutFrontBack(svg) {
  const stacks = extractStacks(svg)
  if (!Object.keys(stacks).length) return svg
  const { front, back, waistband } = stacks
  const MARGIN = 20, GAP = 30
  const place = {}
  const pinned = front && back
  let rowBottom = MARGIN - GAP
  let pageWidth
  if (pinned) {
    place.front = { tx: MARGIN - front.minX, ty: MARGIN - front.minY }
    const frontGlobalMaxX = place.front.tx + front.maxX
    place.back = { tx: frontGlobalMaxX + GAP - back.minX, ty: MARGIN - back.minY }
    rowBottom = Math.max(place.front.ty + front.maxY, place.back.ty + back.maxY)
    if (waistband) {
      place.waistband = { tx: MARGIN - waistband.minX, ty: rowBottom + GAP - waistband.minY }
      rowBottom = place.waistband.ty + waistband.maxY
    }
    pageWidth = frontGlobalMaxX + GAP + (back.maxX - back.minX)
  } else {
    // No front+back pair to anchor on (a bow tie, an AI-drafted custom garment):
    // shelf-pack everything, wide enough for the widest piece.
    const widths = Object.values(stacks).map((s) => s.maxX - s.minX)
    pageWidth = Math.max(900, ...widths) + MARGIN
  }

  // Shelf-pack every remaining piece below, left-to-right, wrapping to a new row
  // whenever a row would run wider than the front+back row above.
  const rest = Object.keys(stacks).filter((s) => !(s in place))
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

// One pattern per input: a redraft of the same input reuses its first draft's
// garment read, catalogue decision and custom pieces (see pattern-lock.mjs).
const lock = readLock(outArg, photo)
if (lock) console.log(`Pattern lock: reusing this input's pattern (drafted ${lock.created}) — only the measurements change`)
const attrs = lock?.attrs ?? await analyzeGarment(photo)
console.log(`Detected: ${attrs.notes}`)
console.log(`  category=${attrs.garmentCategory} fit=${attrs.fit} sleeves=${attrs.sleeveLength} neckline=${attrs.neckline} closure=${attrs.closure}${attrs.closure === 'button' ? ` buttons=${attrs.buttonCount}` : ''} length=${attrs.garmentLength} size=${attrs.apparentSize} confidence=${attrs.confidence}`)

if (attrs.garmentCategory === 'unsupported') {
  console.error(`\nCannot draft this: it does not look like a garment. Recognized types: ${Object.keys(CATEGORY_TO_DESIGN).join(', ')}`)
  process.exit(1)
}
// Catalogue first: when vision matched the photo to a catalogue pattern (the designs
// in the pattern PDF) closely enough, that pattern is used -- details it lacks get
// their own pieces from extra-pieces.mjs. A garment the catalogue doesn't really
// have (different length/silhouette, or vision says "other") is drafted from scratch
// by AI instead of being forced onto the nearest block. Without a catalogueMatch
// (older mocks) the category table decides, as before.
const match = attrs.catalogueMatch
let catalogueDesign
let patternCheck = null
if (lock) {
  catalogueDesign = lock.catalogueDesign
  patternCheck = lock.patternCheck ?? null
} else {
if (match) {
  catalogueDesign = match.design !== 'none' && DESIGNS[match.design] && match.similarity >= CATALOGUE_MATCH_MIN ? match.design : null
} else {
  catalogueDesign = attrs.confidence >= 0.5 ? CATEGORY_TO_DESIGN[attrs.garmentCategory] || null : null
  // the knee-length coat blocks are no stand-in for a hip-length jacket/blazer
  if ((catalogueDesign === 'carlton' || catalogueDesign === 'carlita') && attrs.garmentCategory !== 'coat' && attrs.garmentLength !== 'long')
    catalogueDesign = null
}
if (match)
  console.log(`Catalogue match: ${match.design} (similarity ${match.similarity}) → ${catalogueDesign ? 'close enough, checking its pattern construction' : 'not close enough — AI is drafting its cut pieces from scratch'}`)
// Second gate: similar is not enough -- the catalogue design's own cut pieces must
// build this garment (same panels, seams, collar, closure...). Draft it at the
// size's default measurements, show the model its pieces next to the input.
if (catalogueDesign && match) {
  try {
    const probeCm = defaultMeasurements(SIZE_KEYS.includes(attrs.apparentSize) ? attrs.apparentSize : 'M')
    const probeMm = Object.fromEntries(Object.entries(probeCm).map(([k, v]) => [k, k === 'shoulderSlope' ? v : v * 10]))
    const probe = new DESIGNS[catalogueDesign].Design({ measurements: probeMm, units: 'metric', paperless: true }).use(pluginTheme)
    probe.draft()
    const probeSvg = blackOnWhite(inlineFillStroke(stripBranding(stripTitleAndLogo(escapeBareAmpersands(probe.render())))))
    patternCheck = await checkCataloguePattern(photo, DESIGNS[catalogueDesign].label, renderPieceThumbs(probeSvg), attrs)
  } catch (e) {
    console.error(`Note: couldn't run the catalogue pattern check (${e.message}) — keeping the catalogue pattern.`)
  }
  if (patternCheck?.checked) {
    console.log(`Pattern check: ${patternCheck.samePattern ? 'same construction' : 'different construction'}${patternCheck.differences.length ? ` (${patternCheck.differences.join('; ')})` : ''}`)
    if (!patternCheck.samePattern) {
      console.log('→ catalogue pattern pieces don\'t build this garment — AI is drafting its cut pieces from scratch')
      catalogueDesign = null
    }
  }
}
}
const isCustom = !catalogueDesign
const mappedCategory = isCustom ? 'custom' : catalogueDesign
if (match && !isCustom) console.log(`→ using the ${DESIGNS[mappedCategory].label} pattern`)
else if (isCustom)
  console.log(`Note: "${attrs.garmentCategory}" (confidence ${attrs.confidence}) has no matching catalogue pattern — AI is drafting its cut pieces from scratch.`)
else if (!DEDICATED_CATEGORIES.has(attrs.garmentCategory))
  console.log(`Note: "${attrs.garmentCategory}" has no dedicated block — using ${DESIGNS[mappedCategory].label} as the closest sloper.`)

const { Design, i18n, label } = isCustom
  ? { Design: null, i18n: null, label: 'Custom AI draft (not in pattern catalogue)' }
  : DESIGNS[mappedCategory]
const required = isCustom ? CUSTOM_MEASUREMENTS : Design.patternConfig.measurements || []

let raw = {}
if (measFile) {
  if (!fs.existsSync(measFile)) {
    console.error(`Measurements file not found: ${measFile}`)
    process.exit(1)
  }
  raw = JSON.parse(fs.readFileSync(measFile, 'utf8'))
}
// Size: an explicit pick from the pattern tab wins, else the garment's apparent size.
const normSize = (sz) => (sz === 'XXL' ? '2XL' : sz)
const size = SIZE_KEYS.includes(normSize(raw.size)) ? normSize(raw.size)
  : SIZE_KEYS.includes(normSize(attrs.apparentSize)) ? normSize(attrs.apparentSize) : 'M'
const defaults = defaultMeasurements(size)
const userCm = raw.measurements || (measFile && !raw.size ? raw : {})
const overridden = Object.keys(userCm).filter((k) => typeof userCm[k] === 'number' && userCm[k] > 0)
const cm = { ...defaults, ...Object.fromEntries(overridden.map((k) => [k, userCm[k]])) }

console.log(`Measurements: size-${size}${raw.size ? ' (chosen)' : attrs.apparentSize === 'unknown' ? ' (size unclear in photo)' : ''} defaults${overridden.length ? `, ${overridden.length} overridden by you (${overridden.join(', ')})` : ' (no user values given)'}`)

const measurements = {}
for (const [k, v] of Object.entries(cm)) measurements[k] = k === 'shoulderSlope' ? v : v * 10

const missing = required.filter((m) => !(m in measurements))
if (missing.length) {
  console.error(`\nMissing measurements for ${label} (not covered by defaults):`)
  for (const m of missing) console.error(`  ${m} — ${HOW_TO_MEASURE[m] || 'see freesewing.org/docs/measurements'}`)
  process.exit(1)
}

const applied = [], skipped = []
let svg
let sleevesRemoved = false
let extraPieces = []
if (isCustom) {
  let pieces
  if (lock?.custom?.pieces?.length) {
    pieces = gradePieces(lock.custom.pieces, lock.custom.cm, cm)
    console.log(`Custom pieces: the locked ${lock.custom.pieces.length} pieces, graded from size ${lock.custom.size} to ${size}`)
  } else {
    try {
      const ref = match && match.design !== 'none' ? CATALOGUE[match.design] : ''
      pieces = await draftCustomPieces(photo, attrs, cm, size, ref)
    } catch (e) {
      console.error(`AI custom draft failed: ${e.message}`)
      process.exit(1)
    }
  }
  if (!lock?.custom?.pieces?.length) writeLock(outArg, photo, { attrs, catalogueDesign: null, patternCheck, custom: { pieces, cm, size } })
  // Only borrowed for its freesewing header (theme CSS + grainline/dimension markers).
  const headerDraft = new DESIGNS.teagan.Design({ measurements, units: 'metric', paperless: true }).use(pluginTheme)
  headerDraft.draft()
  svg = customPatternSvg(escapeBareAmpersands(headerDraft.render()), pieces)
  svg = inlineFillStroke(svg)
  extraPieces = pieces.map((p) => `${p.title} — ${p.cut}`)
  svg = layoutFrontBack(svg)
  svg = blackOnWhite(svg)
} else {
  const options = { ...buildOptions(Design, attrs, applied, skipped), ...(raw.options || {}) }

  if (!lock) writeLock(outArg, photo, { attrs, catalogueDesign, patternCheck, custom: null })
  const pattern = new Design({ measurements, options, sa: raw.sa ?? 10, units: 'metric', paperless: true }).use(pluginTheme)
  pattern.draft()
  const errors = pattern.setStores?.[0]?.logs?.error || []
  if (errors.length) {
    console.error('Drafting errors:', errors)
    process.exit(1)
  }

  svg = inlineFillStroke(stripBranding(stripTitleAndLogo(collapseRepeatedLabels(fixLabels(escapeBareAmpersands(pattern.render()), i18n)))))
  // A design with no sleeveLength option (buildOptions already logged this to `skipped`)
  // always drafts a full sleeve, even for a photo that's actually sleeveless — remove the
  // sleeve (and its cuff/placket-overlap pieces) entirely instead of shipping an unwanted
  // long sleeve on a sleeveless pattern. Front/back keep their original armhole curve
  // (bind or face it directly; it isn't redrafted as a dedicated sleeveless armhole).
  const noSleeveOption = !Design.patternConfig.options.sleeveLength
  sleevesRemoved = attrs.sleeveLength === 'sleeveless' && noSleeveOption
  if (sleevesRemoved) svg = removeStacks(svg, /sleeve|cuff/i)
  svg = mirrorHalfParts(svg, DESIGNS[mappedCategory].mirrorParts)
  // Features the photo shows but this catalogue design has no piece for (pockets,
  // waistband, cuffs, collar, badge) get a real cut piece of their own, sized from the
  // vision estimate + measurements — the overlays below still mark where each goes.
  const feat = buildFeaturePieces(svg, attrs, mappedCategory, cm)
  svg = inlineFillStroke(feat.svg)
  extraPieces = feat.added
  svg = layoutFrontBack(svg)
  svg = blackOnWhite(svg)
  // Simon/Simone, Carlita/Carlton, Devon, and Wahid all stamp `<use xlink:href="#button">`
  // (Simon/Simone also `#buttonhole`) snippets for their button-front closures — a fixed
  // default that doesn't match a photo showing an actual zip/snap front. drawZipOverlay
  // strips those marks and draws a zip/snap placement line instead whenever the photo
  // shows zip/snap, regardless of which of those designs drafted the buttons.
  svg = drawPocketOverlay(svg, attrs, mappedCategory)
  svg = drawWaistbandOverlay(svg, attrs, mappedCategory)
  svg = drawCuffOverlay(svg, attrs, mappedCategory)
  svg = drawZipOverlay(svg, attrs, mappedCategory)
  svg = drawCollarOverlay(svg, attrs, mappedCategory)
  svg = drawBadgeOverlay(svg, attrs)
}
const zipOverlayAdded = !isCustom && JACKET_BUTTON_DESIGNS.has(mappedCategory) && (attrs.closure === 'zipper' || attrs.closure === 'snap')
const out = outArg || `${attrs.garmentCategory}-pattern.svg`
fs.writeFileSync(out, svg)

// The vision stage's read of the garment (fit, closure, pockets, collar, sleeves,
// apparent size) is the only place those attributes exist -- the classify stage's
// JSON has category/block/POMs but none of them. Persist it next to the pattern so
// the UI can show what the draft was actually based on -- plus the measurement set
// and per-size defaults the pattern tab's size/measurement editor redrafts from.
const designOut = out.replace(/\.svg$/i, '') + '-design.json'
const pick = (table) => Object.fromEntries(required.map((k) => [k, table[k] ?? null]))
fs.writeFileSync(designOut, JSON.stringify({
  ...attrs, design: label, designKey: mappedCategory, custom: isCustom, size,
  sizes: SIZE_KEYS,
  measurements: required.map((key) => ({
    key, label: humanLabel(key), how: HOW_TO_MEASURE[key] || '', cm: cm[key] ?? null, overridden: overridden.includes(key),
  })),
  sizeTable: Object.fromEntries(SIZE_KEYS.map((sz) => [sz, pick(defaultMeasurements(sz))])),
  extraPieces,
  patternCheck: patternCheck?.checked ? { samePattern: patternCheck.samePattern, differences: patternCheck.differences } : null,
}, null, 2))
console.log(`design attributes → ${designOut}`)

const pagesOut = out.replace(/\.svg$/i, '') + '-pages.pdf'
const piecesOut = out.replace(/\.svg$/i, '') + '-pieces.json'
await writePartsPdf(svg, pagesOut, label, attrs, coverPhotoArg || photo, piecesOut)
await addPiecePlacement(piecesOut, { designLabel: label, attrs })

const wh = svg.match(/width="([\d.]+)(mm)?".*?height="([\d.]+)(mm)?"/s)
console.log(`\nDesign: ${label}`)
console.log(`Options applied:${applied.length ? '' : ' (none — design defaults)'}`)
for (const a of applied) console.log(`  ${a}`)
for (const s of skipped) console.log(`  skipped: ${s}`)
console.log(`Pieces: ${(svg.match(/class="fs-part"/g) || svg.match(/<g[^>]*part/g) || []).length || 'see file'}`)
for (const piece of extraPieces) console.log(`${isCustom ? 'AI piece' : 'Added cut piece'}: ${piece}`)
if (zipOverlayAdded)
  console.log(`Closure: photo shows ${attrs.closure}, not buttons — ${label}'s button marks were removed and a ${attrs.closure} placement line added down the front instead. Sew in a ${attrs.closure} there; the front seamline itself still stands in for the real closure.`)
if (sleevesRemoved)
  console.log(`Sleeves: photo is sleeveless but ${label} has no sleeveless option — the sleeve/cuff pieces were removed; bind or face the drafted armhole directly.`)
if (wh) console.log(`Size: ${(wh[1] / 10).toFixed(1)} × ${(wh[3] / 10).toFixed(1)} cm — print at 100%`)
console.log(`Saved: ${out}`)
console.log(`Saved (one page per part): ${pagesOut}`)
