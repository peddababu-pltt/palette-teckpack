// piece-placement.mjs — AI read of where every cut piece goes on the body, for the
// sewing pattern tab's 3D preview.
//
// Piece names alone are a poor guide (Carlton's "frontFacing", Simon's
// "sleevePlacketOverlap", trouser "front"/"back" that are legs, not a bodice), and
// which edge of a half-piece is its centre front can't be read off a name at all.
// So the vision model looks at every piece's texture (the same transparent PNGs the
// 3D view uses, labelled by name + cut size) together with what the garment is, and
// returns per piece: its role, which edge is the centre line, and where it's sewn.
//
// Result is merged into pattern-pieces.json as `place` per piece + a top-level
// `garment` block. Optional: no API key, offline mode (MOCK_VISION) or any failure
// -> nothing is added, and the viewer falls back to its own name-based rules.
import fs from 'fs'
import path from 'path'
import { GoogleGenAI } from '@google/genai'

// Piece categories (the garment pipeline's vocabulary). Extensible: the viewer treats
// an unknown category as needs_review, never guesses a place for it.
export const PIECE_CATEGORIES = [
  // upper
  'bodice_front', 'bodice_back', 'side_panel', 'yoke', 'shoulder', 'sleeve', 'sleeve_left', 'sleeve_right',
  'collar', 'collar_stand', 'neckline', 'cuff', 'placket', 'hood',
  // lower
  'skirt_front', 'skirt_back', 'skirt_side', 'trouser_front', 'trouser_back', 'waistband', 'leg_panel', 'gusset',
  // either / other
  'pocket', 'pocket_flap', 'facing', 'lining', 'interfacing', 'belt', 'strap', 'tie', 'badge', 'accessory', 'other',
]
const LAYERS = ['upper', 'lower', 'accessory']
const SIDES = ['front', 'back', 'left', 'right', 'none']
const EDGES = ['left', 'right', 'none']
const GARMENTS = ['upper', 'lower', 'full']
export const REVIEW_BELOW = 0.6

const HINT = `Respond with ONLY a raw JSON object, no prose, no markdown fences:
{
  "garment": { "type": "<shirt | jacket | coat | top | dress | skirt | trousers | shorts | jumpsuit | hoodie | ...>", "region": "upper | lower | full", "has_upper": <bool>, "has_lower": <bool>, "fabric": "cotton | denim | silk | wool | linen | leather | knit | mesh" },
  "pieces": [
    {
      "suffix": "<the piece name exactly as labelled>",
      "category": "${PIECE_CATEGORIES.join(' | ')}",
      "garment_layer": "upper | lower | accessory"  <- which garment the piece belongs to: tops/jackets/sleeves/collars = upper; skirts/trousers/waistbands of bottoms = lower; belts/straps/badges/ties = accessory,
      "side": "front | back | left | right | none",
      "centreEdge": "left | right | none"  <- ONLY for a half of a symmetric panel (bodice/skirt/trouser halves, yokes): which image edge lies on the body's centre line (centre front/back; for trouser legs the crotch-side edge). "none" otherwise,
      "confidence": <number 0..1>  <- how sure you are of category + layer,
      "sewnOn": "<3-8 words: where it attaches>"
    }
  ]
}`

const toPart = (file) => ({ inlineData: { mimeType: 'image/png', data: fs.readFileSync(file).toString('base64') } })

function validate(obj, suffixes) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.pieces)) throw new Error('bad shape')
  const g = obj.garment || {}
  const garment = {
    type: typeof g.type === 'string' ? g.type.slice(0, 40) : null,
    region: GARMENTS.includes(g.region) ? g.region : null,
    has_upper: typeof g.has_upper === 'boolean' ? g.has_upper : null,
    has_lower: typeof g.has_lower === 'boolean' ? g.has_lower : null,
    fabric: typeof g.fabric === 'string' ? g.fabric.slice(0, 20) : null,
  }
  const place = {}
  for (const p of obj.pieces) {
    if (!suffixes.includes(p?.suffix)) continue
    const known = PIECE_CATEGORIES.includes(p.category)
    const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(1, p.confidence)) : 0.5
    place[p.suffix] = {
      category: known ? p.category : 'other',
      garmentLayer: LAYERS.includes(p.garment_layer) ? p.garment_layer : null,
      side: SIDES.includes(p.side) ? p.side : 'none',
      centreEdge: EDGES.includes(p.centreEdge) ? p.centreEdge : 'none',
      confidence,
      status: known && LAYERS.includes(p.garment_layer) && confidence >= REVIEW_BELOW ? 'ok' : 'needs_review',
      sewnOn: typeof p.sewnOn === 'string' ? p.sewnOn.slice(0, 80) : '',
    }
  }
  if (!Object.keys(place).length) throw new Error('no usable pieces')
  return { garment, place }
}

// Adds AI placement to pattern-pieces.json in place. Never throws.
export async function addPiecePlacement(piecesJsonPath, { designLabel, attrs, sheetPath = null }) {
  if (process.env.MOCK_VISION && !process.env.MOCK_PLACEMENT) return false
  let index
  try {
    index = JSON.parse(fs.readFileSync(piecesJsonPath, 'utf8'))
  } catch {
    return false
  }
  const suffixes = index.pieces.map((p) => p.suffix)
  let result
  try {
    if (process.env.MOCK_PLACEMENT) {
      result = validate(JSON.parse(process.env.MOCK_PLACEMENT), suffixes)
    } else {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY
      if (!apiKey) return false
      const dir = path.dirname(piecesJsonPath)
      const parts = [{
        text: `You are a garment technologist placing the cut pieces of a sewing pattern onto a 3D body for a preview. ` +
          `Garment: ${attrs?.notes || ''} (category ${attrs?.garmentCategory || 'n/a'}, pattern ${designLabel}). ` +
          `Each image below is ONE cut piece exactly as drafted (blue = fabric inside the cutline, top of the image = top of the piece), preceded by its name and cut size. Classify every piece; do not guess — give low confidence when unsure.`,
      }]
      if (sheetPath && fs.existsSync(sheetPath)) {
        // the whole uploaded sheet: layout and relative sizes say a lot (fronts side
        // by side, sleeves beside the body, bands as long strips, notches, labels)
        parts.push({ text: 'The whole pattern sheet the pieces were cut from (pieces are numbered in reading order: top-to-bottom, left-to-right):' })
        const ext = path.extname(sheetPath).toLowerCase()
        parts.push({ inlineData: { mimeType: ext === '.png' ? 'image/png' : 'image/jpeg', data: fs.readFileSync(sheetPath).toString('base64') } })
      }
      for (const p of index.pieces) {
        parts.push({ text: `Piece "${p.suffix}" — ${(p.cutMm.w / 10).toFixed(1)} x ${(p.cutMm.h / 10).toFixed(1)} cm${p.onFold ? ', cut on the fold (image shows half; the fold is the centre line)' : ''}:` })
        parts.push(toPart(path.join(dir, p.file)))
      }
      parts.push({ text: HINT })
      const client = new GoogleGenAI({ apiKey })
      const ask = async (extra = '') => {
        const res = await client.models.generateContent({
          model: 'gemini-3.8-flash',
          contents: [{ role: 'user', parts: extra ? [...parts, { text: extra }] : parts }],
        })
        return JSON.parse((res.text || '').replace(/```json|```/g, '').trim())
      }
      try {
        result = validate(await ask(), suffixes)
      } catch {
        result = validate(await ask('Your previous answer was invalid. Follow the schema EXACTLY and use the piece names as given.'), suffixes)
      }
    }
  } catch (e) {
    console.error(`Note: AI piece placement unavailable (${e.message}) — the 3D view uses its own placement rules.`)
    return false
  }
  index.garment = result.garment
  index.pieces = index.pieces.map((p) => (result.place[p.suffix] ? { ...p, place: result.place[p.suffix] } : p))
  fs.writeFileSync(piecesJsonPath, JSON.stringify(index, null, 2))
  console.log(`3D placement (AI): ${Object.entries(result.place).map(([s, v]) => `${s}=${v.category}/${v.garmentLayer}${v.status === 'needs_review' ? '(review)' : ''}`).join(', ')}`)
  return true
}
