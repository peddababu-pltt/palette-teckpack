// catalogue.mjs — the pattern catalogue (the designs in `sweing pattern garemtns.pdf`)
// described for the vision model, so it can say which catalogue pattern a photo IS,
// or that none of them is. Kept free of the freesewing imports (designs.mjs) so the
// quick upload screen can use it too.
//
// There is NO similarity score: a catalogue pattern is used only when the garment is
// the SAME garment as a catalogue entry (sameGarment: true). Anything else -- even a
// close relative -- is drafted from scratch by the LLM (extra-pieces.mjs
// draftCustomPieces). The body blocks in the PDF (Bella, Bent, Bibi, Breanna, Brian,
// Noble, Sarah, Titan) are slopers, not garments, so they are not catalogue entries.
//
// Keys match DESIGNS in designs.mjs. Each line says what the PDF's flat drawing shows.
export const CATALOGUE = {
  aaron: 'Aaron A-shirt: sleeveless tank, deep scooped armholes, scoop neck, narrow shoulder straps, straight hip-length hem, pullover knit',
  albert: 'Albert apron: bib apron, crossed shoulder straps, one large patch pocket on the front, waist ties, open back',
  ashley: 'Ashley shorts: denim-style short shorts, fly front with button, waistband with belt loops, jeans scoop pockets, curved/rounded leg hem',
  bee: 'Bee bikini top: triangle cups, halter neck ties, under-bust band ties',
  benjamin: 'Benjamin bow tie: tied bow tie with neck band',
  bruce: "Bruce boxer briefs: men's fitted boxer briefs, wide elastic waistband, curved front pouch panel, side leg panels, short legs",
  carlita: "Carlita coat (women's): KNEE-LENGTH tailored double-breasted coat, notch lapel, fitted waist, flap hip pockets, set-in long sleeves",
  carlton: "Carlton coat (men's): KNEE-LENGTH tailored double-breasted coat, notch lapel, straight body, flap hip pockets, set-in long sleeves",
  charlie: 'Charlie chinos: full-length straight trousers, slant front pockets, welt back pockets, fly, waistband with belt loops',
  cornelius: 'Cornelius cycling breeches: very full through the thigh, gathered into a band just below the knee, fly, waistband',
  devon: 'Devon jacket: denim trucker jacket, pointed front yoke seam, two button-flap chest pockets, vertical front panel seams, button front, shirt collar, banded waist, buttoned cuffs',
  diana: 'Diana draped top: cowl-draped neckline falling in folds at the front, long fitted set-in sleeves, fitted body',
  hannah: 'Hannah hoodie: basic fitted pullover hoodie, set-in sleeves, no front opening, no kangaroo pocket',
  huey: 'Huey hoodie: zip-front hoodie with full-length zip, drawstring hood, kangaroo pocket split by the zip, ribbed cuffs and hem band',
  hugo: 'Hugo hoodie: pullover RAGLAN hoodie, drawstring hood, front kangaroo pocket, ribbed cuffs and hem band',
  jett: 'Jett jacket: HIP-LENGTH bomber / puffer jacket, snap or zip front, stand or rib collar, welt hip pockets, ribbed cuffs and waistband; quilted/padded versions included',
  lumina: 'Lumina leggings: capri (mid-calf) leggings, wide yoga waistband, side leg panel with pocket',
  lumira: 'Lumira leggings: full ankle-length leggings, wide waistband, shaped leg seams',
  onyx: 'Onyx one-piece: one-piece swimsuit / surf suit, raglan short sleeves, centre-front zip, short legs',
  otis: 'Otis romper: baby bodysuit / onesie, short sleeves, envelope neck, snap crotch',
  penelope: 'Penelope pencil skirt: straight fitted knee-length skirt, darts, waistband, back slit/zip',
  sandy: 'Sandy circle skirt: very full flared circle skirt, waistband',
  shale: 'Shale shorts: wide waistband, slanted side pockets, large patch pockets on the legs, no fly',
  shin: 'Shin swim trunks: short shorts, elastic waistband with drawstring, curved side hem',
  simon: "Simon shirt (men's): woven shirt, collar + stand, button placket, back yoke, set-in long sleeves with buttoned cuffs, curved shirt-tail hem -- also zip-front shirt-jackets / overshirts built the same way",
  simone: "Simone shirt (women's): as Simon (collar + stand, placket, yoke, cuffs, shirt-tail hem) but with bust darts / women's fit",
  sven: 'Sven sweatshirt: crew-neck sweatshirt, set-in long sleeves, ribbed neckband, ribbed cuffs and hem band',
  teagan: 'Teagan T-shirt: crew neck with neckband, set-in short sleeves, straight hip-length hem, pullover knit',
  tina: 'Tina wrap top: front panels cross over diagonally (V wrap), set-in short sleeves, hip length',
  tristan: 'Tristan top: fitted cropped bodice, front lace-up, princess seams, shoulder straps, optional peplum',
  uma: "Uma undies: women's briefs, front, back and crotch gusset",
  wahid: 'Wahid waistcoat: sleeveless tailored vest, V-neck, single-breasted button front, welt pockets, pointed front hem',
  yuri: 'Yuri hoodie: wrap-front hoodie with asymmetric draped front panel closing with one button at the neck, hood',
}

export const CATALOGUE_KEYS = Object.keys(CATALOGUE)

// Details the drafter adapts on any catalogue pattern (photo-draft.helpers.mjs
// overlays + extra-pieces.mjs feature pieces), so they must never push a garment
// off a pattern whose body construction is right.
export const ADAPTED_DETAILS = 'closure type (buttons / zip / snaps), cuff style (shirt cuff / rib cuff / plain hem), ' +
  'pocket presence and style, collar point shape and size, separate waistband or rib hem band, badges, trims, colour, fabric and quilting stitch lines'

export const CATALOGUE_HINT = `"catalogueMatch": { "design": "${CATALOGUE_KEYS.join(' | ')} | none", "sameGarment": <true | false>, "reason": "<one short sentence>" }  <- our sewing-pattern catalogue (the patterns we can cut exactly) is:
${CATALOGUE_KEYS.map((k) => `    ${k}: ${CATALOGUE[k]}`).join('\n')}
  Decide whether the garment IS one of these catalogue garments -- the SAME garment, not a similar one. sameGarment is true ONLY when sewing that catalogue pattern would give this garment's body construction: the same panels and seam lines (yokes, princess seams, panel splits, wrap/drape fronts), the same sleeve type (set-in / raglan / dropped / sleeveless), the same collar family (shirt collar + stand / stand collar / hood / lapel / none), the same length class (cropped / hip / knee / ankle) and the same silhouette (fitted / straight / flared / gathered).
  These are adapted automatically on any catalogue pattern, so they must NOT make sameGarment false on their own: ${ADAPTED_DETAILS}.
  sameGarment is false for anything that only resembles an entry: a dress, jumpsuit, kurta, kimono, cape, poncho, saree blouse, a blazer or hip-length jacket vs a knee-length coat, a raglan top vs a set-in one, an A-line skirt vs a pencil or circle skirt, shorts vs trousers, an extra panel or yoke the entry does not have. When unsure, answer false -- a non-catalogue garment is drafted perfectly from scratch, a wrong catalogue pattern is not.
  Lower garments: LEG LENGTH decides the family first -- legs ending at or above the knee are shorts (ashley, shale, shin, bruce, uma), legs reaching toward the ankle are trousers/leggings (charlie, cornelius, lumira); capri (mid-calf) is lumina. Shorts are never the same garment as a trouser entry, and the reverse.
  "design" is the matching entry when sameGarment is true; when it is false give "none".`

export function validCatalogueMatch(m) {
  return !!m && typeof m === 'object' && typeof m.sameGarment === 'boolean' &&
    (m.design === 'none' || CATALOGUE_KEYS.includes(m.design)) && (m.sameGarment ? m.design !== 'none' : true)
}

// The catalogue design to cut, or null when the garment is not a catalogue garment
// (then the LLM drafts every piece). No match at all also means null: nothing is
// ever forced onto a "nearest" catalogue pattern.
export function catalogueDesignFor(m) {
  return validCatalogueMatch(m) && m.sameGarment && m.design !== 'none' ? m.design : null
}
