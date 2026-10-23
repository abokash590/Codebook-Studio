"""
GitHub Gist Auto-Sync for Codebook Studio
Maintains persistent SQLite database across ephemeral container deployments (e.g. Render, Railway)
by pulling codebook.db on boot and pushing codebook.db in the background upon data modifications.
"""

import base64
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

logger = logging.getLogger("gist_sync")

DB_PATH = Path(os.environ.get("CODEBOOK_DB_PATH", Path(__file__).parent / "data" / "codebook.db"))
GIST_TOKEN = os.environ.get("GITHUB_SYNC_TOKEN", "").strip()
GIST_ID = os.environ.get("GITHUB_SYNC_GIST_ID", "").strip()

# In-memory sync state
_state_lock = threading.Lock()
_sync_state = {
    "configured": bool(GIST_TOKEN),
    "gist_id": GIST_ID,
    "last_sync_time": None,
    "last_sync_status": "idle",
    "last_error": None,
    "pending_sync": False,
}

_debounce_timer = None


def get_sync_status():
    with _state_lock:
        st = dict(_sync_state)
        st["configured"] = bool(os.environ.get("GITHUB_SYNC_TOKEN", "").strip())
        return st


def _api_request(url: str, method: str = "GET", payload: dict = None, token: str = None) -> dict:
    req_token = token or os.environ.get("GITHUB_SYNC_TOKEN", "").strip()
    headers = {
        "User-Agent": "Codebook-Studio-Sync",
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {req_token}",
    }
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def restore_db_from_gist() -> bool:
    """
    Called on startup before init_db().
    Pulls codebook.db.b64 from GitHub Gist and restores it to local disk.
    """
    token = os.environ.get("GITHUB_SYNC_TOKEN", "").strip()
    gist_id = os.environ.get("GITHUB_SYNC_GIST_ID", "").strip()

    if not token:
        logger.info("[GistSync] GITHUB_SYNC_TOKEN not set. Running with local SQLite.")
        return False

    with _state_lock:
        _sync_state["configured"] = True
        _sync_state["last_sync_status"] = "restoring"

    try:
        # If Gist ID not specified, find existing Gist with our signature file
        if not gist_id:
            logger.info("[GistSync] Searching for existing Codebook Studio backup Gist...")
            gists = _api_request("https://api.github.com/gists", method="GET", token=token)
            for g in gists:
                files = g.get("files", {})
                if "codebook.db.b64" in files or "codebook_manifest.json" in files:
                    gist_id = g.get("id")
                    logger.info(f"[GistSync] Discovered existing Gist: {gist_id}")
                    break

        if not gist_id:
            logger.info("[GistSync] No existing backup Gist found. Will create one after init.")
            with _state_lock:
                _sync_state["last_sync_status"] = "ready_to_create"
            return False

        # Fetch the Gist
        logger.info(f"[GistSync] Restoring database from Gist ID: {gist_id}...")
        gist_data = _api_request(f"https://api.github.com/gists/{gist_id}", method="GET", token=token)
        files = gist_data.get("files", {})

        if "codebook.db.b64" not in files:
            logger.warning("[GistSync] 'codebook.db.b64' not found in Gist. Starting with fresh DB.")
            return False

        b64_content = files["codebook.db.b64"].get("content", "")
        # GitHub truncates content >1MB in standard response; handle raw_url if truncated
        if files["codebook.db.b64"].get("truncated"):
            raw_url = files["codebook.db.b64"].get("raw_url")
            req = urllib.request.Request(raw_url, headers={"User-Agent": "Codebook-Studio-Sync"})
            with urllib.request.urlopen(req, timeout=30) as r:
                b64_content = r.read().decode("utf-8")

        if not b64_content:
            return False

        db_bytes = base64.b64decode(b64_content.encode("utf-8"))
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(DB_PATH, "wb") as f:
            f.write(db_bytes)

        with _state_lock:
            _sync_state["gist_id"] = gist_id
            _sync_state["last_sync_time"] = int(time.time())
            _sync_state["last_sync_status"] = "restored"
            _sync_state["last_error"] = None

        logger.info(f"[GistSync] Successfully restored database ({len(db_bytes)} bytes) from Gist {gist_id}!")
        return True

    except Exception as e:
        logger.error(f"[GistSync] Failed to restore database from Gist: {e}")
        with _state_lock:
            _sync_state["last_sync_status"] = "error"
            _sync_state["last_error"] = str(e)
        return False


def backup_db_to_gist_now() -> bool:
    """
    Immediately syncs the current codebook.db to GitHub Gist.
    Creates a secret Gist if GITHUB_SYNC_GIST_ID is not configured yet.
    """
    token = os.environ.get("GITHUB_SYNC_TOKEN", "").strip()
    gist_id = os.environ.get("GITHUB_SYNC_GIST_ID", "").strip() or _sync_state.get("gist_id")

    if not token:
        return False

    if not DB_PATH.exists():
        return False

    with _state_lock:
        _sync_state["last_sync_status"] = "syncing"

    try:
        with open(DB_PATH, "rb") as f:
            db_bytes = f.read()

        b64_str = base64.b64encode(db_bytes).decode("utf-8")
        manifest = {
            "app": "Codebook Studio",
            "backup_time": int(time.time()),
            "backup_iso": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
            "db_size_bytes": len(db_bytes),
        }

        files_payload = {
            "codebook.db.b64": {"content": b64_str},
            "codebook_manifest.json": {"content": json.dumps(manifest, indent=2)},
        }

        if gist_id:
            # Update existing Gist
            payload = {
                "description": f"Codebook Studio DB Auto-Backup - {manifest['backup_iso']}",
                "files": files_payload,
            }
            _api_request(f"https://api.github.com/gists/{gist_id}", method="PATCH", payload=payload, token=token)
            logger.info(f"[GistSync] Successfully updated Gist {gist_id} ({len(db_bytes)} bytes).")
        else:
            # Create a brand new secret Gist
            payload = {
                "description": f"Codebook Studio DB Auto-Backup - {manifest['backup_iso']}",
                "public": False,
                "files": files_payload,
            }
            res = _api_request("https://api.github.com/gists", method="POST", payload=payload, token=token)
            gist_id = res.get("id")
            logger.info(f"[GistSync] Created new secret backup Gist: {gist_id}")

        with _state_lock:
            _sync_state["gist_id"] = gist_id
            _sync_state["last_sync_time"] = int(time.time())
            _sync_state["last_sync_status"] = "synced"
            _sync_state["last_error"] = None
            _sync_state["pending_sync"] = False

        return True

    except Exception as e:
        logger.error(f"[GistSync] Backup to Gist failed: {e}")
        with _state_lock:
            _sync_state["last_sync_status"] = "error"
            _sync_state["last_error"] = str(e)
            _sync_state["pending_sync"] = False
        return False


def schedule_gist_sync(delay_seconds: float = 4.0):
    """
    Debounced non-blocking sync.
    Wait for multiple rapid database writes to settle before pushing to GitHub.
    """
    token = os.environ.get("GITHUB_SYNC_TOKEN", "").strip()
    if not token:
        return

    global _debounce_timer
    with _state_lock:
        _sync_state["pending_sync"] = True
        if _debounce_timer is not None:
            _debounce_timer.cancel()

        _debounce_timer = threading.Timer(delay_seconds, _run_async_backup)
        _debounce_timer.daemon = True
        _debounce_timer.start()


def _run_async_backup():
    threading.Thread(target=backup_db_to_gist_now, daemon=True).start()
