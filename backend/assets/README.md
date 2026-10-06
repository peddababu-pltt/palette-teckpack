# 3D preview assets

## mannequin.glb

Realistic human body for the Sewing pattern tab's 3D view.

- **Source:** `public/avatars/parametric-base.glb` from
  [nirholas/three.ws](https://github.com/nirholas/three.ws), baked from the
  MakeHuman / MPFB2 hm08 base mesh via [NAVER anny](https://github.com/naver/anny).
- **License:** CC0 1.0 Universal (public domain). Original MakeHuman assets
  released to CC0 in September 2020 by Data Collection AB, Joel Palmius and
  Jonas Hauquier. Credited here as good citizenship; no attribution required.
- **Modified:** slimmed to the 34 body-shape morph targets the viewer uses
  (chest/waist/hips/shoulders/…); face morphs dropped. Regenerate with
  `python3 scripts/slim-mannequin.py parametric-base.glb backend/assets/mannequin.glb`.

The viewer reshapes it to each pattern's measurements at load time. If the
file is missing it falls back to a built-in procedural mannequin.
