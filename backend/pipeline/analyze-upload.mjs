// analyze-upload.mjs — what the studio needs the moment a file is dropped in.
// Usage: node analyze-upload.mjs <image.jpg|png|webp>
//
// Prints ONE JSON object on stdout answering two questions:
//   1. is this a photograph or a technical flat?  (the Image/Sketch mode gate)
//   2. which freesewing design would this draft as, and therefore which body
//      measurements should the sidebar ask for?
//
// Deliberately NOT the same call as photo-draft.mjs's analyzeGarment: that one
// is 2.5-pro against a 20-field schema and takes long enough that firing it on
// every upload would make the studio feel broken. This is 2.5-flash and five
// fields. The full analysis still runs later, at draft time.
try { process.loadEnvFile(new URL('./.env', import.meta.url)) } catch {}
import { screenImage } from './analyze.mjs'
import {
  DESIGNS, CATEGORY_TO_DESIGN, BODY_REGION,
  HOW_TO_MEASURE, defaultMeasurements,
} from './designs.mjs'

// hpsToWaistBack -> "Hps To Waist Back"
function humanLabel(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase())
}

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + '\n')
  process.exit(1)
}

const imagePath = process.argv[2]
if (!imagePath) fail('usage: node analyze-upload.mjs <image>')

let screen
try {
  screen = await screenImage(imagePath)
} catch (e) {
  fail(`vision screen failed: ${e.message}`)
}

const design = CATEGORY_TO_DESIGN[screen.garmentCategory] || null
const entry = design ? DESIGNS[design] : null

// The list is read straight off the design the draft will actually use, so the
// sidebar can never ask for a field the pattern ignores or miss one it needs.
// Values are the same size-scaled defaults photo-draft.mjs would fall back to,
// so an untouched form and no form at all produce an identical pattern.
let measurements = []
if (entry) {
  const defaults = defaultMeasurements(screen.apparentSize)
  measurements = (entry.Design.patternConfig.measurements || []).map((key) => ({
    key,
    label: humanLabel(key),
    cm: defaults[key] ?? null,
    how: HOW_TO_MEASURE[key] || 'see freesewing.org/docs/measurements',
  }))
}

process.stdout.write(JSON.stringify({
  imageKind: screen.imageKind,
  garmentCategory: screen.garmentCategory,
  design,
  designLabel: entry ? entry.label : null,
  bodyRegion: design ? BODY_REGION[design] || null : null,
  apparentSize: screen.apparentSize,
  confidence: screen.confidence,
  notes: screen.notes,
  measurements,
}) + '\n')
