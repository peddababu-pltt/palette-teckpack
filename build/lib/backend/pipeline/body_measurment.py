"""
Standard body measurement tables (industry standard, in mm) for sizes XS through 4XL.
All circumference values are FULL body circumference. Pattern pieces typically use half values.
"""

SIZES = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"]

# Full body circumference measurements in mm
BODY_MEASUREMENTS: dict[str, dict[str, float]] = {
    "XS": {
        "chest": 840,
        "waist": 680,
        "hip": 900,
        "shoulder_width": 400,
        "neck": 360,
        "arm_length": 580,
        "back_length": 400,
        "front_length": 420,
        "inseam": 780,
        "outseam": 1020,
        "thigh": 520,
        "knee": 360,
        "ankle": 220,
        "wrist": 160,
        "bicep": 280,
        "across_back": 340,
        "across_front": 320,
    },
    "S": {
        "chest": 880,
        "waist": 720,
        "hip": 940,
        "shoulder_width": 415,
        "neck": 370,
        "arm_length": 590,
        "back_length": 410,
        "front_length": 430,
        "inseam": 790,
        "outseam": 1035,
        "thigh": 540,
        "knee": 370,
        "ankle": 225,
        "wrist": 165,
        "bicep": 290,
        "across_back": 355,
        "across_front": 335,
    },
    "M": {
        "chest": 940,
        "waist": 780,
        "hip": 980,
        "shoulder_width": 430,
        "neck": 380,
        "arm_length": 600,
        "back_length": 420,
        "front_length": 440,
        "inseam": 800,
        "outseam": 1050,
        "thigh": 560,
        "knee": 380,
        "ankle": 230,
        "wrist": 170,
        "bicep": 305,
        "across_back": 370,
        "across_front": 350,
    },
    "L": {
        "chest": 1000,
        "waist": 840,
        "hip": 1040,
        "shoulder_width": 450,
        "neck": 395,
        "arm_length": 610,
        "back_length": 430,
        "front_length": 455,
        "inseam": 810,
        "outseam": 1065,
        "thigh": 590,
        "knee": 395,
        "ankle": 238,
        "wrist": 175,
        "bicep": 320,
        "across_back": 390,
        "across_front": 370,
    },
    "XL": {
        "chest": 1080,
        "waist": 920,
        "hip": 1100,
        "shoulder_width": 470,
        "neck": 410,
        "arm_length": 620,
        "back_length": 440,
        "front_length": 470,
        "inseam": 810,
        "outseam": 1070,
        "thigh": 620,
        "knee": 410,
        "ankle": 245,
        "wrist": 180,
        "bicep": 340,
        "across_back": 410,
        "across_front": 390,
    },
    "2XL": {
        "chest": 1160,
        "waist": 1000,
        "hip": 1170,
        "shoulder_width": 485,
        "neck": 425,
        "arm_length": 625,
        "back_length": 445,
        "front_length": 480,
        "inseam": 810,
        "outseam": 1070,
        "thigh": 650,
        "knee": 425,
        "ankle": 252,
        "wrist": 185,
        "bicep": 360,
        "across_back": 430,
        "across_front": 410,
    },
    "3XL": {
        "chest": 1240,
        "waist": 1080,
        "hip": 1240,
        "shoulder_width": 500,
        "neck": 440,
        "arm_length": 630,
        "back_length": 450,
        "front_length": 490,
        "inseam": 810,
        "outseam": 1070,
        "thigh": 680,
        "knee": 440,
        "ankle": 258,
        "wrist": 190,
        "bicep": 380,
        "across_back": 450,
        "across_front": 430,
    },
    "4XL": {
        "chest": 1320,
        "waist": 1160,
        "hip": 1310,
        "shoulder_width": 515,
        "neck": 455,
        "arm_length": 635,
        "back_length": 455,
        "front_length": 500,
        "inseam": 810,
        "outseam": 1070,
        "thigh": 710,
        "knee": 455,
        "ankle": 265,
        "wrist": 195,
        "bicep": 400,
        "across_back": 470,
        "across_front": 450,
    },
}

# Default ease values per garment category (mm, added to body measurements)
EASE_DEFAULTS: dict[str, dict[str, float]] = {
    "top": {
        "chest": 100,
        "waist": 100,
        "hip": 80,
        "bicep": 50,
        "wrist": 30,
        "shoulder_width": 15,
        "arm_length": 25,
        "across_back": 15,
        "across_front": 15,
        "neck": 10,
    },
    "bottom": {
        "waist": 20,
        "hip": 40,
        "thigh": 40,
        "knee": 40,
        "ankle": 20,
    },
    "outerwear": {
        "chest": 160,
        "waist": 140,
        "hip": 120,
        "bicep": 80,
        "wrist": 50,
        "shoulder_width": 20,
        "arm_length": 40,
        "across_back": 30,
        "across_front": 25,
        "neck": 15,
    },
    "dress": {
        "chest": 80,
        "waist": 60,
        "hip": 80,
        "bicep": 40,
        "shoulder_width": 10,
        "arm_length": 20,
        "across_back": 12,
        "across_front": 12,
        "neck": 8,
    },
    "skirt": {
        "waist": 20,
        "hip": 40,
    },
}


def get_measurements(size: str) -> dict[str, float]:
    if size not in BODY_MEASUREMENTS:
        raise ValueError(f"Unknown size '{size}'. Valid: {SIZES}")
    return dict(BODY_MEASUREMENTS[size])


def get_measurements_with_ease(
    size: str,
    category: str,
    ease_overrides: dict[str, float] | None = None,
) -> dict[str, float]:
    m = get_measurements(size)
    ease = dict(EASE_DEFAULTS.get(category, {}))
    if ease_overrides:
        ease.update(ease_overrides)
    for key, val in ease.items():
        if key in m:
            m[key] += val
    # Add ease values as separate keys for formula access
    for key, val in ease.items():
        m[f"ease_{key}"] = val
    return m
