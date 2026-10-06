// analyze.mjs — Stage 1: garment photo → structured attributes JSON
import fs from 'fs'
import path from 'path'
import { GoogleGenAI } from '@google/genai'
import { CATALOGUE_HINT, validCatalogueMatch } from './catalogue.mjs'

const SCHEMA_HINT = `Respond with ONLY a raw JSON object, no prose, no markdown fences:
{
  "garmentCategory": "tshirt | tanktop | corset_top | wrap_top | draped_top | buttonup_shirt | trousers | cycling_breeches | shorts | shorts_cargo | skirt_pencil | skirt_circle | skirt | jumpsuit | overalls | underwear | briefs | bomber_jacket | denim_jacket | jacket | coat | vest | blazer | cardigan | hoodie_zip | hoodie_pullover | hoodie_wrap | hoodie | sweater | sweatshirt | bikini_top | one_piece_swimsuit | leggings_capri | leggings_full | leggings | onesie | apron | bowtie | other | unsupported"  <- pick the closest real garment type by CONSTRUCTION, checked in this order:\n  UPPER BODY, sleeved/sleeveless tops: "tanktop" = basic sleeveless tee. "corset_top" = fitted cropped top/bodice with front lacing/lace-up grommets and a peplum hem. "wrap_top" = front closes with one panel crossing over the other, a diagonal overlap seam visible down the front. "draped_top" = soft cowl/draped fold gathered at the neckline (not a flat crew/scoop). "tshirt" = plain crew or scoop neckline, no lacing/wrap/drape/buttons, the default upper-body fallback. "buttonup_shirt" = woven collar (point or spread) with a full button-down front placket.\n  JACKETS/OUTERWEAR: "bomber_jacket" = ribbed knit collar/cuffs/waist-hem band (contrast or self-color), snap- or zip-front, welt/patch hip pockets, no woven lapel — quilted/puffer fill counts here too. "denim_jacket" = trucker-style: front yoke seam across the chest, two chest button-flap pockets, sits at waist with a banded hem, denim or twill fabric. "vest" = sleeveless, tailored, front button closure, worn over a shirt (waistcoat). "jacket"/"coat"/"blazer"/"cardigan" = tailored woven construction with a notch or roll lapel collar, welt/flap pockets, front button or double-breasted closure, woolen or structured fabric — "coat" only if it clearly extends to the knee or below, otherwise "jacket"/"blazer"/"cardigan".\n  HOODIES/SWEATERS: "hoodie_zip" = hood + a full front zipper. "hoodie_pullover" = hood, no front opening, raglan/diagonal shoulder-to-underarm seam, drawstring hood, kangaroo pocket. "hoodie_wrap" = hood, asymmetric drape-front closing with a single button/toggle off to one side, no separate front/back symmetry. "hoodie" = has a hood but fits none of the above (fitted, no kangaroo pocket) — the default hoodie fallback. "sweatshirt"/"sweater" = crew neckline, ribbed cuffs/hem, no hood.\n  BOTTOMS: "trousers" = full-length flat-front or pleated pants. "cycling_breeches" = puffy/bloused through the thigh, gathered into a band just below the knee. "shorts_cargo" = wide waistband, large patch pockets on the leg, no fly. "shorts" = above/at-knee length with a separate waistband seam and typically a fly (denim shorts, casual shorts) — default shorts fallback. "skirt_pencil" = straight/fitted skirt, narrow silhouette. "skirt_circle" = very full flared skirt that would lie flat as a circle. "skirt" = any other skirt silhouette (A-line etc), the default skirt fallback. "jumpsuit"/"overalls" = one-piece combining a top and full-length trousers.\n  UNDERWEAR/SWIM: "underwear" = snug men\'s boxer-briefs with a leg gusset/crotch seam and NO distinct waistband panel. "briefs" = women\'s hip-hugging brief/panty cut, no leg extension. "bikini_top" = triangle/halter bikini top with ties. "one_piece_swimsuit" = full-coverage one-piece, may have a front zip and built-in leg/sleeve ribbing.\n  LEGGINGS: "leggings_capri" = ends mid-calf. "leggings_full" = ends at the ankle.\n  OTHER: "onesie" = short/long-sleeve snap-front baby bodysuit/romper. "apron" = front panel with a large patch pocket and neck+waist ties/straps, open back. "bowtie" = a bow tie. Use "other" for a real garment whose construction clearly matches NONE of the types above (e.g. a dress, kimono, cape, poncho, saree blouse, kurta, dungaree dress) — it will be drafted from scratch. Use "unsupported" only if it\'s not a garment at all,
  "sleeveLength": "sleeveless | short | elbow | three_quarter | long | n/a",
  "neckline": "crew | scoop | v | collar | n/a",
  "closure": "button | zipper | snap | drawstring | pullover | n/a"  <- how the front actually closes, look closely (a zipper pull/teeth means zipper, not button),
  "buttonCount": <integer>  <- ONLY when closure is "button": count the actual visible buttons down the center-front placket in the photo (not sleeve/collar buttons). 0 if closure is not "button" or the count truly can't be seen,
  "buttonTopFraction": <number 0..1>  <- ONLY when closure is "button": how far down the front the FIRST (top) button sits, as a fraction of the collar-to-hem length (0 = right at the collar, 0.5 = halfway down). 0 if closure is not "button",
  "pockets": { "type": "none | patch | welt | flap", "count": 0 | 1 | 2, "position": "chest | hip | n/a", "widthCm": <number>, "heightCm": <number>, "horizontalFraction": <number 0..1>, "verticalFraction": <number 0..1> }  <- look for pocket openings/flaps on the garment; count is how many roughly-symmetric pockets of that type, not total pockets of all types; widthCm/heightCm are the real-world size of ONE pocket opening; horizontalFraction is the pocket's distance from the center-front line as a fraction of half the chest width (0 = at center front, 1 = at the side seam); verticalFraction is distance down the front as a fraction of the full shoulder-to-hem length (0 = at the shoulder/collar, 1 = at the hem) — all four are 0 if type is "none",
  "waistband": "none | elastic | banded | n/a"  <- only relevant for trouser/short/skirt-style waist construction; "elastic" = stretchy pull-on band, "banded" = separate fabric strip with its own seam (belt loops, buttons, or a hook-and-bar closure usually mean banded),
  "cuffs": "none | ribbed | buttoned | plain | n/a"  <- sleeve or leg hem finish; "ribbed" = stretchy knit band gathering the opening, "buttoned" = fabric cuff with a button/buttonhole closure, "plain" = hemmed edge with no separate band,
  "cuffWidthCm": <number>  <- ONLY when cuffs is "ribbed" or "buttoned": the real-world height of that cuff band, estimated against the garment's own proportions (0 otherwise),
  "zipLength": "full | partial | n/a"  <- ONLY when closure is "zipper" or "snap": "full" if it runs the entire collar-to-hem front, "partial" if it stops short (e.g. a half-zip pullover). "n/a" otherwise,
  "zipTopFraction": <number 0..1>  <- ONLY when zipLength is "partial": where the zip/snap run starts, as a fraction of collar-to-hem length (0 = at the collar). 0 otherwise,
  "zipBottomFraction": <number 0..1>  <- ONLY when zipLength is "partial": where the zip/snap run ends, as a fraction of collar-to-hem length (1 = at the hem). 1 otherwise,
  "collarStyle": "none | spread | mandarin | shawl | notch_lapel | n/a"  <- ONLY when neckline is "collar": the actual collar CONSTRUCTION, checked in this order: "notch_lapel" = tailored jacket/coat lapel with a notch where collar meets lapel. "shawl" = one continuous rolled collar with no notch (cardigan/robe-style). "mandarin" = short stand-up band collar with no fold-over leaf (includes snap-front mandarin/nehru/scrub-style collars). "spread" = classic shirt collar, a stand plus a folded-over pointed leaf. "none" if neckline is "collar" but you genuinely can't tell the construction. "n/a" whenever neckline is NOT "collar",
  "badge": { "present": <bool>, "widthCm": <number>, "heightCm": <number>, "horizontalFraction": <number 0..1>, "verticalFraction": <number 0..1> }  <- a separate applique/patch/name-badge stitched onto the chest (distinct from a pocket): present=true only if you can see one; widthCm/heightCm are its real-world size; horizontalFraction is distance from center-front as a fraction of half the chest width (0 = center front, 1 = side seam); verticalFraction is distance down from the shoulder/collar as a fraction of the full shoulder-to-hem length; all four are 0/false if none is visible,
  "fit": "fitted | regular | relaxed | oversized",
  "garmentLength": "cropped | regular | long | n/a",
  "apparentSize": "XS | S | M | L | XL | XXL | unknown"  <- estimate the garment's size from its cut and proportions,
  ${CATALOGUE_HINT},
  "confidence": <number 0..1>,
  "notes": "<one sentence describing the garment>"
}`

const ALLOWED = {
  garmentCategory: [
    'tshirt', 'tanktop', 'corset_top', 'wrap_top', 'draped_top', 'buttonup_shirt',
    'trousers', 'cycling_breeches', 'shorts', 'shorts_cargo', 'skirt_pencil', 'skirt_circle',
    'skirt', 'jumpsuit', 'overalls', 'underwear', 'briefs',
    'bomber_jacket', 'denim_jacket', 'jacket', 'coat', 'vest', 'blazer', 'cardigan',
    'hoodie_zip', 'hoodie_pullover', 'hoodie_wrap', 'hoodie', 'sweater', 'sweatshirt',
    'bikini_top', 'one_piece_swimsuit', 'leggings_capri', 'leggings_full', 'leggings',
    'onesie', 'apron', 'bowtie', 'other', 'unsupported',
  ],
  sleeveLength: ['sleeveless', 'short', 'elbow', 'three_quarter', 'long', 'n/a'],
  neckline: ['crew', 'scoop', 'v', 'collar', 'n/a'],
  closure: ['button', 'zipper', 'snap', 'drawstring', 'pullover', 'n/a'],
  waistband: ['none', 'elastic', 'banded', 'n/a'],
  cuffs: ['none', 'ribbed', 'buttoned', 'plain', 'n/a'],
  fit: ['fitted', 'regular', 'relaxed', 'oversized'],
  garmentLength: ['cropped', 'regular', 'long', 'n/a'],
  apparentSize: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'unknown'],
  zipLength: ['full', 'partial', 'n/a'],
  collarStyle: ['none', 'spread', 'mandarin', 'shawl', 'notch_lapel', 'n/a'],
}
const ALLOWED_POCKET_TYPE = ['none', 'patch', 'welt', 'flap']
const ALLOWED_POCKET_POSITION = ['chest', 'hip', 'n/a']

const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

// catalogueMatch is advisory: a malformed one is dropped (the draft then falls back
// to the category table) rather than failing the whole analysis.
function keepCatalogueMatch(obj) {
  if (obj && 'catalogueMatch' in obj && !validCatalogueMatch(obj.catalogueMatch)) delete obj.catalogueMatch
  return obj
}

function validate(obj) {
  keepCatalogueMatch(obj)
  for (const [key, allowed] of Object.entries(ALLOWED)) {
    if (!allowed.includes(obj[key])) throw new Error(`invalid ${key}: ${obj[key]}`)
  }
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)
    throw new Error(`invalid confidence: ${obj.confidence}`)
  if (!Number.isInteger(obj.buttonCount) || obj.buttonCount < 0)
    throw new Error(`invalid buttonCount: ${obj.buttonCount}`)
  if (typeof obj.buttonTopFraction !== 'number' || obj.buttonTopFraction < 0 || obj.buttonTopFraction > 1)
    throw new Error(`invalid buttonTopFraction: ${obj.buttonTopFraction}`)
  if (!obj.pockets || typeof obj.pockets !== 'object')
    throw new Error(`invalid pockets: ${JSON.stringify(obj.pockets)}`)
  if (!ALLOWED_POCKET_TYPE.includes(obj.pockets.type))
    throw new Error(`invalid pockets.type: ${obj.pockets.type}`)
  if (![0, 1, 2].includes(obj.pockets.count))
    throw new Error(`invalid pockets.count: ${obj.pockets.count}`)
  if (!ALLOWED_POCKET_POSITION.includes(obj.pockets.position))
    throw new Error(`invalid pockets.position: ${obj.pockets.position}`)
  if (typeof obj.pockets.widthCm !== 'number' || obj.pockets.widthCm < 0)
    throw new Error(`invalid pockets.widthCm: ${obj.pockets.widthCm}`)
  if (typeof obj.pockets.heightCm !== 'number' || obj.pockets.heightCm < 0)
    throw new Error(`invalid pockets.heightCm: ${obj.pockets.heightCm}`)
  if (typeof obj.pockets.horizontalFraction !== 'number' || obj.pockets.horizontalFraction < 0 || obj.pockets.horizontalFraction > 1)
    throw new Error(`invalid pockets.horizontalFraction: ${obj.pockets.horizontalFraction}`)
  if (typeof obj.pockets.verticalFraction !== 'number' || obj.pockets.verticalFraction < 0 || obj.pockets.verticalFraction > 1)
    throw new Error(`invalid pockets.verticalFraction: ${obj.pockets.verticalFraction}`)
  if (typeof obj.cuffWidthCm !== 'number' || obj.cuffWidthCm < 0)
    throw new Error(`invalid cuffWidthCm: ${obj.cuffWidthCm}`)
  if (typeof obj.zipTopFraction !== 'number' || obj.zipTopFraction < 0 || obj.zipTopFraction > 1)
    throw new Error(`invalid zipTopFraction: ${obj.zipTopFraction}`)
  if (typeof obj.zipBottomFraction !== 'number' || obj.zipBottomFraction < 0 || obj.zipBottomFraction > 1)
    throw new Error(`invalid zipBottomFraction: ${obj.zipBottomFraction}`)
  if (!obj.badge || typeof obj.badge !== 'object')
    throw new Error(`invalid badge: ${JSON.stringify(obj.badge)}`)
  if (typeof obj.badge.present !== 'boolean')
    throw new Error(`invalid badge.present: ${obj.badge.present}`)
  if (typeof obj.badge.widthCm !== 'number' || obj.badge.widthCm < 0)
    throw new Error(`invalid badge.widthCm: ${obj.badge.widthCm}`)
  if (typeof obj.badge.heightCm !== 'number' || obj.badge.heightCm < 0)
    throw new Error(`invalid badge.heightCm: ${obj.badge.heightCm}`)
  if (typeof obj.badge.horizontalFraction !== 'number' || obj.badge.horizontalFraction < 0 || obj.badge.horizontalFraction > 1)
    throw new Error(`invalid badge.horizontalFraction: ${obj.badge.horizontalFraction}`)
  if (typeof obj.badge.verticalFraction !== 'number' || obj.badge.verticalFraction < 0 || obj.badge.verticalFraction > 1)
    throw new Error(`invalid badge.verticalFraction: ${obj.badge.verticalFraction}`)
  return obj
}

function parseLoose(text) {
  const clean = text.replace(/```json|```/g, '').trim()
  return JSON.parse(clean)
}

function visionKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_AI_API_KEY
}

const ALLOWED_SCREEN_CATEGORIES = ALLOWED.garmentCategory
const ALLOWED_IMAGE_KIND = ['photo', 'flat_sketch', 'not_a_garment']

function validateScreen(obj) {
  keepCatalogueMatch(obj)
  if (!ALLOWED_IMAGE_KIND.includes(obj.imageKind))
    throw new Error(`invalid imageKind: ${obj.imageKind}`)
  if (!ALLOWED_SCREEN_CATEGORIES.includes(obj.garmentCategory))
    throw new Error(`invalid garmentCategory: ${obj.garmentCategory}`)
  if (!ALLOWED.apparentSize.includes(obj.apparentSize))
    throw new Error(`invalid apparentSize: ${obj.apparentSize}`)
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1)
    throw new Error(`invalid confidence: ${obj.confidence}`)
  return obj
}

// ---------------- lightweight upload screen ----------------
// analyzeGarment runs 2.5-pro against the ~20-field schema above: right for
// drafting, far too slow and expensive to fire on every file the user drops in
// the browser. screenImage answers only the two questions the upload UI has --
// "is this a photo or a flat?" and "which design is this, so which measurements
// do I ask for?" -- on flash, in a couple of seconds.
const SCREEN_SCHEMA_HINT = `Respond with ONLY a raw JSON object, no prose, no markdown fences:
{
  "imageKind": "photo | flat_sketch | not_a_garment"  <- "photo" = a photograph or photorealistic render of a real garment, with real fabric texture, shading, folds and lighting. "flat_sketch" = a technical flat, line drawing, CAD illustration or vector mockup: flat line art, no photographic texture, usually pure white background, often front and back laid side by side. "not_a_garment" = anything that is neither (a person's face, a landscape, a document, a logo),
  "garmentCategory": "${ALLOWED_SCREEN_CATEGORIES.join(' | ')}"  <- the closest garment type by construction; "other" for a real garment that matches none of the listed types (a dress, kimono, cape, kurta...); "unsupported" if imageKind is "not_a_garment" or you cannot tell,
  "apparentSize": "XS | S | M | L | XL | XXL | unknown"  <- estimate the garment's size from its cut and proportions,
  ${CATALOGUE_HINT},
  "confidence": <number 0..1>,
  "notes": "<one sentence describing what you see>"
}`

export async function screenImage(imagePath) {
  // Offline/test mode, mirroring MOCK_VISION: MOCK_SCREEN='{"imageKind":"photo",...}'
  if (process.env.MOCK_SCREEN) return validateScreen(JSON.parse(process.env.MOCK_SCREEN))

  const apiKey = visionKey()
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set')
  const mediaType = MEDIA[path.extname(imagePath).toLowerCase()]
  if (!mediaType) throw new Error(`unsupported image type: ${path.extname(imagePath)} (use jpg/png/webp)`)

  const data = fs.readFileSync(imagePath).toString('base64')
  const client = new GoogleGenAI({ apiKey })
  const ask = async (extra = '') => {
    const res = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mediaType, data } },
          { text: `Classify this image for a sewing-pattern tool. ${extra}\n${SCREEN_SCHEMA_HINT}` },
        ],
      }],
    })
    return res.text
  }

  try {
    return validateScreen(parseLoose(await ask()))
  } catch {
    // One retry, then throw rather than process.exit -- the HTTP caller needs to
    // report this as "analysis unavailable" and let the run proceed, not die.
    return validateScreen(parseLoose(await ask(
      'Your previous answer was invalid JSON or used values outside the allowed lists. Follow the schema EXACTLY.')))
  }
}

export async function analyzeGarment(imagePath) {
  // Offline/test mode: MOCK_VISION='{"garmentCategory":"tshirt",...}'
  if (process.env.MOCK_VISION) return validate(JSON.parse(process.env.MOCK_VISION))

  const apiKey = visionKey()
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set. Run:  export GEMINI_API_KEY=your-key')
    process.exit(1)
  }
  const mediaType = MEDIA[path.extname(imagePath).toLowerCase()]
  if (!mediaType) {
    console.error(`Unsupported image type: ${imagePath} (use jpg/png/webp)`)
    process.exit(1)
  }
  const data = fs.readFileSync(imagePath).toString('base64')
  const client = new GoogleGenAI({ apiKey })

  const ask = async (extra = '') => {
    const res = await client.models.generateContent({
      model: 'gemini-2.5-pro',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: mediaType, data } },
            { text: `Analyze the garment in this image for sewing pattern drafting. ${extra}\n${SCHEMA_HINT}` },
          ],
        },
      ],
    })
    return res.text
  }

  try {
    return validate(parseLoose(await ask()))
  } catch (e1) {
    try {
      return validate(parseLoose(await ask('Your previous answer was invalid JSON or used values outside the allowed lists. Follow the schema EXACTLY.')))
    } catch (e2) {
      console.error('Vision analysis failed twice:', e2.message)
      process.exit(1)
    }
  }
}
