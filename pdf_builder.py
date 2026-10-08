import base64
import functools
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import ImageFont
from pygments import highlight as pygments_highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_lexer_by_name
from pygments.util import ClassNotFound
from weasyprint import HTML
try:
    from weasyprint.text.fonts import FontConfiguration
except ImportError:
    from weasyprint.fonts import FontConfiguration
from db import get_db

# Reused across every build instead of created fresh each time -- WeasyPrint
# has to parse and register all the embedded @font-face fonts (JetBrains
# Mono, etc.) before it can lay out a single page, and that work is
# identical every build. Keeping one FontConfiguration alive for the life
# of the process means only the FIRST build after the server starts pays
# that cost; every build after that skips straight to page layout.
_FONT_CONFIG = FontConfiguration()

OUTPUT_DIR = Path(__file__).parent / "output"
FONTS_DIR = Path(__file__).parent / "static" / "fonts"
STATIC_DIR = Path(__file__).parent / "static"


def _find_chrome() -> str | None:
    """Return the path to a Chrome/Chromium executable, or None if not found."""
    # 1. Common explicit Windows paths
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Chromium\Application\chrome.exe",
        r"C:\Program Files (x86)\Chromium\Application\chrome.exe",
    ]
    for c in candidates:
        if Path(c).exists():
            return c
    # 2. Try PATH for linux/mac
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        found = shutil.which(name)
        if found:
            return found
    return None


def build_pdf_from_html(html_content: str) -> Path:
    """Render html_content to PDF using Chrome headless.

    Chrome uses the exact same Blink rendering engine as the live preview, so
    the PDF is guaranteed to be pixel-perfect identical to what the user sees.
    """
    chrome = _find_chrome()
    if not chrome:
        raise RuntimeError(
            "Chrome not found. Install Google Chrome and try again."
        )

    OUTPUT_DIR.mkdir(exist_ok=True)
    pdf_path = OUTPUT_DIR / "codebook.pdf"

    with tempfile.TemporaryDirectory() as tmp_dir:
        html_path = Path(tmp_dir) / "preview.html"
        html_path.write_text(html_content, encoding="utf-8")

        result = subprocess.run(
            [
                chrome,
                "--headless=new",
                "--no-sandbox",
                "--disable-gpu",
                "--disable-dev-shm-usage",
                "--run-all-compositor-stages-before-draw",
                "--disable-extensions",
                f"--print-to-pdf={pdf_path}",
                "--no-pdf-header-footer",
                "--print-to-pdf-no-header",
                str(html_path),
            ],
            capture_output=True,
            text=True,
            timeout=120,
        )

    if not pdf_path.exists():
        raise RuntimeError(
            f"Chrome failed to produce PDF.\nstderr: {result.stderr[:2000]}"
        )

    return pdf_path

# ---- Fonts available for the code blocks (family name -> file basenames) ----
CODE_FONT_FILES = {
    "JetBrains Mono": ("JetBrainsMono-Regular.ttf", "JetBrainsMono-Bold.ttf"),
    "IBM Plex Mono": ("IBMPlexMono-Regular.ttf", "IBMPlexMono-Bold.ttf"),
    "Space Mono": ("SpaceMono-Regular.ttf", "SpaceMono-Bold.ttf"),
}
DEFAULT_CODE_FONT = "JetBrains Mono"

# ---- Syntax highlighting (P1.2) -- one Pygments lexer per supported team
# language. Kept restrained to the 4 accepted contest languages; anything
# else falls back to C++ so an unrecognized value never breaks a build. ----
LEXER_ALIASES = {
    "cpp": "cpp", "c++": "cpp", "c": "c",
    "java": "java",
    "python": "python3", "py": "python3",
    "kotlin": "kotlin",
}
DEFAULT_LANGUAGE = "cpp"

# A restrained, print-friendly 4-color palette -- the same colors are used
# in static/style.css (via Prism token classes) for the editor/preview, so
# the printed PDF doesn't look like a different tool decided the colors.
SYNTAX_COLORS = {
    "keyword": "#5B4A8A",
    "string": "#3B7A4E",
    "comment": "#948F84",
    "func": "#A85A1E",
}


@functools.lru_cache(maxsize=None)
def _get_lexer(language: str):
    name = LEXER_ALIASES.get((language or DEFAULT_LANGUAGE).lower(), DEFAULT_LANGUAGE)
    try:
        return get_lexer_by_name(name, stripnl=False, stripall=False)
    except ClassNotFound:
        return get_lexer_by_name(DEFAULT_LANGUAGE, stripnl=False, stripall=False)


_HTML_FORMATTER = HtmlFormatter(nowrap=True)


def highlight_code_html(code: str, language: str) -> str:
    """Returns Pygments-highlighted HTML (span-wrapped tokens, already
    entity-escaped) for embedding directly inside a <pre>. Falls back to
    plain escaped text if Pygments can't process it for any reason -- a
    highlighting bug should never be able to break a PDF build."""
    try:
        return pygments_highlight(code or "", _get_lexer(language), _HTML_FORMATTER)
    except Exception:
        return escape_html(code)


SYNTAX_HIGHLIGHT_CSS = f"""
.card-code .k, .card-code .kt, .card-code .kd, .card-code .kn, .card-code .kr,
.boilerplate-code .k, .boilerplate-code .kt, .boilerplate-code .kd, .boilerplate-code .kn, .boilerplate-code .kr {{
  color: {SYNTAX_COLORS['keyword']}; font-weight: 600;
}}
.card-code .s, .card-code .s1, .card-code .s2, .card-code .sc,
.boilerplate-code .s, .boilerplate-code .s1, .boilerplate-code .s2, .boilerplate-code .sc {{
  color: {SYNTAX_COLORS['string']};
}}
.card-code .c, .card-code .c1, .card-code .cm, .card-code .cp,
.boilerplate-code .c, .boilerplate-code .c1, .boilerplate-code .cm, .boilerplate-code .cp {{
  color: {SYNTAX_COLORS['comment']}; font-style: italic;
}}
.card-code .nf, .card-code .fm, .card-code .mi, .card-code .mf, .card-code .mh,
.boilerplate-code .nf, .boilerplate-code .fm, .boilerplate-code .mi, .boilerplate-code .mf, .boilerplate-code .mh {{
  color: {SYNTAX_COLORS['func']};
}}
"""

PAGE_SIZE_CSS = {
    "A4": "A4",
    "Letter": "letter",
}
DEFAULT_PAGE_SIZE = "A4"

CONTEST_PAGE_LIMIT = 25

# ---- Page geometry (must mirror the @page margin/column rules in build_css
# and the .card / .boilerplate-code padding below) so fit_code_font_size()
# knows the real available width in mm for a card vs. a full-width page. ----
PAGE_WIDTH_MM = {"A4": 210.0, "Letter": 215.9}
PAGE_MARGIN_LEFT_MM = 12.0
PAGE_MARGIN_RIGHT_MM = 12.0
CARD_COLUMN_GAP_MM = 8.0
CARD_PADDING_MM = 3.0            # .card padding, each side
CARD_BORDER_ALLOWANCE_MM = 1.0   # left border + hairline border rounding
BOILERPLATE_PADDING_MM = 3.0     # .boilerplate-code padding, each side


def _content_width_mm(page_size: str) -> float:
    width = PAGE_WIDTH_MM.get(page_size, PAGE_WIDTH_MM[DEFAULT_PAGE_SIZE])
    return width - PAGE_MARGIN_LEFT_MM - PAGE_MARGIN_RIGHT_MM


def _card_inner_width_mm(page_size: str) -> float:
    column_width = (_content_width_mm(page_size) - CARD_COLUMN_GAP_MM) / 2
    return column_width - (CARD_PADDING_MM * 2) - CARD_BORDER_ALLOWANCE_MM


def _boilerplate_inner_width_mm(page_size: str) -> float:
    return _content_width_mm(page_size) - (BOILERPLATE_PADDING_MM * 2)


@functools.lru_cache(maxsize=None)
def _font_b64(filename: str) -> str:
    path = FONTS_DIR / filename
    return base64.b64encode(path.read_bytes()).decode("ascii")


def _font_face(family: str, filename: str, weight: str) -> str:
    fmt = "woff2" if filename.endswith(".woff2") else "truetype"
    data = _font_b64(filename)
    return f"""@font-face {{
  font-family: '{family}';
  font-weight: {weight};
  src: url(data:font/{fmt};base64,{data}) format('{fmt}');
}}"""


def build_font_faces_css(code_font: str) -> str:
    """Embed Inter (UI/body font) plus whichever code font is selected,
    so the PDF always renders with the right typeface -- no dependency
    on system-installed fonts or internet access at render time."""
    faces = [
        _font_face("Inter", "Inter-Regular.woff2", "400"),
        _font_face("Inter", "Inter-Medium.woff2", "500"),
        _font_face("Inter", "Inter-SemiBold.woff2", "600"),
    ]
    regular_file, bold_file = CODE_FONT_FILES.get(code_font, CODE_FONT_FILES[DEFAULT_CODE_FONT])
    resolved_family = code_font if code_font in CODE_FONT_FILES else DEFAULT_CODE_FONT
    faces.append(_font_face(resolved_family, regular_file, "400"))
    faces.append(_font_face(resolved_family, bold_file, "700"))
    return "\n".join(faces)


MIN_CODE_FONT_SIZE = 7.0
BASE_CODE_FONT_SIZE = 9.5
MM_PER_PX = 25.4 / 96.0


@functools.lru_cache(maxsize=None)
def _pil_font(filename: str, probe_px: int):
    return ImageFont.truetype(str(FONTS_DIR / filename), probe_px)


def _longest_unbreakable_token(code: str) -> str:
    """The printed code only wraps at whitespace (white-space: pre-wrap;
    word-break: normal). The only thing that can force an ugly mid-token
    break is a single run of non-whitespace characters wider than the
    column -- find the widest one so the card's font-size can be sized to
    fit it, instead of letting the browser/renderer chop it in half."""
    tokens = [t for t in re.split(r"\s+", code or "") if t]
    return max(tokens, key=len) if tokens else ""


def fit_code_font_size(code: str, code_font: str, available_width_mm: float,
                        base_size: float = BASE_CODE_FONT_SIZE,
                        min_size: float = MIN_CODE_FONT_SIZE) -> float:
    """Returns the largest font-size (>= min_size, <= base_size) at which
    this code's longest unbreakable token fits within available_width_mm,
    measured against the real embedded font file so it matches what
    actually prints."""
    token = _longest_unbreakable_token(code)
    if not token:
        return base_size
    regular_file, _ = CODE_FONT_FILES.get(code_font, CODE_FONT_FILES[DEFAULT_CODE_FONT])
    available_width_px = available_width_mm / MM_PER_PX
    # small safety margin -- font-metric rounding differs slightly between
    # PIL's measurement here and WeasyPrint's actual text shaping
    available_width_px *= 0.97

    size = base_size
    while size > min_size:
        probe_px = max(int(size * 4), 8)  # measure at 4x for sub-pixel precision
        token_width_px = _pil_font(regular_file, probe_px).getlength(token) / 4.0
        if token_width_px <= available_width_px:
            break
        size -= 0.25
    return round(max(size, min_size), 2)


def _css_string(s: str) -> str:
    """Escape a value for safe use inside a CSS content: "..." string."""
    return (s or "").replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


COVER_STYLES = ["minimal", "sketch", "banner", "frame", "terminal", "geometric"]
DEFAULT_COVER_STYLE = "minimal"


def _cover_html(style: str, book_title: str, team_name: str, institution_name: str) -> str:
    """Five deliberately distinct cover-page layouts, picked in Settings.
    Each returns its own markup (not just a CSS reskin of one template) so
    they read as genuinely different books, not the same page recolored."""
    style = style if style in COVER_STYLES else DEFAULT_COVER_STYLE
    title = escape_html(book_title)
    team = escape_html(team_name)
    inst = escape_html(institution_name)
    inst_html = f'<p class="cover-inst">{inst}</p>' if inst else ""

    if style == "sketch":
        inst_block = f'<p class="cover-sketch-inst">{inst}</p>' if inst else ""
        return f"""
        <section class="cover cover-sketch-page" id="cover-page-anchor">
          <div class="cover-sketch">
            <svg class="cover-sketch-border" viewBox="0 0 520 740" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
              <path d="M18,12 Q130,8 260,10 T502,14 Q506,180 504,370 T500,726 Q380,730 260,728 T18,724 Q14,560 16,370 T18,12 Z"
                fill="none" stroke="{accent_color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.55"/>
              <path d="M28,22 Q140,19 260,21 T492,25 Q495,185 493,370 T490,716 Q375,719 260,717 T28,714 Q25,555 27,370 T28,22 Z"
                fill="none" stroke="{accent_color}" stroke-width="0.8" stroke-linecap="round" opacity="0.25"/>
            </svg>
            <div class="cover-sketch-doodles" aria-hidden="true">
              <span class="csd csd-1">{{</span>
              <span class="csd csd-2">}}</span>
              <span class="csd csd-3">;</span>
              <span class="csd csd-4">#include</span>
              <span class="csd csd-5">//</span>
              <span class="csd csd-6">int main()</span>
              <span class="csd csd-7">&lt;&lt;</span>
              <span class="csd csd-8">return 0;</span>
              <span class="csd csd-9">[ ]</span>
              <span class="csd csd-10">==</span>
              <span class="csd csd-11">O(n log n)</span>
              <span class="csd csd-12">nullptr</span>
            </div>
            <div class="cover-sketch-body">
              <div class="cover-sketch-eyebrow">
                <span>Contest Notebook</span>
              </div>
              <h1 class="cover-sketch-title">{title}</h1>
              <div class="cover-sketch-rule"></div>
              <div class="cover-sketch-meta">
                {inst_block}
                <p class="cover-sketch-team">{team}</p>
              </div>
              <svg class="cover-sketch-bracket" width="40" height="28" viewBox="0 0 40 28" fill="none" stroke="{accent_color}" stroke-width="1.5" stroke-linecap="round">
                <path d="M12,4 Q8,4 7,8 T7,20 Q7,24 12,24"/>
                <path d="M28,4 Q32,4 33,8 T33,20 Q33,24 28,24"/>
              </svg>
            </div>
          </div>
        </section>
        """

    if style == "banner":
        return f"""
        <section class="cover cover-banner" id="cover-page-anchor">
          <div class="cover-banner-content">
            {inst_html}
            <div class="cover-banner-rule"></div>
            <h1>{title}</h1>
            <p class="cover-team">{team}</p>
          </div>
        </section>
        """

    if style == "frame":
        return f"""
        <section class="cover cover-frame" id="cover-page-anchor">
          <div class="cover-frame-border">
            {inst_html}
            <div class="cover-frame-rule"></div>
            <h1>{title}</h1>
            <div class="cover-frame-rule"></div>
            <p class="cover-team">{team}</p>
          </div>
        </section>
        """

    if style == "terminal":
        rows = ""
        if inst:
            rows += f'<p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> cat institution.txt</p><p class="cover-term-line cover-term-out">{inst}</p>'
        rows += f'<p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> whoami</p><p class="cover-term-line cover-term-out">{team}</p>'
        return f"""
        <section class="cover cover-terminal" id="cover-page-anchor">
          <div class="cover-term-window">
            <div class="cover-term-titlebar">
              <span class="cover-term-btn"></span>
              <span class="cover-term-btn"></span>
              <span class="cover-term-btn"></span>
            </div>
            <div class="cover-term-body">
              <p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> cat title.txt</p>
              <p class="cover-term-line cover-term-out cover-term-title-out">{title}</p>
              {rows}
              <p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> <span class="cover-term-cursor">&#9608;</span></p>
            </div>
          </div>
        </section>
        """

    if style == "geometric":
        return f"""
        <section class="cover cover-geometric" id="cover-page-anchor">
          <div class="cover-geo-mark"></div>
          <div class="cover-geo-text">
            {inst_html}
            <h1>{title}</h1>
            <div class="cover-geo-rule"></div>
            <p class="cover-team">{team}</p>
          </div>
        </section>
        """

    # "minimal" (default / fallback for unrecognized values)
    return f"""
    <section class="cover cover-minimal" id="cover-page-anchor">
      {inst_html}
      <h1>{title}</h1>
      <p class="cover-team">{team}</p>
      <div class="cover-minimal-rule"></div>
    </section>
    """


def build_css(code_font, page_size, accent_color, institution_name, team_name, show_header):
    resolved_family = code_font if code_font in CODE_FONT_FILES else DEFAULT_CODE_FONT
    page_size_css = PAGE_SIZE_CSS.get(page_size, PAGE_SIZE_CSS[DEFAULT_PAGE_SIZE])
    font_faces = build_font_faces_css(code_font)

    # Contest rule: institution name + team name must be in the upper-LEFT
    # corner of every page, and the page number in the upper-RIGHT corner.
    header_bits = [b for b in (institution_name, team_name) if b]
    header_text = " \u2014 ".join(header_bits)  # em dash separator
    top_left_rule = ""
    if show_header and header_text:
        top_left_rule = f"""@top-left {{ content: "{_css_string(header_text)}"; font-family: 'Inter', sans-serif; font-size: 9px; color: #5F5E5A; }}"""

    return f"""
{font_faces}

@page {{
  size: {page_size_css};
  margin: 16mm 12mm 14mm 12mm;
  {top_left_rule}
  @top-center {{ content: string(topicname); font-family: 'Inter', sans-serif; font-size: 9px; color: #888780; text-transform: uppercase; letter-spacing: 0.3px; }}
  @top-right {{
    content: counter(page); font-family: 'Inter', sans-serif; font-size: 9px; color: #5F5E5A;
    width: 6mm; height: 6mm;
    border: 0.8pt solid #888780; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    transform: rotate(2deg);
  }}
}}
* {{ box-sizing: border-box; }}
body {{ font-family: 'Inter', sans-serif; color: #2C2C2A; margin: 0; }}

.cover {{ page-break-after: always; position: relative; }}
.cover-sketch-page {{ page-break-after: always; position: relative; height: 257mm; }}
.cover-team {{ font-size: 13px; color: #5F5E5A; margin: 0; }}
.cover-inst {{ font-size: 11.5px; font-weight: 700; color: #55534D; text-transform: uppercase; letter-spacing: 1.1px; margin: 0 0 8px; }}

/* ---- sketch cover ---- */
.cover-sketch {{
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  color: {accent_color}; overflow: hidden;
}}
.cover-sketch-border {{ position: absolute; inset: -16mm; width: calc(100% + 32mm); height: calc(100% + 32mm); pointer-events: none; }}
.cover-sketch-doodles {{ position: absolute; inset: 0; pointer-events: none; font-family: 'JetBrains Mono', monospace; overflow: hidden; }}
.csd {{ position: absolute; font-size: 11px; color: {accent_color}; opacity: 0.07; white-space: nowrap; }}
.csd-1  {{ top: 8%;  left: 5%;  font-size: 42px; transform: rotate(-8deg); opacity: 0.06; }}
.csd-2  {{ top: 75%; left: 80%; font-size: 38px; transform: rotate(6deg);  opacity: 0.05; }}
.csd-3  {{ top: 55%; left: 4%;  font-size: 28px; transform: rotate(-3deg); opacity: 0.07; }}
.csd-4  {{ top: 14%; right: 6%; font-size: 12px; transform: rotate(3deg);  opacity: 0.09; }}
.csd-5  {{ top: 85%; left: 8%;  font-size: 16px; transform: rotate(-5deg); opacity: 0.08; }}
.csd-6  {{ top: 6%;  left: 28%; font-size: 11px; transform: rotate(-2deg); opacity: 0.08; }}
.csd-7  {{ top: 68%; right: 5%; font-size: 20px; transform: rotate(8deg);  opacity: 0.07; }}
.csd-8  {{ top: 88%; right: 12%;font-size: 11px; transform: rotate(-4deg); opacity: 0.09; }}
.csd-9  {{ top: 40%; left: 3%;  font-size: 13px; transform: rotate(5deg);  opacity: 0.07; }}
.csd-10 {{ top: 78%; left: 35%; font-size: 15px; transform: rotate(-3deg); opacity: 0.06; }}
.csd-11 {{ top: 22%; right: 3%; font-size: 11px; transform: rotate(4deg);  opacity: 0.09; }}
.csd-12 {{ top: 92%; left: 52%; font-size: 11px; transform: rotate(-2deg); opacity: 0.07; }}
.cover-sketch-body {{ position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; text-align: center; max-width: 140mm; }}
.cover-sketch-eyebrow {{ display: flex; align-items: center; gap: 6px; font-family: 'JetBrains Mono', monospace; font-size: 9px; letter-spacing: 1.8px; text-transform: uppercase; color: {accent_color}; opacity: 0.6; margin-bottom: 10mm; }}
.cover-sketch-title {{ font-family: 'Kalam', cursive; font-size: 34px; font-weight: 700; line-height: 1.15; color: #2C2C2A; margin: 0 0 7mm; letter-spacing: -0.5px; }}
.cover-sketch-rule {{ width: 48mm; height: 4px; background: {accent_color}; margin: 0 auto 8mm; }}
.cover-sketch-meta {{ display: flex; flex-direction: column; gap: 3px; margin-bottom: 8mm; }}
.cover-sketch-inst {{ font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: {accent_color}; margin: 0; opacity: 0.85; }}
.cover-sketch-team {{ font-family: 'JetBrains Mono', monospace; font-size: 10px; color: #888780; margin: 0; }}
.cover-sketch-bracket {{ color: {accent_color}; opacity: 0.4; margin-top: 2mm; }}

/* ---- minimal (default) -- plain, centered, thin accent rule ---- */
.cover-minimal {{ padding-top: 40mm; text-align: left; }}
.cover-minimal h1 {{ font-size: 26px; font-weight: 500; margin: 0 0 4px; color: {accent_color}; }}
.cover-minimal .cover-team {{ margin-bottom: 24px; }}
.cover-minimal-rule {{ width: 32mm; height: 2px; background: {accent_color}; }}

/* ---- banner -- was a full solid color band (expensive to print); now a
   short, thick accent rule as the graphic anchor instead ---- */
.cover-banner-content {{ padding-top: 54mm; }}
.cover-banner-rule {{ width: 26mm; height: 3.2mm; background: {accent_color}; margin-bottom: 8mm; }}
.cover-banner-content h1 {{ font-size: 28px; font-weight: 700; margin: 0 0 5mm; color: #1C1C1C; letter-spacing: -0.3px; }}
.cover-banner-content .cover-team {{ font-size: 13px; font-weight: 500; color: {accent_color}; }}

/* ---- frame -- academic double-border, centered, small caps ---- */
.cover-frame {{ padding: 14mm; height: calc(100% - 28mm); }}
.cover-frame-border {{
  border: 1.5pt solid {accent_color}; height: 100%; padding: 8mm;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; position: relative;
}}
.cover-frame-border::before {{
  content: ""; position: absolute; top: 4mm; left: 4mm; right: 4mm; bottom: 4mm;
  border: 0.5pt solid {accent_color};
}}
.cover-frame h1 {{ font-size: 24px; font-weight: 500; color: {accent_color}; margin: 6mm 0; letter-spacing: 0.5px; }}
.cover-frame .cover-inst {{ margin: 0; }}
.cover-frame .cover-team {{ margin-top: 2mm; }}
.cover-frame-rule {{ width: 18mm; height: 1px; background: {accent_color}; opacity: 0.5; }}

/* ---- terminal -- was a full dark-background page (very expensive to
   print); now a bordered "code window" mockup on plain white, same
   personality with almost no ink beyond thin lines and small text ---- */
.cover-terminal {{ padding-top: 60mm; }}
.cover-term-window {{ border: 1pt solid #D8D6D0; border-radius: 3mm; overflow: hidden; }}
.cover-term-titlebar {{ background: #F5F4EF; padding: 3mm 4mm; display: flex; gap: 2mm; border-bottom: 1pt solid #D8D6D0; }}
.cover-term-btn {{ width: 2.6mm; height: 2.6mm; border-radius: 50%; display: inline-block; background: {accent_color}; opacity: 0.55; }}
.cover-term-btn:nth-child(2) {{ opacity: 0.35; }}
.cover-term-btn:nth-child(3) {{ opacity: 0.2; }}
.cover-term-body {{ padding: 9mm 8mm; font-family: 'JetBrains Mono', monospace; }}
.cover-term-prompt-sym {{ color: {accent_color}; margin-right: 2mm; font-weight: 700; }}
.cover-term-line {{ font-size: 11px; color: #6B6A66; margin: 0 0 2mm; }}
.cover-term-out {{ color: #1C1C1C; padding-left: 5mm; margin-bottom: 5mm; }}
.cover-term-title-out {{ font-size: 16px; font-weight: 700; color: {accent_color}; }}
.cover-term-cursor {{ color: {accent_color}; }}

/* ---- geometric -- was a large 90mm solid triangle; now a small corner
   mark (~90% less ink) plus a short rule for the same graphic energy ---- */
.cover-geometric {{ padding-top: 50mm; padding-left: 4mm; position: relative; }}
.cover-geo-mark {{
  position: absolute; top: 0; right: 0; width: 0; height: 0;
  border-style: solid; border-width: 28mm 28mm 0 0; border-color: {accent_color} transparent transparent transparent;
}}
.cover-geo-text h1 {{ font-size: 27px; font-weight: 700; margin: 0 0 4mm; color: #1C1C1C; max-width: 120mm; }}
.cover-geo-rule {{ width: 20mm; height: 1.6mm; background: {accent_color}; margin-bottom: 6mm; }}
.cover-geo-text .cover-team {{ font-weight: 500; color: {accent_color}; }}

.boilerplate {{ page-break-before: always; }}
.boilerplate-header {{ display: flex; align-items: center; gap: 8px; border-bottom: 1.5px solid {accent_color}; padding-bottom: 8px; margin-bottom: 14px; }}
.boilerplate-mark {{ width: 8px; height: 8px; background: {accent_color}; border-radius: 2px; flex-shrink: 0; }}
.boilerplate-name {{ font-size: 12px; font-weight: 600; letter-spacing: 0.3px; color: {accent_color}; string-set: topicname content(); }}
/* Code-editor "window" treatment, echoing the Terminal cover style's
   titlebar so the template page reads as part of the same book rather
   than a plain block of text pasted onto the page. */
/* Same left colored-line treatment every other code card uses, so the
   template page reads as one of the book's cards, not a different object. */
.boilerplate-window {{ border: 0.5px solid #D3D1C7; border-left: 3px solid {accent_color}; border-radius: 10px; overflow: hidden; }}
.boilerplate-code {{
  background: #F1EFE8; border-radius: 0; padding: 3mm; margin: 0;
  font-family: '{resolved_family}', monospace; font-size: 9.5px; line-height: 1.45;
  /* wrap only at whitespace/newlines -- never chop an identifier mid-token;
     font-size on individual blocks is set inline by fit_code_font_size() */
  white-space: pre-wrap; word-break: normal; overflow-wrap: normal;
}}

/* One .topic-page-chunk = exactly one physical page. Chunks are computed
   from the layout the live preview already worked out (see build_codebook_pdf),
   so WeasyPrint isn't independently re-deciding page breaks -- it's only
   balancing columns within a page-sized, already-correct set of cards. */
.topic-page-chunk {{ page-break-before: always; }}
.topic-header {{ display: flex; align-items: center; gap: 8px; border-bottom: 1.5px solid {accent_color}; padding-bottom: 8px; margin-bottom: 14px; }}
.topic-dot {{ width: 8px; height: 8px; border-radius: 50%; }}
.topic-name {{ font-size: 12px; font-weight: 600; letter-spacing: 0.3px; color: {accent_color}; string-set: topicname content(); }}

.card-columns {{ column-count: 2; column-gap: 8mm; column-fill: auto; }}

/* Wavy hairline divider between snippet-containers */
.snippet-container {{ position: relative; margin-bottom: 4mm; }}
.snippet-container:not(:last-child)::after {{
  content: "";
  position: absolute;
  left: 6px; right: 6px;
  bottom: -2.3mm;
  height: 1.2mm;
  background: #D3D1C7;
  -webkit-mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10"><path d="M2,5 Q25,8 50,4 T98,6" fill="none" stroke="black" stroke-width="1.4" stroke-linecap="round"/></svg>');
  mask-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10"><path d="M2,5 Q25,8 50,4 T98,6" fill="none" stroke="black" stroke-width="1.4" stroke-linecap="round"/></svg>');
  -webkit-mask-size: 100% 100%; mask-size: 100% 100%;
}}

.card {{
  break-inside: auto;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  border: 0.5px solid #D3D1C7;
  border-left: 3px solid;
  border-radius: 10px;
  padding: 3mm;
  margin-bottom: 4mm;
  position: relative;
}}
/* Tape corners */
.card::before, .card::after {{
  content: "";
  position: absolute;
  top: -2.5mm;
  width: 9mm; height: 3.5mm;
  background: rgba(214, 196, 120, 0.5);
  border-radius: 1px;
}}
.card::before {{ left: 8mm; transform: rotate(-6deg); }}
.card::after  {{ right: 8mm; transform: rotate(5deg); }}
.card.unverified {{ border-style: dashed; }}
.card-head {{ display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }}
.card-title {{ font-size: 13px; font-weight: 600; }}
.card-complexity {{ font-size: 10.5px; color: #888780; font-family: '{resolved_family}', monospace; }}
.card-subtitle {{ font-size: 11px; color: #888780; margin: 0 0 6px; }}
.card-notes {{ font-size: 10.5px; line-height: 1.5; color: #2C2C2A; margin: 0 0 6px; }}
.card-formulas {{ display: flex; flex-direction: column; gap: 3px; margin: 0 0 6px; }}
.card-formula-img {{ max-width: 100%; height: auto; display: block; }}

/* ---- note cards ---- */
.card-note-body {{ font-size: 11px; line-height: 1.6; color: #2C2C2A; }}
.card-note-body p {{ margin: 0 0 8px; }}
.card-note-body p:last-child {{ margin-bottom: 0; }}
.card-note-body ul {{ margin: 0 0 8px; padding-left: 16px; }}
.card-note-body li {{ margin-bottom: 3px; }}

/* ---- standalone formula cards -- generous whitespace, centered, larger
   than the small inline formulas attached to a code card ---- */
.card-formulas-standalone {{ display: flex; flex-direction: column; gap: 10mm; padding: 4mm 0; }}
.card-formula-img-lg {{ max-width: 90%; margin: 0 auto; }}
.card-formula-raw {{ font-size: 9.5px; font-style: italic; color: #A32D2D; }}
.card-code {{
  background: #F1EFE8;
  border-radius: 6px;
  padding: 2mm;
  margin: 0;
  font-family: '{resolved_family}', monospace;
  font-size: 9.5px; /* default/max -- individual cards override inline when they need to shrink */
  line-height: 1.42;
  white-space: pre-wrap;
  word-break: normal;
  overflow-wrap: normal;
}}

/* Subtle paper-grain texture — 4% opacity, well below the 5% ceiling */
body {{
  background-image: radial-gradient(rgba(60,55,40,0.55) 0.5px, transparent 0.5px);
  background-size: 3px 3px;
  background-color: #ffffff;
}}
"""


def escape_html(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---- Minimal markdown for note cards (P1-extension) -- deliberately tiny:
# bold, italic, bullet lists, paragraphs. Escapes first so raw HTML in a
# note can never leak into the page; hand-rolled instead of pulling in a
# markdown library so the app stays "just pip install -r requirements.txt,
# no other installs" the same way formula_render.py already promises. The
# JS twin of this lives in static/app.js as markdownLite() -- keep both in
# sync if you touch the rules here. ----
def markdown_lite_html(text: str) -> str:
    text = escape_html(text or "")
    blocks = re.split(r"\n\s*\n", text.strip())
    html_blocks = []
    for block in blocks:
        lines = [ln.strip() for ln in block.split("\n") if ln.strip()]
        if not lines:
            continue
        if all(re.match(r"^[-*]\s+", ln) for ln in lines):
            items = "".join(f"<li>{_inline_md(ln[2:].strip())}</li>" for ln in lines)
            html_blocks.append(f"<ul>{items}</ul>")
        else:
            html_blocks.append(f"<p>{'<br>'.join(_inline_md(ln) for ln in lines)}</p>")
    return "".join(html_blocks)


def _inline_md(s: str) -> str:
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"_(.+?)_", r"<em>\1</em>", s)
    return s


def _formulas_html(s, standalone: bool = False) -> str:
    try:
        formulas = json.loads(s["formulas"] or "[]")
    except (TypeError, ValueError):
        formulas = []
    if not formulas:
        return ""
    parts = []
    for f in formulas:
        if f.get("img"):
            img_class = "card-formula-img card-formula-img-lg" if standalone else "card-formula-img"
            parts.append(f'<img class="{img_class}" src="{f["img"]}" alt="formula">')
        else:
            # couldn't be typeset (bad LaTeX) -- show the raw text so it isn't lost
            parts.append(f'<span class="card-formula-raw">{escape_html(f.get("latex", ""))}</span>')
    wrap_class = "card-formulas card-formulas-standalone" if standalone else "card-formulas"
    return f'<div class="{wrap_class}">{"".join(parts)}</div>'


def _card_html(s, topic_color: str, font_size: float) -> str:
    kind = s["kind"] if "kind" in s.keys() else "code"
    title_html = f'<span class="card-title">{escape_html(s["title"])}</span>'
    subtitle_html = f'<p class="card-subtitle">{escape_html(s["subtitle"])}</p>' if s["subtitle"] else ""

    if kind == "note":
        return f"""
        <div class="card card-note" style="border-left-color:{topic_color}">
          <div class="card-head">{title_html}</div>
          {subtitle_html}
          <div class="card-note-body">{markdown_lite_html(s["notes"])}</div>
        </div>
        """

    if kind == "formula":
        return f"""
        <div class="card card-formula-card" style="border-left-color:{topic_color}">
          <div class="card-head">{title_html}</div>
          {subtitle_html}
          {_formulas_html(s, standalone=True)}
        </div>
        """

    # kind == "code" (default, and fallback for any unrecognized value)
    verified_class = "" if s["verified"] else " unverified"
    notes_html = f'<p class="card-notes">{escape_html(s["notes"])}</p>' if s["notes"] else ""
    language = s["language"] if "language" in s.keys() else DEFAULT_LANGUAGE
    return f"""
    <div class="card{verified_class}" style="border-left-color:{topic_color}">
      <div class="card-head">
        {title_html}
        <span class="card-complexity">{escape_html(s['complexity'])}</span>
      </div>
      {subtitle_html}
      {notes_html}
      {_formulas_html(s)}
      <pre class="card-code" style="font-size:{font_size}px">{highlight_code_html(s['code'], language)}</pre>
    </div>
    """


def build_codebook_pdf(exclude_unverified: bool = False, layout: dict | None = None) -> Path:
    """Renders the codebook PDF.

    `layout`, when provided, is the exact page-by-page breakdown the browser
    preview already computed (see computeBuildLayout() in app.js): which
    snippet IDs land on which physical page, and how the boilerplate text is
    split across pages. When present, this function renders one page per
    chunk instead of handing WeasyPrint a long continuous flow to paginate
    on its own -- that's what keeps the built PDF matching what was shown
    on screen (previously these were two independent pagination decisions
    that could disagree). If no layout is given (e.g. an older client, or a
    direct API call), it falls back to letting WeasyPrint lay out each
    topic as one continuous multi-column flow, same as before.
    """
    conn = get_db()
    topics = conn.execute("SELECT * FROM topics WHERE deleted_at IS NULL ORDER BY sort_order").fetchall()
    settings = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM settings")}
    team_name = settings.get("team_name") or "MEC_ALGO_SCHOLARS"
    institution_name = settings.get("institution_name") or "Mymensingh Engineering College"
    book_title = settings.get("book_title") or "Contest Codebook"
    code_font = settings.get("code_font", DEFAULT_CODE_FONT)
    page_size = settings.get("page_size", DEFAULT_PAGE_SIZE)
    accent_color = settings.get("accent_color", "#2C2C2A")
    boilerplate_code = settings.get("boilerplate_code", "")
    cover_style = settings.get("cover_style", DEFAULT_COVER_STYLE)
    template_accent_color = settings.get("template_accent_color", accent_color)
    _show_header_val = settings.get("show_team_footer", "1")
    show_header = _show_header_val not in (0, "0", False, None, "")
    _show_boilerplate_val = settings.get("show_boilerplate", "1")
    show_boilerplate = _show_boilerplate_val not in (0, "0", False, None, "") and bool(boilerplate_code.strip())

    all_snippets = conn.execute("SELECT * FROM snippets WHERE deleted_at IS NULL").fetchall()
    snippet_by_id = {s["id"]: s for s in all_snippets}

    by_topic = {}
    for t in topics:
        query = "SELECT * FROM snippets WHERE topic_id=? AND deleted_at IS NULL"
        if exclude_unverified:
            query += " AND verified=1"
        query += " ORDER BY sort_order"
        by_topic[t["id"]] = conn.execute(query, (t["id"],)).fetchall()
    conn.close()

    card_width_mm = _card_inner_width_mm(page_size)
    boilerplate_width_mm = _boilerplate_inner_width_mm(page_size)

    # Cover: five selectable styles, see _cover_html() and COVER_STYLES.
    cover_html = _cover_html(cover_style, book_title, team_name, institution_name)

    # Boilerplate page(s): a pinned starter template that always sits right
    # after the cover. Split into the same chunks the preview computed, if
    # given, so a long boilerplate paginates identically in both places.
    boilerplate_html = ""
    if show_boilerplate:
        boilerplate_pages = (layout or {}).get("boilerplate_pages") or None
        chunks = boilerplate_pages if boilerplate_pages else [boilerplate_code]
        multi = len(chunks) > 1
        parts = []
        for idx, chunk_text in enumerate(chunks):
            font_size = fit_code_font_size(chunk_text, code_font, boilerplate_width_mm)
            label = "TEMPLATE" + (f" \u2014 PART {idx + 1}/{len(chunks)}" if multi else "")
            id_attr = ' id="template-page-anchor"' if idx == 0 else ""
            parts.append(f"""
            <section class="boilerplate"{id_attr}>
              <div class="boilerplate-header">
                <span class="boilerplate-mark"></span>
                <span class="boilerplate-name">{escape_html(label)}</span>
              </div>
              <div class="boilerplate-window">
                <pre class="boilerplate-code" style="font-size:{font_size}px">{highlight_code_html(chunk_text, DEFAULT_LANGUAGE)}</pre>
              </div>
            </section>
            """)
        boilerplate_html = "".join(parts)

    layout_topics = {}
    with open('debug_layout.log', 'a') as f: f.write(f'LAYOUT KEYS BEFORE: {layout}\n')

    sections_html = []
    index_entries = []       # [(anchor_id, topic_name, topic_color)] -- one row per topic that made it into the book
    bookmark_css_rules = ['#cover-page-anchor { bookmark-level: 1; bookmark-label: "Cover"; }']
    if show_boilerplate:
        bookmark_css_rules.append('#template-page-anchor { bookmark-level: 1; bookmark-label: "Template"; }')
    anchor_counter = 0

    def _next_anchor():
        nonlocal anchor_counter
        anchor_counter += 1
        return f"topic-anchor-{anchor_counter}"

    for t in topics:
        topic_pages = layout_topics.get(t["id"])
        if topic_pages:
            # Layout-driven path: render exactly the pages the preview computed.
            multi = len(topic_pages) > 1
            topic_anchor = None
            for idx, page_data in enumerate(topic_pages):
                with open("debug.log", "a") as f:
                    f.write(f"PAGE DATA TYPE: {type(page_data)} VAL: {repr(page_data)}\\n")
                # WeasyPrint layout parity: check if JS gave us explicit columns of PRE-SPLIT snippets
                if isinstance(page_data, dict) and "col1" in page_data:
                    def render_col(snippets):
                        col_cards = []
                        for s in snippets:
                            if exclude_unverified and not s.get("verified"):
                                continue
                            font_size = s.get("font_size") or fit_code_font_size(s.get("code", ""), code_font, card_width_mm)
                            col_cards.append(_card_html(s, t["color"], font_size))
                        return "".join(col_cards)
                    
                    col1_html = render_col(page_data.get("col1", []))
                    col2_html = render_col(page_data.get("col2", []))
                    
                    if not col1_html and not col2_html:
                        continue
                        
                    is_first_rendered_page = topic_anchor is None
                    if is_first_rendered_page:
                        topic_anchor = _next_anchor()
                        index_entries.append((topic_anchor, t["name"], t["color"]))
                        bookmark_css_rules.append(
                            f'#{topic_anchor} {{ bookmark-level: 1; bookmark-label: "{_css_string(t["name"])}"; }}'
                        )
                    id_attr = f' id="{topic_anchor}"' if is_first_rendered_page else ""
                    label = escape_html(t["name"]).upper() + (f" \u2014 PART {idx + 1}/{len(topic_pages)}" if multi else "")
                    sections_html.append(f"""
                    <section class="topic-page-chunk"{id_attr}>
                      <div class="topic-header">
                        <span class="topic-dot" style="background:{t['color']}"></span>
                        <span class="topic-name">{label}</span>
                      </div>
                      <div style="display: flex; gap: 8mm; height: 257mm; overflow: hidden;">
                        <div style="width: calc((100% - 8mm) / 2); display: flex; flex-direction: column;">{col1_html}</div>
                        <div style="width: calc((100% - 8mm) / 2); display: flex; flex-direction: column;">{col2_html}</div>
                      </div>
                    </section>
                    """)
                else:
                    # Fallback for old layout format (list of snippet IDs)
                    cards = []
                    for sid in page_data:
                        s = snippet_by_id.get(sid)
                        if s is None:
                            try:
                                s = snippet_by_id.get(int(sid))
                            except (TypeError, ValueError):
                                s = None
                        if s is None or s["topic_id"] != t["id"]:
                            continue  # stale id
                        if exclude_unverified and not s["verified"]:
                            continue
                        font_size = fit_code_font_size(s["code"], code_font, card_width_mm)
                        cards.append(_card_html(s, t["color"], font_size))
                    if not cards:
                        continue
                    is_first_rendered_page = topic_anchor is None
                    if is_first_rendered_page:
                        topic_anchor = _next_anchor()
                        index_entries.append((topic_anchor, t["name"], t["color"]))
                        bookmark_css_rules.append(
                            f'#{topic_anchor} {{ bookmark-level: 1; bookmark-label: "{_css_string(t["name"])}"; }}'
                        )
                    id_attr = f' id="{topic_anchor}"' if is_first_rendered_page else ""
                    label = escape_html(t["name"]).upper() + (f" \u2014 PART {idx + 1}/{len(topic_pages)}" if multi else "")
                    sections_html.append(f"""
                    <section class="topic-page-chunk"{id_attr}>
                      <div class="topic-header">
                        <span class="topic-dot" style="background:{t['color']}"></span>
                        <span class="topic-name">{label}</span>
                      </div>
                      <div class="card-columns">{''.join(cards)}</div>
                    </section>
                    """)
        else:
            # Fallback: no layout supplied for this topic -- let WeasyPrint
            # lay the whole topic out as one continuous flow, same as before.
            rows = by_topic[t["id"]]
            if not rows:
                continue
            topic_anchor = _next_anchor()
            index_entries.append((topic_anchor, t["name"], t["color"]))
            bookmark_css_rules.append(
                f'#{topic_anchor} {{ bookmark-level: 1; bookmark-label: "{_css_string(t["name"])}"; }}'
            )
            cards = [_card_html(s, t["color"], fit_code_font_size(s["code"], code_font, card_width_mm)) for s in rows]
            sections_html.append(f"""
            <section class="topic-page-chunk" id="{topic_anchor}">
              <div class="topic-header">
                <span class="topic-dot" style="background:{t['color']}"></span>
                <span class="topic-name">{escape_html(t['name']).upper()}</span>
              </div>
              <div class="card-columns">{''.join(cards)}</div>
            </section>
            """)

    # ---- Index / table of contents (P1.1) -- one page, right after the
    # boilerplate, listing topic -> page number via target-counter() so it
    # stays correct no matter how pagination shakes out. ----
    index_html = ""
    index_html = ""

    css = build_css(code_font, page_size, accent_color, institution_name, team_name, show_header)
    css += f"""
/* Template page has its own independent accent color (Settings > Template
   accent), separate from the book's main accent color. Scoped to .boilerplate
   (the template page's own section) specifically -- .boilerplate-header and
   .boilerplate-name are also reused by the Contents/index page, which must
   stay on the book's main accent_color, not this one. */
.boilerplate .boilerplate-header {{ border-bottom-color: {template_accent_color}; }}
.boilerplate-mark {{ background: {template_accent_color}; }}
.boilerplate .boilerplate-name {{ color: {template_accent_color}; }}
.boilerplate-window {{ border-left-color: {template_accent_color}; }}
"""
    css += SYNTAX_HIGHLIGHT_CSS
    css += "\n/* PDF outline bookmarks + index page-number targets (P1.1) */\n"
    css += "\n".join(bookmark_css_rules)
    css += """
.index-page { page-break-before: always; page-break-after: always; }
.index-row { display: flex; align-items: baseline; gap: 6px; text-decoration: none; color: inherit; padding: 5px 0; border-bottom: 1px dotted #D3D1C7; }
.index-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.index-name { font-size: 12px; }
.index-dots { flex: 1; }
.index-pagenum { font-size: 11px; color: #5F5E5A; font-variant-numeric: tabular-nums; }
.index-pagenum::after { content: target-counter(attr(href), page); }
"""

    html_str = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>{css}</style></head>
<body>{cover_html}{boilerplate_html}{index_html}{''.join(sections_html)}</body></html>"""

    OUTPUT_DIR.mkdir(exist_ok=True)
    pdf_path = OUTPUT_DIR / "codebook.pdf"
    HTML(string=html_str, base_url=str(Path(__file__).parent)).write_pdf(str(pdf_path), font_config=_FONT_CONFIG)
    return pdf_path
