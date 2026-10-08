import difflib
import json
import time
from pathlib import Path

from flask import Flask, render_template, request, jsonify, send_file
from db import get_db, init_db, purge_expired_trash
from pdf_builder import build_codebook_pdf, build_pdf_from_html
from formula_render import render_formula

app = Flask(__name__)
init_db()


def row_to_dict(row):
    return {k: row[k] for k in row.keys()}


def snippet_row_to_dict(row):
    d = row_to_dict(row)
    try:
        d["formulas"] = json.loads(d.get("formulas") or "[]")
    except (TypeError, ValueError):
        d["formulas"] = []
    return d


STANDALONE_FORMULA_FONTSIZE = 19  # bigger than the default -- these ARE the card's content, not an aside


def build_formulas_json(raw_formulas, kind="code"):
    """Takes the list of LaTeX strings the editor sent, renders each one to
    a typeset image server-side, and returns the JSON string to store in the
    DB. A formula that fails to parse is kept (so the user's text isn't
    lost) with img=None -- the UI/PDF fall back to showing the raw text."""
    fontsize = STANDALONE_FORMULA_FONTSIZE if kind == "formula" else None
    out = []
    for latex in (raw_formulas or []):
        latex = (latex or "").strip()
        if not latex:
            continue
        ok, img, error = render_formula(latex, **({"fontsize": fontsize} if fontsize else {}))
        out.append({"latex": latex, "img": img, "error": None if ok else error})
    return json.dumps(out)


# ---------- Page ----------

@app.route("/")
def index():
    return render_template("index.html")


# ---------- State (everything the preview needs, in one call) ----------

@app.route("/api/state")
def api_state():
    conn = get_db()
    topics = [row_to_dict(r) for r in conn.execute(
        "SELECT * FROM topics WHERE deleted_at IS NULL ORDER BY sort_order"
    )]
    for t in topics:
        t["snippets"] = [
            snippet_row_to_dict(r) for r in conn.execute(
                "SELECT * FROM snippets WHERE topic_id=? AND deleted_at IS NULL ORDER BY sort_order", (t["id"],)
            )
        ]
    settings = {r["key"]: r["value"] for r in conn.execute("SELECT * FROM settings")}
    conn.close()
    return jsonify({"topics": topics, "settings": settings})


# ---------- Snippets ----------

@app.route("/api/snippet", methods=["POST"])
def api_snippet_create():
    d = request.json
    formulas_json = build_formulas_json(d.get("formulas"), d.get("kind", "code"))
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO snippets (title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code, notes, formulas, language, kind)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (d.get("title", "Untitled"), d.get("subtitle", ""), d.get("complexity", ""),
         d["topic_id"], int(d.get("sort_order") or 100), 1 if d.get("verified") else 0,
         d.get("tested_on", ""), d.get("code", ""), d.get("notes", ""), formulas_json,
         d.get("language", "cpp"), d.get("kind", "code")),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return jsonify({"ok": True, "id": new_id})


@app.route("/api/snippet/<int:snippet_id>", methods=["PUT"])
def api_snippet_update(snippet_id):
    d = request.json
    formulas_json = build_formulas_json(d.get("formulas"), d.get("kind", "code"))
    conn = get_db()
    conn.execute(
        """UPDATE snippets SET title=?, subtitle=?, complexity=?, topic_id=?,
           sort_order=?, verified=?, tested_on=?, code=?, notes=?, formulas=?, language=?, kind=? WHERE id=?""",
        (d.get("title", "Untitled"), d.get("subtitle", ""), d.get("complexity", ""),
         d["topic_id"], int(d.get("sort_order") or 100), 1 if d.get("verified") else 0,
         d.get("tested_on", ""), d.get("code", ""), d.get("notes", ""), formulas_json,
         d.get("language", "cpp"), d.get("kind", "code"), snippet_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/snippet/<int:snippet_id>", methods=["DELETE"])
def api_snippet_delete(snippet_id):
    # Soft delete (P1.5) -- moves to "Recently deleted" instead of vanishing,
    # so a misclick or accidental confirm isn't catastrophic. Purged after 30 days.
    conn = get_db()
    conn.execute("UPDATE snippets SET deleted_at=? WHERE id=?", (int(time.time()), snippet_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Reorder (drag-and-drop, P1.3) ----------

@app.route("/api/reorder", methods=["POST"])
def api_reorder():
    """Body: { kind: 'topics'|'snippets', order: [id, id, ...] }.
    Rewrites sort_order in steps of 10 to match the given order, in a single
    batched request rather than one PATCH per dragged item."""
    d = request.json or {}
    kind = d.get("kind")
    order = d.get("order") or []
    conn = get_db()
    if kind == "topics":
        for i, topic_id in enumerate(order):
            conn.execute("UPDATE topics SET sort_order=? WHERE id=?", ((i + 1) * 10, topic_id))
    elif kind == "snippets":
        for i, snippet_id in enumerate(order):
            conn.execute("UPDATE snippets SET sort_order=? WHERE id=?", ((i + 1) * 10, snippet_id))
    else:
        conn.close()
        return jsonify({"ok": False, "error": "Unknown reorder kind"}), 400
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Duplicate detection (P1.6) ----------

def _normalize_code(code: str) -> str:
    """Strips whitespace/blank-line noise so near-identical pastes (different
    indentation, trailing spaces) still compare as similar."""
    lines = [ln.strip() for ln in (code or "").splitlines()]
    return "\n".join(ln for ln in lines if ln)


@app.route("/api/check_similar", methods=["POST"])
def api_check_similar():
    d = request.json or {}
    if d.get("kind", "code") != "code":
        # Similarity checking only makes sense for code -- a note or formula
        # card being "similar" to another isn't the same kind of mistake a
        # pasted-twice code snippet is, so skip rather than produce noise.
        return jsonify({"matches": []})
    code = d.get("code", "")
    topic_id = d.get("topic_id")
    exclude_id = d.get("exclude_id")
    normalized = _normalize_code(code)
    if not normalized or not topic_id:
        return jsonify({"matches": []})

    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, code FROM snippets WHERE topic_id=? AND deleted_at IS NULL AND kind='code'", (topic_id,)
    ).fetchall()
    conn.close()

    matches = []
    for r in rows:
        if exclude_id and str(r["id"]) == str(exclude_id):
            continue
        other = _normalize_code(r["code"])
        if not other:
            continue
        ratio = difflib.SequenceMatcher(None, normalized, other).ratio()
        if ratio >= 0.82:
            matches.append({"id": r["id"], "title": r["title"], "ratio": round(ratio, 2)})
    matches.sort(key=lambda m: -m["ratio"])
    return jsonify({"matches": matches[:3]})


# ---------- Formula preview (live, while typing -- not saved) ----------

@app.route("/api/render_formula", methods=["POST"])
def api_render_formula():
    d = request.json or {}
    kwargs = {"fontsize": STANDALONE_FORMULA_FONTSIZE} if d.get("kind") == "formula" else {}
    ok, img, error = render_formula(d.get("latex", ""), **kwargs)
    return jsonify({"ok": ok, "img": img, "error": error})


# ---------- Topics ----------

@app.route("/api/topic", methods=["POST"])
def api_topic_create():
    d = request.json
    topic_id = d["name"].strip().lower().replace(" ", "-")
    conn = get_db()
    existing = conn.execute("SELECT id FROM topics WHERE id=?", (topic_id,)).fetchone()
    if existing:
        conn.close()
        return jsonify({"ok": False, "error": "A topic with this name already exists."}), 400
    max_order = conn.execute("SELECT COALESCE(MAX(sort_order),0) m FROM topics").fetchone()["m"]
    conn.execute(
        "INSERT INTO topics (id, name, color, sort_order) VALUES (?,?,?,?)",
        (topic_id, d["name"].strip(), d.get("color", "#378ADD"), max_order + 10),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "id": topic_id})


@app.route("/api/topic/<topic_id>", methods=["PUT"])
def api_topic_update(topic_id):
    d = request.json
    conn = get_db()
    conn.execute(
        "UPDATE topics SET name=?, color=?, sort_order=? WHERE id=?",
        (d["name"].strip(), d.get("color", "#378ADD"), int(d.get("sort_order") or 100), topic_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/topic/<topic_id>", methods=["DELETE"])
def api_topic_delete(topic_id):
    conn = get_db()
    count = conn.execute(
        "SELECT COUNT(*) c FROM snippets WHERE topic_id=? AND deleted_at IS NULL", (topic_id,)
    ).fetchone()["c"]
    if count > 0:
        conn.close()
        return jsonify({"ok": False, "error": f"{count} template(s) still use this topic."}), 400
    conn.execute("UPDATE topics SET deleted_at=? WHERE id=?", (int(time.time()), topic_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Recently deleted / trash (P1.5) ----------

@app.route("/api/trash")
def api_trash():
    conn = get_db()
    purge_expired_trash(conn)
    conn.commit()
    topics = [row_to_dict(r) for r in conn.execute(
        "SELECT * FROM topics WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    )]
    snippets = [snippet_row_to_dict(r) for r in conn.execute(
        "SELECT * FROM snippets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC"
    )]
    conn.close()
    now = int(time.time())
    for row in topics + snippets:
        days_left = 30 - (now - row["deleted_at"]) // 86400
        row["days_left"] = max(0, days_left)
    return jsonify({"topics": topics, "snippets": snippets})


@app.route("/api/trash/restore/topic/<topic_id>", methods=["POST"])
def api_trash_restore_topic(topic_id):
    conn = get_db()
    conn.execute("UPDATE topics SET deleted_at=NULL WHERE id=?", (topic_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/trash/restore/snippet/<int:snippet_id>", methods=["POST"])
def api_trash_restore_snippet(snippet_id):
    conn = get_db()
    # If the snippet's topic was also deleted, restore the topic too --
    # otherwise the snippet reappears orphaned from an invisible topic.
    row = conn.execute("SELECT topic_id FROM snippets WHERE id=?", (snippet_id,)).fetchone()
    if row:
        conn.execute("UPDATE topics SET deleted_at=NULL WHERE id=?", (row["topic_id"],))
    conn.execute("UPDATE snippets SET deleted_at=NULL WHERE id=?", (snippet_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/trash/purge/topic/<topic_id>", methods=["DELETE"])
def api_trash_purge_topic(topic_id):
    conn = get_db()
    conn.execute("DELETE FROM topics WHERE id=? AND deleted_at IS NOT NULL", (topic_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/trash/purge/snippet/<int:snippet_id>", methods=["DELETE"])
def api_trash_purge_snippet(snippet_id):
    conn = get_db()
    conn.execute("DELETE FROM snippets WHERE id=? AND deleted_at IS NOT NULL", (snippet_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Settings ----------

@app.route("/api/settings", methods=["POST"])
def api_settings_update():
    d = request.json
    conn = get_db()
    for key in ("team_name", "book_title", "code_font", "code_theme", "page_size", "accent_color",
                "show_team_footer", "institution_name", "boilerplate_code", "show_boilerplate",
                "cover_style", "template_accent_color"):
        if key in d:
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, d[key]),
            )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Build / download ----------

@app.route("/api/build", methods=["POST"])
def api_build():
    body = request.json or {}
    exclude_unverified = bool(body.get("exclude_unverified"))

    try:
        # Primary path: JS sent the fully-rendered HTML (Chrome headless path).
        # This guarantees the PDF is pixel-perfect identical to the live preview
        # because Chrome renders it with the exact same Blink engine.
        html_content = body.get("html")
        if html_content:
            path = build_pdf_from_html(html_content)
        else:
            # Fallback: WeasyPrint path (used if Chrome not available or old payload)
            layout = body.get("layout")
            path = build_codebook_pdf(exclude_unverified=exclude_unverified, layout=layout)

        from pypdf import PdfReader
        page_count = len(PdfReader(str(path)).pages)
        return jsonify({
            "ok": True,
            "page_count": page_count,
            "over_limit": page_count > 25,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/download")
def download():
    pdf_path = Path(__file__).parent / "output" / "codebook.pdf"
    if not pdf_path.exists():
        return (
            "No PDF has been built yet in this session. Click \"Build PDF\" first, "
            "wait for it to finish, then click \"Download PDF\".",
            404,
        )
    return send_file(str(pdf_path), as_attachment=True, download_name="codebook.pdf")


if __name__ == "__main__":
    import os
    import threading
    import webbrowser

    PORT = 5050

    def _open_browser():
        webbrowser.open(f"http://127.0.0.1:{PORT}")

    # Flask's debug reloader spawns a child process; only the actual serving
    # process has WERKZEUG_RUN_MAIN set, so this guard stops a second tab
    # from popping open.
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Timer(1.0, _open_browser).start()

    app.run(debug=True, port=PORT)
