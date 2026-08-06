// photo-draft.helpers.mjs — pure SVG string-processing helpers shared by
// photo-draft.mjs's overlay-drawing functions. Split out from photo-draft.mjs
// (which runs as a script with top-level side effects) so they're independently
// unit-testable without invoking the vision/drafting pipeline.

// Finds every top-level piece stack (freesewing's own per-piece <g id="fs-stack-*">
// wrapper) whose suffix (the part of its id after the design name) matches suffixRe,
// and computes its bounding box from every numeric coordinate pair found in its
// content — same technique layoutFrontBack() already uses in photo-draft.mjs.
export function findStacks(svg, suffixRe) {
  const re = /<!-- Start of group #fs-stack-([\w]+)\.(\w+) -->\s*<g id="fs-stack-\1\.\2"\s+transform="translate\(([-\d.]+), ([-\d.]+)\)">([\s\S]*?)<\/g>\s*<!-- end of group #fs-stack-\1\.\2 -->/g
  const out = []
  for (const m of svg.matchAll(re)) {
    const [, name, suffix, tx, ty, content] = m
    if (!suffixRe.test(suffix)) continue
    const pairs = [...content.matchAll(/(-?\d+\.?\d*),(-?\d+\.?\d*)/g)]
    if (!pairs.length) continue
    const xs = pairs.map((p) => +p[1])
    const ys = pairs.map((p) => +p[2])
    out.push({
      name: `${name}.${suffix}`, suffix, tx: +tx, ty: +ty,
      minX: Math.min(...xs), maxX: Math.max(...xs),
      minY: Math.min(...ys), maxY: Math.max(...ys),
      content,
    })
  }
  return out
}

// Reads the y-coordinate of a freesewing-drawn guideline (the hidden path backing a
// "chest line" / "waist line" textPath label) within one piece's content, in that
// piece's own local coordinate space. Returns null if the piece doesn't draw that
// particular guideline — callers must fall back to a bbox-percentage estimate.
export function findGuideline(pieceContent, key) {
  const re = new RegExp(`data-text="[a-zA-Z]+:${key}[^"]*"[^>]*\\bd="M\\s*[-\\d.]+,([-\\d.]+)\\s*L`)
  const m = pieceContent.match(re)
  return m ? parseFloat(m[1]) : null
}

// Removes entire top-level piece stacks whose suffix matches suffixRe — for pieces a
// design always drafts unconditionally even when the photo doesn't have them (e.g.
// Simon has no sleeveless option, so it drafts a full sleeve even for a sleeveless
// shirt photo). Matches on the FULL "name.suffix" backreference so the non-greedy
// content match can't stop early at the nested "-part-" group's own closing tag —
// same technique extractStacks() in photo-draft.mjs already relies on.
export function removeStacks(svg, suffixRe) {
  const re = /<!--\s*Start of group #fs-stack-([\w]+\.([\w]+))\s*-->\s*<g id="fs-stack-\1"\s+transform="translate\([-\d.]+,\s*[-\d.]+\)">[\s\S]*?<\/g>\s*<!--\s*end of group #fs-stack-\1\s*-->\n?/g
  return svg.replace(re, (m, full, suffix) => (suffixRe.test(suffix) ? '' : m))
}

// Inserts raw SVG markup as the last child of a piece's innermost "part" group (the
// <g id="fs-stack-NAME-part-NAME"> freesewing always nests one level inside the outer
// <g id="fs-stack-NAME">), so the markup shares that group's local coordinate space
// with the piece's own cutlines/guidelines.
export function injectIntoStack(svg, stackName, markup) {
  const esc = stackName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const stackRe = new RegExp(`(<!-- Start of group #fs-stack-${esc} -->[\\s\\S]*?)(<\\/g>\\s*<!-- end of group #fs-stack-${esc} -->)`)
  return svg.replace(stackRe, (whole, body, tail) => {
    const partCloseRe = new RegExp(`<\\/g>\\s*<!-- end of group #fs-stack-${esc}-part-${esc} -->`)
    if (partCloseRe.test(body)) {
      return body.replace(partCloseRe, `${markup}\n$&`) + tail
    }
    return `${body}${markup}\n` + tail
  })
}

// Designs that already draft real pocket bags/welts of their own — never overlay
// a placement guide on top of a real piece.
export const NO_POCKET_OVERLAY = new Set([
  'charlie', 'carlita', 'jett', 'carlton', 'devon', 'cornelius', 'ashley', 'shale',
  'huey', 'hugo', 'lumina', 'wahid', 'albert',
])

// Freesewing convention: front pieces draft with the center-front seam at the local
// x closest to 0, extending out toward the side seam at the far x. Works for both a
// full symmetric front (one piece, CF at x=0, side seams at ±maxX) and a split
// frontleft/frontright pair (each half's own CF edge sits near 0, its side-seam edge
// is the far bound) — used to turn a 0..1 "distance from center front" fraction from
// vision into a real local x inside whichever front piece(s) a design drafts.
function centerAndSideX(piece) {
  const centerX = Math.abs(piece.minX) < Math.abs(piece.maxX) ? piece.minX : piece.maxX
  const sideX = centerX === piece.minX ? piece.maxX : piece.minX
  return { centerX, sideX }
}

// Draws a dashed placement guide (not a real cutline) for a pocket the mapped
// design's block has no piece for. Position comes straight from vision's
// horizontalFraction/verticalFraction (0..1 across the piece's own bbox) — no
// guideline lookup or fixed chest/hip estimate needed anymore.
export function drawPocketOverlay(svg, attrs, mappedCategory) {
  if (NO_POCKET_OVERLAY.has(mappedCategory)) return svg
  if (!attrs.pockets || attrs.pockets.type === 'none') return svg
  const { type, count, widthCm, heightCm, horizontalFraction, verticalFraction } = attrs.pockets
  const fronts = findStacks(svg, /front/i)
  if (!fronts.length) return svg
  const targets = count === 1 ? fronts.slice(0, 1) : fronts
  // widthCm/heightCm are real-world pocket-opening size from the photo; fall back to
  // the old fixed guesses only when vision couldn't estimate one (0 or missing).
  const w = (widthCm > 0 ? widthCm * 10 : 14)
  const openingH = (heightCm > 0 ? heightCm * 10 : 8)
  const patchH = (heightCm > 0 ? heightCm * 10 : 160)
  for (const piece of targets) {
    const { centerX, sideX } = centerAndSideX(piece)
    const cx = centerX + horizontalFraction * (sideX - centerX)
    const y = piece.minY + verticalFraction * (piece.maxY - piece.minY)
    let markup
    if (type === 'welt') {
      markup = `<path d="M ${cx - w / 2},${y} L ${cx + w / 2},${y} M ${cx - w / 2},${y + openingH} L ${cx + w / 2},${y + openingH}" stroke="#000" stroke-width="1" stroke-dasharray="4,3" fill="none"/>` +
        `<text x="${cx}" y="${y + openingH + 14}" text-anchor="middle" font-size="9">welt pocket — add</text>`
    } else if (type === 'flap') {
      markup = `<path d="M ${cx - w / 2},${y} L ${cx + w / 2},${y}" stroke="#000" stroke-width="1" stroke-dasharray="4,3" fill="none"/>` +
        `<path d="M ${cx - w / 2},${y} L ${cx - w / 2},${y + openingH * 3.75} L ${cx + w / 2},${y + openingH * 3.75} L ${cx + w / 2},${y}" stroke="#000" stroke-width="1" stroke-dasharray="4,3" fill="none"/>` +
        `<text x="${cx}" y="${y + openingH * 3.75 + 14}" text-anchor="middle" font-size="9">flap pocket — add</text>`
    } else {
      markup = `<path d="M ${cx - w / 2},${y} L ${cx + w / 2},${y} L ${cx + w / 2},${y + patchH} L ${cx - w / 2},${y + patchH} Z" stroke="#000" stroke-width="1" stroke-dasharray="4,3" fill="none"/>` +
        `<text x="${cx}" y="${y + patchH + 14}" text-anchor="middle" font-size="9">patch pocket — add</text>`
    }
    svg = injectIntoStack(svg, piece.name, markup)
  }
  return svg
}

// Designs that already draft a real waistband piece — Charlie (waistband.mjs,
// waistbandCurved.mjs), Shin (waistband.mjs), and the rest below (each has its own
// waistband/waistband-front/waistband-back/waistband_ends piece). Never overlay a
// marking on those.
export const NO_WAISTBAND_OVERLAY = new Set([
  'charlie', 'shin', 'ashley', 'cornelius', 'shale', 'penelope', 'sandy',
])
export const WAISTBAND_CATEGORIES = new Set([
  'trousers', 'cycling_breeches', 'shorts', 'shorts_cargo',
  'skirt_pencil', 'skirt_circle', 'skirt', 'jumpsuit', 'overalls',
])

// Marks where a separate waistband strip should be added, for trouser/short/skirt-
// family designs whose block doesn't draft a real waistband piece.
export function drawWaistbandOverlay(svg, attrs, mappedCategory) {
  if (!WAISTBAND_CATEGORIES.has(attrs.garmentCategory)) return svg
  if (NO_WAISTBAND_OVERLAY.has(mappedCategory)) return svg
  if (!attrs.waistband || attrs.waistband === 'none' || attrs.waistband === 'n/a') return svg
  const fronts = findStacks(svg, /front/i)
  if (!fronts.length) return svg
  const heightMm = attrs.waistband === 'banded' ? 60 : 40
  for (const piece of fronts) {
    const fallback = piece.minY + (piece.maxY - piece.minY) * 0.15
    const y = findGuideline(piece.content, 'waistLine') ?? fallback
    const width = piece.maxX - piece.minX
    const markup = `<path d="M ${piece.minX},${y} L ${piece.maxX},${y}" stroke="#000" stroke-width="1" stroke-dasharray="6,3" fill="none"/>` +
      `<text x="${piece.minX + width / 2}" y="${y - 6}" text-anchor="middle" font-size="9">${attrs.waistband} waistband — add separate strip, ~${heightMm}mm tall</text>`
    svg = injectIntoStack(svg, piece.name, markup)
  }
  return svg
}

// Simon/Simone, Carlita/Carlton, Devon, Wahid, and Jett all draft a real button-front
// placket as their fixed default closure. A photo showing an actual zip/snap front
// doesn't wear those buttons at all — strip them and mark a zip/snap line instead.
// (Every other design that stamps #button snippets — Ashley/Charlie/Cornelius/Sandy —
// does so for a trouser/skirt fly or waistband, not a jacket front, so they're excluded.)
export const JACKET_BUTTON_DESIGNS = new Set(['carlita', 'carlton', 'simon', 'simone', 'devon', 'wahid', 'jett'])

// Strips the mismatched button marks and marks a straight zip/snap line instead.
// The line's x comes from the design's own already-drafted button points (their
// average x sits right on the real front-edge seam); its y-span comes from vision's
// zipTopFraction/zipBottomFraction against the piece's full collar-to-hem bbox
// (0/1 for a "full" zip, a narrower span for a "partial" one like a half-zip).
export function drawZipOverlay(svg, attrs, mappedCategory) {
  if (!JACKET_BUTTON_DESIGNS.has(mappedCategory)) return svg
  if (attrs.closure !== 'zipper' && attrs.closure !== 'snap') return svg
  const fronts = findStacks(svg, /front/i)
  if (!fronts.length) return svg
  const topFrac = attrs.zipLength === 'partial' ? attrs.zipTopFraction : 0
  const bottomFrac = attrs.zipLength === 'partial' ? attrs.zipBottomFraction : 1
  for (const piece of fronts) {
    const pts = [...piece.content.matchAll(/<use x="(-?[\d.]+)" y="(-?[\d.]+)" xlink:href="#button"/g)]
      .map((m) => ({ x: +m[1], y: +m[2] }))
    const x = pts.length ? pts.reduce((sum, p) => sum + p.x, 0) / pts.length : centerAndSideX(piece).centerX
    const y1 = piece.minY + topFrac * (piece.maxY - piece.minY)
    const y2 = piece.minY + bottomFrac * (piece.maxY - piece.minY)
    const markup = `<path d="M ${x},${y1} L ${x},${y2}" stroke="#000" stroke-width="1.5" stroke-dasharray="2,2" fill="none"/>` +
      `<text x="${x + 8}" y="${(y1 + y2) / 2}" font-size="9">${attrs.closure} — attach here</text>`
    svg = injectIntoStack(svg, piece.name, markup)
  }
  // Only JACKET_BUTTON_DESIGNS members reach this function, and only their front
  // piece(s) stamp #button/#buttonhole at all — safe to strip every such snippet in
  // the document. Simon/Simone draw both a button AND a separate buttonhole mark per
  // closure point (the placket's two sides); #button alone would leave orphaned slits.
  return svg
    .replace(/<use[^>]*xlink:href="#button"[^>]*>\s*<\/use>/g, '')
    .replace(/<use[^>]*xlink:href="#buttonhole"[^>]*>\s*<\/use>/g, '')
}

// Designs that draft a real cuff piece of their own that is NOT a ribbed knit band
// (Simon/Simone: barrel/french cuff.mjs; Carlton: tailored cuffFacing; Devon: denim
// cuff tab). These need the "mismatch" framing (ribbed vs. what's already drafted) —
// a "buttoned" cuff photo matches what they draft, but a "ribbed" one doesn't.
export const CUFF_PIECE_DESIGNS = new Set(['simon', 'simone', 'carlton', 'devon'])

// Designs whose own cuff piece IS already a ribbed knit band (Jett's bomber cuff;
// Hannah/Huey/Hugo/Sven/Tina's hoodie/sweatshirt cuff, several sharing Toni's
// cuff.mjs internally) — a "ribbed" photo is not a mismatch here the way it is for
// Simon's buttoned/barrel cuff, so no overlay at all.
export const RIBBED_CUFF_PIECE_DESIGNS = new Set(['jett', 'hannah', 'huey', 'hugo', 'sven', 'tina'])

// Designs that already draft a real collar/lapel piece of their own, and which
// collarStyle that piece actually matches — Simon/Simone's spread shirt collar,
// Carlton/Carlita's notch-lapel coat collar, Devon's denim-jacket collar (spread-
// style stand+leaf), Jett's ribbed bomber collar (reads as a mandarin/band collar).
// Every other mapped design (t-shirt/tank/hoodie/wrap/vest/bottoms/...) drafts no
// separate collar piece at all — just its own crew/V/hood neckline.
export const COLLAR_STYLE_BY_DESIGN = {
  simon: 'spread', simone: 'spread',
  carlton: 'notch_lapel', carlita: 'notch_lapel',
  devon: 'spread',
  jett: 'mandarin',
}

// Marks a mismatch between the photo's actual collar construction and whatever the
// mapped design already drafts (or a missing collar entirely, for designs with none).
// Like drawCuffOverlay/drawZipOverlay, this never touches a piece that already
// matches — only flags the gap with a placement/replacement guide.
export function drawCollarOverlay(svg, attrs, mappedCategory) {
  if (!attrs.collarStyle || attrs.collarStyle === 'none' || attrs.collarStyle === 'n/a') return svg
  const expected = COLLAR_STYLE_BY_DESIGN[mappedCategory]
  if (expected === attrs.collarStyle) return svg
  const fronts = findStacks(svg, /front/i)
  if (!fronts.length) return svg
  const label = expected
    ? `${attrs.collarStyle} collar — replace drafted ${expected} collar with a ${attrs.collarStyle} one`
    : `${attrs.collarStyle} collar — add separate collar piece, this block has none`
  for (const piece of fronts) {
    const { centerX } = centerAndSideX(piece)
    const y = piece.minY + 6
    const markup = `<path d="M ${piece.minX + 10},${y} L ${piece.maxX - 10},${y}" stroke="#000" stroke-width="1" stroke-dasharray="3,3" fill="none"/>` +
      `<text x="${centerX}" y="${y - 4}" text-anchor="middle" font-size="9">${label}</text>`
    svg = injectIntoStack(svg, piece.name, markup)
  }
  return svg
}

// Marks a chest applique/patch badge the mapped design's block has no piece for —
// same dashed-placement-guide treatment as drawPocketOverlay, but a single instance
// (a badge never comes in a bilateral left/right pair the way pockets can).
export function drawBadgeOverlay(svg, attrs) {
  if (!attrs.badge || !attrs.badge.present) return svg
  const fronts = findStacks(svg, /front/i)
  if (!fronts.length) return svg
  const piece = fronts[0]
  const { centerX, sideX } = centerAndSideX(piece)
  const w = attrs.badge.widthCm > 0 ? attrs.badge.widthCm * 10 : 70
  const h = attrs.badge.heightCm > 0 ? attrs.badge.heightCm * 10 : 70
  const cx = centerX + attrs.badge.horizontalFraction * (sideX - centerX)
  const y = piece.minY + attrs.badge.verticalFraction * (piece.maxY - piece.minY)
  const markup = `<path d="M ${cx - w / 2},${y} L ${cx + w / 2},${y} L ${cx + w / 2},${y + h} L ${cx - w / 2},${y + h} Z" stroke="#000" stroke-width="1" stroke-dasharray="2,2" fill="none"/>` +
    `<text x="${cx}" y="${y + h + 12}" text-anchor="middle" font-size="9">badge — appliqué placement, add</text>`
  svg = injectIntoStack(svg, piece.name, markup)
  return svg
}

// Marks a ribbed/buttoned cuff band at the sleeve hem, either because the block has no
// cuff piece at all, or (Simon only) because the photo shows ribbing where the block
// drafts a buttoned cuff instead. Band height comes from vision's cuffWidthCm when
// given, falling back to the old fixed 20mm guess otherwise.
export function drawCuffOverlay(svg, attrs, mappedCategory) {
  if (RIBBED_CUFF_PIECE_DESIGNS.has(mappedCategory) && attrs.cuffs === 'ribbed') return svg
  const hasCuffPiece = CUFF_PIECE_DESIGNS.has(mappedCategory)
  const needsOverlay = attrs.cuffs === 'ribbed' || (attrs.cuffs === 'buttoned' && !hasCuffPiece)
  if (!needsOverlay) return svg
  const sleeves = findStacks(svg, /^(top|under)?sleeve$/i)
  if (!sleeves.length) return svg
  const bandH = attrs.cuffWidthCm > 0 ? attrs.cuffWidthCm * 10 : 20
  for (const piece of sleeves) {
    const y = piece.maxY - bandH
    const width = piece.maxX - piece.minX
    const third = bandH / 3
    const markup = `<path d="M ${piece.minX + 10},${y} L ${piece.maxX - 10},${y} M ${piece.minX + 10},${y + third} L ${piece.maxX - 10},${y + third} M ${piece.minX + 10},${y + 2 * third} L ${piece.maxX - 10},${y + 2 * third}" stroke="#000" stroke-width="0.5" fill="none"/>` +
      `<text x="${piece.minX + width / 2}" y="${y + bandH + 6}" text-anchor="middle" font-size="9">ribbed cuff — add band, ~${bandH.toFixed(0)}mm</text>`
    svg = injectIntoStack(svg, piece.name, markup)
  }
  return svg
}
