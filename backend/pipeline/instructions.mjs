// instructions.mjs — AI-generated sewing/assembly instructions per cut piece.
// An earlier version scraped freesewing.eu's own instructions pages and fuzzy-matched
// pieces to sections by keyword — too fragile (heading conventions vary per design: some
// number "Step N: Title", some don't; matching often picked the wrong section or none at
// all). Generating instructions directly with the same AI model already used for garment
// analysis is more reliable: it reasons about the SPECIFIC piece (suffix) and this
// garment's actual detected details, instead of matching against whatever prose happens
// to exist on an unrelated doc page.
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { GoogleGenAI } from '@google/genai'

const CACHE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '.cache', 'instructions')

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function cacheKey(designLabel, suffix) {
  return `${designLabel}__${suffix}`.replace(/[^a-z0-9_.-]/gi, '_')
}

// Returns a short plain-text instruction card for this one piece, or null when there's no
// API key configured, we're in offline/test mode (MOCK_VISION), or generation fails — any
// of which just falls back to a plain cut-piece-only page, same as before this feature.
export async function generatePieceInstructions(designLabel, suffix, attrs) {
  ensureDir(CACHE_DIR)
  const key = cacheKey(designLabel, suffix)
  const cacheFile = path.join(CACHE_DIR, `${key}.txt`)
  if (fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, 'utf8')

  if (process.env.MOCK_VISION) return null

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY
  if (!apiKey) return null

  const prompt = `You are writing a short sewing instruction card for ONE cut pattern piece, to print next to that piece's cutline diagram.
Design: ${designLabel}
Piece name: ${suffix}
Garment details: ${attrs?.notes || ''} closure=${attrs?.closure || 'n/a'} pockets=${attrs?.pockets?.type || 'none'} cuffs=${attrs?.cuffs || 'n/a'} waistband=${attrs?.waistband || 'n/a'}

Write 3-6 short numbered steps for how this SPECIFIC piece is sewn or attached during construction (not instructions for the whole garment). Assume home-sewing skill level, plain practical language, no fluff. If this piece has no meaningful standalone sewing step (e.g. it's a facing/interfacing/lining consumed as part of another piece's step), say that briefly in one line instead of inventing steps. Plain numbered lines only, no markdown formatting.`

  try {
    const client = new GoogleGenAI({ apiKey })
    const res = await client.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })
    const text = (res.text || '').trim()
    if (text) fs.writeFileSync(cacheFile, text)
    return text || null
  } catch (e) {
    console.error(`Note: AI instruction generation failed for ${designLabel}/${suffix} (${e.message}) — page will show cut piece only.`)
    return null
  }
}
