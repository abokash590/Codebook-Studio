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
try:
    from weasyprint import HTML
    try:
        from weasyprint.text.fonts import FontConfiguration
    except ImportError:
        from weasyprint.fonts import FontConfiguration
    _FONT_CONFIG = FontConfiguration()
    HAS_WEASYPRINT = True
except Exception:
    HTML = None
    _FONT_CONFIG = None
    HAS_WEASYPRINT = False

try:
    from backend.db import get_db
except ImportError:
    from db import get_db

BASE_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = BASE_DIR / "output"
STATIC_DIR = BASE_DIR / "frontend" / "static"
FONTS_DIR = STATIC_DIR / "fonts"


def _find_chrome() -> str | None:
    """Return the path to a Chrome/Chromium executable, or None if not found."""
    # 0. Check explicit environment variable
    import os
    env_bin = os.environ.get("CHROME_BIN") or os.environ.get("CHROMIUM_PATH")
    if env_bin and Path(env_bin).exists():
        return env_bin

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


def build_pdf_from_html(html_content: str, output_path: Path | None = None) -> Path:
    """Render html_content to PDF using Chrome headless.

    Chrome uses the exact same Blink rendering engine as the live preview, so
    the PDF is guaranteed to be pixel-perfect identical to what the user sees.
    """
    OUTPUT_DIR.mkdir(exist_ok=True)
    pdf_path = output_path if output_path is not None else (OUTPUT_DIR / "codebook.pdf")

    # Primary Engine: WeasyPrint in-process Cairo vector renderer (~50MB RAM, fits easily in 512MB Render tier)
    if HAS_WEASYPRINT and HTML:
        try:
            HTML(string=html_content, base_url=str(BASE_DIR / "frontend")).write_pdf(str(pdf_path), font_config=_FONT_CONFIG)
            if pdf_path.exists() and pdf_path.stat().st_size > 1000:
                return pdf_path
        except Exception as weasy_err:
            print(f"WeasyPrint render warning: {weasy_err}, attempting Chrome headless...")

    chrome = _find_chrome()
    if not chrome:
        if pdf_path.exists():
            return pdf_path
        raise RuntimeError(
            "PDF engine not available. Please try again."
        )

    # Enforce multi-page printing rules so Chrome headless never clips pages to a single viewport height
    pagination_fix_css = """
    <style id="chrome-headless-pagination-fix">
      @page {
        size: 210mm 297mm;
        margin: 0;
      }
      @media print, all {
        html, body {
          background: white !important;
          margin: 0 !important;
          padding: 0 !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          overflow: visible !important;
          position: static !important;
        }
        .app, .preview-area, .preview-scroll {
          display: block !important;
          background: transparent !important;
          overflow: visible !important;
          height: auto !important;
          min-height: 0 !important;
          max-height: none !important;
          width: auto !important;
          padding: 0 !important;
          margin: 0 !important;
          position: static !important;
        }
        .a4-page {
          width: 210mm !important;
          min-height: 297mm !important;
          height: 297mm !important;
          margin: 0 !important;
          padding: 14mm !important;
          box-shadow: none !important;
          border-radius: 0 !important;
          page-break-after: always !important;
          break-after: page !important;
          overflow: hidden !important;
          position: relative !important;
        }
        .a4-page:last-child {
          page-break-after: avoid !important;
          break-after: avoid !important;
        }
        .craft-navbar, .sidebar, .thumbnails-rail, .sidebar-toggle-btn, .rail-toggle-btn, .modal-backdrop, .color-popover, .canvas-dock, .card-hover-launcher, .hover-launcher-left, .hover-launcher-right {
          display: none !important;
        }
      }
    </style>
    """
    if "</head>" in html_content:
        prepared_html = html_content.replace("</head>", f"{pagination_fix_css}\n</head>")
    else:
        prepared_html = f"{pagination_fix_css}\n{html_content}"

    with tempfile.TemporaryDirectory() as tmp_dir:
        html_path = Path(tmp_dir) / "preview.html"
        html_path.write_text(prepared_html, encoding="utf-8")

        try:
            result = subprocess.run(
                [
                    chrome,
                    "--headless=new",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--no-proxy-server",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-sync",
                    "--no-first-run",
                    "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process",
                    f"--print-to-pdf={pdf_path}",
                    "--no-pdf-header-footer",
                    "--print-to-pdf-no-header",
                    str(html_path),
                ],
                capture_output=True,
                text=True,
                timeout=90,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(
                "PDF generation timed out (90s limit)."
            )

    if not pdf_path.exists():
        err_msg = result.stderr[:2000] if 'result' in locals() and result.stderr else "Process terminated or Out of Memory"
        raise RuntimeError(
            f"Chrome failed to produce PDF (likely memory limit reached).\nDetails: {err_msg}"
        )

    return pdf_path

# ---- Fonts available for the code blocks (family name -> file basenames) ----
CODE_FONT_FILES = {
    "JetBrains Mono": ("JetBrainsMono-Regular.ttf", "JetBrainsMono-Bold.ttf"),
    "Fira Code": ("FiraCode-Regular.ttf", "FiraCode-Bold.ttf"),
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


def _cover_html(style: str, book_title: str, team_name: str, institution_name: str, accent_color: str = "currentColor") -> str:
    """Five deliberately distinct cover-page layouts, picked in Settings.
    Each returns its own markup (not just a CSS reskin of one template) so
    they read as genuinely different books, not the same page recolored."""
    style = style if style in COVER_STYLES else DEFAULT_COVER_STYLE
    title = escape_html(book_title)
    team = escape_html(team_name)
    inst = escape_html(institution_name)
    inst_html = f'<p class="cover-inst">{inst}</p>' if inst else ""
    team_html = f'<p class="cover-team">{team}</p>' if team else ""

    if style == "sketch":
        inst_block = f'<p class="cover-sketch-inst">{inst}</p>' if inst else ""
        team_block = f'<div class="cover-sketch-team-pill">{team}</div>' if team else ""
        return f"""
        <section class="cover cover-sketch-page" id="cover-page-anchor">
          <div class="cover-sketch-inner">
            <div class="cover-sketch-border"></div>
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
                <span>VOL. I</span>
                <span class="cover-sketch-eyebrow-sep">•</span>
                <span>ALGORITHMIC COMPENDIUM</span>
              </div>
              <h1 class="cover-sketch-title">{title}</h1>
              <div class="cover-sketch-rule-row">
                <span class="csk-line"></span>
                <span class="csk-diamond">◆</span>
                <span class="csk-line"></span>
              </div>
              <div class="cover-sketch-meta">
                {inst_block}
                {team_block}
              </div>
              <div class="cover-sketch-footer">COMPILED FOR ICPC CONTEST REFERENCE</div>
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
            {team_html}
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
            {team_html}
          </div>
        </section>
        """

    if style == "terminal":
        inst_block = f"""<div class="cover-term-row"><span class="cover-term-prompt">user@icpc:~$</span> <span class="cover-term-cmd">cat /etc/institution</span></div>
        <div class="cover-term-out cover-term-inst-out term-inst-out">{inst}</div>""" if inst else ""
        team_block = f"""<div class="cover-term-row"><span class="cover-term-prompt">user@icpc:~$</span> <span class="cover-term-cmd">whoami</span></div>
              <div class="cover-term-out cover-term-team-out term-team-out">{team}</div>""" if team else ""
        return f"""
        <section class="cover cover-terminal" id="cover-page-anchor">
          <div class="cover-term-window">
            <div class="cover-term-titlebar">
              <div class="cover-term-traffic">
                <span class="cover-term-btn cover-term-btn-red"></span>
                <span class="cover-term-btn cover-term-btn-yellow"></span>
                <span class="cover-term-btn cover-term-btn-green"></span>
              </div>
              <span class="cover-term-tab">bash — 80×24 — contest-codebook</span>
              <span class="cover-term-session">[UTF-8]</span>
            </div>
            <div class="cover-term-body">
              <div class="cover-term-row"><span class="cover-term-prompt">user@icpc:~$</span> <span class="cover-term-cmd">cat /etc/codebook/title</span></div>
              <div class="cover-term-out cover-term-title-highlight">{title}</div>
              {inst_block}
              {team_block}
              <div class="cover-term-row"><span class="cover-term-prompt">user@icpc:~$</span> <span class="cover-term-cmd">./verify_build.sh --strict</span></div>
              <div class="cover-term-out cover-term-success"><span>✔</span> 100% algorithms verified • 0 warnings • Ready for contest</div>
              <div class="cover-term-row"><span class="cover-term-prompt">user@icpc:~$</span> <span class="cover-term-cursor">█</span></div>
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
            {team_html}
          </div>
        </section>
        """

    # "minimal" (default / fallback)
    inst_block = f'<div class="cover-min-inst">{inst}</div>' if inst else ""
    team_block = f'<div class="cover-min-team">{team}</div>' if team else ""
    return f"""
    <section class="cover cover-minimal" id="cover-page-anchor">
      <div class="cover-min-inner">
        <div class="cover-min-header">
          <div class="cover-min-badge">
            <span class="cover-min-badge-dot"></span>
            <span>OFFICIAL REFERENCE MANUAL</span>
          </div>
          <span class="cover-min-serial">ICPC-STD // 2026</span>
        </div>
        <div class="cover-min-body">
          <h1 class="cover-min-title">{title}</h1>
          <div class="cover-min-rule-wrap">
            <div class="cover-min-rule"></div>
            <span class="cover-min-coord">BUILD SEC. 01</span>
          </div>
          <div class="cover-min-meta">
            {inst_block}
            {team_block}
          </div>
        </div>
        <div class="cover-min-footer">
          <span>COMPETITIVE PROGRAMMING REFERENCE</span>
          <span>VERIFIED COMPILATION</span>
        </div>
      </div>
    </section>
    """


def build_css(code_font, page_size, accent_color, institution_name, team_name, show_header, template_accent_color="#0071E3"):
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
.cover-sketch-title {{ font-family: 'Source Serif 4', Georgia, 'Times New Roman', serif; font-size: 36px; font-weight: 600; line-height: 1.15; color: #030302; margin: 0 0 7mm; letter-spacing: -0.03em; }}
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

/* ================= SNIPPET CARD THEMES (Craft, IDE Window, Academic) ================= */
.card-theme-craft.card {{
  border: 0.5px solid #CBD5E1;
  border-left: 3.5px solid;
  border-radius: 8px;
  background: #FFFFFF;
}}
.card-theme-craft .card-head {{
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;
}}
.card-theme-craft .card-title-row {{
  display: flex; align-items: center; gap: 4px;
}}
.card-theme-craft .card-title-dot {{
  display: inline-block; width: 5px; height: 5px; border-radius: 50%; margin-right: 4px; vertical-align: middle;
}}
.card-theme-craft .card-complexity {{
  font-size: 9.5px; font-weight: 600; color: #475569; background: #F1F5F9; border: 0.5px solid #CBD5E1; padding: 1px 6px; border-radius: 999px;
}}
.card-theme-craft .card-notes {{
  background: #F8FAFC; border-left: 2px solid #CBD5E1; padding: 3px 6px; border-radius: 0 4px 4px 0; margin-bottom: 5px; font-size: 10px;
}}

.card-theme-ide.card {{
  border: 0.5px solid #D4D4D8;
  border-left: 0.5px solid #D4D4D8 !important;
  border-radius: 8px;
  overflow: hidden;
  padding: 0 !important;
}}
.card-theme-ide .card-windowbar {{
  background: #F4F4F5; border-bottom: 0.5px solid #D4D4D8; padding: 2mm 2.5mm; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box;
}}
.card-theme-ide .card-window-controls {{
  display: inline-flex; align-items: center; gap: 3px; min-width: 35px; flex-shrink: 0;
}}
.card-theme-ide .card-window-dot {{
  display: inline-block; width: 4.5px; height: 4.5px; border-radius: 50%;
}}
.card-theme-ide .card-window-filetab {{
  font-family: '{resolved_family}', monospace; font-size: 9px; font-weight: 600; color: #18181B; background: #FFFFFF; border: 0.5px solid #D4D4D8; padding: 1px 6px; border-radius: 3px; text-align: center; margin: 0 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 55%;
}}
.card-theme-ide .card-complexity {{
  font-size: 8.5px; font-weight: 700; color: #FFFFFF; background: #18181B; padding: 1px 5px; border-radius: 3px; min-width: 35px; text-align: right; white-space: nowrap; flex-shrink: 0;
}}
.card-theme-ide .card-window-spacer {{
  display: inline-block; min-width: 35px; flex-shrink: 0;
}}
.card-theme-ide .card-inner-body {{
  padding: 2.5mm 3mm;
}}
.card-theme-ide .card-notes {{
  background: #FAFAFA; border-left: 2px solid #7C3AED; padding: 3px 6px; margin-bottom: 5px; font-size: 10px;
}}
.card-theme-ide .card-code {{
  background: #FAF9F6; border: 0.5px solid #E4E4E7;
}}

.card-theme-academic.card {{
  border: 1px solid #1C1917;
  border-left: 1px solid #1C1917 !important;
  border-radius: 3px;
  padding: 2.5mm 3mm;
}}
.card-theme-academic .card-academic-topbar {{
  display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px;
}}
.card-theme-academic .card-category-tag {{
  font-size: 8px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; color: #78716C;
}}
.card-theme-academic .card-complexity {{
  font-size: 9.5px; font-weight: 700; color: #1C1917;
}}
.card-theme-academic .card-title {{
  display: block; font-size: 12px; font-weight: 800; color: #0C0A09; padding-bottom: 2px; border-bottom: 0.5px solid #E7E5E4; margin-bottom: 3px;
}}
.card-theme-academic .card-notes {{
  font-size: 9.5px; line-height: 1.35; color: #44403C; margin-bottom: 4px;
}}
.card-theme-academic .card-code {{
  background: #F5F5F4; border: 0.5px solid #D6D3D1; border-radius: 2px; font-size: 9.5px; line-height: 1.36;
}}

/* Note Cards Styling across all 3 themes */
.card-theme-craft .card-note .card-note-body,
.card-theme-craft.card-note .card-note-body {{
  background: #F8FAFC; border: 0.5px solid #E2E8F0; border-radius: 6px; padding: 5px 8px; font-size: 10px; line-height: 1.48; color: #334155; margin-top: 4px;
}}
.card-theme-ide .card-note.card,
.card-theme-ide.card-note {{
  padding: 0 !important; border: 0.5px solid #D4D4D8; border-radius: 8px; overflow: hidden;
}}
.card-theme-ide .card-note .card-note-body,
.card-theme-ide.card-note .card-note-body {{
  background: #FAF9F6; border: 0.5px solid #E4E4E7; border-radius: 5px; padding: 5px 7px; font-size: 9.5px; line-height: 1.45; color: #27272A; margin-top: 4px;
}}
.card-theme-academic .card-note.card,
.card-theme-academic.card-note {{
  border: 1px solid #1C1917; border-radius: 3px; padding: 2.5mm 3mm;
}}
.card-theme-academic .card-note .card-note-body,
.card-theme-academic.card-note .card-note-body {{
  background: #F5F5F4; border: 0.5px solid #D6D3D1; border-radius: 2px; padding: 4px 7px; font-size: 9px; line-height: 1.38; color: #1C1917; margin-top: 3px;
}}

.card-theme-ide .card-title {{
  font-size: 12.5px; font-weight: 700; color: #18181B; margin-bottom: 3px; display: block;
}}
.card-theme-craft .card-title {{
  font-size: 13px; font-weight: 700; color: #0F172A;
}}

/* Template Cards across all 3 themes */
.boilerplate-page {{ page-break-before: always; }}
.card-theme-craft.card-template, .card-theme-craft .card-template {{
  border: 0.5px solid #CBD5E1; border-left: 3.5px solid {template_accent_color} !important; border-radius: 8px; background: #FFFFFF; overflow: hidden; padding: 0 !important;
}}
.card-theme-craft .template-card-header {{
  background: #F8FAFC; border-bottom: 0.5px solid #CBD5E1; padding: 2.5mm 3mm; display: flex; justify-content: space-between; align-items: center;
}}
.card-theme-craft .tmpl-pill {{ font-size: 11px; font-weight: 700; color: #0F172A; }}
.card-theme-craft .tmpl-tag {{ font-size: 9px; font-weight: 600; padding: 1px 5px; border-radius: 3px; background: #E0F2FE; color: #0284C7; }}
.card-theme-craft.card-template .card-code, .card-theme-craft .card-template .card-code {{
  background: #FFFFFF !important; border: none; border-radius: 0; padding: 3mm 4mm;
}}

.card-theme-ide.card-template, .card-theme-ide .card-template {{
  border: 0.5px solid #D4D4D8; border-radius: 8px; overflow: hidden; background: #FFFFFF; padding: 0 !important;
}}
.card-theme-ide .template-card-header {{
  background: #18181B; color: #FFFFFF; padding: 2.5mm 3mm; display: flex; justify-content: space-between; align-items: center;
}}
.card-theme-ide .tmpl-pill {{ font-family: '{resolved_family}', monospace; font-size: 10px; font-weight: 600; color: #FFFFFF; display: flex; align-items: center; gap: 4px; }}
.card-theme-ide .tmpl-tag {{ font-size: 8.5px; color: #A1A1AA; border: 0.5px solid rgba(255,255,255,0.3); padding: 1px 4px; border-radius: 2px; }}
.card-theme-ide.card-template .card-code, .card-theme-ide .card-template .card-code {{
  background: #FAF9F6 !important; border: none; border-radius: 0; padding: 3mm 4mm;
}}

.card-theme-academic.card-template, .card-theme-academic .card-template {{
  border: 1px solid #1C1917; border-radius: 3px; padding: 2.5mm 3mm !important; background: #FFFFFF;
}}
.card-theme-academic .template-card-header {{
  display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid #1C1917; padding-bottom: 2px; margin-bottom: 3mm;
}}
.card-theme-academic .tmpl-pill {{ font-size: 11px; font-weight: 800; letter-spacing: 0.3px; text-transform: uppercase; color: #1C1917; }}
.card-theme-academic .tmpl-tag {{ font-family: '{resolved_family}', monospace; font-size: 8.5px; color: #57534E; font-weight: 600; }}
.card-theme-academic.card-template .card-code, .card-theme-academic .card-template .card-code {{
  background: #F5F5F4 !important; border: 0.5px solid #D6D3D1; border-radius: 2px; padding: 2.5mm 3mm;
}}
"""


def escape_html(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# Computes a clean file slug for IDE card window bar:
# - If title length <= max_len (default 12), use the full sanitized slug.
# - If title length > max_len, construct an acronym from the first character of each word.
def get_snippet_file_slug(title: str, max_len: int = 12) -> str:
    clean = (title or "").strip()
    if not clean:
        return "snippet"
    full_slug = re.sub(r"[^a-z0-9]+", "_", clean.lower()).strip("_")
    if not full_slug:
        return "snippet"
    if len(full_slug) <= max_len:
        return full_slug
    split_words = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", clean)
    words = [re.sub(r"[^a-zA-Z0-9]", "", w) for w in re.split(r"[\s_\-]+", split_words)]
    words = [w for w in words if w]
    if len(words) > 1:
        acronym = "".join(w[0].lower() for w in words)
        if acronym:
            return acronym
    return full_slug[:10]


# Maps languages to canonical file extensions for IDE window tabs (e.g. python -> py, c++ -> cpp, kotlin -> kt)
def get_lang_ext(lang: str) -> str:
    l = (lang or "").lower().strip()
    ext_map = {
        "c++": "cpp",
        "cpp": "cpp",
        "c": "c",
        "python": "py",
        "py": "py",
        "java": "java",
        "kotlin": "kt",
        "kt": "kt",
        "rust": "rs",
        "rs": "rs",
        "go": "go",
        "golang": "go",
        "javascript": "js",
        "js": "js",
        "typescript": "ts",
        "ts": "ts",
        "text": "txt",
        "markdown": "md",
        "md": "md",
    }
    return ext_map.get(l, re.sub(r"[^a-z0-9]", "", l) or "cpp")


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


def _card_html(s, topic_color: str, font_size: float, card_style: str = "craft", topic_name: str = "") -> str:
    kind = s["kind"] if "kind" in s.keys() else "code"
    title_html = f'<span class="card-title">{escape_html(s["title"])}</span>'

    if kind == "note":
        note_body_html = f'<div class="card-note-body">{markdown_lite_html(s["notes"])}</div>'
        if card_style == "ide":
            title_str = s["title"] if "title" in s.keys() else "note"
            slug = get_snippet_file_slug(title_str, 12)
            return f"""
            <div class="card card-note card-theme-ide">
              <div class="card-windowbar">
                <span class="card-window-controls">
                  <span class="card-window-dot" style="background:#EF4444"></span>
                  <span class="card-window-dot" style="background:#F59E0B"></span>
                  <span class="card-window-dot" style="background:#10B981"></span>
                </span>
                <span class="card-window-filetab">{slug}.md</span>
                <span class="card-complexity">NOTE</span>
              </div>
              <div class="card-inner-body">
                <div class="card-title">{escape_html(s['title'])}</div>
                {note_body_html}
              </div>
            </div>
            """
        elif card_style == "academic":
            return f"""
            <div class="card card-note card-theme-academic">
              <div class="card-academic-topbar">
                <span class="card-category-tag">{escape_html(topic_name).upper()} // NOTE</span>
                <span class="card-complexity">OBSERVATION</span>
              </div>
              <div class="card-title">{escape_html(s['title'])}</div>
              {note_body_html}
            </div>
            """
        else: # craft
            dot_html = f'<span class="card-title-dot" style="background:{topic_color}"></span>'
            note_badge = '<span class="card-complexity">⏱ NOTE</span>'
            return f"""
            <div class="card card-note card-theme-craft" style="border-left-color:{topic_color}">
              <div class="card-head">
                <div class="card-title-row">
                  {dot_html}
                  <div class="card-title">{escape_html(s['title'])}</div>
                </div>
                {note_badge}
              </div>
              {note_body_html}
            </div>
            """

    if kind == "formula":
        return f"""
        <div class="card card-formula-card card-theme-{card_style}" style="border-left-color:{topic_color}">
          <div class="card-head"><div class="card-title">{escape_html(s['title'])}</div></div>
          {_formulas_html(s, standalone=True)}
        </div>
        """

    # kind == "code" (default, and fallback for any unrecognized value)
    notes_html = f'<p class="card-notes">{escape_html(s["notes"])}</p>' if s["notes"] else ""
    language = s["language"] if "language" in s.keys() else DEFAULT_LANGUAGE
    raw_comp = s["complexity"] if "complexity" in s.keys() else ""
    complexity = escape_html(raw_comp or "")

    if card_style == "ide":
        title_str = s["title"] if "title" in s.keys() else "snippet"
        slug = get_snippet_file_slug(title_str, 12)
        ext = get_lang_ext(language)
        comp_pill = f'<span class="card-complexity">{complexity}</span>' if complexity else '<span class="card-window-spacer"></span>'
        return f"""
        <div class="card card-theme-ide">
          <div class="card-windowbar">
            <span class="card-window-controls">
              <span class="card-window-dot" style="background:#EF4444"></span>
              <span class="card-window-dot" style="background:#F59E0B"></span>
              <span class="card-window-dot" style="background:#10B981"></span>
            </span>
            <span class="card-window-filetab">{slug}.{ext}</span>
            {comp_pill}
          </div>
          <div class="card-inner-body">
            <div class="card-title">{escape_html(s['title'])}</div>
            {notes_html}
            {_formulas_html(s)}
            <pre class="card-code" style="font-size:{font_size}px">{highlight_code_html(s['code'], language)}</pre>
          </div>
        </div>
        """

    if card_style == "academic":
        comp_span = f'<span class="card-complexity">{complexity}</span>' if complexity else ''
        return f"""
        <div class="card card-theme-academic">
          <div class="card-academic-topbar">
            <span class="card-category-tag">{escape_html(topic_name).upper()}</span>
            {comp_span}
          </div>
          <div class="card-title">{escape_html(s['title'])}</div>
          {notes_html}
          {_formulas_html(s)}
          <pre class="card-code" style="font-size:{font_size}px">{highlight_code_html(s['code'], language)}</pre>
        </div>
        """

    # card_style == "craft" (default)
    dot_html = f'<span class="card-title-dot" style="background:{topic_color}"></span>'
    comp_html = f'<span class="card-complexity">⏱ {complexity}</span>' if complexity else ''
    return f"""
    <div class="card card-theme-craft" style="border-left-color:{topic_color}">
      <div class="card-head">
        <div class="card-title-row">
          {dot_html}
          <div class="card-title">{escape_html(s['title'])}</div>
        </div>
        {comp_html}
      </div>
      {notes_html}
      {_formulas_html(s)}
      <pre class="card-code" style="font-size:{font_size}px">{highlight_code_html(s['code'], language)}</pre>
    </div>
    """


def _template_card_html(label: str, chunk_text: str, font_size: float, card_style: str = "craft", template_accent: str = "#0071E3") -> str:
    if card_style == "ide":
        return f"""
        <div class="card card-template card-theme-ide">
          <div class="card-windowbar template-card-header">
            <span class="card-window-controls">
              <span class="card-window-dot" style="background:#EF4444"></span>
              <span class="card-window-dot" style="background:#F59E0B"></span>
              <span class="card-window-dot" style="background:#10B981"></span>
            </span>
            <span class="card-window-filetab">template.cpp &bull; {escape_html(label)}</span>
            <span class="tmpl-tag">SETUP BUFFER</span>
          </div>
          <pre class="card-code" style="font-size:{font_size}px">{highlight_code_html(chunk_text, DEFAULT_LANGUAGE)}</pre>
        </div>
        """
    elif card_style == "academic":
        return f"""
        <div class="card card-template card-theme-academic">
          <div class="template-card-header">
            <span class="tmpl-pill">CONTEST SETUP SPECIFICATION &mdash; {escape_html(label).upper()}</span>
            <span class="tmpl-tag">// BOILERPLATE SETUP</span>
          </div>
          <pre class="card-code" style="font-size:{font_size}px">{highlight_code_html(chunk_text, DEFAULT_LANGUAGE)}</pre>
        </div>
        """
    else:  # craft
        return f"""
        <div class="card card-template card-theme-craft" style="border-left-color:{template_accent}">
          <div class="template-card-header">
            <div class="tmpl-pill">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="{template_accent}" stroke-width="2.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
              <span>{escape_html(label)}</span>
            </div>
            <span class="tmpl-tag" style="background:{template_accent}; color:#FFFFFF;">C++ SETUP</span>
          </div>
          <pre class="card-code" style="font-size:{font_size}px">{highlight_code_html(chunk_text, DEFAULT_LANGUAGE)}</pre>
        </div>
        """


def build_codebook_pdf(exclude_unverified: bool = False, layout: dict | None = None, user_id: str = "guest", output_path: Path | None = None) -> Path:
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
    OUTPUT_DIR.mkdir(exist_ok=True)
    pdf_path = output_path if output_path is not None else (OUTPUT_DIR / "codebook.pdf")
    conn = get_db()
    topics = conn.execute("SELECT * FROM topics WHERE user_id=? AND deleted_at IS NULL ORDER BY sort_order", (user_id,)).fetchall()
    settings = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings WHERE user_id=?", (user_id,))}
    team_name = settings.get("team_name") or ""
    institution_name = settings.get("institution_name") or ""
    book_title = settings.get("book_title") or "Contest Codebook"
    code_font = settings.get("code_font", DEFAULT_CODE_FONT)
    page_size = settings.get("page_size", DEFAULT_PAGE_SIZE)
    accent_color = settings.get("accent_color", "#2C2C2A")
    boilerplate_code = settings.get("boilerplate_code", "")
    cover_style = settings.get("cover_style", DEFAULT_COVER_STYLE)
    card_style = settings.get("card_style") or "craft"
    template_accent_color = settings.get("template_accent_color", accent_color)
    _show_header_val = settings.get("show_team_footer", "1")
    show_header = _show_header_val not in (0, "0", False, None, "")
    _show_boilerplate_val = settings.get("show_boilerplate", "1")
    show_boilerplate = _show_boilerplate_val not in (0, "0", False, None, "") and bool(boilerplate_code.strip())

    all_snippets = conn.execute("SELECT * FROM snippets WHERE user_id=? AND deleted_at IS NULL", (user_id,)).fetchall()
    snippet_by_id = {s["id"]: s for s in all_snippets}

    by_topic = {}
    for t in topics:
        query = "SELECT * FROM snippets WHERE user_id=? AND topic_id=? AND deleted_at IS NULL ORDER BY sort_order"
        by_topic[t["id"]] = conn.execute(query, (user_id, t["id"])).fetchall()
    conn.close()

    card_width_mm = _card_inner_width_mm(page_size)
    boilerplate_width_mm = _boilerplate_inner_width_mm(page_size)

    # Cover: five selectable styles, see _cover_html() and COVER_STYLES.
    cover_html = _cover_html(cover_style, book_title, team_name, institution_name, accent_color=accent_color)

    # Boilerplate page(s): a pinned starter template that always sits right
    # after the cover. Split into the same chunks the preview computed, if
    # given, so a long boilerplate paginates identically in both places.
    boilerplate_html = ""
    if show_boilerplate:
        boilerplate_pages = (layout or {}).get("boilerplate_pages") or None
        chunks = boilerplate_pages if boilerplate_pages else [boilerplate_code]
        multi = len(chunks) > 1
        template_title = (settings.get("template_title") or "Template").strip()
        parts = []
        for idx, chunk_text in enumerate(chunks):
            font_size = fit_code_font_size(chunk_text, code_font, boilerplate_width_mm)
            label = template_title.upper() + (f" \u2014 PART {idx + 1}/{len(chunks)}" if multi else "")
            id_attr = ' id="template-page-anchor"' if idx == 0 else ""
            effective_tmpl_accent = accent_color if card_style == "craft" else template_accent_color
            tmpl_card = _template_card_html(label, chunk_text, font_size, card_style=card_style, template_accent=effective_tmpl_accent)
            parts.append(f"""
            <section class="boilerplate-page"{id_attr}>
              {tmpl_card}
            </section>
            """)
        boilerplate_html = "".join(parts)

    layout_topics = {}
    with open('debug_layout.log', 'a') as f: f.write(f'LAYOUT KEYS BEFORE: {layout}\n')

    sections_html = []
    index_entries = []       # [(anchor_id, topic_name, topic_color)] -- one row per topic that made it into the book
    bookmark_css_rules = ['#cover-page-anchor { bookmark-level: 1; bookmark-label: "Cover"; }']
    if show_boilerplate:
        template_title = (settings.get("template_title") or "Template").strip()
        bookmark_css_rules.append(f'#template-page-anchor {{ bookmark-level: 1; bookmark-label: "{escape_html(template_title)}"; }}')
    anchor_counter = 0

    def _next_anchor():
        nonlocal anchor_counter
        anchor_counter += 1
        return f"topic-anchor-{anchor_counter}"

    card_style = settings.get("card_style") or "craft"

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
                effective_card_color = accent_color if card_style == "craft" else t["color"]
                if isinstance(page_data, dict) and "col1" in page_data:
                    def render_col(snippets):
                        col_cards = []
                        for s in snippets:
                            font_size = s.get("font_size") or fit_code_font_size(s.get("code", ""), code_font, card_width_mm)
                            col_cards.append(_card_html(s, effective_card_color, font_size, card_style=card_style, topic_name=t["name"]))
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
                        font_size = fit_code_font_size(s["code"], code_font, card_width_mm)
                        cards.append(_card_html(s, effective_card_color, font_size, card_style=card_style, topic_name=t["name"]))
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
            effective_card_color = accent_color if card_style == "craft" else t["color"]
            cards = [_card_html(s, effective_card_color, fit_code_font_size(s["code"], code_font, card_width_mm), card_style=card_style, topic_name=t["name"]) for s in rows]
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

    css = build_css(code_font, page_size, accent_color, institution_name, team_name, show_header, template_accent_color=template_accent_color)
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
    if HAS_WEASYPRINT and HTML:
        HTML(string=html_str, base_url=str(BASE_DIR / "frontend")).write_pdf(str(pdf_path), font_config=_FONT_CONFIG)
    else:
        build_pdf_from_html(html_str, output_path=pdf_path)
    return pdf_path
