"""SVG -> PNG rendering shared by layered_trace_v4.py and verify_layers.py.

cairosvg needs a system libcairo.so the hosted runtime doesn't have, so it
always fails there (ImportError/OSError depending on how far the dlopen
gets). PyMuPDF (fitz) renders SVG natively with no external library at all,
and is already installed wherever this pipeline runs (declared in
pyproject.toml, and already present in the hosted shared venv regardless).
"""


def svg2png(write_to, output_width, svg_bytes=None, svg_path=None):
    """Match cairosvg.svg2png()'s call shape: `write_to` is a file path OR a
    file-like object (verify_layers.py renders into an in-memory buffer);
    exactly one of `svg_bytes`/`svg_path` supplies the source SVG."""
    import fitz
    doc = fitz.open(stream=svg_bytes, filetype="svg") if svg_bytes is not None else fitz.open(svg_path)
    try:
        page = doc[0]
        zoom = output_width / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=True)
        if hasattr(write_to, "write"):
            write_to.write(pix.tobytes("png"))
        else:
            pix.save(write_to)
    finally:
        doc.close()
