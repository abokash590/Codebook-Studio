"""Renders a LaTeX-ish math string into a real typeset SVG image (the same
way Word's equation editor or a proper math renderer would show it), instead
of leaving it as plain typed characters.

Uses matplotlib's built-in "mathtext" engine -- it understands a large
subset of LaTeX math syntax (\\frac, \\sum, \\int, \\sqrt, super/subscripts,
Greek letters, \\binom, etc.) and needs no external LaTeX install, so it
works out of the box after `pip install -r requirements.txt`.

The rendered SVG is returned already base64-encoded as a `data:` URL, so it
can be dropped straight into an <img src="..."> tag in both the live HTML
preview and the final PDF (WeasyPrint renders data-URL images natively).
"""

import base64
import io

import matplotlib
matplotlib.use("Agg")  # headless -- no display needed
import matplotlib.pyplot as plt

FONT_SIZE = 13
TEXT_COLOR = "#2C2C2A"


def _wrap(latex: str) -> str:
    text = latex.strip()
    if not text:
        return ""
    if not (text.startswith("$") and text.endswith("$")):
        text = f"${text}$"
    return text


def render_formula(latex: str, fontsize: int = FONT_SIZE, color: str = TEXT_COLOR):
    """Returns (ok, img_data_url_or_None, error_message_or_None)."""
    text = _wrap(latex)
    if not text:
        return True, None, None

    fig = plt.figure(figsize=(0.01, 0.01))
    fig.patch.set_alpha(0.0)
    try:
        fig.text(0, 0, text, fontsize=fontsize, color=color)
        buf = io.BytesIO()
        fig.savefig(
            buf, format="svg", transparent=True,
            bbox_inches="tight", pad_inches=0.04,
        )
    except Exception as e:  # matplotlib raises plain ValueError/RuntimeError on bad syntax
        plt.close(fig)
        return False, None, str(e)
    plt.close(fig)

    buf.seek(0)
    b64 = base64.b64encode(buf.read()).decode("ascii")
    return True, f"data:image/svg+xml;base64,{b64}", None
