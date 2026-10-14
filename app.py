"""
Codebook Studio - Entry Point
Delegates application configuration and routes to backend/app.py
Serves frontend templates and static assets from frontend/
"""

import os
import threading
import webbrowser

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from backend.app import app

PORT = 5050


def _open_browser():
    webbrowser.open(f"http://127.0.0.1:{PORT}")


if __name__ == "__main__":
    if os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        threading.Timer(1.0, _open_browser).start()

    app.run(debug=True, host="0.0.0.0", port=PORT)
