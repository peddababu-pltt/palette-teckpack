// pattern-check.mjs — second gate before a catalogue pattern is used.
//
// Vision saying the photo is the same garment as a catalogue design (sameGarment)
// doesn't prove that design's actual cut pieces build it. So
// the vision model gets the input image plus the catalogue design's own drafted
// pieces (small renders, labelled) and answers one question: would sewing exactly
// these pieces give this garment -- same panels, seam / yoke lines, collar, closure,
// pockets, sleeve type, length? If not, the garment is drafted by AI instead.
//
// No API key, or the check itself fails -> the catalogue pattern is kept (nothing to
// judge with). MOCK_PATTERN_CHECK='{"samePattern":false,"differences":[...]}' mocks it.
import fs from 'fs'
import { ADAPTED_DETAILS } from './catalogue.mjs'
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
    text: `You are a garment technologist. If someone cut and sewed exactly these pieces, would they get the INPUT garment's BODY construction? ` +
      `Compare the panel layout and seam lines (yokes, princess seams, panel splits), sleeve type (set-in / raglan / dropped / sleeveless), collar family (shirt collar + stand / stand collar / hood / lapel / none) and length class. ` +
      `Our software adapts these on its own, so they are NOT differences and must not make samePattern false: ${ADAPTED_DETAILS}. Also ignore small size differences. ` +
      `List only real body-construction differences. ` +
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


// Same idea for an AI-drafted (non-catalogue) garment: the drafted pieces are shown
// next to the input and the model names every construction mistake -- wrong sleeve
// type (raglan / set-in / dropped), a missing or invented piece, wrong opening,
// yoke, length or proportions. The caller redrafts once with these as feedback.
// MOCK_CUSTOM_CHECK='{"ok":false,"problems":[...]}' mocks it; no key -> treated as ok.
export async function checkCustomPattern(photoPath, thumbs, construction, attrs) {
  const fallback = { ok: true, problems: [], checked: false }
  if (process.env.MOCK_CUSTOM_CHECK) return { ...JSON.parse(process.env.MOCK_CUSTOM_CHECK), checked: true }
  if (process.env.MOCK_VISION || process.env.MOCK_CUSTOM_PIECES) return fallback
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY
  if (!apiKey || !thumbs.length) return fallback
  const parts = [
    { text: `INPUT garment ("${attrs?.notes || ''}"):` },
    { inlineData: { mimeType: sniffMedia(photoPath), data: fs.readFileSync(photoPath).toString('base64') } },
    { text: `Our drafted sewing pattern for it. Construction used: ${JSON.stringify(construction || {})}. ` +
      `Each image below is one cut piece, labelled with its name and size. Symmetric pieces are drawn as a half to cut on the fold.` },
  ]
  for (const t of thumbs) {
    parts.push({ text: `Piece "${t.suffix}" (${t.wCm.toFixed(0)} x ${t.hCm.toFixed(0)} cm):` })
    parts.push({ inlineData: { mimeType: 'image/png', data: t.png.toString('base64') } })
  }
  parts.push({
    text: `You are a senior pattern maker checking this pattern before it is cut. If someone cut and sewed exactly these pieces, ` +
      `would they get the INPUT garment? Check each, against the image:\n` +
      `1. SLEEVE TYPE: raglan (a diagonal seam from the neckline down to the underarm, no shoulder seam on the body -- the body pieces ` +
      `must have a slanted neck-to-armhole edge and the sleeve must include the shoulder) vs set-in (seam at the shoulder point, round ` +
      `armhole) vs dropped (shoulder seam falls onto the upper arm, flat sleeve cap) vs sleeveless.\n` +
      `2. PIECES: every panel the image shows has a piece (front, back, sleeve, collar, collar stand, hood, yokes, side panels, facings, ` +
      `bands, cuffs, pockets...), and there is no piece for something the image does not show.\n` +
      `3. FRONT OPENING (zip / buttons / snaps / none), YOKES, COLLAR TYPE, HEM shape and band.\n` +
      `4. PROPORTIONS: body length class (cropped / hip / thigh / knee / ankle), sleeve length, width/fit relative to each other.\n` +
      `Ignore drawing style, seam allowance lines, grid, labels and small size differences. ` +
      `Respond with ONLY a raw JSON object: {"ok": <true only if these pieces really build this garment>, ` +
      `"problems": ["<specific mistake and what the image actually shows, e.g. 'sleeves are set-in but the garment has raglan sleeves'>", ...]}`,
  })
  try {
    const client = new GoogleGenAI({ apiKey })
    const res = await client.models.generateContent({ model: 'gemini-2.5-pro', contents: [{ role: 'user', parts }] })
    const obj = JSON.parse((res.text || '').replace(/```json|```/g, '').trim())
    if (typeof obj.ok !== 'boolean') throw new Error('bad answer')
    return { ok: obj.ok, problems: Array.isArray(obj.problems) ? obj.problems.map(String).slice(0, 10) : [], checked: true }
  } catch (e) {
    console.error(`Note: custom pattern check unavailable (${e.message}) — keeping the draft.`)
    return fallback
  }
}
