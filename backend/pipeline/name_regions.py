#!/usr/bin/env python3
"""
name_regions.py — Claude Vision names the auto-segmented regions.

Usage: ANTHROPIC_API_KEY=... python3 name_regions.py seg_out/ groups.json

Sends seg_out/preview.png (numbered regions) plus the region stats from
seg_out/regions.json, gets back the name -> region-ids mapping that
layered_trace_v4.py consumes.
"""
import base64
import io
import json
import math
import os
import sys

from _bootstrap_deps import ensure

ensure(modules=["scipy"], packages=["scipy==1.18.0"])
import anthropic  # noqa: E402

try:                                   # load .env if python-dotenv installed
    from dotenv import load_dotenv
    load_dotenv()                      # looks in current dir and parents
except ImportError:
    pass
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402
from scipy import ndimage  # noqa: E402

PROMPT = """This is a fashion flat sketch of a garment (could be ANY type:
jacket, shirt, t-shirt, hoodie, pants, shorts, skirt, dress, saree blouse,
kurta, etc.). Every enclosed area has been auto-segmented and labeled with
a red NUMBER at its centroid.

Region stats (id: area px, centroid [x,y], bbox [x0,y0,x1,y1]):
{stats}

Group ALL region ids into named garment parts. Rules:
- Part names MUST contain one of these keywords (used for layer stacking):
  body, panel, leg, yoke, sleeve, hem, cuff, waistband, fly, zip, placket,
  pocket, collar, hood, strap, belt, badge, label, drawcord, button, trim
- Prefix each name with the view it belongs to: front_/back_/side_
  (views are separate drawings side by side; use x-position).
- SURFACE PATTERN IS NOT A PART. Print, texture, quilting, houndstooth,
  check, stripe, camo, hatching, shading and any other all-over decoration
  is printed or stitched ONTO a panel — it is not a seam and it never cuts
  a pattern piece. It still segments, because a printed shape encloses
  white just like a seam does, so a single body panel can arrive as dozens
  of small look-alike regions tiling one area. Group EVERY one of them into
  the single panel they sit on. You are naming the pieces a cutter would
  cut, not the shapes a printer would print.
  Never emit a part per cell, and never invent numbered siblings for them
  ("front_left_panel_7", "front_left_panel_8", ...) — a garment has one
  front left body panel, not twenty-eight. Never name a part after the
  decoration itself (no "houndstooth", "quilt", "check", "hatch" parts).
  The tell is repetition: many regions of similar size and shape, evenly
  tiling one area, is a pattern. Real pieces vary wildly and each appears
  once per side.
  This applies to the SLEEVE hatching too: diagonal ruling drawn down a
  sleeve is shading on that sleeve, so its regions go into the sleeve —
  not into a separate "trim" or "panel" part.
- THE ARMHOLE IS A CUT LINE, NOT A PIECE. Where a sleeve meets the body there
  is a seam, and its only job is to say where the sleeve stops and the body
  panel starts. Never emit a part for the strip along it -- no
  "front_left_yoke", "front_right_yoke", "shoulder_panel" or "armhole_panel",
  however much the drawing shades or hatches that shoulder area. Put those
  regions in the sleeve if they sit outboard of the seam and in the body panel
  if they sit inboard, so exactly two parts meet there with nothing between.
  A BACK YOKE is the exception and IS a real piece: it is the panel above a
  seam running right across the upper back, from armhole to armhole, well
  below the shoulder. The test is that seam. A front view has no yoke unless
  a seam like that crosses it too.
- The parts you are looking for are the garment's construction pieces:
  body panels (front left/right, back), yoke, sleeves, cuffs, collar,
  waistband, plackets, zip, buttons, pockets, and the dashes/topstitch
  that mark them. If a name you are about to emit is not one of those
  kinds of piece, it is probably decoration — put its regions in the panel
  underneath instead.
- Quilted/paneled parts appear as several stacked regions: group ALL the
  sections of ONE sleeve/leg/pocket/cuff instance into that ONE part —
  never merge the left instance and the right instance together.
- Ribbed bands (cuffs, hems, waistbands) appear as clusters of many thin
  regions: group each cluster into its one part.
- A CUFF IS ITS OWN PART, never the last band of the sleeve. At the wrist a
  sleeve ends in a band bounded by a real seam on its TOP edge and the
  garment's own bottom edge below — knit/rib, elastic, or a plain buttoned
  cuff. It is a separate pattern piece in a different fabric, so it must not
  be grouped in with the sleeve's quilted sections above it, even though it
  continues the same column and the "group ALL the sections of ONE sleeve"
  rule would otherwise sweep it in. Emit it as e.g.
  "front_left_cuff": {{"regions": [61]}} and leave the sleeve holding only
  the sections above the cuff seam. Do this for EVERY sleeve, front and
  back: if one sleeve's cuff is split out and its pair's is not, the two
  sleeves come out different lengths.
- A HEM ALLOWANCE IS ITS OWN PART -- BUT ONLY WHEN THE SKETCH ACTUALLY DRAWS
  ONE. First decide whether this garment has a hem strip at all.
  A thin region along the bottom edge is NOT sufficient evidence. A stray
  topstitch line drawn just above the bottom edge produces exactly such a
  strip, and naming it cuts a phantom piece from a garment that has none.
  Apply this test to any candidate bottom strip: does it carry visible
  vertical RIB TICKS the way a rib cuff does, or any interior marking of its
  own? If YES, it is a real band -- name it. If NO -- it is featureless, just
  two lines with blank white between them -- it is a topstitch artifact:
  DO NOT name a hem part, and fold those regions into the body panel above so
  the panel runs to the garment's true bottom edge.
  Likewise if the bottom of the panel is a single plain edge with no second
  line above it, THIS GARMENT HAS NO HEM PART: do not emit one, do not carve a
  strip out of the panel to make one, and do not add one for symmetry with
  another view. Most garments here have no separate hem part, and inventing
  one is a defect -- it prints a duplicate band across a bottom edge that has
  none.
  When a real hem strip IS present, split it out into its own part
  (e.g. "front_left_hem": {{"regions": [21]}}) and leave the panel above
  holding only the sections above that line, so the panel is cut to that
  line, not the garment's outer edge.
  Then apply it consistently: if the left and right panels split their strip
  out into "front_left_hem" / "front_right_hem" and the center one keeps its
  strip fused into "front_center_panel", the center panel runs ~30px longer
  than its neighbours and the seams between them step. Symmetry is the check
  on a hem that exists, never a reason to invent one: name a hem part for
  every panel along that same hem line, or -- the common case -- none at all.
  A ribbed hem BAND (visible rib ticks, a real band with two edges) is a
  different thing and is named as usual; this rule is about the thin
  turned-up allowance strip.
- A BELT / STRAP / TIE crossed by loops, keepers or a buckle is still ONE
  piece. Each loop laid over it chops its interior into a separate region,
  so one belt arrives as a ROW of regions sitting side by side along the
  same axis, all sharing nearly the same y-range (for a horizontal belt) or
  x-range (for a vertical one), butted end to end at each loop. Group that
  WHOLE row — every section between the loops, plus the tapered tip section
  and the section running under/behind the buckle — into ONE part named for
  the belt (e.g. "front_belt"). Never emit belt_center_panel + belt_tip +
  belt_right_panel as separate parts: that is one belt cut into fragments,
  and it must come out as a single continuous piece.
  The BUCKLE itself is its own separate part ("front_belt_buckle") — it is a
  distinct piece of hardware, not fabric. So are the LOOPS/keepers, one part
  each. Everything else along that row is the belt.
  Only merge sections that genuinely lie ALONG the belt's own axis. A region
  running PERPENDICULAR to it — for a horizontal belt, a tall narrow strap
  down the side seam, whose y-range is several times the belt's own height —
  is a different piece entirely (a side adjuster strap / tab), even where it
  touches the belt's end. Keep each of those as its own part; folding them
  into the belt stretches it into an L or U shape that is not a belt.
  This side strap/tab MUST still get its OWN named part, e.g. "front_belt_tab"
  (name always contains "belt") — never leave it unnamed, and never fold its
  region into whatever body panel or sleeve it happens to overlap just
  because it bends away from the belt's main axis. A belt's excess tail
  hanging past its buckle is this same case: it is anchored AT the buckle
  (touches or overlaps the buckle region), not merely resting near the belt's
  end, and it still needs its own "*_belt_tab" part rather than disappearing.
- Bilateral parts (sleeves, legs, pockets, side panels, straps) exist as
  TWO separate instances — left and right — even if both appear under one
  view. Each instance is its OWN part with "left_"/"right_" in the name
  (e.g. "front_left_sleeve", "front_right_sleeve"). Use each instance's
  x-position (centroid) to tell them apart. Never combine both instances'
  region ids into a single part.
- Left/right means the VIEWER's left/right.
- EVERY VIEW WITH SLEEVES GETS ITS OWN SLEEVE PARTS. A back view of a
  sleeved garment shows two sleeves just as the front does, so
  "back_left_sleeve" and "back_right_sleeve" MUST exist alongside
  "front_left_sleeve" and "front_right_sleeve". Naming the front sleeves
  and then leaving the back sleeves' regions inside "back_left_body_panel"
  / "back_right_body_panel" is a defect: the back panel then comes out as a
  torso with an arm fused to it and cannot be cut as a pattern piece.
  Before you answer, check each view separately — if a view has a sleeve in
  the drawing and no sleeve part in your output, you have merged it into a
  body panel; find the outboard region in that view and split it out.
  The same completeness check applies to cuffs, pockets and collars: a
  feature the drawing shows on both views is named on both views.
- A BODY PANEL IS A TORSO ONLY. Its outline is a torso column — shoulder,
  armhole, side seam, hem. If a group's regions together form a torso WITH
  an arm attached, the arm's region does not belong to that group. Judge
  this on the combined silhouette of the group, not on one region at a
  time: a region can look plausible on its own and still be the piece that
  welds an arm onto a torso.
- SLEEVE vs BODY PANEL — the most common mistake, check carefully:
  the body panel is the WIDE central torso column flanking the front
  opening/placket. The sleeve is the NARROWER column OUTBOARD of the
  body panel (further from the center placket), running from the
  shoulder seam down to the cuff — it is a visually separate limb
  silhouette, not part of the torso mass. Compare each region's bbox
  x-range to the placket's x-position: regions closer to center are
  body/torso, regions farther out (near the garment's left/right
  silhouette edge) are sleeve. Do not swap these two labels.
- RAGLAN SLEEVES: when a diagonal seam runs from the neckline (beside the
  collar) down and out to the underarm, the sleeve starts AT THE NECK.
  Everything outboard of that diagonal seam -- the top shoulder wedge and
  every band below it down the outer arm to the cuff -- is the SLEEVE; the
  regions INBOARD of the diagonal (between it and the placket/centre) are the
  body panel, even the top ones under the collar. On a raglan coat the
  sleeve column is diagonal, so its bands do not share one x-range: follow
  the arm's own outline from the neck to the cuff instead.
- A quilted/paneled sleeve is cut into SEVERAL regions stacked from
  shoulder to cuff, all sharing nearly the SAME bbox x-range (only y
  differs, band after band down the arm). Once you identify ONE band
  in that x-range as sleeve, EVERY OTHER region sharing that same
  x-range — all the way down to the cuff — is that SAME sleeve, not
  body. Never classify only the top band as sleeve and leave the
  remaining bands below it in the body panel: check every region's
  x-range against the sleeve's, not just the first one you find.
- COLLAR vs YOKE vs PLACKET — these three sit close together near the
  neckline/center-front and are the most commonly WRONGLY merged parts.
  Even when their outlines touch or share a seam line, they are ALWAYS
  separate parts:
  - COLLAR: the band that wraps the neckline itself (collar stand +
    leaf, or hood trim). Shape: a curved strip hugging the neck.
    SIZE IS NOT A TEST. A SHAWL, LAPEL OR NOTCH collar is a LARGE draped
    shape, not a narrow strip: it frames the neck opening and sweeps down
    both sides of the chest to the V where the two sides meet, and on a
    puffer it can be the single biggest region in the front view. That
    whole shape is COLLAR. Do not reject a region as "too big to be a
    collar" and file it under a body panel -- measured on a shawl-collar
    puffer, the collar region ran 133k px against the body panel's 44k,
    and calling it front_left_body_panel put the entire collar inside the
    panel's extracted piece. What decides is POSITION AND ROLE: a shape
    that wraps the neck opening and turns back on itself down the chest
    is the collar at any size. The body panel is what lies OUTBOARD and
    BELOW it, behind the collar's own attachment edge.
  - YOKE: the panel just below/behind the collar's attachment seam,
    spanning shoulder to shoulder (classic case: back yoke). Shape: a
    roughly horizontal panel at shoulder width. It is BELOW the collar
    seam — never part of the collar itself.
  - PLACKET: the narrow vertical button/buttonhole strip running down
    the center-front opening, starting below the collar. Shape: a thin
    vertical column down the chest. It is NOT the collar and NOT the
    yoke, even though it starts right where the collar ends.
    On a stand/funnel collar the placket usually runs UP THROUGH the
    collar to its top edge, so at collar height the same narrow column
    continues, flanked by the collar band on both sides. Those
    collar-height sections of the column are PLACKET (same x-range as the
    strip below — check the x-range, not the y-position), and the wide
    band either side of them is COLLAR. Getting this backwards — filing
    the wide neck band under placket and the narrow strip under collar —
    is the single most common failure on this garment type.
    - The collar may also show a small facing/notch shape drawn at center
      front ABOVE where the placket starts (inside the collar's top
      edge). That is COLLAR, even though it sits in the placket's own
      x-range: it is higher up than the placket's topmost point.
  Judge by shape and position, not just adjacency: curved neck-hugging
  band -> collar; horizontal shoulder-width panel -> yoke; thin
  vertical strip down center front -> placket. Each gets its own part
  name. A FRONT-view collar and a BACK-view collar are also separate
  parts (front_collar / back_collar) — never merge them with each
  other or with a yoke/placket region just because they're adjacent.
  - A common variant: a narrow diagonal/triangular strip running from
    the collar's outer point OUT to the sleeve/armhole at the shoulder
    (a front shoulder panel/yoke) is easy to mistake for part of the
    collar because they touch at a seam. It is NEVER part of the
    collar. Check each region individually, not just the group as a
    whole: a region whose bbox sits mostly OUTBOARD of the collar's own
    neck-hugging band (farther from center front, closer to the
    sleeve/shoulder point) is that shoulder panel, even if its region
    id was segmented right next to collar ids. Give it its own part,
    e.g. "front_left_shoulder_panel"/"front_right_shoulder_panel".
- NOTCH LAPEL / FOLD-LINE COLLARS: on a blazer/jacket with a notch lapel,
  the "collar" and "lapel" are usually NOT their own enclosed region at
  all — the roll line / gorge line is a fold guide drawn on the SAME
  continuous front body panel, not a real seam, so no separate region id
  will exist for it. Do not force-fit some other nearby small region
  (a pocket square, a buttonhole, a stray sliver) into a "collar"/"lapel"
  part just because the naming schema expects one. If no region's own
  shape actually matches a genuine separate collar/lapel piece, omit that
  part entirely and leave the full silhouette as body_panel — a missing
  part is correct here; a wrong region wearing that name is not.
- POCKETS (welt, flap, patch) are small closed shapes with a
  button/snap, sitting ON TOP of the body panel around waist/chest
  height — never label a pocket region "sleeve", and never label a
  torso/body-panel region "pocket" just because a pocket sits near it.
  A welt pocket is often drawn with a dashed rectangle/box stitch-guide
  line running from the welt sideways across to the placket/center-front
  edge (marking the pocket bag's hidden stitch line through the panel
  fabric). That dashed box's region is BODY-PANEL fabric with a
  construction marking on it, not the pocket piece itself — only the
  welt slit region (the small closed shape actually cut/bound with a
  button) is the pocket's own part. If a region's bbox reaches sideways
  all the way from the welt to the placket/center-front seam, it is the
  body panel, not the pocket, even though it was segmented touching the
  welt's region id.
  That welt rule applies ONLY to welt pockets. A PATCH or CARGO pocket is
  a real piece of fabric laid on the panel: a closed box sitting directly
  under (or behind) its own flap, with its own outline and its own
  topstitch border on all sides, and its bottom edge well clear of the
  panel's hem. Its bag region IS the pocket — put it in the pocket part
  together with the flap, never in the body panel. Tell the two apart by
  what the box hangs off: a welt bag box runs SIDEWAYS out of a narrow
  slit toward the center front and dies at a seam, while a patch pocket's
  box hangs DOWNWARD from a flap of matching width and is closed on all
  four sides. When a flap and the box beneath it have nearly the same
  width and share an edge, they are one patch pocket — emit them as a
  single part with BOTH region ids (e.g.
  "front_left_pocket": {{"regions": [33, 42]}}), not a flap part plus a
  body-panel region.
- A SEAM LINE IS NOT A PART. A yoke/across-back seam is drawn as two
  parallel lines a few px apart, which seals the sliver between them into a
  region of its own — a very long, very thin strip spanning the panel's full
  width. That strip is the seam allowance of the piece ABOVE it, so it goes
  into that piece's regions (e.g. "back_yoke": {{"regions": [7, 16]}}), giving
  the yoke its true bottom edge. Never emit it as its own
  "..._seam_line"/"..._stitch_line" part: on its own it is a floating hairline
  layer and the panel above it is cut short of the seam it attaches at.
- Every region id must appear in exactly ONE part. Never invent ids.
- A ZIP IS TEETH. THAT IS WHAT MAKES IT A ZIP. Before you emit any part
  whose name ends in "_zip", find the repeating tooth/ladder texture — the
  row of short ticks packed close together between two rails, usually with
  a slider and an end stop. If a strip has no teeth it is NOT a zip: a
  dashed or dotted line is topstitching or a quilt seam, two plain parallel
  lines are a placket or a panel seam, and a plain curved line down a
  sleeve is a sleeve seam. Naming one of those "..._zip" invents hardware
  the garment does not have and hands the tracer an empty strip. Do not
  emit a zip part "just in case" — no teeth, no zip part.
- EVERY REAL ZIP GETS ITS OWN PART AND ITS OWN grab_box — no exceptions,
  and not just the main front one. Sweep the whole sketch and emit one part
  per toothed strip you can actually see: front/center zip, chest zip, each
  pocket zip, each sleeve/cuff zip, each vent or hem zip, front AND back
  views separately. A zip on the front view does NOT imply one on the back:
  name only the ones the drawing shows. Name them distinctly (e.g.
  "front_chest_zip", "front_left_pocket_zip", "back_left_sleeve_zip").
  Missing the grab_box is worse than missing the part: without one the
  teeth are traced at low resolution by whichever panel they land on and
  fuse into a SOLID BLACK BAR across the drawing.
- A DIAGONAL STRIP USES "grab_poly", NOT grab_box. grab_box is an
  axis-aligned rectangle, so it cannot follow a zip that runs corner to
  corner across the front: a narrow vertical box at the zip's top
  x-position misses everything below it, and a box wide enough to reach the
  bottom end swallows both front panels. Whenever a strip's two ends are at
  clearly DIFFERENT x-positions, give "grab_poly" instead — the four
  corners of the strip itself, as [[x,y],[x,y],[x,y],[x,y]] going around
  the quadrilateral in order: top-left of the top end, top-right of the top
  end, bottom-right of the bottom end, bottom-left of the bottom end. Keep
  it the strip's own width, the same way grab_box would be kept tight, and
  cover its full length end to end including the slider and end stop. Omit
  grab_box when you give grab_poly; the bounds are computed from it.
  A vertical or horizontal strip does NOT need a polygon — grab_box is
  simpler and works.
- For a stitched strip whose stitching crosses other parts (zipper tape,
  button placket, fly topstitch), add "grab_box": [x0,y0,x1,y1] covering
  ONLY that strip's own exclusive content (e.g. a zip's teeth/pull track).
  Keep the box TIGHT to that content's own WIDTH (x0/x1) — do NOT extend it
  out sideways to the topstitch lines flanking the strip on either side.
  Those flanking topstitch lines run along the body panel's own edge (the
  panel fabric the zip is sewn to) and must stay with the panel, not get
  pulled into the zip/placket's own piece.
  A ZIP CARRIES ITS OWN TAPE EDGES, THOUGH. The zip's cut piece is the
  complete strip: the two rail/tape edge lines, the teeth between them, and
  the slider and end stops. Take the rails WITH the teeth — teeth alone
  trace as a floating ladder with no piece around them. What stays behind
  on the panel is only the topstitch line OUTSIDE the tape, not the tape
  edge itself.
- THE BODY PANELS ARE CUT AT THE ZIP'S TAPE EDGE. A zip is a real seam: the
  pieces either side of it stop at its tape edge lines, and no region may
  run across a zip from one side to the other. Where the front opening zip
  crosses the body, that is the boundary between the left front panel and
  the right front panel — a region spanning both sides of the zip is a
  segmentation leak and must go to the side holding most of its area, never
  be left bridging the two. The same holds for a pocket zip against its
  pocket, and a sleeve zip against its sleeve.
  However, the box's HEIGHT (y0/y1) must cover the strip's FULL visible
  length end to end — e.g. a zip runs from its pull-tab/slider at the top
  down to its bottom end-stop/bar-tack, which is usually longer than the
  toothed region alone. Check the actual ink for the tab and stop marks
  (they can sit beyond the segmented region's own bbox) and set y0/y1 to
  cover them too — do not truncate the box to just the mid-length teeth.
  "TIGHT TO THE CONTENT" ONLY APPLIES when the strip has its own separate
  interior content (teeth, tape print, ticks) drawn INSIDE two flanking
  lines that belong to the panel instead. A PLAIN double-line placket/band
  (just two parallel lines with blank fabric between, no separate interior
  marks) has NO exclusive content at all to grab_box -- do not invent a
  full-height grab_box for it. Those two lines are each a neighboring
  panel's own center-front edge and are already correctly shared onto both
  panels automatically; a grab_box spanning that blank interior can never
  actually capture either line (both sit outside a tight interior box, and
  widening it does not help either, since the lines are fused into the
  garment's main outline stroke, not an isolated one) -- it only produces
  an empty layer. Only give this kind of part a grab_box, or its own part
  at all, for a genuinely separate small piece (e.g. a distinct flap/tab
  at one end with its own closed outline) -- leave the rest of the strip's
  length unassigned to any placket part; it's already handled as shared
  panel edges.
- FUR/WOOL TRIM: a fuzzy, scribbly-textured line running along an edge
  (hood opening, front placket, hem, collar) is a separate trim piece, not
  part of the body/hood/collar panel it borders. Even though it sits right
  against that panel's edge and their outlines touch, give it its own part
  name containing "trim" (e.g. "hood_fur_trim", "front_left_trim"). Never
  merge its region ids into the panel it decorates.
- DRAWCORD/THREAD TAIL: a thin dangling line hanging free below a hem,
  cuff, or waistband (a drawcord tail or loose thread end) is its own
  separate part — never merge it into the hem/body region it hangs from,
  even though it touches it at one end. Name it with "drawcord" (e.g.
  "front_drawcord").
- Order z_order from bottom layer to top (big panels first, small applied
  details like pockets/badges/collars last, trim and drawcord on top since
  they visually sit over/in front of the edge they hang from).

Respond with ONLY valid JSON, no markdown fences. Include a
"garment_type" field classifying the garment (e.g. "puffer jacket",
"shorts", "hoodie", "kurta"):
{{
 "garment_type": "puffer jacket",
 "z_order": ["body","panel","leg","yoke","sleeve","hem","cuff","waistband","fly","zip",
   "placket","pocket","collar","hood","strap","badge","label","button"],
 "parts": {{
   "front_body": {{"regions": [6,7]}},
   "front_left_sleeve": {{"regions": [10,11]}},
   "front_right_sleeve": {{"regions": [12,13]}},
   "front_zip":  {{"regions": [8,9], "grab_box": [695,180,715,1350]}},
   "front_moto_zip": {{"regions": [14], "grab_poly": [[660,120],[700,120],[880,1400],[840,1400]]}}
 }}
}}"""


def repair_parts(parts: dict, all_ids: set, info: dict) -> dict:
    """De-dupe/validate each part's region ids, release any region wrongly
    attached to a grab_box part (see below), reassign every unclaimed region
    to its nearest part by centroid distance, then drop only parts left with
    neither regions nor a grab_box. A part with an empty regions list but a
    grab_box is still valid -- e.g. a zip whose ink comes entirely from
    geometric box-grab, not region membership (see layered_trace_v4.py) --
    dropping it here would silently un-separate it back into whichever part
    borders its grab_box."""
    # The model routinely claims one region for two parts: once for the
    # specific part it belongs to (a hem band, a cuff) and again for the
    # umbrella panel it sits on. Taking the FIRST claimant -- i.e. whichever
    # the model happened to list earlier -- always handed it to the umbrella,
    # because the model lists body panels first. A band whose only region went
    # that way was left with no regions at all and got dropped below, which is
    # how a named back_hem vanished into back_body_panel and both cuffs lost
    # half their area.
    #
    # Award each contested region to the part it matters MOST to, measured as
    # the share of that part's own total area. A hem band IS its region (share
    # 1.0); to the body panel the same region is a sliver. Being a ratio, this
    # holds regardless of sketch resolution or how many regions a part has.
    def _area(r):
        return info[str(r)]["area"]

    claimed = {nm: list(dict.fromkeys(r for r in p.get("regions", []) if r in all_ids))
               for nm, p in parts.items()}
    totals = {nm: sum(_area(r) for r in rs) or 1 for nm, rs in claimed.items()}
    winner = {}
    for nm, rs in claimed.items():
        for r in rs:
            if r not in winner or _area(r) / totals[nm] > _area(r) / totals[winner[r]]:
                winner[r] = nm
    for nm, p in parts.items():
        kept = [r for r in claimed[nm] if winner[r] == nm]
        if len(kept) != len(claimed[nm]):
            lost = [r for r in claimed[nm] if winner[r] != nm]
            for r in lost:
                print(f"  region {r} claimed by {nm} and {winner[r]} "
                      f"-> {winner[r]} (it is {_area(r) / totals[winner[r]]:.0%} of that part)")
        p["regions"] = kept
    seen = {r for rs in claimed.values() for r in rs}

    # A grab_box part is meant to be a small, tight box-cut feature (zipper
    # tape/teeth, guard stitching -- per layered_trace_v4.py's own docstring).
    # The naming model can still additionally attach a whole region to it;
    # if that region's own bbox doesn't even overlap the grab_box, it's a
    # naming mistake (observed in practice: a large unrelated fabric region
    # hallucinated onto a zip), not real content for this part -- release it
    # back to the unassigned pool instead of ballooning the part into a
    # warped, oversized shape once its ink gets captured and traced.
    released = []
    for p in parts.values():
        gb = p.get("grab_box")
        if not gb or not p["regions"]:
            continue
        gx0, gy0, gx1, gy1 = gb
        keep = []
        for r in p["regions"]:
            rx0, ry0, rx1, ry1 = info[str(r)]["bbox"]
            if rx0 < gx1 and rx1 > gx0 and ry0 < gy1 and ry1 > gy0:
                keep.append(r)
            else:
                released.append(r)
        p["regions"] = keep
    seen -= set(released)

    missing = (all_ids - seen) | set(released)
    if missing:
        cents = {nm: [sum(c) / len(c) for c in zip(
            *[info[str(r)]["centroid"] for r in p["regions"]])]
            for nm, p in parts.items() if p["regions"]}
        for rid in missing:
            cx, cy = info[str(rid)]["centroid"]
            nm = min(cents, key=lambda n: math.dist(cents[n], (cx, cy)))
            parts[nm]["regions"].append(rid)
    return {nm: p for nm, p in parts.items() if p["regions"] or p.get("grab_box")}


def _boxes_near(a: tuple, b: tuple, tol: float) -> bool:
    """True if bbox `a` touches or sits within `tol` px of bbox `b` -- used to
    tell a belt's own tail (anchored at the buckle) from an unrelated strap
    that merely happens to run across the belt's middle."""
    gap_x = max(b[0] - a[2], a[0] - b[2], 0)
    gap_y = max(b[1] - a[3], a[1] - b[3], 0)
    return gap_x <= tol and gap_y <= tol


def split_offaxis_belt_regions(parts: dict, info: dict) -> dict:
    """Release regions that run ACROSS a belt out into their own strap part.

    Grouping a belt back into one piece is the right call -- the loops chop
    its interior into a row of regions -- but the naming model applies it
    unevenly, sometimes sweeping in a tall side-adjuster strap that merely
    touches the belt's end (and doing it for one side but not the other). A
    belt is a long band along ONE axis, so a section whose long axis is the
    other one is deterministically not part of it: measure instead of asking
    again."""
    for nm in [n for n in parts if "belt" in n and "buckle" not in n]:
        regs = parts[nm]["regions"]
        if len(regs) < 2:
            continue
        boxes = {r: info[str(r)]["bbox"] for r in regs}
        # Axis from how the sections are STRUNG OUT (centroid spread), not from
        # their union bbox: one tall off-axis region in the group makes the
        # union taller than it is wide and flips the answer, which then
        # released the belt's own centre section and kept the strap.
        cents = [info[str(r)]["centroid"] for r in regs]
        spread_x = max(c[0] for c in cents) - min(c[0] for c in cents)
        spread_y = max(c[1] for c in cents) - min(c[1] for c in cents)
        horizontal = spread_x >= spread_y
        # the belt's own cross-measure: the median thickness of its sections
        thick = sorted((b[3] - b[1]) if horizontal else (b[2] - b[0])
                       for b in boxes.values())[len(boxes) // 2]
        # A belt's own hanging tail/tab past its buckle often bends to a
        # different angle than the main strip (that's the whole point of a
        # buckle), which reads exactly like a perpendicular loop to the
        # across/long_across test below. A loop sits AWAY from the buckle,
        # against the belt's middle; a tail is anchored AT the buckle. Only
        # the latter gets an exemption, so mid-belt loops still release.
        buckle_nm = nm.replace("_belt", "_belt_buckle")
        buckle_box = None
        if buckle_nm in parts and parts[buckle_nm].get("regions"):
            bb = [info[str(r)]["bbox"] for r in parts[buckle_nm]["regions"]]
            buckle_box = (min(b[0] for b in bb), min(b[1] for b in bb),
                          max(b[2] for b in bb), max(b[3] for b in bb))
        keep, off = [], []
        for r, b in boxes.items():
            w, h = b[2] - b[0], b[3] - b[1]
            across = (h > OFFAXIS_RATIO * w) if horizontal else (w > OFFAXIS_RATIO * h)
            long_across = (h if horizontal else w) > OFFAXIS_SPAN * thick
            near_buckle = buckle_box is not None and _boxes_near(b, buckle_box, thick)
            (off if (across and long_across and not near_buckle) else keep).append(r)
        if not keep or not off:
            continue
        parts[nm]["regions"] = keep
        view = nm.split("_")[0]
        for i, r in enumerate(off, 1):
            new = f"{view}_side_strap_{i}"
            while new in parts:
                i += 1
                new = f"{view}_side_strap_{i}"
            parts[new] = {"regions": [r]}
            print(f"  region {r} runs across {nm} -> own part {new}")
    return parts


OFFAXIS_RATIO = 2.0   # long/short bbox ratio that makes a section "across"
OFFAXIS_SPAN = 2.0    # ...and how many belt-thicknesses long it must run

HEM_MAX_FRAC = 0.25   # a hem allowance is at most this fraction of the height
                      # of the panel it belongs to
HEM_MIN_ASPECT = 3.0  # ...and is a wide, thin strip
HEM_JOIN_TOL = 0.06   # its top may sit this far (as a fraction of the panel's
                      # height) from the panel's own bottom edge
HEM_STEP_MIN = 5      # px a sibling panel must run below the hemmed one
                      # before the step between them counts as real


def merge_hem_allowance(parts: dict, info: dict) -> dict:
    """Fold a hem-allowance strip back into the panel it hems.

    The sketch draws a topstitch line parallel to and just above a panel's
    real bottom edge. That line seals the turned-up hem into a region of its
    own, and the naming model then sometimes calls it "..._hem" -- but only
    for SOME panels along the same hem. The result is a panel cut ~30px short
    while its neighbours run to the true edge, so the seams between them step,
    and the strip floats as a separate piece below the panel.

    Only the INCONSISTENT case is repaired here. Geometry cannot tell a hem
    allowance from a genuine ribbed/contrast band -- measured across five
    sketches, a hoodie's rib hem and a skirt's turned-up hem have the same
    one-region, wide-and-thin footprint, so a purely geometric rule merges
    real bands too. What IS decidable is symmetry: if every panel along a hem
    has its own band, that band is real; if some panels have one and their
    neighbours run straight to the edge, the odd ones out are a naming slip,
    and those are the ones that make the seams step. Judging ribbing itself
    is left to the naming prompt, which can actually see it.
    """
    def union_box(p):
        bs = [info[str(r)]["bbox"] for r in p["regions"]]
        return (min(b[0] for b in bs), min(b[1] for b in bs),
                max(b[2] for b in bs), max(b[3] for b in bs))

    hem_names = [n for n in parts if "hem" in n
                 and parts[n].get("regions") and not parts[n].get("grab_box")]
    panels = {n: union_box(p) for n, p in parts.items()
              if p.get("regions") and "hem" not in n}
    for nm in hem_names:
        regs = parts[nm]["regions"]
        boxes = [info[str(r)]["bbox"] for r in regs]
        hx0 = min(b[0] for b in boxes)
        hy0 = min(b[1] for b in boxes)
        hx1 = max(b[2] for b in boxes)
        hy1 = max(b[3] for b in boxes)
        hw, hh = hx1 - hx0, hy1 - hy0
        if hh <= 0 or hw / hh < HEM_MIN_ASPECT:
            continue
        best, best_ov = None, 0.0
        for onm, op in parts.items():
            if onm == nm or not op.get("regions"):
                continue
            obs = [info[str(r)]["bbox"] for r in op["regions"]]
            ox0 = min(b[0] for b in obs)
            oy0 = min(b[1] for b in obs)
            ox1 = max(b[2] for b in obs)
            oy1 = max(b[3] for b in obs)
            oh = oy1 - oy0
            if oh <= 0 or hh > HEM_MAX_FRAC * oh:
                continue
            # the panel must sit directly ABOVE, ending where the strip starts
            if abs(oy1 - hy0) > HEM_JOIN_TOL * oh:
                continue
            ov = max(0, min(hx1, ox1) - max(hx0, ox0)) / float(hw)
            if ov > best_ov:
                best, best_ov = onm, ov
        if not (best and best_ov >= 0.6):
            continue
        # Only repair the case this can actually decide: one panel out of a
        # group of SIBLING panels treated differently from the others.
        # Siblings are named as such -- front_skirt_center_panel next to
        # front_skirt_left_panel / front_skirt_right_panel. If a sibling runs
        # LOWER than this panel, this panel was cut short at the stitch line
        # while its neighbour kept its allowance, and the seam between them
        # steps: that is the bug, and merging fixes it.
        # Bbox geometry alone cannot make this call -- a hoodie's sleeves and
        # a puffer's rib cuffs both hang below the body hem, so a
        # "does any neighbour run lower" test merges real rib hems away.
        # Whether a band is ribbed is left to the naming prompt, which can see
        # it; a garment with no sibling panels (one body per view) is never
        # touched here.
        _, _, _, by1 = panels[best]
        key = "_".join(best.split("_")[:2])
        lower_sibling = next(
            (onm for onm, (_, _, _, oy1) in panels.items()
             if onm != best and "_".join(onm.split("_")[:2]) == key
             and oy1 > by1 + HEM_STEP_MIN), None)
        if not lower_sibling:
            print(f"  {nm} kept: no sibling panel of {best} runs lower "
                  f"-> treat as a real band, not an allowance")
            continue
        print(f"  {lower_sibling} runs below {best}: the seam between them "
              f"steps")
        parts[best]["regions"].extend(regs)
        parts[nm]["regions"] = []
        print(f"  {nm} is a hem allowance of {best} "
              f"({best_ov:.0%} width overlap) -> merged")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


def split_hem_from_panel(parts: dict, info: dict) -> dict:
    """Lift the turned-up hem allowance out of the body panel it belongs to.

    The mirror of split_cuff_bands, one tier up: a hem is now its own part
    (see the naming prompt), but the prompt's own "group every section into
    ONE panel" instinct can still swallow the strip back into a panel the
    model didn't reach for a hem on. Where a view has several body panels
    (a zip splits front into left/right, say), symmetry is the same test
    merge_hem_allowance uses, pointed the other way: if EVERY body panel in
    that view already carries its own hem strip, the hold-out panel that
    doesn't is the naming slip, not the strip. A view with only one body
    panel (a plain back, a dress front) has no sibling to check against, but
    unlike a cuff -- which may genuinely not exist on a given garment -- a
    hem allowance is not optional, so that lone panel is still judged on its
    own shape.
    """
    for view in ("front", "back", "side"):
        panels = [nm for nm in parts
                  if nm.startswith(view + "_")
                  and ("panel" in nm or "body" in nm)
                  and "hem" not in nm and "yoke" not in nm
                  and len(parts[nm].get("regions", [])) > 1
                  and not parts[nm].get("grab_box")]
        if not panels:
            continue
        cand = {}
        for nm in panels:
            boxes = {r: info[str(r)]["bbox"] for r in parts[nm]["regions"]
                     if str(r) in info}
            if len(boxes) < 2:
                continue
            py0 = min(b[1] for b in boxes.values())
            py1 = max(b[3] for b in boxes.values())
            ph = py1 - py0
            if ph <= 0:
                continue
            band = [r for r, b in boxes.items()
                    if b[3] >= py1 - HEM_JOIN_TOL * ph
                    and (b[3] - b[1]) > 0
                    and (b[3] - b[1]) <= HEM_MAX_FRAC * ph
                    and (b[2] - b[0]) >= HEM_MIN_ASPECT * (b[3] - b[1])]
            if not band or len(band) >= len(boxes):
                continue
            cand[nm] = band
        if len(panels) >= 2 and len(cand) != len(panels):
            if cand:
                print(f"  {view}: only {len(cand)}/{len(panels)} panels end "
                      f"in a thin strip -> left fused, not symmetric enough "
                      f"to split")
            continue
        for nm, band in cand.items():
            new = (nm.replace("body_panel", "hem") if "body_panel" in nm
                   else nm.replace("panel", "hem") if "panel" in nm
                   else nm + "_hem")
            i = 2
            while new in parts:
                new = f"{new.rstrip('0123456789_')}_{i}"
                i += 1
            parts[nm]["regions"] = [r for r in parts[nm]["regions"]
                                    if r not in band]
            parts[new] = {"regions": sorted(band)}
            print(f"  {nm} ends in strip {sorted(band)} -> own part {new}")
    return parts


APPLIED_KEYWORDS = ("pocket", "flap", "badge", "label", "trim", "welt")
HOST_KEYWORDS = ("panel", "body", "sleeve", "yoke", "skirt", "leg", "front",
                 "back")

# Who may ADOPT a region handed back by one of the repairs below. HOST_KEYWORDS
# is too loose for that job -- it matches "front"/"back", so every part in the
# view qualifies, and a released body panel got handed to front_main_zip purely
# because the zip ran along its edge and shared the longest border with it.
# A piece of fabric can only be re-homed into a piece of fabric.
STRUCT_HOST = ("panel", "body", "sleeve", "yoke", "skirt", "leg", "bodice",
               "torso")
NON_HOST = ("zip", "placket", "button", "belt", "strap", "buckle", "loop",
            "drawcord", "epaulette", "trim", "badge", "label", "pocket",
            "flap", "welt", "collar", "cuff", "hem", "waistband", "seam",
            "stitch", "vent")


def _can_host(nm: str) -> bool:
    return (any(k in nm for k in STRUCT_HOST)
            and not any(k in nm for k in NON_HOST))


def cuffs_are_expected(segdir: str):
    """Does this garment have cuffs at all, per stage 1's own classification?

    Geometry cannot separate a rib cuff from a turned-back sleeve hem -- both are
    a wide thin band at the wrist bounded by a seam above and the garment's edge
    below (measured: the biker's hem halves and the bomber's knit cuff overlap on
    every shape measure). What CAN tell them apart is that the classifier already
    read the drawing: the puffer and the bomber list "ribbed cuffs" among their
    construction elements, the biker jacket mentions no cuff at all.

    Returns True/False, or None when there is no classification to consult (then
    callers leave cuff parts exactly as the naming model reported them).
    """
    path = os.path.join(os.path.dirname(os.path.abspath(segdir)),
                        "classification.json")
    if not os.path.isfile(path):
        return None
    try:
        c = json.load(open(path))
    except (json.JSONDecodeError, OSError):
        return None
    text = " ".join(c.get("construction_elements", []) + [c.get("reasoning", "")
                                                          or ""]).lower()
    if not text.strip():
        return None
    return any(w in text for w in ("cuff", "ribbed", "rib ", "elasticated"))


def split_oversized_applied(parts: dict, info: dict, segdir: str) -> dict:
    """Hand a panel-sized region back from an applied part to its host panel.

    NOT WIRED IN -- kept for reference, and because the measurement it is built
    on is still the right one; the threshold is what failed.

    Measured against 37addc513d18, a puffer whose front panels are split into
    two big body panels plus two small shoulder panels of ~4k px each. The
    median "panel" is then 53.7k, dragged down by the small ones, and the
    garment's genuinely large slanted pocket (47.8k) reads as oversized -- so
    this moved a real pocket into the panel and left the pocket layer holding
    nothing but side-seam and hem slivers. A median over parts of wildly
    different roles is not a size a pocket can be compared against. Anything
    reinstating this needs a threshold that survives that sketch: compare
    against the part the pocket actually sits on, not against all panels.

    What it is for: when the naming model groups the panel area BELOW a pocket
    into the pocket itself, nothing downstream can tell. The layer still traces
    to a perfectly closed outline, just the wrong one, carrying the panel's
    side seam and hem with it, while the panel loses everything under the
    pocket and cannot be cut.

    Only regions that are panel-sized ON THEIR OWN move -- an applied part made
    of several small regions (a welt plus its flap plus a tab) is left alone.
    Each one goes to whichever structural part it shares the longest border
    with, measured on the label map, so it rejoins the piece it was actually
    cut from rather than the nearest centroid.

    Border adjacency alone is not enough. When the mis-grouping swallows the
    whole lower panel, the region that has to move is fenced in by the OTHER
    regions of the same bad part, and the panel it belongs to is nowhere near
    it -- on 37addc513d18 the panel stops at y760 while the region runs y814
    to y1132, with more pocket regions in between. So a region that borders no
    structural part falls back to the structural part on its own side of the
    garment, by name (front_left_pocket -> front_left_body_panel), which is the
    same piece a person reading the layer sheet would hand it back to.
    """
    def area_of(p):
        return sum(info[str(r)]["area"] for r in p.get("regions", [])
                   if str(r) in info)
    panels = [area_of(p) for n, p in parts.items()
              if ("panel" in n or "body" in n) and p.get("regions")]
    if not panels:
        return parts
    med = float(np.median(panels))

    suspects = {}
    for nm, p in parts.items():
        if not any(k in nm for k in APPLIED_KEYWORDS) or p.get("grab_box"):
            continue
        if area_of(p) <= med:
            continue
        # A single region at half a panel or more is a panel, not a pocket.
        big = [r for r in p["regions"]
               if str(r) in info and info[str(r)]["area"] >= 0.5 * med]
        if big:
            suspects[nm] = big
    if not suspects:
        return parts

    labels_path = os.path.join(segdir, "labels.npy")
    if not os.path.isfile(labels_path):
        return parts
    lab = np.load(labels_path)
    owner = {r: nm for nm, p in parts.items() for r in p.get("regions", [])}
    st = np.ones((3, 3), bool)

    moved_to = {}                 # applied part -> [(region, host it went to)]
    for nm, big in suspects.items():
        for r in big:
            m = lab == r
            if not m.any():
                continue
            border = ndimage.binary_dilation(m, st, iterations=2) & ~m
            best, best_len = None, 0
            for r2 in np.unique(lab[border]):
                r2 = int(r2)
                if r2 == 0 or r2 == r:
                    continue
                host = owner.get(r2)
                if host is None or host == nm:
                    continue
                if not any(k in host for k in HOST_KEYWORDS):
                    continue
                if any(k in host for k in APPLIED_KEYWORDS):
                    continue
                shared = int((border & (lab == r2)).sum())
                if shared > best_len:
                    best, best_len = host, shared
            if best is None:
                # Same-side fallback: the structural part sharing the most
                # leading name tokens (front/left/...), biggest one wins a tie.
                toks = nm.split("_")
                cands = []
                for host, hp in parts.items():
                    if host == nm or not hp.get("regions"):
                        continue
                    if not ("panel" in host or "body" in host):
                        continue
                    if any(k in host for k in APPLIED_KEYWORDS):
                        continue
                    ht = host.split("_")
                    shared_toks = 0
                    for a, b in zip(toks, ht):
                        if a != b:
                            break
                        shared_toks += 1
                    if shared_toks:
                        cands.append((shared_toks, area_of(hp), host))
                if not cands:
                    continue
                best = max(cands)[2]
                best_len = 0
            parts[nm]["regions"] = [x for x in parts[nm]["regions"] if x != r]
            parts[best].setdefault("regions", []).append(r)
            owner[r] = best
            print(f"  oversized region {r} ({info[str(r)]['area']}px) moved "
                  f"{nm} -> {best} (shares {best_len}px of border)")
            moved_to.setdefault(nm, []).append((r, best))

    # A pocket handed a whole panel usually means the pair was SWAPPED: the
    # panel went to the pocket and the pocket's own welt went to the panel.
    # Measured on job feab02973734, both front pockets came back this way --
    # front_left_pocket [25] was the 146k-px lower body panel, while the 7.3k
    # welt (33) sat in front_left_body_panel. Moving the panel back is only
    # half the repair; without the other half the pocket is deleted below as a
    # ghost and the welt renders inside the panel layer, so the garment has no
    # pocket piece at all. Take back the patch-shaped region the host is now
    # holding INSIDE the footprint just released -- that is the welt.
    for nm, moves in moved_to.items():
        if parts.get(nm, {}).get("regions"):
            continue                      # something patch-shaped stayed put
        for r, host in moves:
            if str(r) not in info or not parts.get(host, {}).get("regions"):
                continue
            rb = info[str(r)]["bbox"]
            hbs = [info[str(h)]["bbox"] for h in parts[host]["regions"]
                   if str(h) in info]
            if not hbs:
                continue
            hh = max(b[3] for b in hbs) - min(b[1] for b in hbs)
            hw = max(b[2] for b in hbs) - min(b[0] for b in hbs)
            cands = []
            for c in parts[host]["regions"]:
                if str(c) not in info or c == r:
                    continue
                b = info[str(c)]["bbox"]
                inside = (b[0] >= rb[0] and b[1] >= rb[1]
                          and b[2] <= rb[2] and b[3] <= rb[3])
                w, h = b[2] - b[0], b[3] - b[1]
                if inside and h <= APPLIED_H_FRAC * hh and w <= APPLIED_W_FRAC * hw:
                    cands.append((info[str(c)]["area"], c))
            if not cands:
                continue
            _, take = min(cands)
            parts[host]["regions"] = [x for x in parts[host]["regions"]
                                      if x != take]
            parts[nm]["regions"] = [take]
            owner[take] = nm
            print(f"  ...and region {take} ({info[str(take)]['area']}px) inside "
                  f"it moved back {host} -> {nm}: the two were swapped")
            break

    # An applied part stripped of everything is a naming ghost, not a piece.
    for nm in list(parts):
        if nm in suspects and not parts[nm].get("regions"):
            del parts[nm]
    return parts


def merge_collar_parts(parts: dict) -> dict:
    """One collar per view, not a pile of collar fragments.

    A drawn collar splits into a left leaf, a right leaf and the band behind
    the neck, and the naming model reports those as separate parts (plus
    "collar_tab" for a buckle tab sitting on one leaf). Extracted separately
    they are unusable slivers -- the collar is wanted as one piece. Merge
    every part in a view whose name mentions collar into that view's collar.
    A collar STAND is left alone: it is a genuinely separate pattern piece."""
    for view in ("front", "back", "side"):
        group = [nm for nm in parts
                 if nm.startswith(view + "_") and "collar" in nm
                 and "stand" not in nm]
        if len(group) < 2:
            continue
        target = f"{view}_collar"
        regions, boxes = [], []
        for nm in group:
            regions += parts[nm].get("regions", [])
            if parts[nm].get("grab_box"):
                boxes.append(parts[nm]["grab_box"])
        for nm in group:
            parts.pop(nm)
        parts[target] = {"regions": sorted(set(regions))}
        if boxes:
            parts[target]["grab_box"] = [min(b[0] for b in boxes),
                                         min(b[1] for b in boxes),
                                         max(b[2] for b in boxes),
                                         max(b[3] for b in boxes)]
        print(f"  merged {len(group)} collar parts -> {target} "
              f"{parts[target]['regions']}")
    return parts


COL_ASPECT = 3.0       # h/w that makes a center-front strip a real column
COL_PAD_FRAC = 0.30    # slack on the column's own width when testing x-fit
COL_TALL_ASPECT = 2.0  # h/w of the strips whose top defines the column's top
COL_TOP_TOL = 0.25     # slack on that top, as a share of the column's WIDTH.
                       # Not its height: at 0.15 of a 996px column the margin
                       # was 149px, which swallowed the placket's whole
                       # collar-height section (133px tall) into "above the
                       # column" and handed it to the collar. The facing this
                       # slack exists for clears the column's top outright.


def separate_collar_placket(parts: dict, info: dict) -> dict:
    """Put the neck band in the collar and the center-front strip in the placket.

    The two meet at the collar's attachment seam and the naming model swaps
    content across it. Measured on f7fd9bf15935 (puffer, stand collar over a
    snap placket): the collar stand's own region -- 353px wide, wrapping the
    whole neckline -- was filed under front_placket, while the placket strip's
    sections AT collar height (77px wide, same x-range as the strip running
    down the chest) were filed under front_collar. Both layers then traced
    cleanly to the wrong outline: a "collar" that is a neckline facing plus a
    stub of placket, and a "placket" wearing the collar as a hat. The review
    pass in verify_layers.py spotted it, argued itself out of it, and returned
    ok -- so this is decided by measurement instead of asked again.

    The placket is the one part whose geometry is unambiguous: a narrow
    vertical column at center front, running most of the body's length. Its
    tallest region fixes the column's x-range. Then, over the regions of both
    parts pooled together:
      - inside that column, at or below its top  -> placket
      - reaching outside it, or entirely above it -> collar
    The "above" case is the neckline facing/notch drawn inside the stand at
    center front (regions 3/4 on that sketch): it sits in the column's
    x-range but higher than the placket ever starts.
    """
    for view in ("front", "back", "side"):
        collar = f"{view}_collar"
        plackets = [nm for nm in parts
                    if nm.startswith(view + "_") and "placket" in nm
                    and parts[nm].get("regions")]
        if collar not in parts or not parts[collar].get("regions") or not plackets:
            continue
        placket = plackets[0]
        pool = list(dict.fromkeys(parts[collar]["regions"]
                                  + [r for nm in plackets
                                     for r in parts[nm]["regions"]]))
        boxes = {r: info[str(r)]["bbox"] for r in pool if str(r) in info}
        if len(boxes) < 2:
            continue
        wh = {r: (b[2] - b[0], b[3] - b[1]) for r, b in boxes.items()}
        # The column spans the x-range of EVERY tall strip in the pool, not just
        # the tallest one's. A placket arrives as the strip itself plus a
        # topstitch sliver down each side, and on a shirt the tallest of those is
        # a 5px sliver: taking it alone put the column at x674-679, which left
        # the placket's own 33px-wide body outside its own column and handed it,
        # and both slivers, to the collar.
        tall = [r for r, (w, h) in wh.items() if w and h >= COL_ASPECT * w]
        if not tall:
            # No center-front column in the pool at all (a notch-lapel jacket, a
            # plain band): nothing here can be told apart geometrically.
            continue
        cx0 = min(boxes[r][0] for r in tall)
        cx1 = max(boxes[r][2] for r in tall)
        cw = max(1, cx1 - cx0)
        pad = COL_PAD_FRAC * cw
        # The column's top comes only from those tall strips -- the facing region
        # we are trying to identify also sits in the column, and letting it set
        # the top would make the test circular.
        col_top = min(boxes[r][1] for r in tall)
        tol = COL_TOP_TOL * cw
        keep_placket, to_collar = [], []
        for r in pool:
            if r not in boxes:
                continue
            b = boxes[r]
            inside = b[0] >= cx0 - pad and b[2] <= cx1 + pad
            above = b[3] <= col_top + tol
            (keep_placket if (inside and not above) else to_collar).append(r)
        if not keep_placket or not to_collar:
            continue
        before = (sorted(parts[collar]["regions"]),
                  sorted(parts[placket]["regions"]))
        for nm in plackets:
            parts[nm]["regions"] = [r for r in parts[nm]["regions"]
                                    if r in keep_placket]
        parts[placket]["regions"] = sorted(set(keep_placket))
        parts[collar]["regions"] = sorted(set(to_collar))
        after = (sorted(parts[collar]["regions"]),
                 sorted(parts[placket]["regions"]))
        if before != after:
            print(f"  center-front column x{cx0}-{cx1} (from regions {sorted(tall)}), "
                  f"top y{col_top}: {collar} {before[0]} -> {after[0]}, "
                  f"{placket} {before[1]} -> {after[1]}")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


CUFF_MAX_FRAC = 0.25    # a cuff band is at most this share of the sleeve's height
CUFF_MIN_ASPECT = 2.5   # ...and is a wide, thin strip
CUFF_JOIN_TOL = 0.04    # ...ending this close (share of sleeve height) to the
                        # sleeve's own bottom edge
SLEEVE_SKIP = ("cuff", "badge", "label", "tab", "strap", "trim", "zip",
               "placket", "pocket", "patch", "button")


def split_cuff_bands(parts: dict, info: dict, segdir: str) -> dict:
    """Lift the rib/knit cuff band out of the sleeve it terminates.

    A cuff is a separate cut piece -- different fabric, its own pattern piece --
    but it arrives as just one more band in the stack of quilted sections the
    naming prompt is told to group into ONE sleeve, so it gets swallowed. On
    f7fd9bf15935 all four cuffs (regions 58/59/60/61) ended up inside their
    sleeve parts even though the naming model's own scratch notes named them
    as cuffs.

    Geometry alone can't tell a cuff band from a turned-up hem allowance (see
    merge_hem_allowance -- same wide-thin footprint), so symmetry decides, the
    same way it does there, only inverted: if EVERY sleeve in a view ends in
    such a strip, the strip is a real band on all of them and splitting it out
    keeps the sleeves consistent. If only one sleeve has one, it is an artifact
    of that sleeve's stitch line and is left alone.
    """
    if cuffs_are_expected(segdir) is False:
        print("  no cuff on this garment per stage 1 -> sleeve end strips left "
              "with their sleeve")
        return parts
    for view in ("front", "back", "side"):
        # A sleeve whose cuff the naming model already split out on its own
        # (never touched by demote_false_cuffs, e.g. this view's cuffs all
        # tiled the opening) still carries a small leftover region -- a strap
        # tab, a sleeve-tag mark -- that can coincidentally clear this band's
        # width/aspect/position gates (measured: a 90x33 decorative tab 17px
        # short of the sleeve's own bottom edge). Lifting it out manufactured
        # a second, bogus "..._cuff_2" alongside the real cuff. This function
        # exists to give a sleeve ITS OWN cuff when none was named -- a sleeve
        # that already has one is not its business.
        def _has_own_cuff(nm):
            side = next((s for s in ("left", "right") if s in nm), None)
            return any(n != nm and "cuff" in n and n.startswith(view + "_")
                       and (side is None or side in n) and parts[n].get("regions")
                       for n in parts)
        sleeves = [nm for nm in parts
                   if nm.startswith(view + "_") and "sleeve" in nm
                   and not any(k in nm for k in SLEEVE_SKIP)
                   and len(parts[nm].get("regions", [])) > 1
                   and not parts[nm].get("grab_box")
                   and not _has_own_cuff(nm)]
        if len(sleeves) < 2:
            continue
        cand = {}
        for nm in sleeves:
            boxes = {r: info[str(r)]["bbox"] for r in parts[nm]["regions"]
                     if str(r) in info}
            if len(boxes) < 2:
                break
            sy0 = min(b[1] for b in boxes.values())
            sy1 = max(b[3] for b in boxes.values())
            sh = sy1 - sy0
            if sh <= 0:
                break
            band = [r for r, b in boxes.items()
                    if b[3] >= sy1 - CUFF_JOIN_TOL * sh
                    and (b[3] - b[1]) > 0
                    and (b[3] - b[1]) <= CUFF_MAX_FRAC * sh
                    and (b[2] - b[0]) >= CUFF_MIN_ASPECT * (b[3] - b[1])]
            if not band or len(band) >= len(boxes):
                break
            # ...and it must cross the opening rather than be one strip that the
            # sleeve's fold line cut into stacked halves (see _tiles_opening).
            if not _tiles_opening(band, info):
                print(f"  {nm}'s end strips {sorted(band)} stack instead of "
                      f"tiling the opening -> hem allowance, not a cuff")
                break
            cand[nm] = band
        if len(cand) != len(sleeves):
            if cand:
                print(f"  {view}: only {len(cand)}/{len(sleeves)} sleeves end "
                      f"in a thin band -> hem allowance, not a cuff; kept")
            continue
        for nm, band in cand.items():
            new = nm.replace("sleeve", "cuff") if "sleeve" in nm else nm + "_cuff"
            i = 2
            while new in parts:
                new = f"{new.rstrip('0123456789_')}_{i}"
                i += 1
            parts[nm]["regions"] = [r for r in parts[nm]["regions"]
                                    if r not in band]
            parts[new] = {"regions": sorted(band)}
            print(f"  {nm} ends in band {sorted(band)} -> own part {new}")
    return parts


PRINT_SIBLING_MIN = 4   # numbered copies of one name that mean a print, not pieces


def merge_numbered_sibling_panels(parts: dict) -> dict:
    """Fold "front_left_panel_1..28" back into the one panel they tile.

    A print or quilt encloses white exactly like a seam does, so one body panel
    can reach the naming model as dozens of look-alike cells. When the model
    sees through it they all land in one part; when it does not, it names them
    positionally and emits a numbered run. Measured on a quilted bomber the
    sheet came back with 28 front_left_panel_N parts, each one diamond.

    The name is the giveaway and needs no geometry: a garment has one front
    left body panel. Two or three numbered siblings are ordinary -- the repairs
    above mint "_2" themselves when they split a part off a name already taken
    -- so only a real run counts, and it merges into the stem they all share.

    This is a backstop for the prompt rule; segmentation's lattice collapse is
    what should stop these cells existing in the first place.
    """
    runs = {}
    for nm in parts:
        stem, sep, tail = nm.rpartition("_")
        if sep and tail.isdigit() and stem:
            runs.setdefault(stem, []).append(nm)
    for stem, sibs in runs.items():
        if len(sibs) < PRINT_SIBLING_MIN:
            continue
        merged = set()
        for nm in sibs:
            merged |= set(parts[nm].get("regions", []))
            parts[nm]["regions"] = []
        if stem in parts:
            merged |= set(parts[stem].get("regions", []))
        else:
            parts[stem] = {"regions": []}
        parts[stem]["regions"] = sorted(merged)
        print(f"  {len(sibs)} numbered {stem}_N parts are one panel's print "
              f"cells -> merged into {stem}")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


HEM_BAND_ASPECT = 3.0   # w/h that makes a waistband region the band's own strip
HEM_X_PAD = 0.02        # slack on that strip's x-range when testing a cuff region
CUFF_ON_SLEEVE = 0.25   # share of its own width a cuff must share with a sleeve


def demote_hem_cuffs(parts: dict, info: dict) -> dict:
    """Rename a "cuff" that terminates no sleeve into the waistband it is.

    Rib knit is drawn the same wherever it sits, so on a garment ribbed at both
    the cuffs and the hem the naming model hands out the name "cuff" by texture
    instead of by position. Measured on a quilted double-breasted bomber:
    front_left_cuff held the hem band's left half (x295-433) while the left
    sleeve ends at x284, and back_left_cuff / back_right_cuff between them held
    the entire back hem (x1291-1753) while the back sleeves sit at x1087-1277
    and x1766-1956. Three of the five "cuffs" were the waistband, and the back
    had no waistband part at all.

    return_hem_rib_to_waistband can't catch this: it needs a waistband already
    holding the band to measure against, and here the band IS the mislabelled
    part. So test the other end instead -- a cuff finishes a sleeve, so it has
    to sit under one. A region sharing none of its width with any sleeve in its
    own view is hem, and if the view has no waistband yet it gets one.
    """
    for view in ("front", "back", "side"):
        sleeves = [nm for nm in parts
                   if nm.startswith(view + "_") and "sleeve" in nm
                   and "cuff" not in nm and parts[nm].get("regions")]
        cuffs = [nm for nm in parts
                 if nm.startswith(view + "_") and "cuff" in nm
                 and parts[nm].get("regions")]
        if not sleeves or not cuffs:
            continue
        spans = []
        for nm in sleeves:
            bs = [info[str(r)]["bbox"] for r in parts[nm]["regions"] if str(r) in info]
            if bs:
                spans.append((min(b[0] for b in bs), max(b[2] for b in bs)))
        if not spans:
            continue
        for nm in cuffs:
            orphan = []
            for r in parts[nm]["regions"]:
                if str(r) not in info:
                    continue
                b = info[str(r)]["bbox"]
                w = max(1, b[2] - b[0])
                on = max((min(b[2], x1) - max(b[0], x0) for x0, x1 in spans),
                         default=0)
                if on < CUFF_ON_SLEEVE * w:
                    orphan.append(r)
            if not orphan:
                continue
            band = next((n for n in parts
                         if n.startswith(view + "_")
                         and ("waistband" in n or "hem" in n)), None)
            if band is None:
                band = f"{view}_waistband"
                parts[band] = {"regions": []}
                print(f"  {view} has no waistband part -> created one")
            elif parts[band].get("regions"):
                # A view that already has its band gives a second, independent
                # reading: the hem runs at one height, so anything joining it
                # has to sit at that height. This is what keeps the rule honest
                # when the sleeve parts themselves are mislocated -- on a
                # 240-region segmentation of the bomber, front_left_sleeve was
                # grouped at x306-431 with the real sleeve running to x92, and
                # the x test alone would have read that sleeve's own cuff as
                # hem. It sits 20px below the band, so the y test refuses it.
                bs = [info[str(r)]["bbox"] for r in parts[band]["regions"]
                      if str(r) in info]
                if bs:
                    by0, by1 = min(b[1] for b in bs), max(b[3] for b in bs)
                    keep = []
                    for r in orphan:
                        b = info[str(r)]["bbox"]
                        h = max(1, b[3] - b[1])
                        if min(b[3], by1) - max(b[1], by0) >= 0.5 * h:
                            keep.append(r)
                        else:
                            print(f"  {nm} r{r} misses no {view} sleeve but sits "
                                  f"off the {band}'s y{by0}-{by1} -> left alone")
                    orphan = keep
                    if not orphan:
                        continue
            parts[nm]["regions"] = [r for r in parts[nm]["regions"]
                                    if r not in orphan]
            parts[band]["regions"] = sorted(set(parts[band]["regions"]) | set(orphan))
            print(f"  {nm} {sorted(orphan)} sits under no {view} sleeve "
                  f"{spans} -> {band}")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


def return_hem_rib_to_waistband(parts: dict, info: dict) -> dict:
    """Give the waistband back the hem ribbing that was filed under a cuff.

    Rib knit reads the same wherever it is drawn, so on a garment whose cuffs
    and hem are the same ribbing the naming model files hem sections as cuffs.
    Measured on ece62e234074 (hooded puffer): the front hem rib -- regions 77
    and 94 on the left, 78 and 95 on the right, all sitting directly under the
    waistband -- went into front_left_cuff / front_right_cuff, leaving
    front_waistband holding nothing but the band's 25px top edge. The extracted
    "cuffs" were a real cuff with a slab of hem stuck to it, and the waistband
    was two thin lines. The back, where the rib segments into narrow columns
    instead of wide slabs, was grouped correctly -- so this is not the model
    misreading rib, it is the model misreading WHERE the rib is.

    Position settles it, and one axis is enough: a cuff terminates a sleeve, and
    on a flat the sleeves lie outboard of the body. Anything inside the
    waistband's own x-range, at or below where that band starts, is hem. The
    waistband's x-range comes only from its wide strips -- a stray topstitch
    line filed under the waistband would otherwise drag the range off the band.
    """
    for view in ("front", "back", "side"):
        bands = [nm for nm in parts
                 if nm.startswith(view + "_")
                 and ("waistband" in nm or "hem" in nm)
                 and parts[nm].get("regions")]
        cuffs = [nm for nm in parts
                 if nm.startswith(view + "_") and "cuff" in nm
                 and parts[nm].get("regions")]
        if not bands or not cuffs:
            continue
        band = bands[0]
        boxes = {r: info[str(r)]["bbox"] for r in parts[band]["regions"]
                 if str(r) in info}
        wide = [b for b in boxes.values()
                if (b[3] - b[1]) > 0
                and (b[2] - b[0]) >= HEM_BAND_ASPECT * (b[3] - b[1])]
        if not wide:
            continue
        wx0 = min(b[0] for b in wide)
        wx1 = max(b[2] for b in wide)
        wtop = min(b[1] for b in wide)
        pad = HEM_X_PAD * max(1, wx1 - wx0)
        for nm in cuffs:
            moved = [r for r in parts[nm]["regions"]
                     if str(r) in info
                     and info[str(r)]["bbox"][0] >= wx0 - pad
                     and info[str(r)]["bbox"][2] <= wx1 + pad
                     and info[str(r)]["bbox"][3] > wtop]
            if not moved:
                continue
            parts[nm]["regions"] = [r for r in parts[nm]["regions"]
                                    if r not in moved]
            parts[band]["regions"] = sorted(set(parts[band]["regions"]) | set(moved))
            what = "all of" if not parts[nm]["regions"] else "part of"
            print(f"  {what} {nm} {sorted(moved)} sits inside the "
                  f"{band} x{wx0}-{wx1} below y{wtop} -> hem, not cuff")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


SLEEVE_XOVERLAP = 0.70   # share of its own width a column must share with the
                         # sleeve's x-range to be that same sleeve
SLEEVE_YOVERLAP = 0.40   # ...and of its own height, with the sleeve's y-range
SLEEVE_MIN_ASPECT = 2.0  # ...and it must be a tall column, not a wide flap
SLEEVE_MAX_W_MULT = 2.0  # ...no wider than this many sleeve widths
SLEEVE_MAX_A_MULT = 1.5  # ...and no bigger than this many sleeve areas
SLEEVE_KEEP_OUT = ("cuff", "hem", "waistband", "band", "trim", "badge",
                   "label", "drawcord", "button", "zip", "collar", "belt")


def reunite_sleeve_columns(parts: dict, info: dict) -> dict:
    """Give a sleeve back the column that was filed under the body panel.

    A tailored sleeve is drawn with its own fold/crease line running the whole
    length, so it segments as TWO tall columns side by side, and the naming
    model routinely files the inboard one under the body panel it touches --
    measured on 3038bc32f0a0 (blazer + skirt suit): back_left_body_panel held
    region 15, the sleeve's outer column, while back_left_sleeve held only
    region 18; the extracted "body panel" was a body with a sleeve stuck to it
    and the sleeve was half a sleeve. The same slip put the front sleeve's
    inboard column (region 23) inside front_left_pocket.

    The prompt already states the test -- bands of one sleeve share an x-range --
    so enforce it: a TALL column that shares most of its own width with a
    sleeve's x-range, overlaps it vertically, and is no bigger than that sleeve
    is part of it. The aspect gate is what keeps a pocket flap or a cuff (wide
    and short, however well its x-range lines up) out of the sleeve.
    """
    def union_box(regs):
        bs = [info[str(r)]["bbox"] for r in regs if str(r) in info]
        return None if not bs else (min(b[0] for b in bs), min(b[1] for b in bs),
                                    max(b[2] for b in bs), max(b[3] for b in bs))

    def area_of(regs):
        return sum(info[str(r)]["area"] for r in regs if str(r) in info)

    def ov(a0, a1, b0, b1):
        return max(0, min(a1, b1) - max(a0, b0))
    for view in ("front", "back", "side"):
        sleeves = [nm for nm in parts
                   if nm.startswith(view + "_") and "sleeve" in nm
                   and not any(k in nm for k in SLEEVE_SKIP)
                   and parts[nm].get("regions")]
        for snm in sleeves:
            sb = union_box(parts[snm]["regions"])
            if not sb:
                continue
            sw = sb[2] - sb[0]
            sa = area_of(parts[snm]["regions"])
            for onm, p in parts.items():
                if onm == snm or not onm.startswith(view + "_"):
                    continue
                if "sleeve" in onm or any(k in onm for k in SLEEVE_KEEP_OUT):
                    continue
                if len(p.get("regions", [])) < 2:
                    continue          # never strip a part down to nothing
                for r in list(p["regions"]):
                    if str(r) not in info or len(p["regions"]) < 2:
                        continue
                    b = info[str(r)]["bbox"]
                    w, h = b[2] - b[0], b[3] - b[1]
                    if w <= 0 or h < SLEEVE_MIN_ASPECT * w:
                        continue
                    if w > SLEEVE_MAX_W_MULT * sw:
                        continue
                    if info[str(r)]["area"] > SLEEVE_MAX_A_MULT * sa:
                        continue
                    if (ov(b[0], b[2], sb[0], sb[2]) / w < SLEEVE_XOVERLAP
                            or ov(b[1], b[3], sb[1], sb[3]) / h < SLEEVE_YOVERLAP):
                        continue
                    p["regions"].remove(r)
                    parts[snm]["regions"] = sorted(set(parts[snm]["regions"]) | {r})
                    print(f"  region {r} ({w}x{h}) is a column of {snm}, not "
                          f"{onm} -> moved")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


APPLIED_H_FRAC = 0.35    # an applied piece is at most this share of its host's
APPLIED_W_FRAC = 0.60    # height / width...
APPLIED_MAX_ASPECT = 4.0 # ...and is never a long thin strip
BORDER_DILATE = 8        # px to grow a region by before asking what it touches:
                         # enough to cross the drawn line between two regions
GROW_OVERLAP = 0.50     # share of its own width a neighbour must share with a
                        # released strip's width to count as the same strip
GROW_THICK_MULT = 2.0   # ...and it may be at most this much thicker


def strip_panels_from_applied(parts: dict, info: dict, segdir: str) -> dict:
    """Hand panel geometry back out of a pocket/badge/flap part.

    When the naming model groups the panel fabric AROUND a pocket into the
    pocket itself, nothing downstream can tell: the layer still traces to a
    perfectly closed outline, just the wrong one. On 3038bc32f0a0
    front_left_pocket came out as [23, 26, 30, 32] -- the flap (30) plus the
    blazer's whole front side panel (26 + 32, split in two by that flap) plus a
    sleeve column -- so the pocket tile showed a full-length panel and the side
    panel existed nowhere.

    Sized against the part it SITS ON, not against a median over all panels
    (which is what the earlier attempt at this got wrong -- a median over parts
    of different roles is not a size a pocket can be compared to). The host is
    whichever structural part shares the longest border with this part's
    footprint. Anything taller/wider than a piece applied to that host could be,
    or shaped like a strip rather than a patch, is released -- and then so is
    anything TOUCHING what was released, which is what reunites a side panel
    that a flap had cut in half.

    Released regions become their own "..._panel" part, clustered by adjacency:
    they are separate closed pieces with their own seams, and folding them into
    the host instead would silently weld two pattern pieces together.
    """
    applied = [nm for nm in parts
               if any(k in nm for k in APPLIED_KEYWORDS)
               and parts[nm].get("regions")
               and not parts[nm].get("grab_box")]
    if not applied:
        return parts
    lab_path = os.path.join(segdir, "labels.npy")
    if not os.path.isfile(lab_path):
        return parts
    lab = np.load(lab_path)
    st = np.ones((3, 3), bool)

    def borders(regs):
        """region -> px of border shared, for everything around `regs`.

        Dilated by BORDER_DILATE, not the 2px a label-map boundary suggests:
        neighbouring regions are not adjacent in the label map at all, they are
        separated by the drawn line between them (measured 4-6px wide on these
        sketches, and 0 in the label map). A 2px ring lands entirely inside that
        gap and finds nothing -- which is why every border-adjacency test here
        used to come back empty.
        """
        m = np.isin(lab, list(regs))
        if not m.any():
            return {}
        ring = ndimage.binary_dilation(m, st, iterations=BORDER_DILATE) & ~m
        out = {}
        for r2 in np.unique(lab[ring]):
            r2 = int(r2)
            if r2:
                out[r2] = int((ring & (lab == r2)).sum())
        return out

    owner = {r: nm for nm, p in parts.items() for r in p.get("regions", [])}
    for nm in applied:
        regs = list(parts[nm]["regions"])
        touch = borders(regs)
        hosts = {}
        for r2, px in touch.items():
            h = owner.get(r2)
            if h and h != nm and _can_host(h):
                hosts[h] = hosts.get(h, 0) + px
        if not hosts:
            continue
        host = max(hosts, key=hosts.get)
        hbs = [info[str(r)]["bbox"] for r in parts[host]["regions"] if str(r) in info]
        if not hbs:
            continue
        hh = max(b[3] for b in hbs) - min(b[1] for b in hbs)
        hw = max(b[2] for b in hbs) - min(b[0] for b in hbs)
        drop = set()
        for r in regs:
            if str(r) not in info:
                continue
            b = info[str(r)]["bbox"]
            w, h = b[2] - b[0], b[3] - b[1]
            oversized = h > APPLIED_H_FRAC * hh or w > APPLIED_W_FRAC * hw
            # The strip test only applies to a part built from SEVERAL regions.
            # A welt pocket's whole piece is one long thin slit, so on its own it
            # would fail an aspect gate that is there to catch a panel sliver
            # swept in alongside a flap.
            strip = (len(regs) > 1 and min(w, h)
                     and max(w, h) / min(w, h) > APPLIED_MAX_ASPECT)
            if oversized or strip:
                drop.add(r)
        if not drop:
            continue
        # ...and whatever CONTINUES the released geometry inside this same part:
        # a flap laid across a panel cuts it in two, and only the taller half
        # trips the size gate on its own (measured: the side panel above the
        # flap ran 342px and tripped it, the stub below ran 182px and did not).
        # Continuing means lying along the released strip's own axis and inside
        # its width -- which the flap does not do: it crosses the strip and
        # sticks out past it, so it stays with the pocket where it belongs.
        grew = True
        while grew:
            grew = False
            for d in sorted(drop):
                if str(d) not in info:
                    continue
                db = info[str(d)]["bbox"]
                dw, dh = db[2] - db[0], db[3] - db[1]
                vertical = dh >= dw
                near = borders({d})
                for r in regs:
                    if r in drop or not near.get(r) or str(r) not in info:
                        continue
                    b = info[str(r)]["bbox"]
                    w, h = b[2] - b[0], b[3] - b[1]
                    if vertical:
                        share = (max(0, min(b[2], db[2]) - max(b[0], db[0]))
                                 / max(1, w))
                        thick_ok = w <= GROW_THICK_MULT * dw
                    else:
                        share = (max(0, min(b[3], db[3]) - max(b[1], db[1]))
                                 / max(1, h))
                        thick_ok = h <= GROW_THICK_MULT * dh
                    if share >= GROW_OVERLAP and thick_ok:
                        drop.add(r)
                        grew = True
        keep = [r for r in regs if r not in drop]
        if not keep:
            # Releasing EVERYTHING would turn the pocket into a panel, and the
            # size gates are not sharp enough to justify that: a slanted welt
            # pocket is a long strip reaching a third of the way down the panel
            # it sits on (measured on 83ab80984b39: 115x375 against a ~1070px
            # panel), which scores the same as the side panel this repair exists
            # to release. When nothing patch-shaped is left over, the reading
            # that this part is a pocket at all is the one to keep.
            print(f"  {nm}: releasing {sorted(drop)} would leave nothing behind "
                  f"-> kept whole, it is an applied piece")
            continue
        parts[nm]["regions"] = keep
        # cluster the released regions by adjacency, one new part per cluster
        clusters = []
        for r in drop:
            hit = [c for c in clusters if borders(c).get(r)]
            if hit:
                hit[0].add(r)
                for extra in hit[1:]:
                    hit[0] |= extra
                    clusters.remove(extra)
            else:
                clusters.append({r})
        stem = "_".join(nm.split("_")[:-1]) or nm
        for i, c in enumerate(clusters, 1):
            new = f"{stem}_panel" if i == 1 else f"{stem}_panel_{i}"
            while new in parts:
                i += 1
                new = f"{stem}_panel_{i}"
            parts[new] = {"regions": sorted(c)}
            for r in c:
                owner[r] = new
            print(f"  {sorted(c)} is panel geometry, not part of {nm} "
                  f"(host {host}) -> own part {new}")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


SYNONYMS = {"torso": "body_panel", "bodice": "body_panel",
            "trouser": "leg", "pant": "leg"}


def normalize_part_names(parts: dict, info: dict) -> dict:
    """Map off-vocabulary part words onto the keywords z-ordering understands.

    layered_trace_v4 stacks layers by matching a keyword in the part's name, so
    a part named front_left_torso matches nothing and falls to the end of the
    order -- a body panel drawn over everything applied to it. The naming model
    reaches for these synonyms regularly, so translate instead of hoping.
    Where the translation collides with an existing part, the BIGGER one keeps
    the plain name (on 3038bc32f0a0 the collision was the real 103k-px front
    panel against a 25k-px lapel facing that had been called body_panel)."""
    def area(p):
        return sum(info[str(r)]["area"] for r in p.get("regions", [])
                   if str(r) in info)
    for nm in list(parts):
        toks = nm.split("_")
        if not any(t in SYNONYMS for t in toks):
            continue
        new = "_".join(SYNONYMS.get(t, t) for t in toks)
        if new == nm:
            continue
        if new in parts:
            if area(parts[nm]) > area(parts[new]):
                parts[new + "_2"] = parts.pop(new)
                print(f"  {new} is smaller than {nm} -> renamed {new}_2")
            else:
                new = new + "_2"
                while new in parts:
                    new += "_2"
        parts[new] = parts.pop(nm)
        print(f"  {nm} -> {new} (keyword the layer order knows)")
    return parts


CUFF_STACK_OVERLAP = 0.25  # x-overlap (share of the narrower one) above which
                           # two end-of-sleeve strips MIGHT be one strip split
                           # by a fold line, not a band tiling the opening
CUFF_Y_COINCIDE = 0.5      # ...and only counts as that fold-line split when
                           # the two boxes also coincide this much in y (share
                           # of the shorter one) -- see below

def _tiles_opening(regs, info):
    """True when these strips sit side by side across the sleeve opening.

    The measurement that tells a real cuff from a turned-back sleeve hem, and
    the only one that survived being checked against all four sketches:

      puffer  front_left_cuff  [61]      one 124x21 region across a 172px opening
      bomber  front_left_cuff  [69]      one 109x74 region -- a knit band
      biker   "front_left_cuff" [58, 61]  90x32 and 105x40, overlapping in x by
                                         80px (89% of the narrower one)

    A band -- rib, knit, buttoned -- crosses the opening once, so it is one
    region, or several butted end to end. A hem allowance turned back at the
    wrist gets cut in two by the sleeve's own fold line, and those two halves
    STACK: they cover the same x, one just sits slightly lower. Aspect ratio
    cannot separate these (the biker's halves run 2.6-2.8 and the bomber's real
    knit cuff runs 1.5, so any cut that keeps the cuff keeps the hem too).

    x-overlap alone is not enough, though: a real one-piece cuff band drawn
    with an internal topstitch line splits into two regions that ALSO overlap
    heavily in x (one sits directly above the other) -- measured on a job
    where regions 94x21179-1273 and 133x1253-1304 shared 125 of their 133px
    width, got called a fold-line stack, and lost the top 2/3 of the cuff to
    the sleeve. The two cases differ in y: fold-line duplicates are the SAME
    crease seen twice, so they mostly COINCIDE in y (one just sits slightly
    lower); a stitch line through one band instead cuts it TOP/BOTTOM, so the
    pieces are adjacent with next to no y overlap. Require real coincidence,
    not just adjacency, before calling it a fold-line stack.
    """
    boxes = [info[str(r)]["bbox"] for r in regs if str(r) in info]
    if len(boxes) < 2:
        return bool(boxes)
    for i, a in enumerate(boxes):
        for b in boxes[i + 1:]:
            aw, bw = a[2] - a[0], b[2] - b[0]
            ov = max(0, min(a[2], b[2]) - max(a[0], b[0]))
            if ov > CUFF_STACK_OVERLAP * max(1, min(aw, bw)):
                ah, bh = a[3] - a[1], b[3] - b[1]
                yov = max(0, min(a[3], b[3]) - max(a[1], b[1]))
                if yov > CUFF_Y_COINCIDE * max(1, min(ah, bh)):
                    return False
    return True


def demote_false_cuffs(parts: dict, info: dict, segdir: str) -> dict:
    """Fold a "cuff" that is really a turned-back sleeve hem back into its sleeve.

    On a garment with no cuffs at all the naming model still reaches for the
    part -- measured on 49c88c6cd4c7 (biker jacket, plain hemmed sleeves): it
    emitted all four cuffs, each holding the two stacked halves of the hem
    allowance. Extracted, they are a pair of overlapping crescents, and each
    sleeve is left cut short of its own opening.
    """
    expected = cuffs_are_expected(segdir)
    cuffs = [n for n in parts if "cuff" in n and parts[n].get("regions")
             and not parts[n].get("grab_box")]
    if expected is False:
        print("  stage 1 found no cuff on this garment -> any cuff part is the "
              "sleeve's own hem")
    elif cuffs and not all(not _tiles_opening(parts[n]["regions"], info)
                           for n in cuffs):
        # The stacked-halves test is only trusted when it condemns EVERY cuff on
        # the garment. A real cuff can still segment into stacked pieces on one
        # sleeve and not another (measured on 0da389fc43f8, a shirt with genuine
        # button cuffs: two of the four tripped it), and demoting only those two
        # leaves one sleeve ending at its cuff seam and its pair running to the
        # hem -- the asymmetry merge_hem_allowance exists to prevent.
        return parts
    for nm in cuffs:
        regs = parts[nm]["regions"]
        view = nm.split("_")[0]
        side = next((s for s in ("left", "right") if s in nm), None)
        host = next((n for n in parts
                     if n.startswith(view + "_") and "sleeve" in n
                     and (side is None or side in n)
                     and not any(k in n for k in SLEEVE_SKIP)
                     and parts[n].get("regions")), None)
        if not host:
            continue
        parts[host]["regions"] = sorted(set(parts[host]["regions"]) | set(regs))
        parts[nm]["regions"] = []
        why = ("the garment has no cuffs" if expected is False
               else "they are stacked halves of one hem, not a band")
        print(f"  {nm} {sorted(regs)}: {why} -> merged into {host}")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


SLEEVE_ANCHOR_MIN = 0.20    # share of the group's biggest region a tall region
                            # needs before it may anchor the sleeve's column
SLEEVE_COL_OVERLAP = 0.35   # share of its own width a region must share with
                            # the sleeve's footprint-so-far to join that sleeve
                            # (measured: the puffer's inner sleeve column joins
                            # at 0.65-0.77, the biker's misfiled body panel
                            # reaches only 0.29)


def evict_offcolumn_from_sleeve(parts: dict, info: dict, segdir: str) -> dict:
    """Take out of a sleeve whatever is not in the sleeve's own column.

    The mirror of reunite_sleeve_columns, and just as common: on 49c88c6cd4c7
    front_right_sleeve held region 67 -- the entire right front body panel, 174
    x600 -- plus two zip-guard slivers at x513-573, nowhere near the sleeve at
    x682-846. The extracted "sleeve" was a sleeve with a body panel welded to
    its inboard edge, and the body panel part was left holding only the lapel.

    A sleeve is a column: everything in it shares the x-range of its biggest
    region. Anything sharing less than half its own width with that column is
    somewhere else on the drawing, whatever its size. Each evicted region goes
    to the structural part it shares the longest border with, or becomes its own
    panel part if it borders no structural part -- never silently deleted.
    """
    lab_path = os.path.join(segdir, "labels.npy")
    lab = np.load(lab_path) if os.path.isfile(lab_path) else None
    st = np.ones((3, 3), bool)
    def ov(a0, a1, b0, b1):
        return max(0, min(a1, b1) - max(a0, b0))
    for view in ("front", "back", "side"):
        for nm in [n for n in parts
                   if n.startswith(view + "_") and "sleeve" in n
                   and not any(k in n for k in SLEEVE_SKIP)
                   and len(parts[n].get("regions", [])) > 1
                   and not parts[n].get("grab_box")]:
            regs = [r for r in parts[nm]["regions"] if str(r) in info]
            if len(regs) < 2:
                continue
            # GROW the sleeve out from its biggest region: a region joins when it
            # shares enough of its own width with the footprint accumulated so
            # far, and the footprint widens as each one joins. Whatever never
            # connects is somewhere else on the drawing.
            #
            # Neither simpler test works. Comparing against the biggest region
            # alone evicts a quilted sleeve's second column (f26c040d5b81 lost 21
            # sections that way, 83ab80984b39 lost its inner sleeve columns to
            # three phantom back panels). Comparing against the union of all the
            # OTHER regions at once fails the opposite way: on 49c88c6cd4c7 two
            # zip-guard slivers drawn at center front stretched that union across
            # the whole chest, so the body panel wrongly filed under the sleeve
            # landed inside it and stayed. Growing from the column reaches the
            # sleeve's own second column (each butts against the last) without
            # ever reaching across the gap to center front.
            # Anchor on the TALLEST region, not the biggest by area. A sleeve
            # runs the whole length of the arm, so it is the longest thing in
            # its own group; a torso wrongly filed into a sleeve is WIDER and
            # therefore bigger by area, but shorter. Anchored on area the
            # column starts on that torso, the real sleeve then merges in as a
            # neighbour, and the repair is a no-op: measured on 9d2354e916e0,
            # front_left_sleeve held reg 9 (262x753 torso, 106629px) next to
            # reg 14 (167x801, the actual sleeve), every region cleared the
            # 0.35 overlap, and the run finished with a 197656px "sleeve"
            # beside a 10278px "body panel". Anchored on reg 14 the torso
            # scores 0.18 and goes home.
            #
            # Height also leaves the healthy groups alone, which outboard-most
            # did not: a ribbed sleeve panel is outboard of the sleeve body and
            # big enough to anchor, so on the quilted bomber 451319c7f2c4 that
            # rule pegged the column to a 52px rib strip and evicted the
            # sleeve's own 123x400 body. Tallest picks the same region the old
            # area rule did on all four healthy sleeve groups across both
            # sketches, and differs only on the broken one.
            #
            # Only regions of real size can anchor: a tall thin stray -- a
            # placket edge, a hanging drawcord -- would otherwise peg the
            # column onto nothing.
            biggest = max(info[str(r)]["area"] for r in regs)
            anchors = [r for r in regs
                       if info[str(r)]["area"] >= biggest * SLEEVE_ANCHOR_MIN]
            col = max(anchors, key=lambda r: (info[str(r)]["bbox"][3]
                                              - info[str(r)]["bbox"][1]))
            cb = info[str(col)]["bbox"]
            kx0, kx1 = cb[0], cb[2]
            kept, pending = {col}, [r for r in regs if r != col]
            grew = True
            while grew:
                grew = False
                for r in list(pending):
                    b = info[str(r)]["bbox"]
                    w = max(1, b[2] - b[0])
                    if ov(b[0], b[2], kx0, kx1) / w >= SLEEVE_COL_OVERLAP:
                        kept.add(r)
                        pending.remove(r)
                        kx0, kx1 = min(kx0, b[0]), max(kx1, b[2])
                        grew = True
            out = pending
            if not out:
                continue
            parts[nm]["regions"] = [r for r in parts[nm]["regions"] if r not in out]
            owner = {r: onm for onm, p in parts.items()
                     for r in p.get("regions", [])}
            # The piece this sleeve hangs off: a torso region wrongly filed
            # into a sleeve almost always belongs to the body panel on the same
            # side of the same view, and saying so beats a border-length vote
            # that can hand it to whatever happens to touch it longest.
            side = nm.split("_")[1] if len(nm.split("_")) > 2 else ""
            preferred = f"{view}_{side}_body_panel" if side else None
            for r in out:
                host = None
                if lab is not None:
                    m = lab == r
                    if m.any():
                        ring = ndimage.binary_dilation(
                            m, st, iterations=BORDER_DILATE) & ~m
                        best = 0
                        for r2 in np.unique(lab[ring]):
                            r2 = int(r2)
                            h = owner.get(r2)
                            # Never another sleeve. Evicting a torso out of one
                            # sleeve and into the opposite one just moves the
                            # defect, and it then gets evicted a second time
                            # into whatever it lands next to (measured on
                            # 9d2354e916e0: reg 9, the left front torso, went
                            # left_sleeve -> right_sleeve -> front_left_panel,
                            # never reaching the body panel it is).
                            if (not h or h == nm or r2 in out
                                    or "sleeve" in h or not _can_host(h)):
                                continue
                            shared = int((ring & (lab == r2)).sum())
                            if h == preferred:
                                host, best = h, float("inf")
                                break
                            if shared > best:
                                host, best = h, shared
                # A quilted/textured region evicted from the sleeve routinely
                # borders nothing at all in the label map -- it is one cell of
                # a diamond-quilt pattern, sealed off from its own body panel
                # by the sleeve seam and from the panel's OTHER quilt cells by
                # the stitch lines between them. The border scan above then
                # never gets the chance to even consider `preferred`, and every
                # such cell spins up its own orphan "..._panel" part instead of
                # joining the body panel it is textural fill for (measured: a
                # quilted bomber's six shoulder/chest diamond cells came out as
                # front_left_panel/_2/_3 and front_right_panel/_2/_3, each a
                # single region, instead of folding into the two body panels).
                # Trust the same-side body panel outright when it already
                # exists, before falling back to minting a new orphan.
                if host is None and preferred and _can_host(preferred) \
                        and parts.get(preferred, {}).get("regions"):
                    host = preferred
                if host is None:
                    host = f"{view}_{'_'.join(nm.split('_')[1:-1]) or 'side'}_panel"
                    i = 2
                    while host in parts and r not in parts[host].get("regions", []):
                        host = f"{view}_{'_'.join(nm.split('_')[1:-1]) or 'side'}_panel_{i}"
                        i += 1
                    parts.setdefault(host, {"regions": []})
                parts[host]["regions"] = sorted(set(parts[host]["regions"]) | {r})
                owner[r] = host
                b = info[str(r)]["bbox"]
                print(f"  region {r} ({b[2]-b[0]}x{b[3]-b[1]}) sits outside "
                      f"{nm}'s column x{cb[0]}-{cb[2]} -> {host}")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


BELT_EDGE_ASPECT = 5.0     # a belt's own edge strip is at least this long/thin
BELT_EDGE_SPAN = 0.60      # ...and runs this share of the belt's length
BELT_EDGE_GAP = 0.60       # ...within this many belt-heights of the belt


def merge_belt_edge_strips(parts: dict, info: dict) -> dict:
    """Give a belt back its own top and bottom edge strips.

    A belt drawn with topstitching along both long edges seals a hairline strip
    outside each stitch line, and the naming model files those as belt loops --
    on 49c88c6cd4c7 front_belt_loop was regions 51 and 77, two 19px-tall strips
    running the belt's whole length above and below it, so the belt came out
    without its edges and a "loop" part was two parallel lines. A real loop is
    compact and crosses the belt; these run ALONG it.
    """
    def union_box(regs):
        bs = [info[str(r)]["bbox"] for r in regs if str(r) in info]
        return None if not bs else (min(b[0] for b in bs), min(b[1] for b in bs),
                                    max(b[2] for b in bs), max(b[3] for b in bs))

    # Reference box = the belt's BIGGEST region, not the union of all of them: a
    # belt part legitimately carries its keepers and buckle tab, whose union
    # spans the whole garment width and several times the belt's own height, and
    # every "does this strip run the belt's length / lie against it" test then
    # measures against a box that is not the belt.
    def ref_box(regs):
        best = max((r for r in regs if str(r) in info),
                   key=lambda r: info[str(r)]["area"], default=None)
        return None if best is None else tuple(info[str(best)]["bbox"])

    belts = {nm: ref_box(parts[nm]["regions"]) for nm in parts
             if "belt" in nm and "buckle" not in nm and "loop" not in nm
             and parts[nm].get("regions")}
    belts = {nm: b for nm, b in belts.items() if b}
    if not belts:
        return parts
    for nm, p in list(parts.items()):
        if nm in belts or not p.get("regions") or p.get("grab_box"):
            continue
        for bnm, bb in belts.items():
            if not nm.startswith(bnm.split("_")[0] + "_"):
                continue
            bw, bh = bb[2] - bb[0], bb[3] - bb[1]
            take = []
            for r in p["regions"]:
                if str(r) not in info:
                    continue
                x0, y0, x1, y1 = info[str(r)]["bbox"]
                w, h = x1 - x0, y1 - y0
                if h <= 0 or w < BELT_EDGE_ASPECT * h:
                    continue                      # not a long thin strip
                if max(0, min(x1, bb[2]) - max(x0, bb[0])) < BELT_EDGE_SPAN * bw:
                    continue                      # does not run the belt's length
                gap = max(bb[1] - y1, y0 - bb[3], 0)
                if gap > BELT_EDGE_GAP * bh:
                    continue                      # not against the belt
                take.append(r)
            if not take:
                continue
            p["regions"] = [r for r in p["regions"] if r not in take]
            parts[bnm]["regions"] = sorted(set(parts[bnm]["regions"]) | set(take))
            print(f"  {sorted(take)} run along {bnm}'s length -> its own edges, "
                  f"not {nm}")
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


SUBPANEL_QUALIFIERS = ("side", "lower", "upper", "under", "inner", "outer",
                       "shoulder")
SUBPANEL_MERGE_VIEWS = {"upper": ("front",), "shoulder": ("front",)}
                        # A yoke across the shoulders IS a pattern piece in the
                        # BACK view, so an upper/shoulder panel is only folded
                        # away in the front, where the seam is normally just a
                        # style line across one piece.


def collapse_subpanels(parts: dict, info: dict, segdir: str) -> dict:
    """Fold a sub-panel back into the piece it is a section OF.

    The naming model subdivides pieces that are not subdivided: on cdc9e4bfb0d6
    (hooded jacket) every sleeve came with a "..._sleeve_side_panel" holding its
    other half, each body panel came with a "..._body_lower_panel" holding the
    section below the hem stitch line, and four bare "..._side_panel" parts held
    slivers 14-71px wide along the sleeves' outer edges. Cut like that, no piece
    is a piece: the sleeve is half a sleeve and the panel stops at the hem line.

    Only names that ADMIT to being a section are touched -- a qualifier word
    (side/lower/upper/under/inner/outer/shoulder) next to "panel". A part simply
    named "..._panel" is left alone: a blazer's princess side panel is a real
    separate piece and arrives under exactly that name.

    Parent by name first (back_left_body_lower_panel -> back_left_body_panel,
    front_left_sleeve_side_panel -> front_left_sleeve), then by longest shared
    border on the label map, which is what catches the bare "..._side_panel"
    slivers: they sit outboard of the sleeve, sharing almost no x-range with it,
    so only adjacency identifies them.
    """
    lab_path = os.path.join(segdir, "labels.npy")
    lab = np.load(lab_path) if os.path.isfile(lab_path) else None
    st = np.ones((3, 3), bool)
    for nm in [n for n in parts if "panel" in n and parts[n].get("regions")
               and not parts[n].get("grab_box")]:
        toks = nm.split("_")
        quals = [t for t in toks if t in SUBPANEL_QUALIFIERS]
        if not quals:
            continue
        view = toks[0]
        blocked = [q for q in quals
                   if q in SUBPANEL_MERGE_VIEWS
                   and view not in SUBPANEL_MERGE_VIEWS[q]]
        if blocked:
            print(f"  {nm} kept: a {blocked[0]} panel in the {view} view is its "
                  f"own piece")
            continue
        # Who this part borders, and by how much. A name-derived host has to be
        # confirmed against this: part names collide by coincidence (on
        # f26c040d5b81, front_right_shoulder_panel's stem is
        # "front_right_panel", which is the name an unrelated release from the
        # pocket had just taken at the other end of the garment), and a section
        # always touches the piece it was cut from.
        touching = {}
        if lab is not None:
            owner = {r: onm for onm, p in parts.items()
                     for r in p.get("regions", []) if onm != nm}
            m = np.isin(lab, parts[nm]["regions"])
            if m.any():
                ring = ndimage.binary_dilation(
                    m, st, iterations=BORDER_DILATE) & ~m
                for r2 in np.unique(lab[ring]):
                    r2 = int(r2)
                    h = owner.get(r2)
                    if h:
                        touching[h] = touching.get(h, 0) + int(
                            (ring & (lab == r2)).sum())
        def adjacent(h):
            return not touching or touching.get(h, 0) > 0
        host = None
        cands = ["_".join(t for t in toks if t not in SUBPANEL_QUALIFIERS)]
        # ...then the piece this name says it is a section of, e.g.
        # front_left_sleeve_side_panel -> front_left_sleeve.
        cands += ["_".join(toks[:i]) for i in range(len(toks) - 1, 0, -1)]
        for cand in cands:
            if cand != nm and parts.get(cand, {}).get("regions") \
                    and adjacent(cand):
                host = cand
                break
        if host is None and touching:
            host = max((h for h in touching
                        if h.startswith(view + "_") and _can_host(h)),
                       key=lambda h: touching[h], default=None)
        if not host or host == nm:
            continue
        parts[host]["regions"] = sorted(set(parts[host]["regions"])
                                        | set(parts[nm]["regions"]))
        print(f"  {nm} {sorted(parts[nm]['regions'])} is a section of {host} "
              f"-> merged")
        parts[nm]["regions"] = []
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


TEXTURE_SLIVER_SHARE = 0.10   # a bare "..._panel" this much smaller than the
                              # garment's median structural piece is texture
STRUCTURAL_WORDS = ("body", "sleeve", "yoke", "leg", "skirt")


def fold_texture_slivers(parts: dict, info: dict, segdir: str) -> dict:
    """Fold a texture sliver named "..._panel" into the piece it lies on.

    Rib knit, quilting and hatch shading all enclose white the same way a seam
    does, so a ribbed sleeve panel or a quilted chest reaches the naming model
    as a handful of look-alike cells. When the model cannot place them it falls
    back to the most generic name it has -- a bare "front_left_panel",
    "front_right_panel_2" -- and those come out of the tracer as separate
    "pieces" that are nothing but hatching.

    collapse_subpanels deliberately leaves bare "..._panel" names alone,
    because a blazer's princess side panel is a real piece under exactly that
    name, and merge_numbered_sibling_panels only fires on a run of four or
    more. Neither catches two or three rib cells. SIZE is what separates them:
    measured on the quilted bomber 451319c7f2c4, the four rib slivers ran
    4.5-6.3% of the median structural piece (2403-3384px against 53392), the
    smallest genuine piece was 45%, and a real pocket flap that had also landed
    under a bare panel name was 19.9% -- so a 10% cut clears both sides by 3x.

    Host is the neighbour sharing the longest border, same as collapse_subpanels.
    """
    lab_path = os.path.join(segdir, "labels.npy")
    lab = np.load(lab_path) if os.path.isfile(lab_path) else None
    if lab is None:
        return parts

    def area_of(nm):
        # info is keyed by STRING region id, same as every other repair here.
        return sum(info[str(r)]["area"] for r in parts[nm].get("regions", [])
                   if str(r) in info)

    struct = sorted(area_of(n) for n in parts
                    if any(w in n for w in STRUCTURAL_WORDS)
                    and parts[n].get("regions"))
    if len(struct) < 3:
        return parts
    median = struct[len(struct) // 2]
    cutoff = median * TEXTURE_SLIVER_SHARE

    st = np.ones((3, 3), bool)
    for nm in [n for n in parts if parts[n].get("regions")
               and not parts[n].get("grab_box")]:
        toks = nm.split("_")
        # bare "..._panel" or "..._panel_N" only: a qualified name is
        # collapse_subpanels' business, and a named piece is not a sliver.
        if toks[-1] == "panel":
            pass
        elif toks[-1].isdigit() and len(toks) > 1 and toks[-2] == "panel":
            pass
        else:
            continue
        if any(t in SUBPANEL_QUALIFIERS for t in toks):
            continue
        a = area_of(nm)
        if a >= cutoff:
            continue
        owner = {r: onm for onm, p in parts.items()
                 for r in p.get("regions", []) if onm != nm}
        m = np.isin(lab, parts[nm]["regions"])
        if not m.any():
            continue
        ring = ndimage.binary_dilation(m, st, iterations=BORDER_DILATE) & ~m
        touching = {}
        for r2 in np.unique(lab[ring]):
            h = owner.get(int(r2))
            if h:
                touching[h] = touching.get(h, 0) + int((ring & (lab == r2)).sum())
        view = toks[0]
        host = max((h for h in touching
                    if h.startswith(view + "_") and _can_host(h)),
                   key=lambda h: touching[h], default=None) \
            or max(touching, key=lambda h: touching[h], default=None)
        if not host or host == nm:
            continue
        parts[host]["regions"] = sorted(set(parts[host]["regions"])
                                        | set(parts[nm]["regions"]))
        print(f"  {nm} is texture ({a}px, {100 * a / median:.1f}% of the median "
              f"piece) -> merged into {host}")
        parts[nm]["regions"] = []
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


SEAM_MIN_ASPECT = 6.0   # long/short bbox ratio of a construction-line strip


def merge_seam_line_parts(parts: dict, info: dict, segdir: str) -> dict:
    """Fold a seam/stitch line back into the piece whose seam it is.

    A yoke's attachment seam is drawn as two parallel lines, which seals the
    sliver between them into its own region; the naming model then emits it as
    "back_yoke_seam_line". A seam line is not a pattern piece -- left on its
    own it is a floating 646x15px hairline layer, and the yoke above it is cut
    short of its true bottom edge. Merge it into the piece named in its own
    name (back_yoke_seam_line -> back_yoke) and, failing that, into whichever
    part it shares the longest border with on the label map.
    """
    def union_box(regs):
        bs = [info[str(r)]["bbox"] for r in regs if str(r) in info]
        return None if not bs else (min(b[0] for b in bs), min(b[1] for b in bs),
                                    max(b[2] for b in bs), max(b[3] for b in bs))

    seams = [nm for nm in parts
             if ("seam" in nm or "stitch" in nm) and parts[nm].get("regions")
             and not parts[nm].get("grab_box")]
    if not seams:
        return parts
    lab = None
    lab_path = os.path.join(segdir, "labels.npy")
    for nm in seams:
        box = union_box(parts[nm]["regions"])
        if not box:
            continue
        w, h = box[2] - box[0], box[3] - box[1]
        if min(w, h) <= 0 or max(w, h) < SEAM_MIN_ASPECT * min(w, h):
            continue          # not a hairline strip: leave it as its own part
        host = None
        stem = nm
        for suffix in ("_seam_line", "_seamline", "_seam", "_stitch_line",
                       "_stitchline", "_stitch"):
            if stem.endswith(suffix):
                stem = stem[:-len(suffix)]
                break
        if stem != nm and parts.get(stem, {}).get("regions"):
            host = stem
        if host is None:
            if lab is None and os.path.isfile(lab_path):
                lab = np.load(lab_path)
            if lab is None:
                continue
            m = np.isin(lab, parts[nm]["regions"])
            if not m.any():
                continue
            border = ndimage.binary_dilation(m, np.ones((3, 3), bool),
                                             iterations=BORDER_DILATE) & ~m
            owner = {r: onm for onm, p in parts.items()
                     for r in p.get("regions", []) if onm != nm}
            best_len = 0
            for r2 in np.unique(lab[border]):
                r2 = int(r2)
                if r2 == 0 or r2 not in owner:
                    continue
                shared = int((border & (lab == r2)).sum())
                if shared > best_len:
                    host, best_len = owner[r2], shared
        if not host:
            continue
        parts[host]["regions"] = sorted(set(parts[host]["regions"])
                                        | set(parts[nm]["regions"]))
        print(f"  {nm} is a construction line, not a piece -> merged into "
              f"{host}")
        parts[nm]["regions"] = []
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


RIB_TICK_MIN_SHARE = 0.005  # notch-ink this far below a rib band's is blank
RIB_VIEW_MEAN_MAX = 0.015   # ...or a view's hems AVERAGE below this: real rib
                            # bands read ~0.04 each, so a mean this low means
                            # blank strips with one noisy reading among them
RIB_CLOSE_RADIUS = 6        # tick width to bridge when closing the band
MERGE_BLANK_HEM = os.environ.get("MERGE_BLANK_HEM", "1") != "0"


def merge_blank_hem_bands(parts: dict, info: dict, segdir: str) -> dict:
    """Fold a BLANK bottom-edge strip back into the panel above it.

    merge_hem_allowance repairs only the asymmetric case, on the reasoning
    that bbox geometry cannot separate a genuine rib hem band from a stray
    topstitch line -- both are one wide, thin region. That is true of the
    footprint, but not of what is drawn INSIDE it: a rib band carries vertical
    rib ticks, and a topstitch strip is blank white.

    The ticks are short marks biting in from the band's edges, so they notch
    the white region rather than splitting it. Closing the region with a disk
    wider than one tick fills those notches, and the ink recovered that way is
    the rib signal. Measured on the puffer (v3): the blank hem strips scored
    0.0000-0.0003 while the rib cuffs on the same sketch scored 0.039-0.042,
    a 100x gap, so the cut sits far from both sides.

    This is the backstop for a defect the generator will not stop producing:
    stage 1 draws a topstitch line above the body's bottom edge, that seals a
    strip, and the strip is named a hem -- so a phantom hem piece gets cut
    from a garment with no hem band. Prompting all three stages against it
    still left it in 3/3 regen attempts.

    Note this also folds in a genuine turned-up hem ALLOWANCE, which is blank
    by nature. That is the intent here -- the allowance is not wanted as its
    own piece. MERGE_BLANK_HEM=0 restores the old behaviour.
    """
    if not MERGE_BLANK_HEM:
        return parts
    hems = [nm for nm in parts if "hem" in nm and parts[nm].get("regions")
            and not parts[nm].get("grab_box")]
    if not hems:
        return parts
    lab_path = os.path.join(segdir, "labels.npy")
    ink_path = os.path.join(segdir, "ink.npy")
    if not (os.path.isfile(lab_path) and os.path.isfile(ink_path)):
        return parts
    lab = np.load(lab_path)
    ink = np.load(ink_path)
    if ink.shape != lab.shape:
        return parts

    r = RIB_CLOSE_RADIUS
    yy, xx = np.ogrid[-r:r + 1, -r:r + 1]
    disk = xx * xx + yy * yy <= r * r

    # Score first, decide per VIEW second. Backtested over 13 jobs, the score
    # can straddle the cut within one hem line -- 23fcf01d read .0143/.0093 on
    # its left and centre hems but .0037 on the right, and 97f18fad .0111 vs
    # .0001 -- because a curved strip picks up a few px of the panel line.
    # Merging only the low sibling would cut that panel short and step the
    # seams against its neighbours, the very fault merge_hem_allowance exists
    # to fix. So a view's hems merge only when EVERY one of them reads blank.
    share = {}
    for nm in hems:
        m = np.isin(lab, parts[nm]["regions"])
        if not m.any():
            continue
        notch = ndimage.binary_closing(m, disk) & ~m
        share[nm] = float((notch & ink).sum()) / float(m.sum())

    #
    # "Every sibling under RIB_TICK_MIN_SHARE" was too strict, though: one noisy
    # strip kept the whole view's phantom hems (97f18fad's back read .0111 /
    # .0001 and both back hems survived, on a puffer with no hem band at all).
    # A real rib band reads ~0.04 on EVERY sibling, so the view mean separates
    # the two cleanly: 97f18fad back .0056, 23fcf01d .0091, rib cuffs .039+.
    blank_views = set()
    for view in {nm.split("_", 1)[0] for nm in share}:
        sibs = [s for nm, s in share.items() if nm.split("_", 1)[0] == view]
        if sibs and (max(sibs) < RIB_TICK_MIN_SHARE
                     or sum(sibs) / len(sibs) < RIB_VIEW_MEAN_MAX):
            blank_views.add(view)

    for nm in hems:
        if nm not in share or nm.split("_", 1)[0] not in blank_views:
            continue          # real rib band, or a sibling says it is one
        m = np.isin(lab, parts[nm]["regions"])
        border = ndimage.binary_dilation(m, np.ones((3, 3), bool),
                                         iterations=BORDER_DILATE) & ~m
        owner = {r2: onm for onm, p in parts.items()
                 for r2 in p.get("regions", []) if onm != nm}
        host, best = None, 0
        for r2 in np.unique(lab[border]):
            r2 = int(r2)
            if r2 == 0 or r2 not in owner:
                continue
            shared = int((border & (lab == r2)).sum())
            if shared > best:
                host, best = owner[r2], shared
        if not host:
            continue
        parts[host]["regions"] = sorted(set(parts[host]["regions"])
                                        | set(parts[nm]["regions"]))
        print(f"  {nm} is a blank strip (rib share {share[nm]:.4f}), not a "
              f"hem band -> merged into {host}")
        parts[nm]["regions"] = []
    return {nm: p for nm, p in parts.items()
            if p.get("regions") or p.get("grab_box")}


def ribs_are_not_buttons(parts: dict, info: dict) -> dict:
    """A rib cuff's slices are never buttons.

    Vertical rib lines cut a ribbed cuff into a row of tall thin slivers. Each
    sliver is button-sized by area, so a vision pass can file the row as
    buttons -- measured on b36b2d80ccb6: the review pass moved a front cuff's
    nine 12x56px slices into button_front_placket and the cuff vanished. A
    button is roughly round; a sliver twice as tall as it is wide is not one.
    Slivers lifted out of a button part become a cuff when three or more sit
    side by side (named by the view and side of the nearest part), else join
    the nearest part.
    """
    def box(r):
        return info[str(r)]["bbox"]

    def thin(r):
        x0, y0, x1, y1 = box(r)
        w, h = max(1, x1 - x0), max(1, y1 - y0)
        return max(w, h) / min(w, h) >= 2.5

    def centre(r):
        x0, y0, x1, y1 = box(r)
        return ((x0 + x1) / 2, (y0 + y1) / 2)

    def nearest(c, names):
        best, bd = None, float("inf")
        for nm in names:
            for r in parts[nm]["regions"]:
                rc = centre(r)
                d = (rc[0] - c[0]) ** 2 + (rc[1] - c[1]) ** 2
                if d < bd:
                    best, bd = nm, d
        return best

    for nm in [n for n in parts if "button" in n]:
        slivers = [r for r in parts[nm].get("regions", []) if thin(r)]
        if not slivers:
            continue
        parts[nm]["regions"] = [r for r in parts[nm]["regions"] if r not in slivers]
        cx = sum(centre(r)[0] for r in slivers) / len(slivers)
        cy = sum(centre(r)[1] for r in slivers) / len(slivers)
        others = [n for n in parts if n != nm and parts[n].get("regions") and "button" not in n]
        if len(slivers) >= 3:
            # view + side from whatever part sits closest (sleeve, pocket or
            # panel): a mis-grouped sleeve must not send a front cuff to the back
            near = nearest((cx, cy), others) or ""
            view = next((v for v in ("front", "back") if v in near), "front")
            side = next((sd for sd in ("left", "right") if sd in near), "")
            target = "_".join(x for x in (view, side, "cuff") if x)
            if target not in parts:
                parts[target] = {"regions": []}
            parts[target]["regions"] = sorted(set(parts[target]["regions"]) | set(slivers))
            print(f"  rib slices {slivers} were filed as buttons ({nm}) -> {target}")
        else:
            for r in slivers:
                t = nearest(centre(r), others)
                if t:
                    parts[t]["regions"].append(r)
        if not parts[nm]["regions"]:
            del parts[nm]
    return parts


def deterministic_repairs(parts: dict, all_ids: set, info: dict,
                          segdir: str) -> dict:
    """Every post-naming repair, in the order they have to run.

    Shared with verify_layers.py: the review pass rewrites groups.json from a
    vision call of its own, so any fix applied only here would be silently
    undone the moment the reviewer returns corrections.
    """
    parts = repair_parts(parts, all_ids, info)
    parts = ribs_are_not_buttons(parts, info)
    # before anything geometric: a run of print cells masquerading as panels
    # skews every span the later repairs measure against.
    parts = merge_numbered_sibling_panels(parts)
    parts = split_offaxis_belt_regions(parts, info)
    parts = merge_hem_allowance(parts, info)
    parts = split_hem_from_panel(parts, info)
    parts = merge_collar_parts(parts)
    parts = separate_collar_placket(parts, info)
    parts = reunite_sleeve_columns(parts, info)
    parts = evict_offcolumn_from_sleeve(parts, info, segdir)
    # Before the per-region release below: a pocket that came back holding a
    # WHOLE panel is a swap, not a mis-grouping, and strip_panels_from_applied
    # cannot fix it -- releasing that one region would leave the pocket with
    # nothing, which it reads (correctly, for its own case) as "this really is
    # an applied piece" and keeps whole. This pass was written for the swap and
    # then never called from anywhere; wired in, it is what puts the panel and
    # the welt back on the right parts.
    parts = split_oversized_applied(parts, info, segdir)
    parts = strip_panels_from_applied(parts, info, segdir)
    parts = collapse_subpanels(parts, info, segdir)
    # after collapse_subpanels, so the qualified sections are already home and
    # what is left under a bare "..._panel" is judged on size alone.
    parts = fold_texture_slivers(parts, info, segdir)
    parts = merge_belt_edge_strips(parts, info)
    parts = demote_false_cuffs(parts, info, segdir)
    parts = split_cuff_bands(parts, info, segdir)
    # after split_cuff_bands, so both see every cuff the run ends up with -- the
    # named ones and the ones lifted out of a sleeve here. demote first: it is
    # what gives the view a waistband for the rib pass to measure against.
    parts = demote_hem_cuffs(parts, info)
    parts = return_hem_rib_to_waistband(parts, info)
    # last of the hem passes: the ones above decide what a hem part IS, this
    # one decides whether the strip is a band at all or just a topstitch line.
    parts = merge_blank_hem_bands(parts, info, segdir)
    parts = merge_seam_line_parts(parts, info, segdir)
    parts = normalize_part_names(parts, info)
    return check_grab_boxes(parts, segdir)


def check_grab_boxes(parts: dict, segdir: str) -> dict:
    """Clamp every grab_box to the image and verify it actually sits on ink.

    Asking the model for one part per zip gets the COUNT and the naming right,
    but its coordinates are guesses: boxes come back out of bounds (x=1900 on
    an 1882px-wide sketch) or over blank fabric. A box on nothing produces an
    empty layer and, worse, a region-less part that survives validation only
    because it has a box. Snap each box to the ink it encloses, and drop a
    region-less part whose box holds no ink at all -- the ink then stays with
    the panel instead of disappearing into a phantom part."""
    work = os.path.join(segdir, "work.png")
    thr_path = os.path.join(segdir, "threshold.txt")
    if not (os.path.isfile(work) and os.path.isfile(thr_path)):
        return parts
    import numpy as np
    a = np.asarray(Image.open(work).convert("L"))
    thr = int(open(thr_path).read().strip())
    ink = a < thr
    H, W = ink.shape
    out = {}
    for nm, p in parts.items():
        gb = p.get("grab_box")
        if not gb:
            out[nm] = p
            continue
        x0, y0, x1, y1 = (int(round(v)) for v in gb)
        x0, x1 = max(0, min(x0, W - 1)), max(1, min(x1, W))
        y0, y1 = max(0, min(y0, H - 1)), max(1, min(y1, H))
        sub = ink[y0:y1, x0:x1] if (x1 > x0 and y1 > y0) else np.zeros((0, 0), bool)
        if sub.size and sub.sum() >= MIN_BOX_INK:
            ys, xs = np.nonzero(sub)
            # snap to the ink, then give it back a rail's worth of margin
            p["grab_box"] = [max(0, x0 + int(xs.min()) - BOX_SNAP_PAD),
                             max(0, y0 + int(ys.min()) - BOX_SNAP_PAD),
                             min(W, x0 + int(xs.max()) + 1 + BOX_SNAP_PAD),
                             min(H, y0 + int(ys.max()) + 1 + BOX_SNAP_PAD)]
            out[nm] = p
            continue
        if p.get("regions"):
            print(f"  grab_box for {nm} holds no ink -- dropping the box, "
                  f"keeping its regions")
            p.pop("grab_box")
            out[nm] = p
        else:
            print(f"  dropping {nm}: grab_box {gb} holds no ink and it has "
                  f"no regions of its own")
    return out


MIN_BOX_INK = 60     # px of ink a grab_box must enclose to be believed
BOX_SNAP_PAD = 6     # margin kept around the ink when snapping a box to it


def main(segdir, out_json):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not found.\n"
                 "Create a .env file next to your scripts containing:\n"
                 "  ANTHROPIC_API_KEY=sk-ant-your-key\n"
                 "and install:  pip install python-dotenv")
    info = json.load(open(os.path.join(segdir, "regions.json")))
    stats = "\n".join(
        f"{k}: {v['area']}px, c{v['centroid']}, bbox{v['bbox']}"
        for k, v in sorted(info.items(), key=lambda kv: int(kv[0])))

    img = Image.open(os.path.join(segdir, "preview.png"))
    scale = min(1.0, 1568 / max(img.size))
    if scale < 1.0:
        img = img.resize((int(img.width * scale), int(img.height * scale)))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    def extract_json(t):
        t = t.strip().removeprefix("```json").removeprefix("```")
        t = t.removesuffix("```").strip()
        try:
            return json.loads(t)
        except json.JSONDecodeError:
            pass
        # model sometimes second-guesses itself and prints a corrected JSON
        # block after the first -- scan all top-level {...} blocks and keep
        # the LAST one that parses (its final answer), not first-to-last.
        best = None
        depth = 0
        start = None
        for idx, ch in enumerate(t):
            if ch == "{":
                if depth == 0:
                    start = idx
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0 and start is not None:
                    try:
                        best = json.loads(t[start:idx + 1])
                    except json.JSONDecodeError:
                        pass
                    start = None
        return best

    client = anthropic.Anthropic()
    content = [
        {"type": "image", "source": {"type": "base64",
         "media_type": "image/png", "data": b64}},
        {"type": "text", "text": PROMPT.format(stats=stats)},
    ]
    cfg = None
    segdir_for_log = os.path.dirname(out_json) or "."
    retry_notice = {"type": "text", "text": (
        "Reply with ONLY the JSON object -- no markdown fences, no "
        "explanation, no self-correction, no second attempt in your reply. "
        "Double-check region ids are non-overlapping BEFORE writing the "
        "JSON, then output the final JSON once.")}
    for attempt in (1, 2, 3):
        msg_content = content if attempt == 1 else content + [retry_notice]
        try:
            msg = client.messages.create(
                model="claude-sonnet-4-6", max_tokens=8000,
                messages=[{"role": "user", "content": msg_content}])
        except anthropic.BadRequestError as e:
            print(f"attempt {attempt}: request failed ({e})")
            continue
        text = "".join(b.text for b in msg.content if b.type == "text")
        raw_path = os.path.join(segdir_for_log, f"naming_raw_{attempt}.txt")
        open(raw_path, "w").write(
            f"stop_reason: {msg.stop_reason}\n---\n{text}")
        cfg = extract_json(text)
        if cfg and "parts" in cfg:
            break
        print(f"attempt {attempt}: not valid JSON "
              f"(stop_reason={msg.stop_reason}, "
              f"starts: {text[:120]!r}) -> saved {raw_path}")
    if not cfg or "parts" not in cfg:
        sys.exit("region naming failed 3x. Send the naming_raw_*.txt files "
                 "for diagnosis, or write groups.json from preview.png")

    # -------- validation & repair --------
    all_ids = {int(k) for k in info}
    cfg["parts"] = deterministic_repairs(cfg["parts"], all_ids, info, segdir)

    json.dump(cfg, open(out_json, "w"), indent=1)
    if cfg.get("garment_type"):
        print(f"garment: {cfg['garment_type']}")
    print(f"wrote {out_json}:")
    for nm, p in cfg["parts"].items():
        print(f"  {nm}: {sorted(p['regions'])}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
