// pattern-check.mjs — second gate before a catalogue pattern is used.
//
// A high catalogue similarity says the photo is the same KIND of garment as a
// catalogue design; it doesn't prove that design's actual cut pieces build it. So
// the vision model gets the input image plus the catalogue design's own drafted
// pieces (small renders, labelled) and answers one question: would sewing exactly
// these pieces give this garment -- same panels, seam / yoke lines, collar, closure,
// pockets, sleeve type, length? If not, the garment is drafted by AI instead.
//
// No API key, or the check itself fails -> the catalogue pattern is kept (nothing to
// judge with). MOCK_PATTERN_CHECK='{"samePattern":false,"differences":[...]}' mocks it.
import fs from 'fs'
import path from 'path'
import { GoogleGenAI } from '@google/genai'

const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

function sniffMedia(file) {
  const b = fs.readFileSync(file)
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  return MEDIA[path.extname(file).toLowerCase()] || 'image/png'
}

// thumbs: [{ suffix, png: Buffer, wCm, hCm }]
export async function checkCataloguePattern(photoPath, designLabel, thumbs, attrs) {
  const fallback = { samePattern: true, differences: [], checked: false }
  if (process.env.MOCK_PATTERN_CHECK) return { ...JSON.parse(process.env.MOCK_PATTERN_CHECK), checked: true }
  if (process.env.MOCK_VISION) return fallback
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY
  if (!apiKey || !thumbs.length) return fallback
  const parts = [
    { text: `INPUT garment ("${attrs?.notes || ''}"):` },
    { inlineData: { mimeType: sniffMedia(photoPath), data: fs.readFileSync(photoPath).toString('base64') } },
    { text: `Below are ALL the cut pieces of the catalogue sewing pattern "${designLabel}" (each image is one piece, labelled with its name and size; half pieces are cut on the fold or in pairs).` },
  ]
  for (const t of thumbs) {
    parts.push({ text: `Piece "${t.suffix}" (${t.wCm.toFixed(0)} x ${t.hCm.toFixed(0)} cm):` })
    parts.push({ inlineData: { mimeType: 'image/png', data: t.png.toString('base64') } })
  }
  parts.push({
    text: `You are a garment technologist. If someone cut and sewed exactly these pieces, would they get the INPUT garment's construction? ` +
      `Compare the panel layout and seam lines (yokes, princess seams, panel splits), collar type, closure type, pocket construction, sleeve type (set-in / raglan / dropped), cuffs, hem band and length. ` +
      `Ignore colour, fabric, quilting stitch lines, trims, badges and small size differences. ` +
      `Respond with ONLY a raw JSON object: {"samePattern": <true only if the construction genuinely matches>, "differences": ["<short construction difference>", ...]}`,
  })
  try {
    const client = new GoogleGenAI({ apiKey })
    const res = await client.models.generateContent({ model: 'gemini-2.5-pro', contents: [{ role: 'user', parts }] })
    const obj = JSON.parse((res.text || '').replace(/```json|```/g, '').trim())
    if (typeof obj.samePattern !== 'boolean') throw new Error('bad answer')
    return {
      samePattern: obj.samePattern,
      differences: Array.isArray(obj.differences) ? obj.differences.map(String).slice(0, 8) : [],
      checked: true,
    }
  } catch (e) {
    console.error(`Note: catalogue pattern check unavailable (${e.message}) — keeping the catalogue pattern.`)
    return fallback
  }
}
