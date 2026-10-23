"""
Codebook Studio - Authentication & User Management Module
Handles user registration, password hashing (PBKDF2 via Werkzeug),
login verification, and starter pack generation for new user accounts.
"""

import random
import re
import time
import uuid
from werkzeug.security import generate_password_hash, check_password_hash

AVATAR_PALETTE = [
    "#0071E3",  # Apple Blue
    "#34C759",  # Emerald Green
    "#AF52DE",  # Purple
    "#FF9500",  # Amber Orange
    "#FF2D55",  # Rose Pink
    "#5856D6",  # Indigo
    "#00C7BE",  # Teal
    "#5B4A8A",  # Deep Violet
]


def is_valid_email(email: str) -> bool:
    if not email or len(email) < 5:
        return False
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email.strip()))


def create_user(conn, email: str, password: str, name: str = "") -> dict:
    """Create a new user account with hashed password and initial starter codebook."""
    clean_email = (email or "").strip().lower()
    if not is_valid_email(clean_email):
        raise ValueError("Please provide a valid email address.")

    if not password or len(password) < 6:
        raise ValueError("Password must be at least 6 characters long.")

    display_name = (name or "").strip()
    if not display_name:
        display_name = clean_email.split("@")[0].capitalize()

    # Check for existing email
    existing = conn.execute("SELECT id FROM users WHERE email = ?", (clean_email,)).fetchone()
    if existing:
        raise ValueError("An account with this email already exists.")

    user_id = "u_" + uuid.uuid4().hex[:10]
    p_hash = generate_password_hash(password, method="pbkdf2:sha256")
    avatar_color = random.choice(AVATAR_PALETTE)
    now = int(time.time())
    role = "admin" if clean_email in ADMIN_EMAILS else "user"

    conn.execute(
        """INSERT INTO users (id, email, password_hash, name, avatar_color, role, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (user_id, clean_email, p_hash, display_name, avatar_color, role, now),
    )
    conn.commit()

    return {
        "id": user_id,
        "email": clean_email,
        "name": display_name,
        "avatar_color": avatar_color,
        "role": role,
        "created_at": now,
    }


ADMIN_EMAILS = {
    "ahmeds89thdoc1@gmail.com",
    "ahmeds89thdoc@gmail.com",
    "ahmeds89thdoc2@gmail.com",
    "ahmedsextraone@gmail.com",
    "admin@codebook.io",
}


def authenticate_user(conn, email: str, password: str) -> dict | None:
    """Verify credentials and return user dict if valid, else None."""
    clean_email = (email or "").strip().lower()
    row = conn.execute("SELECT * FROM users WHERE email = ?", (clean_email,)).fetchone()
    if not row:
        return None

    if not check_password_hash(row["password_hash"], password):
        return None

    role = row["role"] if "role" in row.keys() and row["role"] else ("admin" if clean_email in ADMIN_EMAILS else "user")
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "avatar_color": row["avatar_color"] or "#0071E3",
        "avatar_url": row["avatar_url"] if "avatar_url" in row.keys() else "",
        "provider": row["provider"] if "provider" in row.keys() else "local",
        "role": role,
        "created_at": row["created_at"],
    }


def get_user_by_id(conn, user_id: str) -> dict | None:
    """Fetch user profile by user_id."""
    if not user_id or user_id == "guest":
        return None
    row = conn.execute("SELECT id, email, name, avatar_color, avatar_url, provider, role, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        return None
    role = row["role"] or ("admin" if row["email"] in ADMIN_EMAILS else "user")
    return {
        "id": row["id"],
        "email": row["email"],
        "name": row["name"],
        "avatar_color": row["avatar_color"] or "#0071E3",
        "avatar_url": row["avatar_url"] or "",
        "provider": row["provider"] or "local",
        "role": role,
        "created_at": row["created_at"],
    }


def init_user_starter_pack(conn, user_id: str, default_topics=None, default_snippets=None):
    """Seed the user's account with starter topics, code snippets, notes & contest template if they have none."""
    from backend.db import DEFAULT_TOPICS, DEFAULT_SNIPPETS, DEFAULT_SETTINGS

    count = conn.execute("SELECT COUNT(*) c FROM topics WHERE user_id = ? AND deleted_at IS NULL", (user_id,)).fetchone()["c"]
    if count == 0:
        topics = default_topics or DEFAULT_TOPICS
        snippets = default_snippets or DEFAULT_SNIPPETS

        for t_id, name, color, sort_order in topics:
            user_topic_id = f"{user_id}_{t_id}"
            conn.execute(
                "INSERT INTO topics (id, user_id, name, color, sort_order) VALUES (?, ?, ?, ?, ?)",
                (user_topic_id, user_id, name, color, sort_order),
            )

        for s in snippets:
            user_topic_id = f"{user_id}_{s['topic_id']}"
            conn.execute(
                """INSERT INTO snippets
                   (user_id, title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code, notes, formulas, language, kind)
                   VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?, ?, ?, ?)""",
                (user_id, s["title"], s.get("subtitle", ""), s.get("complexity", ""), user_topic_id,
                 s.get("sort_order", 100), s.get("code", ""), s.get("notes", ""), s.get("formulas", "[]"),
                 s.get("language", "cpp"), s.get("kind", "code")),
            )

    else:
        # User already has topics, but seed sample notes if they have no notes yet
        notes_c = conn.execute("SELECT COUNT(*) c FROM snippets WHERE user_id = ? AND kind = 'note' AND deleted_at IS NULL", (user_id,)).fetchone()["c"]
        if notes_c == 0:
            snippets = default_snippets or DEFAULT_SNIPPETS
            for s in snippets:
                if s.get("kind") == "note":
                    top_row = conn.execute(
                        "SELECT id FROM topics WHERE user_id = ? AND (id = ? OR id = ?) AND deleted_at IS NULL",
                        (user_id, s["topic_id"], f"{user_id}_{s['topic_id']}")
                    ).fetchone()
                    first_top = conn.execute("SELECT id FROM topics WHERE user_id = ? AND deleted_at IS NULL LIMIT 1", (user_id,)).fetchone()
                    target_tid = top_row["id"] if top_row else (first_top["id"] if first_top else None)
                    if target_tid:
                        conn.execute(
                            """INSERT INTO snippets
                               (user_id, title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code, notes, formulas, language, kind)
                               VALUES (?, ?, ?, ?, ?, ?, 1, '', ?, ?, ?, ?, ?)""",
                            (user_id, s["title"], s.get("subtitle", ""), s.get("complexity", ""), target_tid,
                             s.get("sort_order", 100), s.get("code", ""), s.get("notes", ""),
                             s.get("formulas", "[]"), s.get("language", "cpp"), s.get("kind", "code")),
                        )

    # Initialize user settings (including boilerplate contest template) if missing
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings (user_id, key, value) VALUES (?, ?, ?)",
            (user_id, key, value),
        )

    # Ensure boilerplate_code is set
    bp_row = conn.execute("SELECT value FROM settings WHERE user_id = ? AND key = 'boilerplate_code'", (user_id,)).fetchone()
    if not bp_row or not (bp_row["value"] or "").strip():
        conn.execute(
            "INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, 'boilerplate_code', ?)",
            (user_id, DEFAULT_SETTINGS["boilerplate_code"]),
        )

    conn.commit()


def get_or_create_oauth_user(conn, provider: str, provider_id: str, email: str, name: str = "", avatar_url: str = "") -> dict:
    """Find an existing user by OAuth provider ID or email, or create a new user profile."""
    clean_email = (email or "").strip().lower()
    clean_provider_id = str(provider_id or "").strip()
    display_name = (name or "").strip() or (clean_email.split("@")[0].capitalize() if clean_email else "Coder")
    now = int(time.time())

    # 1. Search by provider and provider_id
    if clean_provider_id:
        row = conn.execute(
            "SELECT id, email, name, avatar_color, avatar_url, provider, role, created_at FROM users WHERE provider = ? AND provider_id = ?",
            (provider, clean_provider_id)
        ).fetchone()
        if row:
            if display_name and display_name != row["name"]:
                conn.execute("UPDATE users SET name = ? WHERE id = ?", (display_name, row["id"]))
            if avatar_url and avatar_url != (row["avatar_url"] or ""):
                conn.execute("UPDATE users SET avatar_url = ? WHERE id = ?", (avatar_url, row["id"]))
            conn.commit()
            role = row["role"] or ("admin" if row["email"] in ADMIN_EMAILS else "user")
            return {
                "id": row["id"],
                "email": row["email"],
                "name": display_name or row["name"],
                "avatar_color": row["avatar_color"] or "#0071E3",
                "avatar_url": avatar_url or row["avatar_url"] or "",
                "provider": provider,
                "role": role,
                "created_at": row["created_at"],
            }

    # 2. Search by email (link OAuth to existing account)
    if clean_email:
        row = conn.execute(
            "SELECT id, email, name, avatar_color, avatar_url, provider, role, created_at FROM users WHERE email = ?",
            (clean_email,)
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE users SET provider = ?, provider_id = ?, avatar_url = COALESCE(NULLIF(avatar_url, ''), ?) WHERE id = ?",
                (provider, clean_provider_id, avatar_url, row["id"])
            )
            conn.commit()
            role = row["role"] or ("admin" if row["email"] in ADMIN_EMAILS else "user")
            return {
                "id": row["id"],
                "email": row["email"],
                "name": row["name"],
                "avatar_color": row["avatar_color"] or "#0071E3",
                "avatar_url": avatar_url or row["avatar_url"] or "",
                "provider": provider,
                "role": role,
                "created_at": row["created_at"],
            }

    # 3. Create fresh user
    user_id = f"u_{provider[:2]}_" + uuid.uuid4().hex[:8]
    avatar_color = random.choice(AVATAR_PALETTE)
    role = "admin" if clean_email in ADMIN_EMAILS else "user"
    conn.execute(
        """INSERT INTO users (id, email, password_hash, name, avatar_color, avatar_url, provider, provider_id, role, created_at)
           VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)""",
        (user_id, clean_email or f"{user_id}@{provider}.user", display_name, avatar_color, avatar_url, provider, clean_provider_id, role, now)
    )
    conn.commit()

    # Migrate in-progress guest topics/snippets/settings to new account, or seed starter pack
    migrate_guest_data_to_user(conn, "guest", user_id)

    return {
        "id": user_id,
        "email": clean_email,
        "name": display_name,
        "avatar_color": avatar_color,
        "avatar_url": avatar_url,
        "provider": provider,
        "role": role,
        "created_at": now,
    }


def migrate_guest_data_to_user(conn, guest_id: str, user_id: str):
    """
    Copies guest's current customized topics, snippets, and settings
    to a newly registered user account so that in-progress work is seamlessly retained.
    Guest data is preserved for future anonymous visitors.
    """
    if not guest_id or not user_id or guest_id == user_id:
        return

    # 1. If target user already has saved topics, do NOT overwrite their data
    user_topics_count = conn.execute(
        "SELECT COUNT(*) as c FROM topics WHERE user_id = ? AND deleted_at IS NULL",
        (user_id,)
    ).fetchone()["c"]
    if user_topics_count > 0:
        return

    # 2. Check if guest has topics
    guest_topics = conn.execute(
        "SELECT * FROM topics WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order",
        (guest_id,)
    ).fetchall()

    if not guest_topics:
        # Fallback to standard starter pack
        init_user_starter_pack(conn, user_id)
        return

    # 3. Copy topics with fresh user-scoped IDs
    topic_id_map = {}
    for t in guest_topics:
        old_id = t["id"]
        clean_tid = old_id.replace("guest_", "")
        new_tid = f"{user_id}_{clean_tid}"
        topic_id_map[old_id] = new_tid

        conn.execute(
            """INSERT OR REPLACE INTO topics (id, user_id, name, color, sort_order, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (new_tid, user_id, t["name"], t["color"], t["sort_order"], t["deleted_at"])
        )

    # 4. Copy snippets
    guest_snippets = conn.execute(
        "SELECT * FROM snippets WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort_order",
        (guest_id,)
    ).fetchall()
    for s in guest_snippets:
        new_tid = topic_id_map.get(s["topic_id"], s["topic_id"])
        conn.execute(
            """INSERT INTO snippets
               (user_id, title, subtitle, complexity, topic_id, sort_order, verified, tested_on, code, notes, formulas, language, kind, deleted_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id,
                s["title"],
                s["subtitle"] or "",
                s["complexity"] or "",
                new_tid,
                s["sort_order"],
                s["verified"],
                s["tested_on"] or "",
                s["code"] or "",
                s["notes"] or "",
                s["formulas"] or "[]",
                s["language"] or "cpp",
                s["kind"] or "code",
                s["deleted_at"]
            )
        )

    # 5. Copy settings (book title, university/institution, team name, styles, boilerplate code)
    guest_settings = conn.execute(
        "SELECT key, value FROM settings WHERE user_id = ?",
        (guest_id,)
    ).fetchall()
    for st in guest_settings:
        conn.execute(
            "INSERT OR REPLACE INTO settings (user_id, key, value) VALUES (?, ?, ?)",
            (user_id, st["key"], st["value"])
        )

    conn.commit()

