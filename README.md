# Codebook Studio (live-preview editor)

A local web app for building your ICPC-style contest codebook. Edit
everything from a sidebar on the left; the actual A4 page updates live
in the middle as you type. Runs entirely on your PC — nothing leaves
your machine.

## Setup (one-time)

1. Install Python 3.10+ if you don't have it.

2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```

3. Install fonts used in the PDF (JetBrains Mono + Inter):
   - Windows: download and install manually
     - JetBrains Mono: https://www.jetbrains.com/lp/mono/
     - Inter: https://rsms.me/inter/
   - Linux: `sudo apt-get install fonts-jetbrains-mono fonts-inter`
   - Mac: `brew install --cask font-jetbrains-mono font-inter`

4. Windows only: WeasyPrint needs the GTK3 runtime to render PDFs.
   Install it from: https://github.com/tschoonj/GTK-for-Windows-Runtime-Environment-Installer/releases
   (check "Set up PATH environment variable" during install, then restart your terminal)

## Running the app

```
python app.py
```

Then open **http://127.0.0.1:5050** in your browser.

The app seeds itself with a few sample templates on first run so you can
see the format before adding your own.

## How to use it

- **Left sidebar**: book title, team name, and a list of topics. Each
  topic is a colored group — click the colored dot to change its color,
  click a template name to edit it, click "+ Add template" to add a new
  one to that topic, or "+ Add topic" at the bottom of the sidebar for
  a brand new topic.
- **Middle**: the actual A4 pages of your codebook — cover page, quick
  index, then one page per topic — updating live as you edit.
- **Build PDF**: generates the real print-ready `codebook.pdf`.
- **Download PDF**: grabs the most recently built PDF.

Nothing requires editing code or files by hand — everything is done
through the browser.

## Data storage

Everything (templates, topics, settings) lives in `data/codebook.db`,
a single SQLite file. Back this file up if you want to keep history —
e.g. copy it into your existing GitHub-synced folder occasionally.

## Stopping the app

Press Ctrl+C in the terminal where it's running.
