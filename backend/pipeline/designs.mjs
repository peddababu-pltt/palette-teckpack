// designs.mjs — the design registry and the body-measurement tables.
//
// This lives apart from photo-draft.mjs because photo-draft.mjs ends in a
// top-level main block that drafts a pattern and calls process.exit — importing
// it to ask "which measurements does a bomber jacket need?" would run the whole
// pipeline. analyze-upload.mjs needs exactly that answer and nothing else.
import { Teagan, i18n as teaganI18n } from '@freesewing/teagan'
import { Aaron, i18n as aaronI18n } from '@freesewing/aaron'
import { Simon, i18n as simonI18n } from '@freesewing/simon'
import { Simone, i18n as simoneI18n } from '@freesewing/simone'
import { Bruce, i18n as bruceI18n } from '@freesewing/bruce'
import { Uma, i18n as umaI18n } from '@freesewing/uma'
import { Shin, i18n as shinI18n } from '@freesewing/shin'
import { Charlie, i18n as charlieI18n } from '@freesewing/charlie'
import { Cornelius, i18n as corneliusI18n } from '@freesewing/cornelius'
import { Ashley, i18n as ashleyI18n } from '@freesewing/ashley'
import { Shale, i18n as shaleI18n } from '@freesewing/shale'
import { Penelope, i18n as penelopeI18n } from '@freesewing/penelope'
import { Sandy, i18n as sandyI18n } from '@freesewing/sandy'
import { Carlita, i18n as carlitaI18n } from '@freesewing/carlita'
import { Carlton, i18n as carltonI18n } from '@freesewing/carlton'
import { Jett, i18n as jettI18n } from '@freesewing/jett'
import { Devon, i18n as devonI18n } from '@freesewing/devon'
import { Wahid, i18n as wahidI18n } from '@freesewing/wahid'
import { Huey, i18n as hueyI18n } from '@freesewing/huey'
import { Hugo, i18n as hugoI18n } from '@freesewing/hugo'
import { Yuri, i18n as yuriI18n } from '@freesewing/yuri'
import { Hannah, i18n as hannahI18n } from '@freesewing/hannah'
import { Sven, i18n as svenI18n } from '@freesewing/sven'
import { Tristan, i18n as tristanI18n } from '@freesewing/tristan'
import { Tina, i18n as tinaI18n } from '@freesewing/tina'
import { Diana, i18n as dianaI18n } from '@freesewing/diana'
import { Bee, i18n as beeI18n } from '@freesewing/bee'
import { Onyx, i18n as onyxI18n } from '@freesewing/onyx'
import { Lumina, i18n as luminaI18n } from '@freesewing/lumina'
import { Lumira, i18n as lumiraI18n } from '@freesewing/lumira'
import { Otis, i18n as otisI18n } from '@freesewing/otis'
import { Albert, i18n as albertI18n } from '@freesewing/albert'
import { Benjamin, i18n as benjaminI18n } from '@freesewing/benjamin'

// Keys are design identities (not category names) — a category can now map to a
// design with a different name than itself (e.g. "denim_jacket" -> Devon).
// Every design here is a real, standalone pattern from the reference PDF
// (`sweing pattern garemtns.pdf`) — the PDF's body blocks (Bella, Bent, Bibi,
// Breanna, Brian, Noble, Sarah, Titan) are explicitly flagged there as "not a
// pattern" and are never used as a direct draft target, only internally by the
// real patterns above that build on them.
export const DESIGNS = {
  teagan: { Design: Teagan, i18n: teaganI18n, label: 'Teagan (t-shirt)' },
  aaron: { Design: Aaron, i18n: aaronI18n, label: 'Aaron (tank top)' },
  tristan: { Design: Tristan, i18n: tristanI18n, label: 'Tristan (lace-up corset top — with peplum)' },
  tina: { Design: Tina, i18n: tinaI18n, label: 'Tina (wrap top with overlap)' },
  diana: { Design: Diana, i18n: dianaI18n, label: 'Diana (draped top)' },
  simon: { Design: Simon, i18n: simonI18n, label: 'Simon (button-up shirt)' },
  simone: { Design: Simone, i18n: simoneI18n, label: 'Simone (button-up shirt, women\'s)' },
  charlie: { Design: Charlie, i18n: charlieI18n, label: 'Charlie (chino trousers — front/back/waistband/pockets/fly)' },
  cornelius: { Design: Cornelius, i18n: corneliusI18n, label: 'Cornelius (cycling breeches — with waistband/pockets)' },
  ashley: { Design: Ashley, i18n: ashleyI18n, label: 'Ashley (denim shorts — with waistband/pockets/fly)' },
  shale: { Design: Shale, i18n: shaleI18n, label: 'Shale (cargo shorts — with waistband/pockets)' },
  shin: { Design: Shin, i18n: shinI18n, label: 'Shin (swim trunks/shorts — front/back/waistband)' },
  penelope: { Design: Penelope, i18n: penelopeI18n, label: 'Penelope (pencil skirt — with waistband)' },
  sandy: { Design: Sandy, i18n: sandyI18n, label: 'Sandy (circle skirt — with waistband)' },
  bruce: { Design: Bruce, i18n: bruceI18n, label: 'Bruce (boxer briefs — front/back/side/inset)' },
  uma: { Design: Uma, i18n: umaI18n, label: 'Uma (briefs — with gusset)' },
  carlita: { Design: Carlita, i18n: carlitaI18n, label: 'Carlita (long coat — with welt pockets, women\'s)' },
  carlton: { Design: Carlton, i18n: carltonI18n, label: 'Carlton (long coat — with welt pockets, men\'s)' },
  jett: { Design: Jett, i18n: jettI18n, label: 'Jett (bomber jacket — with welt pockets, ribbed collar/cuffs/waistband)' },
  devon: { Design: Devon, i18n: devonI18n, label: 'Devon (denim jacket — with yoke, flap pockets, waistband)' },
  wahid: { Design: Wahid, i18n: wahidI18n, label: 'Wahid (waistcoat/vest — with welt pockets)' },
  huey: { Design: Huey, i18n: hueyI18n, label: 'Huey (zip-front hoodie — with kangaroo pocket)' },
  hugo: { Design: Hugo, i18n: hugoI18n, label: 'Hugo (pullover raglan hoodie — with kangaroo pocket)' },
  yuri: { Design: Yuri, i18n: yuriI18n, label: 'Yuri (wrap-front hoodie)' },
  hannah: { Design: Hannah, i18n: hannahI18n, label: 'Hannah (basic pullover hoodie)' },
  sven: { Design: Sven, i18n: svenI18n, label: 'Sven (crew sweatshirt — with ribbed cuffs/waistband)' },
  bee: { Design: Bee, i18n: beeI18n, label: 'Bee (bikini top)' },
  onyx: { Design: Onyx, i18n: onyxI18n, label: 'Onyx (one-piece swimsuit — with zip front, hood, ribbing)' },
  lumina: { Design: Lumina, i18n: luminaI18n, label: 'Lumina (capri leggings — with pocket)' },
  lumira: { Design: Lumira, i18n: lumiraI18n, label: 'Lumira (full-length leggings)' },
  otis: { Design: Otis, i18n: otisI18n, label: 'Otis (baby romper/onesie)' },
  albert: { Design: Albert, i18n: albertI18n, label: 'Albert (apron)' },
  benjamin: { Design: Benjamin, i18n: benjaminI18n, label: 'Benjamin (bow tie)' },
}

// Every real garment category the vision stage can name gets mapped onto whichever
// design above is structurally closest. Nothing gets rejected as "unsupported"
// unless the photo genuinely isn't a garment (or vision says so).
export const CATEGORY_TO_DESIGN = {
  tshirt: 'teagan',
  tanktop: 'aaron',
  corset_top: 'tristan',
  wrap_top: 'tina',
  draped_top: 'diana',
  buttonup_shirt: 'simon',
  trousers: 'charlie',
  cycling_breeches: 'cornelius',
  shorts: 'ashley',
  shorts_cargo: 'shale',
  skirt_pencil: 'penelope',
  skirt_circle: 'sandy',
  skirt: 'penelope',
  jumpsuit: 'charlie',
  overalls: 'charlie',
  underwear: 'bruce',
  briefs: 'uma',
  bomber_jacket: 'jett',
  denim_jacket: 'devon',
  jacket: 'carlton',
  coat: 'carlton',
  vest: 'wahid',
  blazer: 'carlton',
  cardigan: 'carlton',
  hoodie_zip: 'huey',
  hoodie_pullover: 'hugo',
  hoodie_wrap: 'yuri',
  hoodie: 'hannah',
  sweater: 'sven',
  sweatshirt: 'sven',
  bikini_top: 'bee',
  one_piece_swimsuit: 'onyx',
  leggings_capri: 'lumina',
  leggings_full: 'lumira',
  leggings: 'lumira',
  onesie: 'otis',
  apron: 'albert',
  bowtie: 'benjamin',
}

// Categories with their own dedicated design (not reusing another category's block) —
// drives the "no dedicated block" console note in photo-draft.mjs. Every category maps
// to a real dedicated pattern now except the deliberately generic fallbacks (skirt,
// leggings, jacket/coat/blazer/cardigan sharing Carlton, sweater/sweatshirt sharing Sven).
export const DEDICATED_CATEGORIES = new Set([
  'tshirt', 'tanktop', 'corset_top', 'wrap_top', 'draped_top', 'buttonup_shirt',
  'trousers', 'cycling_breeches', 'shorts', 'shorts_cargo', 'skirt_pencil', 'skirt_circle',
  'underwear', 'briefs', 'bomber_jacket', 'denim_jacket', 'vest',
  'hoodie_zip', 'hoodie_pullover', 'hoodie_wrap', 'hoodie',
  'bikini_top', 'one_piece_swimsuit', 'leggings_capri', 'leggings_full',
  'onesie', 'apron', 'bowtie',
])

// Which half of the body a design dresses. Only drives the heading the UI shows
// above the measurements panel ("Upper body — Bomber jacket"); the measurement
// list itself always comes from the design's own patternConfig, never from this.
// "full" = spans both halves (a swimsuit, a romper) or belongs to neither (a bow tie).
export const BODY_REGION = {
  teagan: 'upper', aaron: 'upper', tristan: 'upper', tina: 'upper', diana: 'upper',
  simon: 'upper', simone: 'upper', jett: 'upper', devon: 'upper', carlita: 'upper',
  carlton: 'upper', wahid: 'upper', huey: 'upper', hugo: 'upper', yuri: 'upper',
  hannah: 'upper', sven: 'upper', bee: 'upper',
  charlie: 'lower', cornelius: 'lower', ashley: 'lower', shale: 'lower', shin: 'lower',
  penelope: 'lower', sandy: 'lower', bruce: 'lower', uma: 'lower',
  lumina: 'lower', lumira: 'lower',
  onyx: 'full', otis: 'full', albert: 'full', benjamin: 'full',
}

export const HOW_TO_MEASURE = {
  chest: 'around the fullest part of the chest/bust',
  waist: 'around the natural waist (narrowest point)',
  hips: 'around the hip bones',
  seat: 'around the fullest part of the seat',
  neck: 'around the base of the neck',
  biceps: 'around the fullest part of the upper arm',
  wrist: 'around the wrist bone',
  shoulderToShoulder: 'across the back, shoulder point to shoulder point',
  shoulderSlope: 'vertical drop from neck-shoulder point to shoulder tip (cm)',
  shoulderToWrist: 'shoulder tip to wrist, arm slightly bent',
  shoulderToElbow: 'shoulder tip to elbow point',
  hpsToBust: 'high point of shoulder down to bust point',
  hpsToWaistBack: 'high point of shoulder to waist, along the back',
  hpsToWaistFront: 'high point of shoulder to waist, along the front over bust',
  waistToArmpit: 'waist up to armpit level, along the side',
  waistToHips: 'waist down to hip line, along the side',
  waistToSeat: 'waist down to fullest seat point',
  waistToFloor: 'waist to floor, standing straight',
  waistToKnee: 'waist to middle of kneecap',
  waistToUnderbust: 'waist up to underbust line',
  inseam: 'crotch to floor along the inside of the leg',
  ankle: 'around the ankle bone',
  crossSeam: 'front waist through the legs to back waist',
  crossSeamFront: 'front waist to the mid-crotch point',
  bustSpan: 'distance between the two bust points',
  bustPointToUnderbust: 'bust point straight down to underbust line',
  highBust: 'around the chest above the bust, under the arms',
  underbust: 'around the ribcage just under the bust',
  knee: 'around the knee',
  upperLeg: 'around the fullest part of the upper thigh',
  waistToUpperLeg: 'waist down to the top of the thigh at the side (seated crotch-level rise)',
  waistBack: 'across the back only, hip bone to hip bone at the natural waist (roughly half your full waist measurement)',
  seatBack: 'across the back only, at the fullest part of the seat (roughly half your full seat measurement)',
  bustFront: 'across the front only, side seam to side seam at the fullest part of the bust (roughly half your full chest measurement)',
  head: 'around the head at its widest, just above the ears',
  crotchDepth: 'seated, from the side waist straight down to the chair',
  heel: 'around the foot diagonally across the heel and instep',
}

export const BASE_M = {
  chest: 94, waist: 78, hips: 100, seat: 102, neck: 38,
  biceps: 30, wrist: 17, shoulderToShoulder: 43, shoulderSlope: 4.5,
  shoulderToWrist: 58, shoulderToElbow: 35, hpsToBust: 26,
  hpsToWaistBack: 45, hpsToWaistFront: 43, waistToArmpit: 22,
  waistToHips: 12, waistToSeat: 24, waistToFloor: 104, waistToKnee: 58,
  waistToUnderbust: 8, inseam: 78, ankle: 23, knee: 38,
  crossSeam: 72, crossSeamFront: 36, bustSpan: 18,
  bustPointToUnderbust: 8, highBust: 90, underbust: 78,
  upperLeg: 55, waistToUpperLeg: 28,
  // Split-girth measurements some designs (Charlie) need in addition to the
  // full-circumference versions above. Simple exact-half default, same convention
  // crossSeamFront already uses relative to crossSeam (36 = 72 / 2).
  waistBack: 39, seatBack: 51, bustFront: 47,
  // Needed by Tina/Huey/Hugo/Yuri/Hannah/Onyx (hood-block designs) and Ashley/Shale
  // (waistband-rise designs) and Lumina/Lumira (leggings foot opening).
  head: 57, crotchDepth: 28, heel: 34,
}
export const GIRTHS = new Set(['chest', 'waist', 'hips', 'seat', 'neck', 'biceps', 'wrist', 'ankle', 'knee', 'highBust', 'underbust', 'bustSpan', 'upperLeg', 'waistBack', 'seatBack', 'bustFront', 'head', 'heel'])
export const SIZE_FACTOR = { XS: 0.88, S: 0.94, M: 1.0, L: 1.06, XL: 1.13, XXL: 1.2, unknown: 1.0 }

export function defaultMeasurements(size) {
  const f = SIZE_FACTOR[size] ?? 1.0
  const lengthF = (1 + f) / 2 // lengths vary less than girths across sizes
  const out = {}
  for (const [k, v] of Object.entries(BASE_M)) {
    out[k] = k === 'shoulderSlope' ? v : +(v * (GIRTHS.has(k) ? f : lengthF)).toFixed(1)
  }
  return out
}
