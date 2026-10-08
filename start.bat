@echo off
REM Double-click this file to start Codebook Builder and open it in your browser.
cd /d "%~dp0"

python -c "import flask, weasyprint, pypdf" 2>nul
if errorlevel 1 (
    echo Setting up (first run only)... this can take a minute.
    pip install -r requirements.txt --quiet
)

echo Starting Codebook Builder -- your browser will open automatically.
echo Leave this window open while you work. Close it to stop the app.
python app.py
pause
