#!/usr/bin/env bash
# Double-click this file to start Codebook Builder and open it in your browser.
cd "$(dirname "$0")"

if ! python3 -c "import flask, weasyprint, pypdf" 2>/dev/null; then
  echo "Setting up (first run only)... this can take a minute."
  pip3 install -r requirements.txt --quiet
fi

echo "Starting Codebook Builder -- your browser will open automatically."
echo "Leave this window open while you work. Close it to stop the app."
python3 app.py
