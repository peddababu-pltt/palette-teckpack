"""
Measurement resolver: connects block rules + GarmentDNA measurements + body
measurement table to produce graded POM values across all sizes.

Strategy: body table + ease gives reliable M-size garment values. DNA values
from photo extraction are only accepted when within 60-150% of the expected
body-table value. Grading across sizes uses body-table proportional ratios.

resolve_pom()       — given block classification + DNA, returns graded SpecPom list
map_parts_to_pom()  — rule-based mapping from identified parts to POM display names
"""
from __future__ import annotations

import logging

from block_rules import get_block_for_subcategory, get_block_rule
from body_measurment import BODY_MEASUREMENTS, EASE_DEFAULTS

logger = logging.getLogger(__name__)

CIRCUMFERENCE_KEYS = {
    "chest", "waist", "hip", "neck", "bicep", "wrist", "thigh", "knee", "ankle",
}

# Expected FINISHED garment body length for M size (mm).
# Longer-side estimates for women's size M (bust 86-91cm, waist 67-74cm).
# These are conservative longer-side values to accommodate modern fashion trends.
GARMENT_BODY_LENGTH: dict[str, float] = {
    # Tops (HPS to hem) - longer side
    "t_shirt": 710, "polo_shirt": 730, "shirt_woven": 760,
    "blouse": 690, "tank_top": 660, "camisole": 560, "crop_top": 440,
    "sweatshirt": 730, "hoodie": 730, "knit_top": 690, "tunic": 780,
    "henley": 730, "bodysuit": 580,
    # Knitwear
    "sweater": 710, "cardigan": 740, "pullover": 710, "turtleneck": 710,
    "cable_knit": 740, "knit_vest": 650,
    # Outerwear — longer side, varies hugely by subcategory
    "jacket": 720, "blazer": 760, "bomber_jacket": 700, "denim_jacket": 700,
    "leather_jacket": 710, "coat_trench": 1100, "coat_overcoat": 1100,
    "coat_puffer": 750, "parka": 920, "raincoat": 950,     "gilet_vest": 660,
    # Dresses - longer side
    "shift_dress": 980, "a_line_dress": 1050, "bodycon_dress": 930,
    "wrap_dress": 1100, "shirt_dress": 1100, "maxi_dress": 1500,
    "midi_dress": 1150, "mini_dress": 880, "fit_and_flare_dress": 1050,
    "slip_dress": 1050, "puffer_jacket": 750,
    # Activewear
    "sports_bra": 310, "performance_tee": 730, "training_jacket": 720,
    "athletic_hoodie": 730,
    # Loungewear
    "pajama_top": 740, "nightdress": 1150, "robe": 1220, "lounge_top": 720,
    # Ethnic / Cultural (Indian market data)
    "kurta": 1080, "kurti": 1060, "saree_blouse": 420, "lehenga": 1070,
    "sherwani": 1150, "anarkali": 1520, "kaftan": 1250,
    "salwar": 1060, "churidar": 1080,
    # Swimwear
    "one_piece_swimsuit": 720, "rash_guard": 710,
    # Suits / Formalwear
    "suit_jacket": 750, "tuxedo_jacket": 770, "waistcoat": 640,
    "dress_shirt": 760, "formal_skirt": 670,
    # Bottoms — skirts (waist to hem)
    "skirt_mini": 420, "skirt_midi": 720, "skirt_maxi": 1100,
}

# block rule key -> (DNA field path, display name)
KEY_TO_DNA: dict[str, tuple[str, str]] = {
    "chest":          ("measurements.chest_width_cm",    "Chest Width"),
    "waist":          ("measurements.waist_width_cm",    "Waist Width"),
    "hip":            ("measurements.hip_width_cm",      "Hip Width"),
    "shoulder_width": ("measurements.shoulder_width_cm", "Shoulder Width"),
    "back_length":    ("measurements.body_length_cm",    "Body Length"),
    "front_length":   ("measurements.body_length_cm",    "Front Length"),
    "across_back":    ("measurements.across_back_cm",    "Across Back"),
    "across_front":   ("measurements.across_front_cm",   "Across Front"),
    "neck":           ("measurements.neck_width_cm",     "Neck Width"),
    "arm_length":     ("sleeves.length_cm",              "Sleeve Length"),
    "bicep":          ("sleeves.bicep_width_cm",         "Bicep Width"),
    "wrist":          ("sleeves.cuff_width_cm",          "Wrist Width"),
    "inseam":         ("measurements.inseam_cm",         "Inseam"),
    "outseam":        ("measurements.outseam_cm",        "Outseam"),
    "thigh":          ("measurements.thigh_width_cm",    "Thigh Width"),
    "knee":           ("measurements.knee_width_cm",     "Knee Width"),
    "ankle":          ("measurements.ankle_width_cm",    "Ankle Width"),
}

HEM_DNA_PATH = "measurements.hem_width_cm"
HEM_DISPLAY = "Hem Width"

# Map block type -> ease category key in EASE_DEFAULTS
_BLOCK_TO_EASE_CATEGORY: dict[str, str] = {
    "bodice": "top",
    "sleeve": "top",
    "skirt": "skirt",
    "trouser": "bottom",
    "outerwear": "outerwear",
    "dress": "dress",
}

# DNA is accepted only if within this range of the expected value
_DNA_ACCEPT_LOW = 0.6
_DNA_ACCEPT_HIGH = 1.5


def _get_dna_value(dna, field_path: str) -> float:
    """Extract a value from a GarmentDNA dataclass using a dot-separated path."""
    obj = dna
    for part in field_path.split("."):
        obj = getattr(obj, part, 0.0)
        if obj is None:
            return 0.0
    return float(obj) if obj else 0.0


def _max_ease(block_types: list[str], key: str) -> float:
    """Get the highest ease value for a measurement key across block types."""
    best = 0.0
    for bt in block_types:
        cat = _BLOCK_TO_EASE_CATEGORY.get(bt, "top")
        e = EASE_DEFAULTS.get(cat, {}).get(key, 0.0)
        if e > best:
            best = e
    return best


_M_BACK_LENGTH_REF = 420  # M-size nape-to-waist (mm), used as grading anchor
_BODY_LENGTH_GRADE_FACTOR = 1.5  # amplifies back_length ratio for garment length grading


def _garment_mm(key: str, block_types: list[str], body: dict, subcategory: str = "") -> float:
    """Compute the expected garment measurement for a POM key in mm.

    For circumference keys: half-garment width = (body_full_circ + ease) / 2
    For body/front length: looks up GARMENT_BODY_LENGTH table by subcategory,
        with proportional grading across sizes. Falls back to formula if not found.
    For shoulder/across/arm: body value + ease
    For other lengths: body table value directly
    """
    ease_mm = _max_ease(block_types, key)

    if key in CIRCUMFERENCE_KEYS:
        return (body.get(key, 0) + ease_mm) / 2.0

    if key in ("back_length", "front_length"):
        # Try subcategory-specific garment body length table first
        table_len = GARMENT_BODY_LENGTH.get(subcategory)
        if table_len:
            sz_back = body.get("back_length", _M_BACK_LENGTH_REF)
            ratio = sz_back / _M_BACK_LENGTH_REF
            # Amplify the body-proportion ratio for realistic garment length grading
            # e.g. back_length M→L ratio ~1.019 → garment length grading ~+1.9cm for 70cm top
            return table_len * (1 + (ratio - 1) * _BODY_LENGTH_GRADE_FACTOR)

        # Fallback: formula-based (for unknown subcategories)
        back_length = body.get("back_length", _M_BACK_LENGTH_REF)
        hps_offset = 25
        if "outerwear" in block_types:
            below_waist = 400
        elif "dress" in block_types:
            below_waist = body.get("outseam", 1050) * 0.55
        else:
            below_waist = 275
        return back_length + hps_offset + below_waist

    if key in ("shoulder_width", "across_back", "across_front", "arm_length"):
        return body.get(key, 0) + ease_mm

    # inseam, outseam, etc.: body table value is direct
    return body.get(key, 0)


def _collect_block_types(block_classification) -> list[str]:
    """Extract block types from a BlockClassification object."""
    cat = getattr(block_classification, "category", "")
    sub = getattr(block_classification, "subcategory", "")
    blocks = get_block_for_subcategory(cat, sub)
    if blocks:
        return blocks
    bt = getattr(block_classification, "block_type", "")
    return [bt] if bt else []


def resolve_pom(
    block_classification,
    dna,
    sizes: list[str] | None = None,
    sketch_measurements: dict[str, float] | None = None,
) -> list[dict]:
    """Resolve graded POM measurements from block rules + body table + DNA.

    Strategy (priority for M-size base):
      1. sketch_measurements (AI-measured from calibrated sketch) — highest priority
      2. DNA value if within 60-150% of expected
      3. Body table + ease expected value
      4. Grade to each size using body-table proportional ratios.

    Args:
        sketch_measurements: Maps POM display names to cm values measured from
            the flat sketch (e.g. {"Chest Width": 52.3, "Body Length": 71.0}).

    Returns list of {"name": display_name, "values": {size: mm_value}}.
    """
    if sizes is None:
        sizes = ["XS", "S", "M", "L", "XL", "2XL"]

    block_types = _collect_block_types(block_classification)
    if not block_types:
        logger.warning("[measurement_resolver] no block types found")
        return []

    subcategory = getattr(block_classification, "subcategory", "")

    # Collect key_measurements from all blocks, deduplicated
    seen_keys: set[str] = set()
    all_keys: list[str] = []
    for bt in block_types:
        rule = get_block_rule(bt)
        if not rule:
            continue
        for key in rule.key_measurements:
            if key not in seen_keys:
                seen_keys.add(key)
                all_keys.append(key)

    body_m = BODY_MEASUREMENTS.get("M", {})
    result: list[dict] = []

    for key in all_keys:
        mapping = KEY_TO_DNA.get(key)
        if not mapping:
            continue
        field_path, display_name = mapping

        dna_mm = _get_dna_value(dna, field_path) * 10.0
        expected_mm = _garment_mm(key, block_types, body_m, subcategory)

        # Decide M-size base: sketch_measurements > DNA > body table
        sketch_mm = 0.0
        if sketch_measurements:
            sketch_mm = sketch_measurements.get(display_name, 0.0) * 10.0

        if sketch_mm > 0:
            base_mm = sketch_mm
            logger.info(
                "[resolver] %s: using sketch measurement %.1fmm",
                key, sketch_mm,
            )
        elif dna_mm > 0 and expected_mm > 0:
            ratio = dna_mm / expected_mm
            if _DNA_ACCEPT_LOW <= ratio <= _DNA_ACCEPT_HIGH:
                base_mm = dna_mm
            else:
                base_mm = expected_mm
                logger.info(
                    "[resolver] %s: DNA=%.1fmm rejected (%.0f%% of expected %.1fmm)",
                    key, dna_mm, ratio * 100, expected_mm,
                )
        elif expected_mm > 0:
            base_mm = expected_mm
        elif dna_mm > 0:
            base_mm = dna_mm
        else:
            continue

        # Grade across sizes: ratio of target-size garment value to M garment value
        values: dict[str, float] = {}
        for sz in sizes:
            body_sz = BODY_MEASUREMENTS.get(sz, {})
            sz_garment_mm = _garment_mm(key, block_types, body_sz, subcategory)
            grade_ratio = sz_garment_mm / expected_mm if expected_mm > 0 else 1.0
            values[sz] = round(base_mm * grade_ratio, 1)

        result.append({"name": display_name, "values": values})

    # Add hem width (not in block rules but common POM)
    ease_cat = _BLOCK_TO_EASE_CATEGORY.get(block_types[0], "top") if block_types else "top"
    hip_ease = EASE_DEFAULTS.get(ease_cat, {}).get("hip", 80)
    expected_hem_mm = (body_m.get("hip", 980) + hip_ease) / 2.0

    hem_sketch_mm = (sketch_measurements.get(HEM_DISPLAY, 0.0) * 10.0) if sketch_measurements else 0.0
    hem_dna_mm = _get_dna_value(dna, HEM_DNA_PATH) * 10.0

    if hem_sketch_mm > 0:
        base_hem = hem_sketch_mm
    elif hem_dna_mm > 0 and expected_hem_mm > 0:
        ratio = hem_dna_mm / expected_hem_mm
        base_hem = hem_dna_mm if _DNA_ACCEPT_LOW <= ratio <= _DNA_ACCEPT_HIGH else expected_hem_mm
    elif expected_hem_mm > 0:
        base_hem = expected_hem_mm
    elif hem_dna_mm > 0:
        base_hem = hem_dna_mm
    else:
        base_hem = 0

    if base_hem > 0:
        hem_values: dict[str, float] = {}
        for sz in sizes:
            body_sz = BODY_MEASUREMENTS.get(sz, {})
            sz_hip = (body_sz.get("hip", 980) + hip_ease) / 2.0
            grade_ratio = sz_hip / expected_hem_mm if expected_hem_mm > 0 else 1.0
            hem_values[sz] = round(base_hem * grade_ratio, 1)
        result.append({"name": HEM_DISPLAY, "values": hem_values})

    logger.info("[measurement_resolver] resolved %d POMs for blocks=%s", len(result), block_types)
    return result


def map_parts_to_pom(parts: list, block_types: list[str] | None = None) -> dict[str, list[str]]:
    """Rule-based mapping from identified parts to POM display names."""
    mapping: dict[str, list[str]] = {}

    for part in parts:
        name = (getattr(part, "name", None) or (part.get("name") if isinstance(part, dict) else "")).lower()
        comp_type = (getattr(part, "component_type", None)
                     or (part.get("component_type", "") if isinstance(part, dict) else "")).lower()

        poms: list[str] = []

        if ("sleeve" in name or "sleeve" in comp_type) and "cuff" not in name:
            poms = ["Sleeve Length", "Bicep Width"]
        elif "cuff" in name:
            poms = ["Wrist Width"]
        elif "collar" in name or "neckline" in name:
            poms = ["Neck Width"]
        elif "waistband" in name or ("waist" in name and "panel" not in name):
            poms = ["Waist Width"]
        elif "yoke" in name:
            poms = ["Shoulder Width", "Across Back"]
        elif "hem" in name:
            poms = ["Hem Width"]
        elif "pocket" in name:
            poms = []
        elif ("front" in name or "body" in name or "bodice" in name) and (comp_type == "panel" or comp_type == ""):
            poms = ["Chest Width", "Body Length"]
        elif "back" in name and (comp_type == "panel" or comp_type == ""):
            poms = ["Chest Width", "Body Length"]

        part_key = getattr(part, "name", None) or (part.get("name") if isinstance(part, dict) else str(part))
        mapping[part_key] = poms

    return mapping
