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
  DESIGNS, BODY_REGION,
  HOW_TO_MEASURE, defaultMeasurements, humanLabel,
} from './designs.mjs'
import { CUSTOM_MEASUREMENTS } from './extra-pieces.mjs'
import { catalogueDesignFor } from './catalogue.mjs'

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

// Same rule as photo-draft.mjs: a catalogue pattern only when vision says the garment
// IS that catalogue garment (sameGarment); every other real garment is drafted by AI
// from scratch (extra-pieces.mjs draftCustomPieces) and still needs body measurements.
// So the measurement fields asked for here are the ones the draft will actually use.
const matched = catalogueDesignFor(screen.catalogueMatch)
const isGarment = screen.imageKind !== 'not_a_garment' && screen.garmentCategory !== 'unsupported'
const isCustom = isGarment && !(matched && DESIGNS[matched])
const design = isCustom ? 'custom' : isGarment ? matched : null
const entry = isCustom
  ? { label: 'Custom AI draft (not in pattern catalogue)', Design: { patternConfig: { measurements: CUSTOM_MEASUREMENTS } } }
  : design ? DESIGNS[design] : null

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
  bodyRegion: design ? BODY_REGION[design] || (isCustom ? 'full' : null) : null,
  apparentSize: screen.apparentSize,
  confidence: screen.confidence,
  notes: screen.notes,
  measurements,
}) + '\n')
