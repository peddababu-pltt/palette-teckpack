#!/usr/bin/env python3
"""
measure_garment.py — garment photo + size -> full graded measurement chart (POM).

There is no reference scale (ruler/known object) in an arbitrary garment
photo, so absolute pixel-distance measurement isn't possible here. Instead:
Claude is given the photo + the requested size and asked to (a) classify
the garment (category/subcategory) and (b) estimate FLAT garment
measurements in cm, using standard size-chart values for that size as a
baseline and adjusting for visible fit/proportion (oversized, cropped,
slim, longline, etc). Those estimates are then reconciled against the
industry body+ease tables in measurment_resolver.resolve_pom(), which
already rejects any estimate outside a sane 60-150% band of the expected
value — so a bad vision guess falls back to the table value instead of
corrupting the chart.

Usage: ANTHROPIC_API_KEY=... python3 measure_garment.py photo.jpg out.json --size M
"""
import argparse
import base64
import io
import json
import os
import sys
from dataclasses import dataclass, field

import anthropic
from dotenv import load_dotenv
from PIL import Image

from block_rules import BLOCK_RULES, GARMENT_TAXONOMY, get_block_for_subcategory
from body_measurment import SIZES
from measurment_resolver import resolve_pom

load_dotenv()

MEASUREMENT_FIELDS = [
    "chest_width_cm", "waist_width_cm", "hip_width_cm", "shoulder_width_cm",
    "body_length_cm", "across_back_cm", "across_front_cm", "neck_width_cm",
    "inseam_cm", "outseam_cm", "thigh_width_cm", "knee_width_cm",
    "ankle_width_cm", "hem_width_cm",
]
SLEEVE_FIELDS = ["length_cm", "bicep_width_cm", "cuff_width_cm"]

PROMPT = """You are a garment construction expert measuring a garment from a photo.

## Available Block Types
{block_types}

## Garment Taxonomy (12 categories)
{taxonomy}

## Instructions

1. If the image is not a garment (accessory, non-clothing item), set status to
   "failure", block_type/category/subcategory to "", confidence to 0.0, and
   skip steps 2-5 (leave measurements/sleeves at all zeros).
2. Otherwise identify the primary block type that best matches this garment's
   construction, from the Available Block Types above.
3. Classify the garment into one of the 12 taxonomy categories and a specific
   subcategory from the taxonomy above.
4. List the visible construction elements (collar type, sleeve type, closure,
   pockets, etc.).
5. Provide a confidence score from 0.0 to 1.0.
6. Estimate FLAT garment measurements in cm for a size {size} (garment laid
   flat, one side only — e.g. chest width is armpit-to-armpit, NOT full
   circumference). There is no ruler or reference object in the photo, so you
   cannot measure absolute pixel distances — instead, start from standard
   size-chart values for a {size} in this garment category, then adjust based
   on the VISIBLE fit and proportion in the photo (oversized, slim/fitted,
   cropped, longline, relaxed, boxy) relative to a regular fit. Only estimate
   fields that are visible and applicable to this garment type; use 0 for
   anything not visible or not applicable (e.g. inseam on a t-shirt).

Measurement fields:
- measurements.chest_width_cm, measurements.waist_width_cm, measurements.hip_width_cm
- measurements.shoulder_width_cm (shoulder point to shoulder point)
- measurements.body_length_cm (high point shoulder to hem)
- measurements.across_back_cm, measurements.across_front_cm
- measurements.neck_width_cm
- measurements.inseam_cm, measurements.outseam_cm (bottoms only)
- measurements.thigh_width_cm, measurements.knee_width_cm, measurements.ankle_width_cm (bottoms only)
- measurements.hem_width_cm
- sleeves.length_cm, sleeves.bicep_width_cm, sleeves.cuff_width_cm (0 if sleeveless)

## Response Format

Return ONLY valid JSON (no markdown fences, no explanation outside JSON):

{{"status": "success" or "failure",
  "block_type": "<one of the block types above, or empty string>",
  "category": "<one of the 12 taxonomy categories, or empty string>",
  "subcategory": "<specific subcategory from the taxonomy, or empty string>",
  "confidence": 0.0,
  "reasoning": "<brief explanation of classification>",
  "construction_elements": ["<element1>", "<element2>"],
  "measurements": {{"chest_width_cm": 0, "waist_width_cm": 0, "hip_width_cm": 0,
    "shoulder_width_cm": 0, "body_length_cm": 0, "across_back_cm": 0,
    "across_front_cm": 0, "neck_width_cm": 0, "inseam_cm": 0, "outseam_cm": 0,
    "thigh_width_cm": 0, "knee_width_cm": 0, "ankle_width_cm": 0, "hem_width_cm": 0}},
  "sleeves": {{"length_cm": 0, "bicep_width_cm": 0, "cuff_width_cm": 0}}}}"""


@dataclass
class Measurements:
    chest_width_cm: float = 0.0
    waist_width_cm: float = 0.0
    hip_width_cm: float = 0.0
    shoulder_width_cm: float = 0.0
    body_length_cm: float = 0.0
    across_back_cm: float = 0.0
    across_front_cm: float = 0.0
    neck_width_cm: float = 0.0
    inseam_cm: float = 0.0
    outseam_cm: float = 0.0
    thigh_width_cm: float = 0.0
    knee_width_cm: float = 0.0
    ankle_width_cm: float = 0.0
    hem_width_cm: float = 0.0


@dataclass
class Sleeves:
    length_cm: float = 0.0
    bicep_width_cm: float = 0.0
    cuff_width_cm: float = 0.0


@dataclass
class GarmentDNA:
    measurements: Measurements = field(default_factory=Measurements)
    sleeves: Sleeves = field(default_factory=Sleeves)


@dataclass
class BlockClassification:
    category: str
    subcategory: str
    block_type: str = ""


def _taxonomy_text() -> str:
    return "\n".join(
        f"- **{cat}**: {', '.join(subs)}" for cat, subs in GARMENT_TAXONOMY.items()
    )


def _block_types_text() -> str:
    lines = []
    for bt, rule in BLOCK_RULES.items():
        cl_names = ", ".join(cl.name for cl in rule.construction_lines)
        cues = "; ".join(rule.silhouette_cues)
        subcats = "; ".join(f"{cat}: {', '.join(subs)}" for cat, subs in rule.subcategories.items())
        lines.append(
            f"- **{bt}**: Construction lines: {cl_names}\n"
            f"  Silhouette cues: {cues}\n"
            f"  Subcategories: {subcats}"
        )
    return "\n".join(lines)


def _extract_json(t: str):
    t = t.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        i, j = t.find("{"), t.rfind("}")
        if i != -1 and j > i:
            try:
                return json.loads(t[i:j + 1])
            except json.JSONDecodeError:
                pass
    return None


def analyze_garment_photo(image_path: str, size: str) -> dict:
    im = Image.open(image_path).convert("RGB")
    if max(im.size) > 1568:
        scale = 1568 / max(im.size)
        im = im.resize((int(im.width * scale), int(im.height * scale)))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()

    client = anthropic.Anthropic()
    msg = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1000,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64",
                 "media_type": "image/png", "data": b64}},
                {"type": "text", "text": PROMPT.format(
                    size=size, taxonomy=_taxonomy_text(), block_types=_block_types_text())},
            ],
        }],
    )
    text = "".join(b.text for b in msg.content if b.type == "text")
    cfg = _extract_json(text)
    if not cfg:
        sys.exit("garment analysis returned invalid JSON; run again")
    return cfg


def resolve_measurements(image_path: str, size: str) -> dict:
    cfg = analyze_garment_photo(image_path, size)

    if cfg.get("status") == "failure":
        return {
            "status": "failure",
            "confidence": float(cfg.get("confidence", 0.0) or 0.0),
            "reasoning": cfg.get("reasoning", "image does not appear to be a garment"),
        }

    category = cfg.get("category", "")
    subcategory = cfg.get("subcategory", "")
    block_type = cfg.get("block_type", "")
    if not get_block_for_subcategory(category, subcategory) and block_type not in BLOCK_RULES:
        sys.exit(
            f"unrecognized classification from vision: category={category!r} "
            f"subcategory={subcategory!r} block_type={block_type!r} "
            f"(confidence {cfg.get('confidence', 0.0)})"
        )

    m_vals = cfg.get("measurements", {}) or {}
    s_vals = cfg.get("sleeves", {}) or {}
    dna = GarmentDNA(
        measurements=Measurements(**{k: float(m_vals.get(k, 0) or 0) for k in MEASUREMENT_FIELDS}),
        sleeves=Sleeves(**{k: float(s_vals.get(k, 0) or 0) for k in SLEEVE_FIELDS}),
    )
    block_classification = BlockClassification(category=category, subcategory=subcategory, block_type=block_type)

    poms_mm = resolve_pom(block_classification, dna, sizes=SIZES)
    poms_cm = [
        {"name": p["name"], "values": {sz: round(v / 10.0, 1) for sz, v in p["values"].items()}}
        for p in poms_mm
    ]

    return {
        "status": "success",
        "category": category, "subcategory": subcategory, "block_type": block_type,
        "confidence": float(cfg.get("confidence", 0.0) or 0.0),
        "reasoning": cfg.get("reasoning", ""),
        "construction_elements": cfg.get("construction_elements", []) or [],
        "selected_size": size, "poms": poms_cm,
    }


def main():
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY missing in .env")

    ap = argparse.ArgumentParser()
    ap.add_argument("photo")
    ap.add_argument("out_json")
    ap.add_argument("--size", default="M", choices=SIZES)
    a = ap.parse_args()

    result = resolve_measurements(a.photo, a.size)
    json.dump(result, open(a.out_json, "w"), indent=2)
    if result["status"] == "failure":
        print(f"not a garment (confidence {result['confidence']}): {result['reasoning']}")
    else:
        print(f"detected: {result['category']}/{result['subcategory']} "
              f"({result['block_type']}, confidence {result['confidence']}) — "
              f"{len(result['poms'])} measurements, size {a.size}")


if __name__ == "__main__":
    main()
