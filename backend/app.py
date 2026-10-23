import difflib
import json
import os
import re
import threading
import time
from functools import wraps
from pathlib import Path

import urllib.parse
import urllib.request
from flask import Flask, render_template, request, jsonify, send_file, send_from_directory, session, redirect

try:
    from backend.db import get_db, init_db, purge_expired_trash
    from backend.pdf_builder import build_codebook_pdf, build_pdf_from_html
    from backend.formula_render import render_formula
    from backend.auth import (
        create_user,
        authenticate_user,
        get_user_by_id,
        init_user_starter_pack,
        migrate_guest_data_to_user,
        get_or_create_oauth_user,
    )
except ImportError:
    from db import get_db, init_db, purge_expired_trash
    from pdf_builder import build_codebook_pdf, build_pdf_from_html
    from formula_render import render_formula
    from auth import (
        create_user,
        authenticate_user,
        get_user_by_id,
        init_user_starter_pack,
        migrate_guest_data_to_user,
        get_or_create_oauth_user,
    )

BASE_DIR = Path(__file__).resolve().parent.parent
try:
    from dotenv import load_dotenv
    load_dotenv(BASE_DIR / ".env")
except ImportError:
    pass
BACKEND_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"
OUTPUT_DIR = BASE_DIR / "output"
OUTPUT_DIR.mkdir(exist_ok=True)

app = Flask(
    __name__,
    template_folder=str(FRONTEND_DIR / "templates"),
    static_folder=str(FRONTEND_DIR / "static"),
    static_url_path="/static",
)
from werkzeug.middleware.proxy_fix import ProxyFix
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

app.secret_key = os.environ.get("SECRET_KEY", "codebook-studio-secret-987123456")
init_db()


def get_active_user_id() -> str:
    """Return currently authenticated user ID, or 'guest' for unauthenticated users."""
    return session.get("user_id") or "guest"


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


# ---------- Health Check (Keep-Alive for Render / Monitoring) ----------

@app.route("/api/health")
def api_health():
    return jsonify({"status": "ok", "timestamp": int(time.time())})


# ---------- Page & Assets ----------

@app.route("/")
@app.route("/login")
@app.route("/signin")
def index():
    return render_template("index.html")


@app.route("/mockups")
def mockups():
    return render_template("mockups.html")


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(str(FRONTEND_DIR / "static"), "favicon.ico", mimetype="image/vnd.microsoft.icon")


# ---------- Institutions (BCS 169 Universities + Custom Approved) ----------

@app.route("/api/institutions")
def api_institutions():
    conn = get_db()
    rows = conn.execute("SELECT name FROM institutions WHERE status='approved' ORDER BY name ASC").fetchall()
    conn.close()
    return jsonify([r["name"] for r in rows])


@app.route("/api/institutions/short-names")
def api_institution_short_names():
    conn = get_db()
    rows = conn.execute("SELECT name, short_name FROM institutions WHERE status='approved' AND short_name != ''").fetchall()
    conn.close()
    return jsonify({r["name"]: r["short_name"] for r in rows})


# ---------- Authentication Routes ----------

@app.route("/api/auth/me")
def api_auth_me():
    uid = get_active_user_id()
    if uid == "guest":
        return jsonify({"is_logged_in": False, "user": None})
    conn = get_db()
    user = get_user_by_id(conn, uid)
    conn.close()
    if not user:
        session.pop("user_id", None)
        return jsonify({"is_logged_in": False, "user": None})
    return jsonify({"is_logged_in": True, "user": user})


@app.route("/api/auth/register", methods=["POST"])
def api_auth_register():
    d = request.json or {}
    email = d.get("email", "")
    password = d.get("password", "")
    name = d.get("name", "")
    conn = get_db()
    try:
        user = create_user(conn, email, password, name)
        # Migrate in-progress guest work to the new user account if available,
        # otherwise seed standard starter pack
        migrate_guest_data_to_user(conn, "guest", user["id"])
        session["user_id"] = user["id"]
        conn.close()
        return jsonify({"ok": True, "user": user})
    except ValueError as e:
        conn.close()
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        conn.close()
        return jsonify({"ok": False, "error": "Registration failed. Please try again."}), 500


@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    d = request.json or {}
    email = d.get("email", "")
    password = d.get("password", "")
    conn = get_db()
    user = authenticate_user(conn, email, password)
    conn.close()
    if not user:
        return jsonify({"ok": False, "error": "Invalid email or password."}), 401

    session["user_id"] = user["id"]
    return jsonify({"ok": True, "user": user})


@app.route("/api/auth/logout", methods=["POST"])
def api_auth_logout():
    session.pop("user_id", None)
    return jsonify({"ok": True})


# ---------- OAuth (Google & GitHub) Authentication ----------

def _github_credentials():
    cid = os.environ.get("GITHUB_CLIENT_ID", "").strip()
    sec = os.environ.get("GITHUB_CLIENT_SECRET", "").strip()
    if not (cid and sec):
        try:
            from dotenv import load_dotenv
            load_dotenv(BASE_DIR / ".env", override=True)
            cid = os.environ.get("GITHUB_CLIENT_ID", "").strip()
            sec = os.environ.get("GITHUB_CLIENT_SECRET", "").strip()
        except Exception:
            pass
    return cid, sec


def _google_credentials():
    cid = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    sec = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
    if not (cid and sec):
        try:
            from dotenv import load_dotenv
            load_dotenv(BASE_DIR / ".env", override=True)
            cid = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
            sec = os.environ.get("GOOGLE_CLIENT_SECRET", "").strip()
        except Exception:
            pass
    return cid, sec


@app.route("/api/auth/providers")
def api_auth_providers():
    gh_id, _ = _github_credentials()
    gg_id, _ = _google_credentials()
    return jsonify({
        "google": bool(gg_id),
        "github": bool(gh_id),
        "demo_mode": not (gg_id and gh_id)
    })


def _get_redirect_uri(endpoint: str) -> str:
    app_url = os.environ.get("APP_URL") or os.environ.get("RENDER_EXTERNAL_URL", "")
    app_url = app_url.strip().rstrip("/")
    if app_url:
        return f"{app_url}{endpoint}"
    host = request.host
    if "127.0.0.1" in host or "localhost" in host:
        port = host.split(":")[1] if ":" in host else "5050"
        return f"http://localhost:{port}{endpoint}"
    return request.host_url.rstrip("/") + endpoint


@app.route("/api/auth/github")
def api_auth_github_login():
    """Initiates GitHub OAuth flow or enters Dev Demo Mode if credentials not set."""
    gh_id, _ = _github_credentials()
    if not gh_id:
        # Development Demo Mode: Allows instant testing of social login without waiting for API keys
        conn = get_db()
        demo_user = get_or_create_oauth_user(
            conn,
            provider="github",
            provider_id="demo_github_101",
            email="developer@github.demo",
            name="GitHub Coder",
            avatar_url="https://github.githubassets.com/images/modules/logos_page/GitHub-Mark.png"
        )
        conn.close()
        session["user_id"] = demo_user["id"]
        return redirect("/?auth_success=1&provider=GitHub")

    redirect_uri = _get_redirect_uri("/api/auth/github/callback")
    github_url = (
        f"https://github.com/login/oauth/authorize?"
        f"client_id={gh_id}&redirect_uri={urllib.parse.quote(redirect_uri)}&scope=user:email"
    )
    return redirect(github_url)


@app.route("/api/auth/github/callback")
def api_auth_github_callback():
    code = request.args.get("code")
    if not code:
        return redirect("/?auth_error=github_cancelled")

    gh_id, gh_secret = _github_credentials()
    try:
        token_url = "https://github.com/login/oauth/access_token"
        token_payload = json.dumps({
            "client_id": gh_id,
            "client_secret": gh_secret,
            "code": code,
        }).encode("utf-8")
        token_req = urllib.request.Request(
            token_url,
            data=token_payload,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Codebook-Studio"
            }
        )
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            token_data = json.loads(resp.read().decode("utf-8"))

        access_token = token_data.get("access_token")
        if not access_token:
            return redirect("/?auth_error=github_token_failed")

        user_req = urllib.request.Request(
            "https://api.github.com/user",
            headers={
                "Authorization": f"Bearer {access_token}",
                "Accept": "application/json",
                "User-Agent": "Codebook-Studio"
            }
        )
        with urllib.request.urlopen(user_req, timeout=10) as resp:
            gh_user = json.loads(resp.read().decode("utf-8"))

        email = gh_user.get("email")
        if not email:
            email_req = urllib.request.Request(
                "https://api.github.com/user/emails",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Accept": "application/json",
                    "User-Agent": "Codebook-Studio"
                }
            )
            with urllib.request.urlopen(email_req, timeout=10) as resp:
                emails_list = json.loads(resp.read().decode("utf-8"))
                for em in emails_list:
                    if em.get("primary") and em.get("verified"):
                        email = em.get("email")
                        break
                if not email and emails_list:
                    email = emails_list[0].get("email")

        conn = get_db()
        user = get_or_create_oauth_user(
            conn,
            provider="github",
            provider_id=str(gh_user.get("id", "")),
            email=email or f"{gh_user.get('login')}@github.user",
            name=gh_user.get("name") or gh_user.get("login") or "GitHub User",
            avatar_url=gh_user.get("avatar_url", "")
        )
        conn.close()
        session["user_id"] = user["id"]
        return redirect("/?auth_success=1&provider=GitHub")
    except Exception as e:
        print("GitHub OAuth error:", e)
        return redirect("/?auth_error=github_failed")


@app.route("/api/auth/google")
def api_auth_google_login():
    """Initiates Google OAuth flow or enters Dev Demo Mode if credentials not set."""
    gg_id, _ = _google_credentials()
    if not gg_id:
        # Development Demo Mode: Allows instant testing of Google login without waiting for API keys
        conn = get_db()
        demo_user = get_or_create_oauth_user(
            conn,
            provider="google",
            provider_id="demo_google_202",
            email="coder@gmail.demo",
            name="Google Coder",
            avatar_url=""
        )
        conn.close()
        session["user_id"] = demo_user["id"]
        return redirect("/?auth_success=1&provider=Google")

    redirect_uri = _get_redirect_uri("/api/auth/google/callback")
    params = {
        "client_id": gg_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": "openid email profile",
        "prompt": "select_account"
    }
    google_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)
    return redirect(google_url)


@app.route("/api/auth/google/callback")
def api_auth_google_callback():
    code = request.args.get("code")
    if not code:
        return redirect("/?auth_error=google_cancelled")

    gg_id, gg_secret = _google_credentials()
    try:
        redirect_uri = _get_redirect_uri("/api/auth/google/callback")
        token_url = "https://oauth2.googleapis.com/token"
        data = urllib.parse.urlencode({
            "code": code,
            "client_id": gg_id,
            "client_secret": gg_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }).encode("utf-8")
        token_req = urllib.request.Request(token_url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(token_req, timeout=10) as resp:
            tokens = json.loads(resp.read().decode("utf-8"))

        access_token_val = tokens.get("access_token")

        userinfo_req = urllib.request.Request(
            "https://openidconnect.googleapis.com/v1/userinfo",
            headers={"Authorization": f"Bearer {access_token_val}"}
        )
        with urllib.request.urlopen(userinfo_req, timeout=10) as resp:
            userinfo = json.loads(resp.read().decode("utf-8"))

        conn = get_db()
        user = get_or_create_oauth_user(
            conn,
            provider="google",
            provider_id=str(userinfo.get("sub", "")),
            email=userinfo.get("email", ""),
            name=userinfo.get("name", "Google User"),
            avatar_url=userinfo.get("picture", "")
        )
        conn.close()
        session["user_id"] = user["id"]
        return redirect("/?auth_success=1&provider=Google")
    except Exception as e:
        print("Google OAuth error:", e)
        return redirect("/?auth_error=google_failed")



# ---------- State (everything the preview needs, in one call) ----------

@app.route("/api/state")
def api_state():
    uid = get_active_user_id()
    conn = get_db()
    user_info = get_user_by_id(conn, uid) if uid != "guest" else None

    # Check if this user has topics or is missing sample notes
    if uid != "guest":
        init_user_starter_pack(conn, uid)

    topics = [row_to_dict(r) for r in conn.execute(
        "SELECT * FROM topics WHERE user_id=? AND deleted_at IS NULL ORDER BY sort_order", (uid,)
    )]
    for t in topics:
        t["snippets"] = [
            snippet_row_to_dict(r) for r in conn.execute(
                "SELECT * FROM snippets WHERE user_id=? AND topic_id=? AND deleted_at IS NULL ORDER BY sort_order", (uid, t["id"])
            )
        ]
    settings = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM settings WHERE user_id=?", (uid,))}
    if not settings.get("boilerplate_code"):
        from backend.db import DEFAULT_BOILERPLATE_CODE
        settings["boilerplate_code"] = DEFAULT_BOILERPLATE_CODE
    conn.close()
    return jsonify({
        "topics": topics,
        "settings": settings,
        "auth": {
            "is_logged_in": bool(user_info),
            "authenticated": bool(user_info),
            "user": user_info
        }
    })


# ---------- Snippets ----------

@app.route("/api/snippet", methods=["POST"])
def api_snippet_create():
    uid = get_active_user_id()
    d = request.json or {}
    formulas_json = build_formulas_json(d.get("formulas"), d.get("kind", "code"))
    topic_id = d.get("topic_id") or "data-structures"
    conn = get_db()
    cur = conn.execute(
        """INSERT INTO snippets (user_id, title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code, notes, formulas, language, kind)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (uid, d.get("title", "Untitled"), d.get("subtitle", ""), d.get("complexity", ""),
         topic_id, int(d.get("sort_order") or 100), 1,
         "", d.get("code", ""), d.get("notes", ""), formulas_json,
         d.get("language", "cpp"), d.get("kind", "code")),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return jsonify({
        "ok": True,
        "id": new_id,
        "snippet": {
            "id": new_id,
            "title": d.get("title", "Untitled"),
            "subtitle": d.get("subtitle", ""),
            "complexity": d.get("complexity", ""),
            "topic_id": topic_id,
            "code": d.get("code", ""),
            "notes": d.get("notes", ""),
            "language": d.get("language", "cpp"),
            "kind": d.get("kind", "code"),
        }
    })


@app.route("/api/snippet/<int:snippet_id>", methods=["PUT"])
def api_snippet_update(snippet_id):
    uid = get_active_user_id()
    d = request.json or {}
    formulas_json = build_formulas_json(d.get("formulas"), d.get("kind", "code"))
    topic_id = d.get("topic_id") or "data-structures"
    conn = get_db()
    conn.execute(
        """UPDATE snippets SET title=?, subtitle=?, complexity=?, topic_id=?,
           sort_order=?, verified=?, tested_on=?, code=?, notes=?, formulas=?, language=?, kind=? WHERE id=? AND user_id=?""",
        (d.get("title", "Untitled"), d.get("subtitle", ""), d.get("complexity", ""),
         topic_id, int(d.get("sort_order") or 100), 1,
         "", d.get("code", ""), d.get("notes", ""), formulas_json,
         d.get("language", "cpp"), d.get("kind", "code"), snippet_id, uid),
    )
    conn.commit()
    conn.close()
    return jsonify({
        "ok": True,
        "snippet": {
            "id": snippet_id,
            "title": d.get("title", "Untitled"),
            "subtitle": d.get("subtitle", ""),
            "complexity": d.get("complexity", ""),
            "topic_id": topic_id,
            "code": d.get("code", ""),
            "notes": d.get("notes", ""),
            "language": d.get("language", "cpp"),
            "kind": d.get("kind", "code"),
        }
    })


@app.route("/api/snippet/<int:snippet_id>", methods=["DELETE"])
def api_snippet_delete(snippet_id):
    uid = get_active_user_id()
    conn = get_db()
    conn.execute("UPDATE snippets SET deleted_at=? WHERE id=? AND user_id=?", (int(time.time()), snippet_id, uid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Reorder (drag-and-drop, P1.3) ----------

@app.route("/api/reorder", methods=["POST"])
def api_reorder():
    uid = get_active_user_id()
    d = request.json or {}
    kind = d.get("kind")
    order = d.get("order") or []
    conn = get_db()
    if kind == "topics":
        for i, topic_id in enumerate(order):
            conn.execute("UPDATE topics SET sort_order=? WHERE id=? AND user_id=?", ((i + 1) * 10, topic_id, uid))
    elif kind == "snippets":
        for i, snippet_id in enumerate(order):
            conn.execute("UPDATE snippets SET sort_order=? WHERE id=? AND user_id=?", ((i + 1) * 10, snippet_id, uid))
    else:
        conn.close()
        return jsonify({"ok": False, "error": "Unknown reorder kind"}), 400
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Duplicate detection (P1.6) ----------

def _normalize_code(code: str) -> str:
    lines = [ln.strip() for ln in (code or "").splitlines()]
    return "\n".join(ln for ln in lines if ln)


@app.route("/api/check_similar", methods=["POST"])
def api_check_similar():
    d = request.json or {}
    if d.get("kind", "code") != "code":
        return jsonify({"matches": []})
    code = d.get("code", "")
    topic_id = d.get("topic_id")
    exclude_id = d.get("exclude_id")
    normalized = _normalize_code(code)
    if not normalized or not topic_id:
        return jsonify({"matches": []})

    uid = get_active_user_id()
    conn = get_db()
    rows = conn.execute(
        "SELECT id, title, code FROM snippets WHERE user_id=? AND topic_id=? AND deleted_at IS NULL AND kind='code'", (uid, topic_id)
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
    uid = get_active_user_id()
    d = request.json or {}
    raw_name = (d.get("name") or "New Topic").strip()
    if not raw_name:
        raw_name = "New Topic"

    raw_slug = re.sub(r'[^a-zA-Z0-9_\-]+', '', raw_name.lower().replace(" ", "-"))
    if not raw_slug:
        raw_slug = f"topic-{int(time.time())}"
    slug = f"{uid}_{raw_slug}" if uid != "guest" else raw_slug

    conn = get_db()
    base_slug = slug
    counter = 1
    while conn.execute("SELECT id FROM topics WHERE id=?", (slug,)).fetchone():
        slug = f"{base_slug}-{counter}"
        counter += 1
    topic_id = slug

    max_order = conn.execute("SELECT COALESCE(MAX(sort_order),0) m FROM topics WHERE user_id=?", (uid,)).fetchone()["m"]

    palette = ["#0071E3", "#34C759", "#AF52DE", "#FF9500", "#5856D6", "#FF2D55", "#1D9E75", "#378ADD"]
    default_color = palette[len(topic_id) % len(palette)]
    color = d.get("color") or default_color

    conn.execute(
        "INSERT INTO topics (id, user_id, name, color, sort_order) VALUES (?,?,?,?,?)",
        (topic_id, uid, raw_name, color, max_order + 10),
    )
    conn.commit()
    conn.close()
    return jsonify({
        "ok": True,
        "id": topic_id,
        "topic": {
            "id": topic_id,
            "name": raw_name,
            "color": color,
            "sort_order": max_order + 10,
            "snippets": []
        }
    })


@app.route("/api/topic/<topic_id>", methods=["PUT"])
def api_topic_update(topic_id):
    uid = get_active_user_id()
    d = request.json or {}
    conn = get_db()
    cur = conn.execute("SELECT * FROM topics WHERE id=? AND user_id=?", (topic_id, uid)).fetchone()
    if not cur:
        conn.close()
        return jsonify({"ok": False, "error": "Topic not found"}), 404

    new_name = d.get("name", cur["name"]).strip() if "name" in d else cur["name"]
    if not new_name:
        new_name = cur["name"]
    new_color = d.get("color", cur["color"])
    new_order = d.get("sort_order", cur["sort_order"])

    conn.execute(
        "UPDATE topics SET name=?, color=?, sort_order=? WHERE id=? AND user_id=?",
        (new_name, new_color, int(new_order), topic_id, uid),
    )
    conn.commit()
    conn.close()
    return jsonify({
        "ok": True,
        "topic": {
            "id": topic_id,
            "name": new_name,
            "color": new_color,
            "sort_order": int(new_order)
        }
    })


@app.route("/api/topic/<topic_id>", methods=["DELETE"])
def api_topic_delete(topic_id):
    uid = get_active_user_id()
    conn = get_db()
    now = int(time.time())
    # Soft delete topic and cascade soft-delete all snippets belonging to it
    conn.execute("UPDATE topics SET deleted_at=? WHERE id=? AND user_id=?", (now, topic_id, uid))
    conn.execute("UPDATE snippets SET deleted_at=? WHERE topic_id=? AND user_id=? AND deleted_at IS NULL", (now, topic_id, uid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Recently deleted / trash (P1.5) ----------

@app.route("/api/trash")
def api_trash():
    uid = get_active_user_id()
    conn = get_db()
    purge_expired_trash(conn)
    conn.commit()
    topics = [row_to_dict(r) for r in conn.execute(
        "SELECT * FROM topics WHERE user_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", (uid,)
    )]
    snippets = [snippet_row_to_dict(r) for r in conn.execute(
        "SELECT * FROM snippets WHERE user_id=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC", (uid,)
    )]
    conn.close()
    now = int(time.time())
    for row in topics + snippets:
        days_left = 30 - (now - row["deleted_at"]) // 86400
        row["days_left"] = max(0, days_left)
    return jsonify({"topics": topics, "snippets": snippets})


@app.route("/api/trash/restore/topic/<topic_id>", methods=["POST"])
def api_trash_restore_topic(topic_id):
    uid = get_active_user_id()
    conn = get_db()
    conn.execute("UPDATE topics SET deleted_at=NULL WHERE id=? AND user_id=?", (topic_id, uid))
    conn.execute("UPDATE snippets SET deleted_at=NULL WHERE topic_id=? AND user_id=?", (topic_id, uid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/trash/restore/snippet/<int:snippet_id>", methods=["POST"])
def api_trash_restore_snippet(snippet_id):
    uid = get_active_user_id()
    conn = get_db()
    row = conn.execute("SELECT topic_id FROM snippets WHERE id=? AND user_id=?", (snippet_id, uid)).fetchone()
    if row:
        conn.execute("UPDATE topics SET deleted_at=NULL WHERE id=? AND user_id=?", (row["topic_id"], uid))
    conn.execute("UPDATE snippets SET deleted_at=NULL WHERE id=? AND user_id=?", (snippet_id, uid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/trash/purge/topic/<topic_id>", methods=["DELETE"])
def api_trash_purge_topic(topic_id):
    uid = get_active_user_id()
    conn = get_db()
    conn.execute("DELETE FROM snippets WHERE topic_id=? AND user_id=?", (topic_id, uid))
    conn.execute("DELETE FROM topics WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", (topic_id, uid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/trash/purge/snippet/<int:snippet_id>", methods=["DELETE"])
def api_trash_purge_snippet(snippet_id):
    uid = get_active_user_id()
    conn = get_db()
    conn.execute("DELETE FROM snippets WHERE id=? AND user_id=? AND deleted_at IS NOT NULL", (snippet_id, uid))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Settings ----------

@app.route("/api/settings", methods=["POST"])
def api_settings_update():
    uid = get_active_user_id()
    d = request.json or {}
    conn = get_db()
    for key in ("team_name", "book_title", "code_font", "code_theme", "page_size", "accent_color",
                "show_team_footer", "institution_name", "boilerplate_code", "show_boilerplate",
                "cover_style", "card_style", "template_accent_color", "template_title", "snippets_after_template"):
        if key in d:
            conn.execute(
                "INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)",
                (uid, key, str(d[key])),
            )

    # Track university usage or register user-suggested custom institution
    if "institution_name" in d:
        inst_name = str(d["institution_name"]).strip()
        if inst_name and len(inst_name) >= 2:
            clean_inst = re.sub(r'\s*\([^)]*\)', '', inst_name).strip()
            existing = conn.execute(
                """SELECT id, name, status, use_count FROM institutions
                   WHERE LOWER(name) = LOWER(?)
                      OR LOWER(name) = LOWER(?)
                      OR (short_name != '' AND LOWER(short_name) = LOWER(?))""",
                (inst_name, clean_inst, inst_name)
            ).fetchone()
            now = int(time.time())
            if existing:
                conn.execute("UPDATE institutions SET last_used_at = ? WHERE id = ?", (now, existing["id"]))
            else:
                conn.execute(
                    """INSERT INTO institutions (name, short_name, status, use_count, suggested_by, created_at, last_used_at)
                       VALUES (?, '', 'pending', 0, ?, ?, ?)""",
                    (inst_name, uid, now, now),
                )

    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# ---------- Build / download ----------

def format_bytes(size: int) -> str:
    """Format bytes to human-readable string (KB, MB, GB)."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size < 1024.0:
            return f"{size:.1f} {unit}"
        size /= 1024.0
    return f"{size:.1f} TB"


def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        uid = get_active_user_id()
        if uid == "guest":
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Authentication required."}), 401
            return redirect("/?login=1&redirect=/admin")

        conn = get_db()
        user = get_user_by_id(conn, uid)
        conn.close()

        if not user or user.get("role") != "admin":
            if request.path.startswith("/api/"):
                return jsonify({"ok": False, "error": "Access forbidden: Admin privileges required."}), 403
            return render_template("403.html"), 403

        return f(*args, **kwargs)
    return decorated_function


# ---------- Build / download ----------

_pdf_build_lock = threading.Semaphore(1)

@app.route("/api/build", methods=["POST"])
def api_build():
    # Only allow 1 Chrome PDF build at a time to prevent OOM crash on 512MB RAM hosts
    if not _pdf_build_lock.acquire(blocking=False):
        return jsonify({
            "ok": False,
            "error": "Server is busy rendering another PDF. Please wait 10 seconds or use Instant Browser Print."
        }), 429

    try:
        body = request.json or {}
        t0 = time.time()
        uid = get_active_user_id()
        engine = "chrome" if body.get("html") else "weasyprint"
        user_name = "Guest Visitor"
        user_email = ""

        conn = get_db()
        if uid != "guest":
            u_row = conn.execute("SELECT name, email FROM users WHERE id = ?", (uid,)).fetchone()
            if u_row:
                user_name = u_row["name"]
                user_email = u_row["email"]

        # Fetch institution & team name from settings
        inst_row = conn.execute("SELECT value FROM settings WHERE user_id = ? AND key = 'institution_name'", (uid,)).fetchone()
        team_row = conn.execute("SELECT value FROM settings WHERE user_id = ? AND key = 'team_name'", (uid,)).fetchone()
        inst_name = (inst_row["value"].strip() if inst_row and inst_row["value"] else "")
        team_name = (team_row["value"].strip() if team_row and team_row["value"] else "")

        try:
            user_pdf_name = f"codebook_{uid}.pdf"
            user_pdf_path = OUTPUT_DIR / user_pdf_name

            html_content = body.get("html")
            if html_content:
                (OUTPUT_DIR / f"last_build_{uid}.html").write_text(html_content, encoding="utf-8")
                path = build_pdf_from_html(html_content, output_path=user_pdf_path)
            else:
                layout = body.get("layout")
                path = build_codebook_pdf(layout=layout, user_id=uid, output_path=user_pdf_path)

            session["last_build_file"] = user_pdf_name

            from pypdf import PdfReader
            page_count = len(PdfReader(str(path)).pages)
            duration_ms = int((time.time() - t0) * 1000)

            conn.execute(
                """INSERT INTO build_logs
                   (user_id, user_name, user_email, institution_name, team_name, engine, page_count, render_duration_ms, status, error_message, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', '', ?)""",
                (uid, user_name, user_email, inst_name, team_name, engine, page_count, duration_ms, int(time.time())),
            )
            if inst_name:
                clean_inst = re.sub(r'\s*\([^)]*\)', '', inst_name).strip()
                conn.execute(
                    """UPDATE institutions
                       SET use_count = use_count + 1, last_used_at = ?
                       WHERE LOWER(name) = LOWER(?)
                          OR LOWER(name) = LOWER(?)
                          OR (short_name != '' AND LOWER(short_name) = LOWER(?))""",
                    (int(time.time()), inst_name, clean_inst, inst_name)
                )
            conn.commit()
            conn.close()

            return jsonify({
                "ok": True,
                "page_count": page_count,
                "over_limit": page_count > 25,
                "duration_ms": duration_ms,
            })
        except Exception as e:
            duration_ms = int((time.time() - t0) * 1000)
            try:
                conn.execute(
                    """INSERT INTO build_logs
                       (user_id, user_name, user_email, institution_name, team_name, engine, page_count, render_duration_ms, status, error_message, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'failed', ?, ?)""",
                    (uid, user_name, user_email, inst_name, team_name, engine, duration_ms, str(e), int(time.time())),
                )
                conn.commit()
                conn.close()
            except Exception:
                pass
            return jsonify({"ok": False, "error": str(e)}), 500
    finally:
        _pdf_build_lock.release()


@app.route("/download")
def download():
    uid = get_active_user_id()
    user_pdf_path = OUTPUT_DIR / f"codebook_{uid}.pdf"
    fallback_pdf_path = OUTPUT_DIR / "codebook.pdf"

    pdf_path = user_pdf_path if user_pdf_path.exists() else fallback_pdf_path
    if not pdf_path.exists():
        return (
            "No PDF has been built yet in this session. Click \"Download PDF\" first, "
            "wait for it to finish, then download.",
            404,
        )

    # Determine personalized download filename
    download_name = "codebook.pdf"
    conn = get_db()
    team_row = conn.execute("SELECT value FROM settings WHERE user_id = ? AND key = 'team_name'", (uid,)).fetchone()
    conn.close()
    if team_row and team_row["value"].strip():
        safe_team = re.sub(r'[^a-zA-Z0-9_\-]+', '_', team_row["value"].strip())
        download_name = f"codebook_{safe_team}.pdf"

    return send_file(str(pdf_path), as_attachment=True, download_name=download_name)


# ---------- Admin Console Routes ----------

@app.route("/admin")
@admin_required
def admin_page():
    uid = get_active_user_id()
    conn = get_db()
    current_admin = get_user_by_id(conn, uid)
    conn.close()
    return render_template("admin.html", current_admin=current_admin)


@app.route("/api/admin/stats")
@admin_required
def api_admin_stats():
    conn = get_db()
    now = int(time.time())
    midnight = now - (now % 86400)

    total_users = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    new_users_today = conn.execute("SELECT COUNT(*) FROM users WHERE created_at >= ?", (midnight,)).fetchone()[0]

    providers_rows = conn.execute("SELECT provider, COUNT(*) as c FROM users GROUP BY provider").fetchall()
    providers = {r["provider"] or "local": r["c"] for r in providers_rows}

    total_snippets = conn.execute("SELECT COUNT(*) FROM snippets WHERE deleted_at IS NULL").fetchone()[0]
    total_notes = conn.execute("SELECT COUNT(*) FROM snippets WHERE kind='note' AND deleted_at IS NULL").fetchone()[0]
    total_codes = total_snippets - total_notes
    total_topics = conn.execute("SELECT COUNT(*) FROM topics WHERE deleted_at IS NULL").fetchone()[0]

    total_builds = conn.execute("SELECT COUNT(*) FROM build_logs").fetchone()[0]
    success_builds = conn.execute("SELECT COUNT(*) FROM build_logs WHERE status='success'").fetchone()[0]
    failed_builds = conn.execute("SELECT COUNT(*) FROM build_logs WHERE status='failed'").fetchone()[0]

    avg_duration_row = conn.execute("SELECT AVG(render_duration_ms) FROM build_logs WHERE status='success'").fetchone()[0]
    avg_duration_ms = round(avg_duration_row, 0) if avg_duration_row else 0

    admins_count = conn.execute("SELECT COUNT(*) FROM users WHERE role='admin'").fetchone()[0]

    db_file = BACKEND_DIR / "data" / "codebook.db"
    db_size = db_file.stat().st_size if db_file.exists() else 0

    output_size = 0
    if OUTPUT_DIR.exists():
        for f in OUTPUT_DIR.glob("*"):
            if f.is_file():
                output_size += f.stat().st_size

    # University & Team analytics
    total_unis_count = conn.execute("SELECT COUNT(*) FROM institutions").fetchone()[0]
    total_distinct_unis_used = conn.execute("SELECT COUNT(*) FROM institutions WHERE use_count > 0").fetchone()[0]
    pending_suggestions_count = conn.execute("SELECT COUNT(*) FROM institutions WHERE status = 'pending'").fetchone()[0]

    top_unis = [dict(r) for r in conn.execute("""
        SELECT id, name, short_name, use_count
        FROM institutions
        WHERE use_count > 0
        ORDER BY use_count DESC
        LIMIT 6
    """).fetchall()]

    # If no universities have use_count > 0 yet, grab sample top institutions for preview
    if not top_unis:
        top_unis = [dict(r) for r in conn.execute("""
            SELECT id, name, short_name, use_count
            FROM institutions
            ORDER BY id ASC
            LIMIT 5
        """).fetchall()]

    teams_count_row = conn.execute("""
        SELECT COUNT(DISTINCT team_name) FROM (
            SELECT team_name FROM build_logs WHERE team_name != ''
            UNION
            SELECT value as team_name FROM settings WHERE key = 'team_name' AND value != ''
        )
    """).fetchone()
    total_teams_count = teams_count_row[0] if teams_count_row else 0

    recent_teams = [dict(r) for r in conn.execute("""
        SELECT DISTINCT team_name, institution_name, created_at
        FROM build_logs
        WHERE team_name != ''
        ORDER BY created_at DESC
        LIMIT 6
    """).fetchall()]

    conn.close()

    return jsonify({
        "ok": True,
        "users": {
            "total": total_users,
            "new_today": new_users_today,
            "admins": admins_count,
            "providers": providers,
        },
        "content": {
            "total_snippets": total_snippets,
            "total_codes": total_codes,
            "total_notes": total_notes,
            "total_topics": total_topics,
        },
        "builds": {
            "total": total_builds,
            "success": success_builds,
            "failed": failed_builds,
            "success_rate": round((success_builds / total_builds * 100), 1) if total_builds > 0 else 100.0,
            "avg_duration_ms": int(avg_duration_ms),
        },
        "universities": {
            "total_institutions": total_unis_count,
            "total_used": total_distinct_unis_used,
            "pending_count": pending_suggestions_count,
            "top_universities": top_unis,
        },
        "teams": {
            "total_teams": total_teams_count,
            "recent_teams": recent_teams,
        },
        "storage": {
            "db_bytes": db_size,
            "db_formatted": format_bytes(db_size),
            "output_bytes": output_size,
            "output_formatted": format_bytes(output_size),
        },
    })


@app.route("/api/admin/users")
@admin_required
def api_admin_users():
    conn = get_db()
    users_rows = conn.execute("""
        SELECT u.id, u.email, u.name, u.avatar_color, u.avatar_url, u.provider, u.role, u.created_at,
               (SELECT COUNT(*) FROM snippets s WHERE s.user_id = u.id AND s.deleted_at IS NULL) as snippet_count,
               (SELECT COUNT(*) FROM topics t WHERE t.user_id = u.id AND t.deleted_at IS NULL) as topic_count,
               (SELECT value FROM settings st WHERE st.user_id = u.id AND st.key = 'institution_name') as institution_name,
               (SELECT value FROM settings st WHERE st.user_id = u.id AND st.key = 'team_name') as team_name
        FROM users u
        ORDER BY u.created_at DESC
    """).fetchall()

    users = [dict(r) for r in users_rows]
    conn.close()
    return jsonify({"ok": True, "users": users})


@app.route("/api/admin/users/<user_id>/toggle-role", methods=["POST"])
@admin_required
def api_admin_toggle_role(user_id):
    current_uid = get_active_user_id()
    if user_id == current_uid:
        return jsonify({"ok": False, "error": "You cannot alter your own admin privileges."}), 400

    conn = get_db()
    user = conn.execute("SELECT id, role, email FROM users WHERE id = ?", (user_id,)).fetchone()
    if not user:
        conn.close()
        return jsonify({"ok": False, "error": "User not found."}), 404

    new_role = "user" if user["role"] == "admin" else "admin"
    conn.execute("UPDATE users SET role = ? WHERE id = ?", (new_role, user_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "user_id": user_id, "new_role": new_role})


@app.route("/api/admin/users/<user_id>/delete", methods=["POST"])
@admin_required
def api_admin_delete_user(user_id):
    current_uid = get_active_user_id()
    if user_id == current_uid:
        return jsonify({"ok": False, "error": "You cannot delete your own account."}), 400

    conn = get_db()
    conn.execute("DELETE FROM snippets WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM topics WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM settings WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "user_id": user_id})


@app.route("/api/admin/build-logs")
@admin_required
def api_admin_build_logs():
    conn = get_db()
    logs = conn.execute("""
        SELECT id, user_id, user_name, user_email, institution_name, team_name, engine, page_count, render_duration_ms, status, error_message, created_at
        FROM build_logs
        ORDER BY created_at DESC
        LIMIT 60
    """).fetchall()
    conn.close()
    return jsonify({"ok": True, "logs": [dict(r) for r in logs]})


@app.route("/api/admin/starter-pack")
@admin_required
def api_admin_starter_pack():
    from backend.db import DEFAULT_TOPICS, DEFAULT_SNIPPETS
    topics = [{"id": t[0], "name": t[1], "color": t[2], "sort_order": t[3]} for t in DEFAULT_TOPICS]
    return jsonify({"ok": True, "topics": topics, "snippets": DEFAULT_SNIPPETS})


@app.route("/api/admin/institutions")
@admin_required
def api_admin_institutions():
    conn = get_db()
    rows = conn.execute("""
        SELECT id, name, short_name, status, use_count, suggested_by, created_at, last_used_at
        FROM institutions
        ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, use_count DESC, name ASC
    """).fetchall()

    # Match associated teams for each university
    team_rows = conn.execute("""
        SELECT DISTINCT institution_name, team_name FROM build_logs WHERE institution_name != '' AND team_name != ''
        UNION
        SELECT DISTINCT s1.value as institution_name, s2.value as team_name
        FROM settings s1
        JOIN settings s2 ON s1.user_id = s2.user_id AND s2.key = 'team_name'
        WHERE s1.key = 'institution_name' AND s1.value != '' AND s2.value != ''
    """).fetchall()

    teams_by_inst = {}
    for tr in team_rows:
        iname = (tr["institution_name"] or "").strip().lower()
        tname = (tr["team_name"] or "").strip()
        if iname and tname:
            teams_by_inst.setdefault(iname, set()).add(tname)

    institutions = []
    pending_count = 0
    approved_count = 0

    for idx, r in enumerate(rows):
        d = dict(r)
        d["index"] = idx + 1
        if d["status"] == "pending":
            pending_count += 1
        else:
            approved_count += 1
        d["teams"] = sorted(list(teams_by_inst.get(d["name"].strip().lower(), [])))
        institutions.append(d)

    conn.close()
    return jsonify({
        "ok": True,
        "count": len(institutions),
        "pending_count": pending_count,
        "approved_count": approved_count,
        "institutions": institutions,
    })


@app.route("/api/admin/institutions/add", methods=["POST"])
@admin_required
def api_admin_institution_add():
    d = request.json or {}
    name = (d.get("name") or "").strip()
    short_name = (d.get("short_name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Institution full name is required."}), 400

    conn = get_db()
    existing = conn.execute("SELECT id FROM institutions WHERE LOWER(name) = LOWER(?)", (name,)).fetchone()
    if existing:
        conn.close()
        return jsonify({"ok": False, "error": "An institution with this name already exists."}), 400

    now = int(time.time())
    cur = conn.execute(
        """INSERT INTO institutions (name, short_name, status, use_count, suggested_by, created_at, last_used_at)
           VALUES (?, ?, 'approved', 0, 'admin', ?, ?)""",
        (name, short_name, now, now),
    )
    new_id = cur.lastrowid
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "message": "Institution successfully added.", "id": new_id})


@app.route("/api/admin/institutions/<int:inst_id>/edit", methods=["POST"])
@admin_required
def api_admin_institution_edit(inst_id):
    d = request.json or {}
    name = (d.get("name") or "").strip()
    short_name = (d.get("short_name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "Institution name cannot be empty."}), 400

    conn = get_db()
    existing = conn.execute("SELECT id FROM institutions WHERE LOWER(name) = LOWER(?) AND id != ?", (name, inst_id)).fetchone()
    if existing:
        conn.close()
        return jsonify({"ok": False, "error": "Another institution with this name already exists."}), 400

    conn.execute("UPDATE institutions SET name = ?, short_name = ? WHERE id = ?", (name, short_name, inst_id))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "message": "Institution updated."})


@app.route("/api/admin/institutions/<int:inst_id>/approve", methods=["POST"])
@admin_required
def api_admin_institution_approve(inst_id):
    d = request.json or {}
    short_name = (d.get("short_name") or "").strip()
    conn = get_db()
    if short_name:
        conn.execute("UPDATE institutions SET status = 'approved', short_name = ? WHERE id = ?", (short_name, inst_id))
    else:
        conn.execute("UPDATE institutions SET status = 'approved' WHERE id = ?", (inst_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "message": "Institution approved and added to official autocomplete!"})


@app.route("/api/admin/institutions/<int:inst_id>/delete", methods=["POST"])
@admin_required
def api_admin_institution_delete(inst_id):
    conn = get_db()
    conn.execute("DELETE FROM institutions WHERE id = ?", (inst_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "message": "Institution removed."})


@app.route("/api/admin/maintenance/clear-cache", methods=["POST"])
@admin_required
def api_admin_clear_cache():
    freed_bytes = 0
    deleted_files = 0
    if OUTPUT_DIR.exists():
        for f in OUTPUT_DIR.glob("*"):
            if f.is_file() and f.name != "codebook.pdf":
                try:
                    freed_bytes += f.stat().st_size
                    f.unlink()
                    deleted_files += 1
                except Exception:
                    pass
    return jsonify({"ok": True, "deleted_files": deleted_files, "freed_formatted": format_bytes(freed_bytes)})


@app.route("/api/admin/maintenance/backup-db")
@admin_required
def api_admin_backup_db():
    db_file = BACKEND_DIR / "data" / "codebook.db"
    if not db_file.exists():
        return jsonify({"ok": False, "error": "Database file not found."}), 404
    ts = int(time.time())
    return send_file(str(db_file), as_attachment=True, download_name=f"codebook_backup_{ts}.db")


@app.route("/api/admin/maintenance/purge-trash", methods=["POST"])
@admin_required
def api_admin_purge_trash():
    conn = get_db()
    s_del = conn.execute("DELETE FROM snippets WHERE deleted_at IS NOT NULL").rowcount
    t_del = conn.execute("DELETE FROM topics WHERE deleted_at IS NOT NULL").rowcount
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "purged_snippets": s_del, "purged_topics": t_del})


@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "Endpoint not found"}), 404
    return redirect("/")


@app.errorhandler(500)
def handle_500(e):
    if request.path.startswith("/api/"):
        return jsonify({"ok": False, "error": "An internal server error occurred"}), 500
    return "<h3>Internal Server Error</h3><p>An unexpected error occurred. Please return to <a href='/'>Codebook Studio</a>.</p>", 500


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

    app.run(debug=True, host="0.0.0.0", port=PORT)
