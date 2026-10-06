// pattern-image.mjs — after pattern_segment.py has cut an uploaded pattern image into
// pieces: classify every piece with the vision model (piece-placement.mjs, same schema
// as drafted patterns) and write the pattern-design.json the 3D workspace reads
// (garment type + a default body to fit to).
//
// Usage: node pattern-image.mjs <jobdir> [size] [sheet.png]
import fs from 'fs'
import path from 'path'
try { process.loadEnvFile(new URL('./.env', import.meta.url)) } catch {}
import { addPiecePlacement } from './piece-placement.mjs'
import { defaultMeasurements, humanLabel, HOW_TO_MEASURE, SIZE_KEYS } from './designs.mjs'
import { CUSTOM_MEASUREMENTS } from './extra-pieces.mjs'

const dir = process.argv[2]
const size = SIZE_KEYS.includes(process.argv[3]) ? process.argv[3] : 'M'
const sheet = process.argv[4] || null
if (!dir) {
  console.error('usage: node pattern-image.mjs <jobdir> [size]')
  process.exit(1)
}
const piecesJson = path.join(dir, 'pattern-pieces.json')
console.log('classifying pattern pieces')
const ok = await addPiecePlacement(piecesJson, {
  designLabel: 'uploaded pattern pieces',
  attrs: { notes: 'sewing pattern pieces from an uploaded image', garmentCategory: 'unknown' },
  sheetPath: sheet,
})
if (!ok) console.log('Note: AI classification unavailable — pieces keep name-free defaults and need review in the workspace.')
const index = JSON.parse(fs.readFileSync(piecesJson, 'utf8'))
const type = index.garment?.type || 'garment'
const region = index.garment?.region || null
// map the AI garment type onto the categories the 3D pipeline knows
const CAT = { shirt: 'buttonup_shirt', top: 'tshirt', tshirt: 'tshirt', 't-shirt': 'tshirt', jacket: 'jacket', coat: 'coat', hoodie: 'hoodie', skirt: 'skirt', trousers: 'trousers', pants: 'trousers', shorts: 'shorts', dress: 'other', jumpsuit: 'jumpsuit' }
const garmentCategory = CAT[String(type).toLowerCase()] || (region === 'lower' ? 'trousers' : 'other')
const cm = defaultMeasurements(size)
const keys = [...new Set([...CUSTOM_MEASUREMENTS, 'upperLeg', 'ankle', 'hpsToWaistBack', 'waistToHips'])]
fs.writeFileSync(path.join(dir, 'pattern-design.json'), JSON.stringify({
  design: `Uploaded pattern — ${type}`,
  designKey: 'uploaded',
  custom: true,
  garmentCategory,
  notes: `Pattern pieces uploaded as an image (${index.pieces.length} pieces, ${type}).`,
  size,
  sizes: SIZE_KEYS,
  measurements: keys.map((key) => ({ key, label: humanLabel(key), how: HOW_TO_MEASURE[key] || '', cm: cm[key] ?? null, overridden: false })),
  source: 'image',
}, null, 2))
console.log(`Saved: ${index.pieces.length} pieces classified as ${type}`)
