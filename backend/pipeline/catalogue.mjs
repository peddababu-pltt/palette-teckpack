// catalogue.mjs — the pattern catalogue (the designs in `sweing pattern garemtns.pdf`)
// described for the vision model, so it can say which catalogue pattern a photo IS,
// or that none of them is. Kept free of the freesewing imports (designs.mjs) so the
// quick upload screen can use it too.
//
// Keys match DESIGNS in designs.mjs.
export const CATALOGUE = {
  teagan: 'T-shirt: crew/scoop neck, set-in short or long sleeves, hip length, pullover knit',
  aaron: 'A-shirt / tank top: sleeveless, deep armholes, scoop neck, hip length',
  tristan: 'Tristan top: fitted cropped bodice with front lace-up and princess seams, straps',
  tina: 'Tina wrap top: front panels cross over diagonally, set-in sleeves, hip length',
  diana: 'Diana draped top: cowl-draped neckline, long fitted sleeves, fitted body',
  simon: "Simon shirt (men's): woven button-front shirt, collar + stand, yoke, long sleeves with cuffs, shirt-tail hem",
  simone: "Simone shirt (women's): as Simon but with bust darts / women's fit",
  charlie: 'Charlie chinos: full-length trousers, slant front pockets, welt back pockets, fly, waistband with belt loops',
  cornelius: 'Cornelius cycling breeches: full through the thigh, gathered into a band below the knee, waistband',
  ashley: 'Ashley shorts: denim-style shorts, fly, waistband with belt loops, jeans pockets, curved hem',
  shale: 'Shale shorts: cargo shorts, wide waistband, large patch pockets on the legs, no fly',
  shin: 'Shin swim trunks: short shorts, elastic/drawstring waistband',
  penelope: 'Penelope pencil skirt: straight fitted skirt to the knee, darts, waistband',
  sandy: 'Sandy circle skirt: very full flared skirt, waistband',
  bruce: "Bruce boxer briefs: men's fitted boxer briefs with leg and front panels",
  uma: "Uma undies: women's briefs with gusset",
  carlita: "Carlita coat (women's): KNEE-LENGTH tailored double-breasted coat, notch lapel, flap pockets",
  carlton: "Carlton coat (men's): KNEE-LENGTH tailored double-breasted coat, notch lapel, flap pockets",
  jett: 'Jett jacket: HIP-LENGTH bomber / puffer jacket, snap or zip front, welt pockets, ribbed or stand collar, ribbed cuffs and waistband; quilted/padded versions included',
  devon: 'Devon jacket: denim trucker jacket, front yoke, chest flap pockets, button front, banded waist',
  wahid: 'Wahid waistcoat: sleeveless tailored vest, V-neck, button front, welt pockets',
  huey: 'Huey hoodie: zip-front hoodie, kangaroo pocket, ribbed cuffs and hem',
  hugo: 'Hugo hoodie: pullover raglan hoodie, kangaroo pocket, drawstring hood',
  yuri: 'Yuri hoodie: wrap-front hoodie closing with one side button, asymmetric drape',
  hannah: 'Hannah hoodie: basic fitted pullover hoodie',
  sven: 'Sven sweatshirt: crew-neck sweatshirt, ribbed neck, cuffs and hem',
  bee: 'Bee bikini top: triangle halter bikini top with ties',
  onyx: 'Onyx one-piece: one-piece swimsuit, front zip, short sleeves and legs',
  lumina: 'Lumina leggings: capri-length leggings with pocket',
  lumira: 'Lumira leggings: full-length leggings',
  otis: 'Otis romper: baby bodysuit / romper with snap crotch',
  albert: 'Albert apron: bib apron with a patch pocket, neck and waist straps',
  benjamin: 'Benjamin bow tie',
}

export const CATALOGUE_KEYS = Object.keys(CATALOGUE)

// A photo counts as a catalogue pattern only at or above this similarity (the same
// garment, not just the same kind); below it the garment is drafted from scratch by
// AI (extra-pieces.mjs draftCustomPieces), using the closest entry as a reference.
export const CATALOGUE_MATCH_MIN = 0.9

export const CATALOGUE_HINT = `"catalogueMatch": { "design": "${CATALOGUE_KEYS.join(' | ')} | none", "similarity": <number 0..1> }  <- compare the garment against this pattern CATALOGUE and pick the ONE entry it actually is:
${CATALOGUE_KEYS.map((k) => `    ${k}: ${CATALOGUE[k]}`).join('\n')}
  similarity: 0.9-1 = the SAME garment as that catalogue pattern (type, silhouette, length, collar, closure and pocket style all match, only minor details differ); 0.55-0.9 = the same kind of garment but with clearly different construction (a different collar, closure, pocket or panel layout, quilting); below 0.55 = a different garment. A different length class (hip-length jacket vs knee-length coat, shorts vs trousers, top vs dress) or silhouette is ALWAYS below 0.55. Be strict. Still name the closest entry even when similarity is low; use "none" only if no entry is even the same kind of garment`

export function validCatalogueMatch(m) {
  return !!m && typeof m === 'object' && (m.design === 'none' || CATALOGUE_KEYS.includes(m.design)) &&
    typeof m.similarity === 'number' && m.similarity >= 0 && m.similarity <= 1
}
