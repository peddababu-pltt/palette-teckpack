#!/usr/bin/env python3
"""
flat2svg_auto.py — ONE command: flat sketch PNG -> layered SVG.

    ANTHROPIC_API_KEY=...  python3 flat2svg_auto.py sketch.png out.svg

Runs the whole chain:
    1. seg_parts.py       auto-segment enclosed regions (no AI)
    2. name_regions.py    Claude Vision names the regions   (1 API call)
    3. layered_trace_v4.py  cut + trace + compose layered SVG (no AI)

Intermediate files land in <sketch>_seg/ next to the input, so you can
inspect preview.png / groups.json and rerun step 3 alone after edits:

    python3 layered_trace_v4.py sketch.png sketch_seg/labels.npy \
            sketch_seg/groups.json out.svg
"""
import sys, os, subprocess


def run(*args):
    print("+", " ".join(args))
    subprocess.run([sys.executable, *args], check=True)

def main(in_png, out_svg, min_area=None):
    # 6000 (x4 on an upscaled work image = 24000px) merged every applied
    # detail into the panel it sits on before naming ever saw it: pocket
    # flaps, belt loops and waistband tabs run 2-8k px, so they could never
    # become their own part. SEG_MIN_AREA overrides per run.
    #
    # 1500 still lost the small hardware. seg_parts upscales anything under
    # 1400px 2x and multiplies the floor by 4, and the applied-detail floor is
    # min_area//4 -- so on a 1372px flat the floor lands back at 1500 while a
    # button measures 700-1000px. Measured on the puffer job's redrawn flat
    # (1372x784): floor 1500 -> 29 regions, ZERO button-sized ones; 600 -> 44
    # regions, all 5 buttons; 300 -> 48 regions, buttons plus both pocket flaps.
    # 300 is not the default because it pushed a busy quilted flat to 130
    # regions, over seg_parts' 100-region lattice gate, which would then
    # re-segment from the heavy strokes only. At 600 every sketch tested came
    # in at 44-84 regions, clear of that gate.
    min_area = min_area or os.environ.get("SEG_MIN_AREA", "600")
    here = os.path.dirname(os.path.abspath(__file__))
    segdir = os.path.splitext(in_png)[0] + "_seg"

    if os.environ.get("MODE", "").lower() == "polygon":
        # polygon mode: AI states each part's area ("sleeve from here to
        # here"), then cut exactly there and trace. Better for sketchy
        # drawings whose seams don't enclose clean regions.
        os.makedirs(segdir, exist_ok=True)
        parts = os.path.join(segdir, "parts.json")
        os.environ.setdefault("SNAP", "1")   # AI polygons: snap to seams
        run(os.path.join(here, "detect_parts.py"), in_png, parts)
        run(os.path.join(here, "layered_trace_v3.py"), in_png, parts, out_svg)
        print(f"\nDone (polygon mode): {out_svg}  "
              f"(edit {parts} and rerun layered_trace_v3 to adjust)")
        return
    run(os.path.join(here, "seg_parts.py"), in_png, segdir, min_area)
    groups = os.path.join(segdir, "groups.json")
    # SEG_AI=1 swaps the naming step for seg_ai.py: instead of asking a vision
    # model to read region numbers off a preview, it locates each part by
    # language (evf-sam) and assigns whole CV regions by overlap. Same output
    # contract either way, so step 3 is unchanged.
    namer = "seg_ai.py" if os.environ.get("SEG_AI") == "1" else "name_regions.py"
    run(os.path.join(here, namer), segdir, groups)
    work = os.path.join(segdir, "work.png")
    labels = os.path.join(segdir, "labels.npy")
    run(os.path.join(here, "layered_trace_v4.py"), work, labels, groups, out_svg)

    # self-check loop: AI reviews the extracted layers, corrects grouping,
    # and we re-trace -- up to 3 rounds (disable with SKIP_VERIFY=1)
    if not os.environ.get("SKIP_VERIFY"):
        for round_ in (1, 2, 3):
            r = subprocess.run([sys.executable,
                                os.path.join(here, "verify_layers.py"),
                                work, labels, groups, out_svg])
            if r.returncode != 3:
                break
            print(f"re-tracing after correction round {round_}...")
            run(os.path.join(here, "layered_trace_v4.py"),
                work, labels, groups, out_svg)

    print(f"\nDone: {out_svg}  (edit {groups} and rerun layered_trace_v4 to adjust)")

if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit("usage: flat2svg_auto.py sketch.png out.svg [min_region_area]")
    main(*sys.argv[1:4])
