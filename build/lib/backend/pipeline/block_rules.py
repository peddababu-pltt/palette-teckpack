"""
Block rule definitions for the garment classification system.

Defines construction lines, block rules, garment taxonomy, and
subcategory-to-block mappings used by the classifier and
construction line resolver.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)


@dataclass
class ConstructionLine:
    name: str
    position_formula: str
    relative_to: str
    direction: str  # "horizontal" | "vertical" | "diagonal"


@dataclass
class BlockRule:
    block_type: str
    categories: list[str]
    subcategories: dict[str, list[str]]
    construction_lines: list[ConstructionLine]
    key_measurements: list[str]
    ease_ranges: dict[str, tuple[float, float]]
    proportion_rules: dict[str, str]
    silhouette_cues: list[str]


# ---------------------------------------------------------------------------
# Garment taxonomy: 12 categories, each with snake_case subcategories
# ---------------------------------------------------------------------------

GARMENT_TAXONOMY: dict[str, list[str]] = {
    "tops": [
        "t_shirt", "polo_shirt", "shirt_woven", "blouse", "tank_top",
        "camisole", "crop_top", "sweatshirt", "hoodie", "knit_top",
        "tunic", "henley", "bodysuit",
    ],
    "bottoms": [
        "jeans", "trousers", "chinos", "shorts", "skirt_mini",
        "skirt_midi", "skirt_maxi", "culottes", "leggings", "joggers",
        "cargo_pants",
    ],
    "dresses": [
        "shift_dress", "a_line_dress", "bodycon_dress", "wrap_dress",
        "shirt_dress", "maxi_dress", "midi_dress", "mini_dress",
        "fit_and_flare_dress", "slip_dress",
    ],
    "outerwear": [
        "jacket", "blazer", "coat_trench", "coat_overcoat", "coat_puffer",
        "bomber_jacket", "denim_jacket", "leather_jacket", "parka",
        "raincoat", "gilet_vest",
    ],
    "knitwear": [
        "sweater", "cardigan", "pullover", "turtleneck", "cable_knit",
        "knit_vest",
    ],
    "activewear": [
        "sports_bra", "performance_tee", "running_shorts", "track_pants",
        "yoga_pants", "compression_leggings", "training_jacket",
        "athletic_hoodie",
    ],
    "loungewear": [
        "pajama_top", "pajama_bottom", "nightdress", "robe",
        "lounge_pants", "lounge_top", "thermal_set",
    ],
    "underwear": [
        "bra", "bralette", "briefs", "boxer_shorts", "trunks",
        "shapewear", "slip", "chemise",
    ],
    "swimwear": [
        "bikini_top", "bikini_bottom", "one_piece_swimsuit",
        "swim_shorts", "rash_guard",
    ],
    "ethnic_cultural": [
        "kurta", "kurti", "saree_blouse", "lehenga", "sherwani",
        "dupatta", "salwar", "churidar", "anarkali", "kaftan",
    ],
    "suits_formalwear": [
        "suit_jacket", "suit_trousers", "waistcoat", "tuxedo_jacket",
        "dress_shirt", "formal_skirt",
    ],
    "accessories": [
        "scarf", "belt", "hat", "gloves", "socks", "ties", "caps",
    ],
}


# ---------------------------------------------------------------------------
# Block rule definitions
# ---------------------------------------------------------------------------

BLOCK_RULES: dict[str, BlockRule] = {
    "bodice": BlockRule(
        block_type="bodice",
        categories=[
            "tops", "knitwear", "activewear", "loungewear",
            "underwear", "ethnic_cultural", "suits_formalwear", "swimwear",
        ],
        subcategories={},
        construction_lines=[
            ConstructionLine("bust_line", "back_length / 2", "nape_point", "horizontal"),
            ConstructionLine("waist_line", "back_length", "nape_point", "horizontal"),
            ConstructionLine("shoulder_point", "shoulder_width / 2", "center_back_neck", "horizontal"),
            ConstructionLine("armhole_depth", "back_length / 2 + 15", "nape_point", "horizontal"),
            ConstructionLine("across_back", "across_back / 2", "center_back", "horizontal"),
            ConstructionLine("across_front", "across_front / 2", "center_front", "horizontal"),
            ConstructionLine("bust_dart", "back_length / 2 + 10", "side_seam", "vertical"),
            ConstructionLine("waist_dart", "back_length", "bust_point", "vertical"),
        ],
        key_measurements=[
            "chest", "waist", "shoulder_width", "back_length",
            "front_length", "across_back", "across_front", "neck",
        ],
        ease_ranges={
            "chest": (60, 200),
            "waist": (40, 200),
            "bicep": (30, 100),
        },
        proportion_rules={
            "shoulder_to_bust": "shoulder_width / chest",
            "waist_to_bust": "waist / chest",
        },
        silhouette_cues=[
            "Upper body fitted garment",
            "Shoulder seam defines width",
            "Bust/waist shaping via darts or seaming",
            "Armhole connects to sleeve block",
        ],
    ),

    "sleeve": BlockRule(
        block_type="sleeve",
        categories=[],  # Sleeve is always a secondary block, never a primary category
        subcategories={},
        construction_lines=[
            ConstructionLine("crown_height", "arm_length / 4", "sleeve_head", "vertical"),
            ConstructionLine("bicep_line", "arm_length / 4", "sleeve_head", "horizontal"),
            ConstructionLine("elbow_line", "arm_length / 2 + 30", "sleeve_head", "horizontal"),
            ConstructionLine("wrist_line", "arm_length", "sleeve_head", "horizontal"),
        ],
        key_measurements=["arm_length", "bicep", "wrist"],
        ease_ranges={
            "bicep": (20, 80),
            "wrist": (10, 50),
        },
        proportion_rules={
            "bicep_to_wrist": "bicep / wrist",
        },
        silhouette_cues=[
            "Sleeve crown fits armhole",
            "Bicep line at widest point",
            "Elbow at mid-point provides shaping",
            "Wrist line defines cuff position",
        ],
    ),

    "skirt": BlockRule(
        block_type="skirt",
        categories=["bottoms"],
        subcategories={},
        construction_lines=[
            ConstructionLine("waist_line", "0", "waist_point", "horizontal"),
            ConstructionLine("hip_line", "200", "waist_point", "horizontal"),
            ConstructionLine("hem_line", "back_length * 0.6", "waist_point", "horizontal"),
            ConstructionLine("dart_position", "hip / 4", "waist_center", "vertical"),
        ],
        key_measurements=["waist", "hip", "back_length"],
        ease_ranges={
            "waist": (10, 40),
            "hip": (20, 60),
        },
        proportion_rules={
            "waist_to_hip": "waist / hip",
        },
        silhouette_cues=[
            "Waist-to-hip shaping",
            "Hip line 20cm below waist",
            "Hem length defines silhouette",
            "Dart positions control fullness",
        ],
    ),

    "trouser": BlockRule(
        block_type="trouser",
        categories=["bottoms"],
        subcategories={},
        construction_lines=[
            ConstructionLine("waist_line", "0", "waist_point", "horizontal"),
            ConstructionLine("hip_line", "200", "waist_point", "horizontal"),
            ConstructionLine("crotch_line", "outseam - inseam", "waist_point", "horizontal"),
            ConstructionLine("knee_line", "(outseam - inseam) + inseam / 2", "waist_point", "horizontal"),
            ConstructionLine("ankle_line", "outseam", "waist_point", "horizontal"),
            ConstructionLine("inseam_line", "0", "crotch_point", "vertical"),
            ConstructionLine("outseam_line", "hip / 2", "waist_point", "vertical"),
        ],
        key_measurements=[
            "waist", "hip", "inseam", "outseam", "thigh", "knee", "ankle",
        ],
        ease_ranges={
            "waist": (10, 30),
            "hip": (20, 60),
            "thigh": (20, 80),
        },
        proportion_rules={
            "thigh_to_knee": "thigh / knee",
            "knee_to_ankle": "knee / ankle",
        },
        silhouette_cues=[
            "Crotch depth from waist-to-hip",
            "Knee at mid-inseam",
            "Leg taper from thigh to ankle",
            "Inseam/outseam define leg shape",
        ],
    ),

    "outerwear": BlockRule(
        block_type="outerwear",
        categories=["outerwear"],
        subcategories={},
        construction_lines=[
            # All bodice lines
            ConstructionLine("bust_line", "back_length / 2", "nape_point", "horizontal"),
            ConstructionLine("waist_line", "back_length", "nape_point", "horizontal"),
            ConstructionLine("shoulder_point", "shoulder_width / 2", "center_back_neck", "horizontal"),
            ConstructionLine("armhole_depth", "back_length / 2 + 15", "nape_point", "horizontal"),
            ConstructionLine("across_back", "across_back / 2", "center_back", "horizontal"),
            ConstructionLine("across_front", "across_front / 2", "center_front", "horizontal"),
            ConstructionLine("bust_dart", "back_length / 2 + 10", "side_seam", "vertical"),
            ConstructionLine("waist_dart", "back_length", "bust_point", "vertical"),
            # Outerwear-specific lines
            ConstructionLine("lapel_line", "chest / 2 - 50", "shoulder_point", "vertical"),
            ConstructionLine("break_point", "back_length / 2 + 20", "center_front", "horizontal"),
            ConstructionLine("gorge_line", "back_length / 5", "shoulder_point", "diagonal"),
            ConstructionLine("shoulder_extension", "shoulder_width / 2 + 10", "center_back_neck", "horizontal"),
        ],
        key_measurements=[
            "chest", "waist", "shoulder_width", "back_length",
            "front_length", "across_back", "across_front", "neck", "bicep",
        ],
        ease_ranges={
            "chest": (120, 260),
            "waist": (100, 260),
            "bicep": (60, 140),
            "shoulder_width": (10, 30),
        },
        proportion_rules={
            "shoulder_to_bust": "shoulder_width / chest",
            "waist_to_bust": "waist / chest",
        },
        silhouette_cues=[
            "Extended shoulder line",
            "Increased ease over bodice block",
            "Lapel and gorge line define collar",
            "Break point marks button stance",
        ],
    ),

    "dress": BlockRule(
        block_type="dress",
        categories=["dresses", "loungewear"],
        subcategories={},
        construction_lines=[
            ConstructionLine("bust_line", "back_length / 2", "nape_point", "horizontal"),
            ConstructionLine("waist_line", "back_length", "nape_point", "horizontal"),
            ConstructionLine("hip_line", "back_length + 200", "nape_point", "horizontal"),
            ConstructionLine("hem_line", "back_length * 2.2", "nape_point", "horizontal"),
            ConstructionLine("empire_line", "back_length / 2 - 30", "nape_point", "horizontal"),
            ConstructionLine("waist_seam", "back_length", "nape_point", "horizontal"),
        ],
        key_measurements=["chest", "waist", "hip", "shoulder_width", "back_length", "front_length", "neck"],
        ease_ranges={
            "chest": (60, 160),
            "waist": (40, 160),
            "hip": (40, 120),
        },
        proportion_rules={
            "bust_to_waist": "chest / waist",
            "waist_to_hip": "waist / hip",
        },
        silhouette_cues=[
            "Combined bodice and skirt in one",
            "Bust/waist/hip shaping continuous",
            "Empire line option above natural waist",
            "Hem length defines dress type",
        ],
    ),
}


# ---------------------------------------------------------------------------
# Subcategory-to-blocks mapping: (category, subcategory) -> list of block_type
# ---------------------------------------------------------------------------

SUBCATEGORY_TO_BLOCKS: dict[tuple[str, str], list[str]] = {}


def _build_subcategory_map() -> None:
    """Populate SUBCATEGORY_TO_BLOCKS based on the specification rules."""

    # --- tops ---
    sleeveless_tops = {"tank_top", "camisole"}
    for sub in GARMENT_TAXONOMY["tops"]:
        if sub in sleeveless_tops:
            SUBCATEGORY_TO_BLOCKS[("tops", sub)] = ["bodice"]
        else:
            SUBCATEGORY_TO_BLOCKS[("tops", sub)] = ["bodice", "sleeve"]

    # --- knitwear ---
    for sub in GARMENT_TAXONOMY["knitwear"]:
        if sub == "knit_vest":
            SUBCATEGORY_TO_BLOCKS[("knitwear", sub)] = ["bodice"]
        else:
            SUBCATEGORY_TO_BLOCKS[("knitwear", sub)] = ["bodice", "sleeve"]

    # --- activewear ---
    SUBCATEGORY_TO_BLOCKS[("activewear", "sports_bra")] = ["bodice"]
    SUBCATEGORY_TO_BLOCKS[("activewear", "performance_tee")] = ["bodice", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("activewear", "running_shorts")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("activewear", "track_pants")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("activewear", "yoga_pants")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("activewear", "compression_leggings")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("activewear", "training_jacket")] = ["outerwear", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("activewear", "athletic_hoodie")] = ["outerwear", "sleeve"]

    # --- bottoms ---
    skirt_subs = {"skirt_mini", "skirt_midi", "skirt_maxi"}
    for sub in GARMENT_TAXONOMY["bottoms"]:
        if sub in skirt_subs:
            SUBCATEGORY_TO_BLOCKS[("bottoms", sub)] = ["skirt"]
        elif sub == "culottes":
            SUBCATEGORY_TO_BLOCKS[("bottoms", sub)] = ["skirt", "trouser"]
        else:
            SUBCATEGORY_TO_BLOCKS[("bottoms", sub)] = ["trouser"]

    # --- dresses ---
    for sub in GARMENT_TAXONOMY["dresses"]:
        SUBCATEGORY_TO_BLOCKS[("dresses", sub)] = ["dress", "sleeve"]

    # --- outerwear ---
    for sub in GARMENT_TAXONOMY["outerwear"]:
        if sub == "gilet_vest":
            SUBCATEGORY_TO_BLOCKS[("outerwear", sub)] = ["outerwear"]
        else:
            SUBCATEGORY_TO_BLOCKS[("outerwear", sub)] = ["outerwear", "sleeve"]

    # --- loungewear ---
    SUBCATEGORY_TO_BLOCKS[("loungewear", "pajama_top")] = ["bodice", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("loungewear", "pajama_bottom")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("loungewear", "nightdress")] = ["dress", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("loungewear", "robe")] = ["dress", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("loungewear", "lounge_pants")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("loungewear", "lounge_top")] = ["bodice", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("loungewear", "thermal_set")] = ["bodice", "sleeve"]

    # --- underwear ---
    bodice_underwear = {"bra", "bralette", "shapewear", "slip", "chemise"}
    trouser_underwear = {"briefs", "boxer_shorts", "trunks"}
    for sub in GARMENT_TAXONOMY["underwear"]:
        if sub in bodice_underwear:
            SUBCATEGORY_TO_BLOCKS[("underwear", sub)] = ["bodice"]
        elif sub in trouser_underwear:
            SUBCATEGORY_TO_BLOCKS[("underwear", sub)] = ["trouser"]

    # --- swimwear ---
    SUBCATEGORY_TO_BLOCKS[("swimwear", "bikini_top")] = ["bodice"]
    SUBCATEGORY_TO_BLOCKS[("swimwear", "bikini_bottom")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("swimwear", "one_piece_swimsuit")] = ["dress"]
    SUBCATEGORY_TO_BLOCKS[("swimwear", "swim_shorts")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("swimwear", "rash_guard")] = ["bodice", "sleeve"]

    # --- ethnic_cultural ---
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "kurta")] = ["bodice", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "kurti")] = ["bodice", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "saree_blouse")] = ["bodice", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "lehenga")] = ["skirt"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "sherwani")] = ["outerwear", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "dupatta")] = ["bodice"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "salwar")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "churidar")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "anarkali")] = ["dress", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("ethnic_cultural", "kaftan")] = ["dress", "sleeve"]

    # --- suits_formalwear ---
    SUBCATEGORY_TO_BLOCKS[("suits_formalwear", "suit_jacket")] = ["outerwear", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("suits_formalwear", "suit_trousers")] = ["trouser"]
    SUBCATEGORY_TO_BLOCKS[("suits_formalwear", "waistcoat")] = ["outerwear"]
    SUBCATEGORY_TO_BLOCKS[("suits_formalwear", "tuxedo_jacket")] = ["outerwear", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("suits_formalwear", "dress_shirt")] = ["bodice", "sleeve"]
    SUBCATEGORY_TO_BLOCKS[("suits_formalwear", "formal_skirt")] = ["skirt"]

    # --- accessories ---
    for sub in GARMENT_TAXONOMY["accessories"]:
        SUBCATEGORY_TO_BLOCKS[("accessories", sub)] = []


_build_subcategory_map()


def _populate_block_subcategories() -> None:
    """Back-populate BlockRule.subcategories from SUBCATEGORY_TO_BLOCKS."""
    for (cat, sub), block_types in SUBCATEGORY_TO_BLOCKS.items():
        for bt in block_types:
            rule = BLOCK_RULES.get(bt)
            if rule:
                rule.subcategories.setdefault(cat, []).append(sub)


_populate_block_subcategories()


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------


def get_block_rule(block_type: str) -> BlockRule | None:
    """Return the BlockRule for a given block_type, or None if not found."""
    return BLOCK_RULES.get(block_type)


def get_block_for_subcategory(category: str, subcategory: str) -> list[str]:
    """Return the list of block_type strings for a (category, subcategory) pair.

    Returns an empty list if the combination is not found.
    """
    return SUBCATEGORY_TO_BLOCKS.get((category, subcategory), [])


def resolve_construction_lines(block_type: str, size: str = "M") -> dict[str, float]:
    """Evaluate construction line formulas for a block type and size.

    Retrieves body measurements for the given size, converts mm to cm,
    and evaluates each construction line formula to compute positions.

    Args:
        block_type: One of the defined block types (bodice, sleeve, etc.)
        size: Size code from body_measurements (XS through 4XL)

    Returns:
        Dict mapping construction line name to position in cm.
        Returns empty dict if block_type or size is unknown.
    """
    from body_measurment import BODY_MEASUREMENTS

    rule = BLOCK_RULES.get(block_type)
    if rule is None:
        return {}

    measurements_mm = BODY_MEASUREMENTS.get(size)
    if measurements_mm is None:
        return {}

    # Convert all measurements from mm to cm
    context: dict[str, float] = {
        key: val / 10 for key, val in measurements_mm.items()
    }

    results: dict[str, float] = {}
    for cl in rule.construction_lines:
        try:
            value = eval(cl.position_formula, {"__builtins__": {}}, context)  # noqa: S307
            results[cl.name] = float(value)
        except Exception:
            logger.warning(
                "Failed to evaluate formula %r for construction line %r in block %r",
                cl.position_formula, cl.name, block_type,
            )

    return results
