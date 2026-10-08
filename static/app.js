let state = { topics: [], settings: {} };
let editingSnippetId = null;

const $ = (id) => document.getElementById(id);

// ---------------- CODE EDITOR (CodeMirror, P1.2) ----------------

const CM_MODES = {
  cpp: "text/x-c++src",
  java: "text/x-java",
  python: "text/x-python",
  kotlin: "text/x-kotlin",
};

let codeEditor = null;

function initCodeEditor() {
  if (codeEditor || typeof CodeMirror === "undefined") return;
  codeEditor = CodeMirror.fromTextArea($("snippet-code"), {
    mode: "text/x-c++src",
    theme: "default",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    viewportMargin: Infinity,
  });
  codeEditor.on("change", () => {
    codeEditor.save(); // keep the underlying textarea in sync so other code reading its .value still works
    livePreviewWhileEditing();
    scheduleSimilarityCheck();
  });
}

function setCodeEditorLanguage(lang) {
  if (codeEditor) codeEditor.setOption("mode", CM_MODES[lang] || CM_MODES.cpp);
}

function getCode() {
  return codeEditor ? codeEditor.getValue() : $("snippet-code").value;
}

function setCode(value) {
  if (codeEditor) {
    codeEditor.setValue(value || "");
  } else {
    $("snippet-code").value = value || "";
  }
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function setStatus(msg, kind) {
  const el = $("status-msg");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
  if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
}

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  renderSidebar();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(renderPreview);
  } else {
    renderPreview();
  }
}

// ---------------- SIDEBAR ----------------

const PAGE_DIMENSIONS = {
  A4: { w: "210mm", h: "297mm" },
  Letter: { w: "216mm", h: "279mm" },
};

function applyThemeSettings() {
  const root = document.documentElement.style;
  const codeFont = state.settings.code_font || "JetBrains Mono";
  const codeTheme = state.settings.code_theme || "cream";
  const accent = state.settings.accent_color || "#2C2C2A";
  const templateAccent = state.settings.template_accent_color || accent;
  const pageSize = PAGE_DIMENSIONS[state.settings.page_size] ? state.settings.page_size : "A4";
  root.setProperty("--code-font", `'${codeFont}', monospace`);
  root.setProperty("--accent", accent);
  root.setProperty("--template-accent", templateAccent);
  root.setProperty("--page-w", PAGE_DIMENSIONS[pageSize].w);
  root.setProperty("--page-h", PAGE_DIMENSIONS[pageSize].h);
  document.documentElement.setAttribute("data-code-theme", codeTheme);
}

function renderSidebar() {
  $("book-title").value = state.settings.book_title || "";
  $("institution-name").value = state.settings.institution_name || "";
  $("team-name").value = state.settings.team_name || "";
  $("code-font").value = state.settings.code_font || "JetBrains Mono";
  $("code-theme").value = state.settings.code_theme || "cream";
  $("page-size").value = state.settings.page_size || "A4";
  $("accent-color").value = state.settings.accent_color || "#2C2C2A";
  $("template-accent-color").value = state.settings.template_accent_color || state.settings.accent_color || "#2C2C2A";
  updatePaletteActiveState("accent-color", $("accent-color").value);
  updatePaletteActiveState("template-accent-color", $("template-accent-color").value);
  $("cover-style").value = state.settings.cover_style || "minimal";
  const footerSetting = state.settings.show_team_footer;
  $("show-team-footer").checked = !(footerSetting === false || footerSetting === 0 || footerSetting === "0");
  const boilerplateSetting = state.settings.show_boilerplate;
  $("show-boilerplate").checked = !(boilerplateSetting === false || boilerplateSetting === 0 || boilerplateSetting === "0");
  $("boilerplate-code").value = state.settings.boilerplate_code || "";
  applyThemeSettings();

  const container = $("topics-list");
  container.innerHTML = "";

  state.topics.forEach((topic) => {
    const group = document.createElement("div");
    group.className = "topic-group";
    group.dataset.topicId = topic.id;
    
    // Deterministic rotation based on ID hash
    let hash = 0;
    for (let i = 0; i < topic.id.length; i++) {
      hash = topic.id.charCodeAt(i) + ((hash << 5) - hash);
    }
    const rot = ((Math.abs(hash) % 200) / 100 - 1) * 0.8;
    group.style.transform = `rotate(${rot}deg)`;

    const head = document.createElement("div");
    head.className = "topic-group-head";
    head.innerHTML = `
      <span class="drag-handle" title="Drag to reorder" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>
      </span>
      <span class="topic-group-color" style="color: ${topic.color}" role="button" aria-label="Change color">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 21C6 21 3 17.5 3 12S7 3 12 3s9 4 9 9-4 8.5-9.5 8.5c-4.5 0-7.5-3.5-7.5-8S8.5 5 12 5s7 2.5 7 6.5"/></svg>
      </span>
      <span class="topic-group-name">${escapeHtml(topic.name)}</span>
      <span class="topic-group-count" aria-label="${topic.snippets.length} templates">${topic.snippets.length}</span>
      <button class="topic-group-delete" title="Delete topic" aria-label="Delete ${escapeHtml(topic.name)}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5l14 14M5 19L19 5"/></svg>
      </button>
    `;
    head.querySelector(".topic-group-color").addEventListener("click", (e) => {
      e.stopPropagation();
      openTopicColorPicker(topic, e.currentTarget);
    });
    head.querySelector(".topic-group-delete").addEventListener("click", () => deleteTopic(topic.id));
    group.appendChild(head);

    const rowsContainer = document.createElement("div");
    rowsContainer.className = "snippet-rows";
    rowsContainer.dataset.topicId = topic.id;

    topic.snippets.forEach((s) => {
      const row = document.createElement("div");
      row.className = "snippet-row";
      row.dataset.snippetId = s.id;
      row.innerHTML = `
        <span class="drag-handle" title="Drag to reorder" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>
        </span>
        <span class="snippet-kind badge-${s.kind.toLowerCase()}">${escapeHtml(s.kind)}</span>
        <span class="snippet-row-title">${escapeHtml(s.title)}</span>
        ${!s.verified && s.kind === "code" ? '<span class="snippet-row-badge">unverified</span>' : ""}
      `;
      row.addEventListener("click", (e) => {
        if (e.target.closest(".drag-handle")) return;
        openSnippetModal(s);
      });
      rowsContainer.appendChild(row);
    });
    group.appendChild(rowsContainer);

    if (typeof Sortable !== "undefined") {
      Sortable.create(rowsContainer, {
        handle: ".drag-handle",
        animation: 150,
        onEnd: async () => {
          const order = Array.from(rowsContainer.children).map((el) => el.dataset.snippetId);
          await fetch("/api/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "snippets", order }),
          });
          loadState();
        },
      });
    }

    const addRow = document.createElement("div");
    addRow.className = "add-snippet-row";
    addRow.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px;margin-right:5px;"><path d="M12 4.5c-.1 4.5.2 10.5 0 15M4.5 12c4.5.1 10.5-.2 15 0"/></svg>Add template`;
    addRow.addEventListener("click", () => openSnippetModal(null, topic.id));
    group.appendChild(addRow);

    container.appendChild(group);
  });

  if (typeof Sortable !== "undefined") {
    Sortable.create(container, {
      handle: ".topic-group-head .drag-handle",
      animation: 150,
      draggable: ".topic-group",
      onEnd: async () => {
        const order = Array.from(container.children).map((el) => el.dataset.topicId);
        await fetch("/api/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "topics", order }),
        });
        loadState();
      },
    });
  }
}

// ---------------- CONFIRM MODAL (replaces native browser confirm()) ----------------

let _confirmResolve = null;

function showConfirm(title, message, confirmLabel) {
  $("confirm-modal-title").textContent = title;
  $("confirm-modal-message").textContent = message;
  $("confirm-modal-confirm-btn").textContent = confirmLabel || "Delete";
  $("confirm-modal-backdrop").classList.add("open");
  return new Promise((resolve) => {
    _confirmResolve = resolve;
  });
}

function _settleConfirm(result) {
  $("confirm-modal-backdrop").classList.remove("open");
  if (_confirmResolve) {
    const resolve = _confirmResolve;
    _confirmResolve = null;
    resolve(result);
  }
}

let colorPopoverTopic = null;

function openTopicColorPicker(topic, anchorEl) {
  colorPopoverTopic = topic;
  const popover = $("color-popover");
  $("color-popover-swatch").value = topic.color;
  updatePaletteActiveState("color-popover-swatch", topic.color);
  
  const rect = anchorEl.getBoundingClientRect();
  popover.style.top = rect.bottom + 6 + "px";
  popover.style.left = rect.left + "px";
  popover.classList.add("open");
}

function closeColorPopover() {
  $("color-popover").classList.remove("open");
  colorPopoverTopic = null;
}

async function commitPopoverColor() {
  if (!colorPopoverTopic) return;
  const newColor = $("color-popover-swatch").value;
  await fetch(`/api/topic/${colorPopoverTopic.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: colorPopoverTopic.name, color: newColor, sort_order: colorPopoverTopic.sort_order }),
  });
  closeColorPopover();
  loadState();
}

async function deleteTopic(topicId) {
  const topic = state.topics.find((t) => t.id === topicId);
  const ok = await showConfirm(
    "Delete this topic?",
    `"${topic ? topic.name : topicId}" must have no templates left in it. It'll move to Recently deleted for 30 days.`,
    "Delete topic"
  );
  if (!ok) return;
  const res = await fetch(`/api/topic/${topicId}`, { method: "DELETE" });
  const data = await res.json();
  if (!data.ok) {
    setStatus(data.error, "error");
    return;
  }
  loadState();
}

// ---------------- RECENTLY DELETED / TRASH (soft-delete recovery, P1.5) ----------------

async function openTrashModal() {
  $("trash-modal-backdrop").classList.add("open");
  await refreshTrashList();
}

function closeTrashModal() {
  $("trash-modal-backdrop").classList.remove("open");
}

async function refreshTrashList() {
  const res = await fetch("/api/trash");
  const data = await res.json();
  const container = $("trash-list");
  const items = [
    ...data.topics.map((t) => ({ ...t, _kind: "topic", _label: t.name })),
    ...data.snippets.map((s) => ({ ...s, _kind: "snippet", _label: s.title })),
  ];
  if (!items.length) {
    container.innerHTML = `<p class="trash-empty">Nothing deleted recently.</p>`;
    return;
  }
  container.innerHTML = items
    .map(
      (item) => `
    <div class="trash-item" data-kind="${item._kind}" data-id="${item.id}">
      <div class="trash-item-info">
        <span class="trash-item-title">${escapeHtml(item._label)}</span>
        <span class="trash-item-meta">${item._kind === "topic" ? "Topic" : "Template"} · ${item.days_left} day${item.days_left === 1 ? "" : "s"} left</span>
      </div>
      <div class="trash-item-actions">
        <button type="button" class="btn btn-small" data-action="restore">Restore</button>
        <button type="button" class="btn btn-small btn-danger" data-action="purge">Delete forever</button>
      </div>
    </div>`
    )
    .join("");

  container.querySelectorAll(".trash-item").forEach((row) => {
    const kind = row.dataset.kind;
    const id = row.dataset.id;
    row.querySelector('[data-action="restore"]').addEventListener("click", async () => {
      await fetch(`/api/trash/restore/${kind}/${id}`, { method: "POST" });
      await refreshTrashList();
      loadState();
    });
    row.querySelector('[data-action="purge"]').addEventListener("click", async () => {
      const ok = await showConfirm("Delete forever?", `"${row.querySelector(".trash-item-title").textContent}" will be permanently removed. This can't be undone.`, "Delete forever");
      if (!ok) return;
      await fetch(`/api/trash/purge/${kind}/${id}`, { method: "DELETE" });
      await refreshTrashList();
    });
  });
}

// ---------------- LIVE A4 PREVIEW ----------------

const MM_PER_PX = 25.4 / 96;
function mmToPx(mm) { return mm / MM_PER_PX; }
function pxToMm(px) { return px * MM_PER_PX; }

// Page geometry -- must mirror the @page margin / .card padding / .card-columns
// gap values in style.css, and PAGE_WIDTH_MM / CARD_PADDING_MM etc. in
// pdf_builder.py, so the font-fit math here matches what the PDF computes.
const CARD_COLUMN_GAP_MM = 8;
const CARD_PADDING_MM = 3;
const CARD_BORDER_ALLOWANCE_MM = 1;
const BOILERPLATE_PADDING_MM = 3;
const CODE_FONT_BASE_SIZE = 9.5;
const CODE_FONT_MIN_SIZE = 7;

let _measureCanvasCtx = null;
function _measureTextWidth(text, fontPx, fontFamily) {
  if (!_measureCanvasCtx) _measureCanvasCtx = document.createElement("canvas").getContext("2d");
  _measureCanvasCtx.font = `${fontPx}px '${fontFamily}', monospace`;
  return _measureCanvasCtx.measureText(text).width;
}

function longestUnbreakableToken(code) {
  const tokens = (code || "").split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  return tokens.reduce((a, b) => (b.length > a.length ? b : a), "");
}

// Mirrors fit_code_font_size() in pdf_builder.py: instead of letting the
// browser break a long identifier mid-token (the old word-break: break-word
// behavior), shrink this block's font just enough that its longest
// unbreakable token fits the available width.
function fitCodeFontSize(code, fontFamily, availableWidthPx) {
  const token = longestUnbreakableToken(code);
  if (!token) return CODE_FONT_BASE_SIZE;
  const safeWidth = availableWidthPx * 0.97;
  let size = CODE_FONT_BASE_SIZE;
  while (size > CODE_FONT_MIN_SIZE) {
    if (_measureTextWidth(token, size, fontFamily) <= safeWidth) break;
    size -= 0.25;
  }
  return Math.max(size, CODE_FONT_MIN_SIZE);
}

function cardInnerWidthPx(contentWidthPx) {
  const columnWidth = (contentWidthPx - mmToPx(CARD_COLUMN_GAP_MM)) / 2;
  return columnWidth - mmToPx(CARD_PADDING_MM) * 2 - mmToPx(CARD_BORDER_ALLOWANCE_MM);
}

function boilerplateInnerWidthPx(contentWidthPx) {
  return contentWidthPx - mmToPx(BOILERPLATE_PADDING_MM) * 2;
}

// JS twin of markdown_lite_html() in pdf_builder.py -- keep both in sync if
// you touch the rules. Escapes first, so raw HTML in a note can never leak
// into the preview.
function markdownLite(text) {
  const escaped = escapeHtml(text || "");
  const inline = (s) =>
    s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>")
      .replace(/_(.+?)_/g, "<em>$1</em>");
  return escaped
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!lines.length) return "";
      if (lines.every((l) => /^[-*]\s+/.test(l))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.slice(2).trim())}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

function formulasHtml(formulas, standalone) {
  if (!formulas || !formulas.length) return "";
  const items = formulas
    .map((f) =>
      f.img
        ? `<img class="card-formula-img${standalone ? " card-formula-img-lg" : ""}" src="${f.img}" alt="formula">`
        : `<span class="card-formula-raw">${escapeHtml(f.latex || "")}</span>`
    )
    .join("");
  return `<div class="card-formulas${standalone ? " card-formulas-standalone" : ""}">${items}</div>`;
}

function cardHtml(s, topic, cardWidthPx, isFirstInTopic) {
  const kind = s.kind || "code";
  const titleHtml = `<span class="card-title">${escapeHtml(s.title)}</span>`;
  const subtitleHtml = (s.subtitle || "").trim() ? `<p class="card-subtitle">${escapeHtml(s.subtitle)}</p>` : "";

  const headerHtml = isFirstInTopic ? `
    <div class="card-topic-title" style="--th-color:${topic.color}">
      ${escapeHtml(topic.name).toUpperCase()}
    </div>
  ` : "";

  let innerCard = "";
  if (kind === "note") {
    innerCard = `
      <div class="card card-note" style="border-left-color:${topic.color}">
        ${headerHtml}
        <div class="card-head">${titleHtml}</div>
        ${subtitleHtml}
        <div class="card-note-body">${markdownLite(s.notes)}</div>
      </div>
    `;
  } else if (kind === "formula") {
    innerCard = `
      <div class="card card-formula-card" style="border-left-color:${topic.color}">
        ${headerHtml}
        <div class="card-head">${titleHtml}</div>
        ${subtitleHtml}
        ${formulasHtml(s.formulas, true)}
      </div>
    `;
  } else {
    const notesHtml = (s.notes || "").trim() ? `<p class="card-notes">${escapeHtml(s.notes)}</p>` : "";
    const fontFamily = state.settings.code_font || "JetBrains Mono";
    const fontSize = cardWidthPx ? fitCodeFontSize(s.code, fontFamily, cardWidthPx) : CODE_FONT_BASE_SIZE;
    const lang = s.language || "cpp";
    innerCard = `
      <div class="card${s.verified ? "" : " unverified"}" style="border-left-color:${topic.color}">
        ${headerHtml}
        <div class="card-head">
          ${titleHtml}
          <span class="card-complexity">${escapeHtml(s.complexity)}</span>
        </div>
        ${subtitleHtml}
        ${notesHtml}
        ${formulasHtml(s.formulas, false)}
        <pre class="card-code" style="font-size:${fontSize}px"><code class="language-${lang}">${escapeHtml(s.code)}</code></pre>
      </div>
    `;
  }

  // We still use snippet-container to group elements if needed (or just as a wrapper for consistent margins)
  return `
    <div class="snippet-container">
      ${innerCard}
    </div>
  `;
}

function headerLeftHtml() {
  const on = state.settings.show_team_footer;
  const enabled = !(on === false || on === 0 || on === "0");
  const bits = [state.settings.institution_name, state.settings.team_name]
    .map((v) => (v || "").trim())
    .filter(Boolean);
  if (!enabled || bits.length === 0) return "";
  return `<span class="page-header-left">${escapeHtml(bits.join(" \u2014 "))}</span>`;
}

// Split arbitrary plain text (the boilerplate) into page-sized chunks by
// rendering it line-by-line off-screen, the same overflow-detection idea
// used for topic cards.
function buildTextPageChunks(text, metrics) {
  const measureDiv = document.createElement("pre");
  measureDiv.className = "boilerplate-code";
  measureDiv.style.position = "fixed";
  measureDiv.style.visibility = "hidden";
  measureDiv.style.top = "-99999px";
  measureDiv.style.left = "0";
  measureDiv.style.width = metrics.contentWidthPx + "px";
  document.body.appendChild(measureDiv);

  const lines = text.split("\n");
  const pages = [];
  let current = [];

  lines.forEach((line) => {
    const next = current.concat(line);
    measureDiv.textContent = next.join("\n");
    if (measureDiv.scrollHeight > metrics.availableHeightPx && current.length > 0) {
      pages.push(current);
      current = [line];
      measureDiv.textContent = line;
    } else {
      current = next;
    }
  });
  if (current.length) pages.push(current);

  document.body.removeChild(measureDiv);
  return pages.map((lns) => lns.join("\n"));
}

// JS twin of _cover_html() in pdf_builder.py -- keep both in sync if you
// touch the markup. Each style is genuinely different markup, not just a
// CSS reskin, so the preview matches what the PDF actually produces.
function coverPageHtml(style, bookTitle, teamName, institutionName) {
  const title = escapeHtml(bookTitle);
  const team = escapeHtml(teamName);
  const inst = escapeHtml(institutionName);
  const instHtml = inst ? `<p class="cover-inst">${inst}</p>` : "";

  if (style === "banner") {
    return `
      <div class="cover-banner-content">
        ${instHtml}
        <div class="cover-banner-rule"></div>
        <h1>${title}</h1>
        <p class="cover-team">${team}</p>
      </div>`;
  }
  if (style === "frame") {
    return `
      <div class="cover-frame-border">
        ${instHtml}
        <div class="cover-frame-rule"></div>
        <h1>${title}</h1>
        <div class="cover-frame-rule"></div>
        <p class="cover-team">${team}</p>
      </div>`;
  }
  if (style === "terminal") {
    let rows = "";
    if (inst) {
      rows += `<p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> cat institution.txt</p><p class="cover-term-line cover-term-out">${inst}</p>`;
    }
    rows += `<p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> whoami</p><p class="cover-term-line cover-term-out">${team}</p>`;
    return `
      <div class="cover-term-window">
        <div class="cover-term-titlebar">
          <span class="cover-term-btn"></span>
          <span class="cover-term-btn"></span>
          <span class="cover-term-btn"></span>
        </div>
        <div class="cover-term-body">
          <p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> cat title.txt</p>
          <p class="cover-term-line cover-term-out cover-term-title-out">${title}</p>
          ${rows}
          <p class="cover-term-line"><span class="cover-term-prompt-sym">$</span> <span class="cover-term-cursor">&#9608;</span></p>
        </div>
      </div>`;
  }
  if (style === "geometric") {
    return `
      <div class="cover-geo-mark"></div>
      <div class="cover-geo-text">
        ${instHtml}
        <h1>${title}</h1>
        <div class="cover-geo-rule"></div>
        <p class="cover-team">${team}</p>
      </div>`;
  }
  if (style === "sketch") {
    return `
      <div class="cover-sketch">
        <!-- Wobbly hand-drawn border -->
        <svg class="cover-sketch-border" viewBox="0 0 520 740" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
          <path d="M18,12 Q130,8 260,10 T502,14 Q506,180 504,370 T500,726 Q380,730 260,728 T18,724 Q14,560 16,370 T18,12 Z"
            fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
            stroke-dasharray="none" opacity="0.55"/>
          <path d="M28,22 Q140,19 260,21 T492,25 Q495,185 493,370 T490,716 Q375,719 260,717 T28,714 Q25,555 27,370 T28,22 Z"
            fill="none" stroke="currentColor" stroke-width="0.8" stroke-linecap="round" opacity="0.25"/>
        </svg>

        <!-- Background code-doodle decorations -->
        <div class="cover-sketch-doodles" aria-hidden="true">
          <span class="csd csd-1">{</span>
          <span class="csd csd-2">}</span>
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

        <!-- Center content block -->
        <div class="cover-sketch-body">
          <div class="cover-sketch-eyebrow">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>
            <span>Contest Notebook</span>
          </div>

          <h1 class="cover-sketch-title">${title}</h1>

          <div class="cover-sketch-rule"></div>

          <div class="cover-sketch-meta">
            ${inst ? `<p class="cover-sketch-inst">${inst}</p>` : ""}
            <p class="cover-sketch-team">${team}</p>
          </div>

          <!-- Small hand-drawn decorative bracket doodle -->
          <svg class="cover-sketch-bracket" width="40" height="28" viewBox="0 0 40 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
            <path d="M12,4 Q8,4 7,8 T7,20 Q7,24 12,24"/>
            <path d="M28,4 Q32,4 33,8 T33,20 Q33,24 28,24"/>
          </svg>
        </div>
      </div>`;
  }
  return `
    ${instHtml}
    <h1>${title}</h1>
    <p class="cover-team">${team}</p>
    <div class="cover-minimal-rule"></div>`;
}

function renderPreview() {
  const root = $("preview-scroll");
  root.innerHTML = "";

  const bookTitle = state.settings.book_title || "Contest Codebook";
  const teamName = state.settings.team_name || "MEC_ALGO_SCHOLARS";
  const instName = state.settings.institution_name || "Mymensingh Engineering College";
  const coverStyle = state.settings.cover_style || "minimal";
  const topicsWithSnippets = state.topics.filter((t) => t.snippets.length > 0);
  const headerLeft = headerLeftHtml();

  // Page 1: cover -- one of five selectable styles, see coverPageHtml().
  const cover = document.createElement("div");
  cover.className = `a4-page cover-page cover-${coverStyle}`;
  cover.dataset.label = "Cover";
  const showEmptyNote = topicsWithSnippets.length === 0 && !state.settings.boilerplate_code;
  cover.innerHTML = `
    ${coverPageHtml(coverStyle, bookTitle, teamName, instName)}
    ${showEmptyNote ? `
      <div class="empty-state-doodle">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2c.5.5 1 1.5 2 3 1.5-1 3.5-1.5 5 0 2 2 1 6-1 8-1.5 1.5-4 1-5 0-1-1-1.5-3.5-1-5M2 14l5-5 5 5M2 22l10-10"/>
        </svg>
        <p class="empty-page-note">Notebook is empty... add a topic to begin!</p>
      </div>
    ` : ""}
    ${headerLeft}
    <span class="page-number">1</span>
  `;
  root.appendChild(cover);

  const metrics = measurePageMetrics();
  const cardWidthPx = cardInnerWidthPx(metrics.contentWidthPx);
  const boilerplateWidthPx = boilerplateInnerWidthPx(metrics.contentWidthPx);
  const fontFamily = state.settings.code_font || "JetBrains Mono";
  let pageNum = 2;

  // Page 2 (if enabled): the pinned boilerplate/starter template, right after
  // the cover. No topic/template index page -- removed as unnecessary.
  const showBoilerplate = !(state.settings.show_boilerplate === false || state.settings.show_boilerplate === 0 || state.settings.show_boilerplate === "0");
  const boilerplateCode = (state.settings.boilerplate_code || "").trim();
  if (showBoilerplate && boilerplateCode) {
    const chunks = buildTextPageChunks(boilerplateCode, metrics);
    chunks.forEach((chunkText, idx) => {
      const page = document.createElement("div");
      page.className = "a4-page template-page";
      page.dataset.label = "Template";
      const label = "TEMPLATE" + (chunks.length > 1 ? ` — PART ${idx + 1}/${chunks.length}` : "");
      const fontSize = fitCodeFontSize(chunkText, fontFamily, boilerplateWidthPx);
      page.innerHTML = `
        <div class="snippet-container" style="height: calc(100% - 20px);">
          <div class="card" style="border-left-color: var(--template-accent); height: 100%; display: flex; flex-direction: column;">
            <div class="card-topic-title" style="--th-color: var(--template-accent);">
              ${label}
            </div>
            <pre class="card-code" style="font-size:${fontSize}px; flex: 1;"><code class="language-cpp">${escapeHtml(chunkText)}</code></pre>
          </div>
        </div>
        ${headerLeft}
        <span class="page-number">${pageNum}</span>
      `;
      root.appendChild(page);
      pageNum++;
    });
  }

  if (topicsWithSnippets.length === 0) return;

  const pages = buildContinuousPages(topicsWithSnippets, metrics);

  const gapPx = 8 * 3.779527559; // 8mm to px
  const colWidth = Math.floor((metrics.contentWidthPx - gapPx) / 2);

  // Topic pages -- explicitly packed to perfectly balance filling columns without Blink engine bugs
  pages.forEach((page) => {
    const domPage = document.createElement("div");
    domPage.className = "a4-page topic-page";
    
    // Use the first item's topic name for the thumbnail label
    const firstItem = page.col1.length > 0 ? page.col1[0] : (page.col2.length > 0 ? page.col2[0] : null);
    domPage.dataset.label = firstItem ? firstItem.topic.name : `Page ${pageNum}`;
    
    function renderCol(items) {
      return items.map(item => item.html).join("");
    }

    domPage.innerHTML = `
      <div style="display: flex; gap: ${gapPx}px; height: ${metrics.availableHeightPx}px;">
        <div class="page-column" style="width: ${colWidth}px; display: flex; flex-direction: column;">
          ${renderCol(page.col1)}
        </div>
        <div class="page-column" style="width: ${colWidth}px; display: flex; flex-direction: column;">
          ${renderCol(page.col2)}
        </div>
      </div>
      ${headerLeft}
      <span class="page-number">${pageNum}</span>
    `;
    root.appendChild(domPage);
    pageNum++;
  });

  // Syntax-highlight the code just inserted (P1.2) -- same restrained
  // palette as the printed PDF, see the .token.* rules in style.css.
  if (typeof Prism !== "undefined") Prism.highlightAllUnder(root);
  renderThumbnails();
  updatePreviewScale();
}

// ---------------- MINIMAP / THUMBNAILS ----------------

function renderThumbnails() {
  const rail = $("thumbnails-rail");
  if (!rail) return;
  rail.innerHTML = "";
  
  const pages = document.querySelectorAll(".preview-scroll .a4-page");
  if (pages.length === 0) return;
  
  pages.forEach((pageEl, idx) => {
    const wrapper = document.createElement("div");
    wrapper.className = "thumbnail-wrapper";

    const thumb = document.createElement("div");
    thumb.className = "thumbnail-item";
    if (idx === 0) thumb.classList.add("active");
    
    // Create a live miniature clone of the page
    const clone = pageEl.cloneNode(true);
    // Force absolute layout isolation so the clone doesn't get squished by the small container
    const pw = mmToPx(state.settings?.page_size === "Letter" ? 215.9 : 210) || 793.7;
    const ph = mmToPx(state.settings?.page_size === "Letter" ? 279.4 : 297) || 1122.5;
    
    clone.style.setProperty("width", pw + "px", "important");
    clone.style.setProperty("height", ph + "px", "important");
    clone.style.setProperty("min-width", pw + "px", "important");
    clone.style.setProperty("min-height", ph + "px", "important");
    clone.style.setProperty("max-width", pw + "px", "important");
    clone.style.setProperty("max-height", ph + "px", "important");
    clone.style.setProperty("margin", "0", "important");
    clone.style.setProperty("box-shadow", "none", "important");
    clone.style.setProperty("position", "absolute", "important");
    clone.style.setProperty("top", "0", "important");
    clone.style.setProperty("left", "0", "important");
    clone.style.setProperty("transform-origin", "top left", "important");
    clone.style.setProperty("pointer-events", "none", "important");
    
    // We will calculate scale dynamically in a second pass
    thumb.appendChild(clone);
    
    thumb.addEventListener("click", () => {
      pageEl.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    
    wrapper.appendChild(thumb);
    rail.appendChild(wrapper);
  });
  
  // Second pass: Now that all thumbnails are in the DOM, any potential vertical scrollbar
  // on the thumbnails rail has been triggered. This means thumb.clientWidth is now the TRUE final width.
  const thumbs = rail.querySelectorAll(".thumbnail-item");
  if (thumbs.length > 0) {
    let actualW = thumbs[0].clientWidth;
    if (!actualW || actualW === 0) actualW = 70; // Fallback
    const pw = mmToPx(state.settings?.page_size === "Letter" ? 215.9 : 210) || 793.7;
    const scale = actualW / pw;
    
    const clones = rail.querySelectorAll(".thumbnail-item .a4-page");
    clones.forEach(clone => {
      clone.style.setProperty("transform", `scale(${scale})`, "important");
    });
  }
}

function initMinimapScrollSync() {
  const previewArea = $("preview-area");
  if (!previewArea) return;
  
  previewArea.addEventListener("scroll", () => {
    const pages = document.querySelectorAll(".preview-scroll .a4-page");
    const thumbs = document.querySelectorAll(".thumbnails-rail .thumbnail-item");
    if (pages.length === 0 || thumbs.length === 0) return;
    
    let closestIdx = 0;
    let minDistance = Infinity;
    const viewportCenter = previewArea.getBoundingClientRect().top + (previewArea.clientHeight / 2);
    
    pages.forEach((pageEl, idx) => {
      const rect = pageEl.getBoundingClientRect();
      const pageCenter = rect.top + (rect.height / 2);
      const distance = Math.abs(viewportCenter - pageCenter);
      if (distance < minDistance) {
        minDistance = distance;
        closestIdx = idx;
      }
    });
    
    thumbs.forEach((thumb, idx) => {
      if (idx === closestIdx) {
        thumb.classList.add("active");
      } else {
        thumb.classList.remove("active");
      }
    });
  });
}

// Measure how much vertical room a topic page has for cards, and how wide
// the 2-column card area is, so we can split overflow onto new pages instead
// of stretching a single page taller than the real printed page.
function measurePageMetrics() {
  const probe = document.createElement("div");
  probe.className = "a4-page topic-page";
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.top = "-99999px";
  probe.style.left = "0";
  probe.innerHTML = `
    <div class="card-columns"></div>
    <span class="page-number">0</span>
  `;
  document.body.appendChild(probe);

  const pageRect = probe.getBoundingClientRect();
  const pageStyle = getComputedStyle(probe);

  const paddingTop = parseFloat(pageStyle.paddingTop);
  const paddingBottom = parseFloat(pageStyle.paddingBottom);
  const paddingLeft = parseFloat(pageStyle.paddingLeft);
  const paddingRight = parseFloat(pageStyle.paddingRight);

  // No reserve needed, padding already provides space.
  const reserve = 0;
  const availableHeightPx = pageRect.height - paddingTop - paddingBottom - reserve;
  const contentWidthPx = pageRect.width - paddingLeft - paddingRight;

  document.body.removeChild(probe);
  return { availableHeightPx, contentWidthPx };
}



function buildContinuousPages(topics, metrics) {
  const cardW = cardInnerWidthPx(metrics.contentWidthPx);
  const gapPx = 8 * 3.779527559; // 8mm to px
  const colWidth = Math.floor((metrics.contentWidthPx - gapPx) / 2);
  const maxH = metrics.availableHeightPx;

  const measureDiv = document.createElement("div");
  measureDiv.style.cssText = `position: fixed; visibility: hidden; top: -99999px; left: 0; width: ${colWidth}px;`;
  document.body.appendChild(measureDiv);

  const mbPx = 4 * 3.7795;
  const fontFamily = state.settings.code_font || "JetBrains Mono";
  
  const pages = [];
  let pageData = { col1: [], col2: [] };
  let currentColumnHeight = 0;
  let isLeftCol = true;

  function newColumn() {
    if (isLeftCol) {
      isLeftCol = false;
    } else {
      pages.push(pageData);
      pageData = { col1: [], col2: [] };
      isLeftCol = true;
    }
    currentColumnHeight = 0;
  }

  topics.forEach(topic => {
    let isFirstInTopic = true;

    // 2. Measure and place all snippets for this topic
    topic.snippets.forEach(s => {
      measureDiv.innerHTML = cardHtml(s, topic, cardW, isFirstInTopic);
      let h = measureDiv.firstElementChild.getBoundingClientRect().height + mbPx;

      // The last snippet in a column will have its margin-bottom removed.
      // So the effective remaining space is larger by mbPx.
      const remainingSpace = maxH + mbPx - currentColumnHeight;

      if (h <= remainingSpace) {
        const sClone = { ...s, font_size: fitCodeFontSize(s.code, fontFamily, cardW) };
        const item = { type: "snippet", html: cardHtml(sClone, topic, cardW, isFirstInTopic), height: h, topic: topic, snippet: sClone };
        if (isLeftCol) pageData.col1.push(item);
        else pageData.col2.push(item);
        currentColumnHeight += h;
        isFirstInTopic = false;
        return;
      }

      if (s.kind !== "code" || !s.code) {
        newColumn();
        const sClone = { ...s };
        const item = { type: "snippet", html: cardHtml(sClone, topic, cardW, isFirstInTopic), height: h, topic: topic, snippet: sClone };
        if (isLeftCol) pageData.col1.push(item);
        else pageData.col2.push(item);
        currentColumnHeight = h;
        isFirstInTopic = false;
        return;
      }

      const lines = s.code.split("\n");
      let startIdx = 0;
      let currentPart = 1;

      while (startIdx < lines.length) {
        let spaceForThisPart = maxH + mbPx - currentColumnHeight;
        if (spaceForThisPart < 60) {
          newColumn();
          spaceForThisPart = maxH + mbPx;
        }

        let passIsFirst = isFirstInTopic && currentPart === 1;
        let low = startIdx + 1;
        let high = lines.length;
        let bestEnd = startIdx;

        const baseS = { ...s };
        if (currentPart > 1) {
          baseS.title = `${s.title} (cont.)`;
          baseS.subtitle = "";
          baseS.notes = ""; 
        }

        baseS.code = lines.slice(startIdx, lines.length).join("\n");
        baseS.font_size = fitCodeFontSize(baseS.code, fontFamily, cardW);
        measureDiv.innerHTML = cardHtml(baseS, topic, cardW, passIsFirst);
        let fullH = measureDiv.firstElementChild.getBoundingClientRect().height + mbPx;
        
        if (fullH <= spaceForThisPart) {
          const item = { type: "snippet", html: cardHtml(baseS, topic, cardW, passIsFirst), height: fullH, topic: topic, snippet: baseS };
          if (isLeftCol) pageData.col1.push(item);
          else pageData.col2.push(item);
          currentColumnHeight += fullH;
          break;
        }

        while (low <= high) {
          let mid = Math.floor((low + high) / 2);
          baseS.code = lines.slice(startIdx, mid).join("\n");
          baseS.font_size = fitCodeFontSize(baseS.code, fontFamily, cardW);
          measureDiv.innerHTML = cardHtml(baseS, topic, cardW, passIsFirst);
          let currentH = measureDiv.firstElementChild.getBoundingClientRect().height + mbPx;

          if (currentH <= spaceForThisPart) {
            bestEnd = mid;
            low = mid + 1;
          } else {
            high = mid - 1;
          }
        }

        if (bestEnd === startIdx) {
          newColumn();
          continue;
        }

        baseS.code = lines.slice(startIdx, bestEnd).join("\n");
        baseS.font_size = fitCodeFontSize(baseS.code, fontFamily, cardW);
        measureDiv.innerHTML = cardHtml(baseS, topic, cardW, passIsFirst);
        let finalH = measureDiv.firstElementChild.getBoundingClientRect().height + mbPx;

        const item = { type: "snippet", html: cardHtml(baseS, topic, cardW, passIsFirst), height: finalH, topic: topic, snippet: baseS };
        if (isLeftCol) pageData.col1.push(item);
        else pageData.col2.push(item);
        
        startIdx = bestEnd;
        newColumn();
        currentPart++;
      }
      isFirstInTopic = false;
    });
  });

  if (pageData.col1.length > 0 || pageData.col2.length > 0) {
    pages.push(pageData);
  }

  document.body.removeChild(measureDiv);
  return pages;
}
// ---------------- FORMULA ROWS (math typesetting, live) ----------------

const formulaDebounceTimers = new WeakMap();

function renderFormulaPreview(previewEl, img, error, latex) {
  if (img) {
    previewEl.innerHTML = `<img src="${img}" alt="formula preview">`;
  } else if (error) {
    previewEl.innerHTML = `<span class="formula-error">Couldn't render: ${escapeHtml(error)}</span>`;
  } else if ((latex || "").trim()) {
    previewEl.innerHTML = `<span class="formula-placeholder">Rendering…</span>`;
  } else {
    previewEl.innerHTML = `<span class="formula-placeholder">Type a formula to preview it</span>`;
  }
}

async function refreshFormulaRowPreview(row) {
  const input = row.querySelector(".formula-latex-input");
  const previewEl = row.querySelector(".formula-row-preview");
  const latex = input.value.trim();
  if (!latex) {
    row.dataset.img = "";
    row.dataset.error = "";
    renderFormulaPreview(previewEl, null, null, "");
    livePreviewWhileEditing();
    return;
  }
  renderFormulaPreview(previewEl, null, null, latex); // shows "Rendering…"
  try {
    const res = await fetch("/api/render_formula", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ latex, kind: $("snippet-kind").value }),
    });
    const data = await res.json();
    if (input.value.trim() !== latex) return; // input changed again while this was in flight
    row.dataset.img = data.img || "";
    row.dataset.error = data.error || "";
    renderFormulaPreview(previewEl, data.img, data.error, latex);
  } catch (e) {
    row.dataset.img = "";
    row.dataset.error = "Couldn't reach the server";
    renderFormulaPreview(previewEl, null, row.dataset.error, latex);
  }
  livePreviewWhileEditing();
}

function createFormulaRow(latex, img, error) {
  const row = document.createElement("div");
  row.className = "formula-row";
  row.dataset.img = img || "";
  row.dataset.error = error || "";
  row.innerHTML = `
    <div class="formula-row-input">
      <input type="text" class="formula-latex-input" placeholder="e.g. \\frac{n(n+1)}{2}" value="${escapeHtml(latex || "")}">
      <div class="formula-row-preview"></div>
    </div>
    <button type="button" class="formula-row-remove" title="Remove formula">&times;</button>
  `;
  const previewEl = row.querySelector(".formula-row-preview");
  const input = row.querySelector(".formula-latex-input");
  renderFormulaPreview(previewEl, img, error, latex);

  input.addEventListener("input", () => {
    clearTimeout(formulaDebounceTimers.get(row));
    formulaDebounceTimers.set(row, setTimeout(() => refreshFormulaRowPreview(row), 350));
  });

  row.querySelector(".formula-row-remove").addEventListener("click", () => {
    row.remove();
    livePreviewWhileEditing();
  });

  return row;
}

function addFormulaRow(latex, img, error, focus) {
  const row = createFormulaRow(latex, img, error);
  $("snippet-formulas-list").appendChild(row);
  if (focus) row.querySelector(".formula-latex-input").focus();
  return row;
}

// Latex-only list, sent on save -- the backend re-renders authoritatively.
function collectFormulaLatexList() {
  return Array.from($("snippet-formulas-list").querySelectorAll(".formula-latex-input"))
    .map((el) => el.value.trim())
    .filter(Boolean);
}

// Latex + whatever's already been rendered client-side, used for the
// instant in-modal preview so it doesn't wait on a save round-trip.
function collectFormulaDraftList() {
  return Array.from($("snippet-formulas-list").querySelectorAll(".formula-row"))
    .map((row) => ({
      latex: row.querySelector(".formula-latex-input").value.trim(),
      img: row.dataset.img || null,
    }))
    .filter((f) => f.latex);
}

// ---------------- DUPLICATE / NEAR-DUPLICATE DETECTION (P1.6) ----------------

let similarityDebounce = null;

function scheduleSimilarityCheck() {
  clearTimeout(similarityDebounce);
  similarityDebounce = setTimeout(runSimilarityCheck, 500);
}

async function runSimilarityCheck() {
  const warningEl = $("similarity-warning");
  if ($("snippet-kind").value !== "code") {
    warningEl.style.display = "none";
    return;
  }
  const code = getCode();
  const topicId = $("snippet-topic").value;
  if (!code.trim() || !topicId) {
    warningEl.style.display = "none";
    return;
  }
  try {
    const res = await fetch("/api/check_similar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, topic_id: topicId, exclude_id: editingSnippetId, kind: "code" }),
    });
    const data = await res.json();
    if (!data.matches || !data.matches.length) {
      warningEl.style.display = "none";
      return;
    }
    const names = data.matches.map((m) => `"${escapeHtml(m.title)}"`).join(", ");
    warningEl.innerHTML = `This looks similar to ${names} already in this topic — still save as new?`;
    warningEl.style.display = "flex";
  } catch (e) {
    // Non-blocking by design (P1.6) -- if the check fails, just skip it silently.
  }
}

// ---------------- SNIPPET MODAL ----------------

const KIND_LABELS = { code: "template", note: "note", formula: "formula sheet" };

// Shows/hides every field group marked with data-show-for="kind1,kind2" to
// match the currently selected card type. Title/subtitle stay visible for
// all kinds since every card type has them.
function applyKindVisibility(kind) {
  document.querySelectorAll("[data-show-for]").forEach((el) => {
    const kinds = el.dataset.showFor.split(",");
    el.style.display = kinds.includes(kind) ? "" : "none";
  });
  $("snippet-modal-title").textContent = (editingSnippetId ? "Edit " : "Add ") + KIND_LABELS[kind];
  const label = $("snippet-notes-label");
  if (kind === "note") {
    label.childNodes[0].textContent = "Content";
    $("snippet-notes").placeholder = "Markdown-ish: **bold**, *italic*, and \"- \" bullet lists.";
  } else {
    label.childNodes[0].textContent = "Notes / explanation";
    $("snippet-notes").placeholder = "Plain-text explanation shown above the code (not monospaced)";
  }
}

function openSnippetModal(snippet, defaultTopicId) {
  editingSnippetId = snippet ? snippet.id : null;
  const kind = snippet && snippet.kind ? snippet.kind : "code";
  $("snippet-kind").value = kind;
  $("snippet-id").value = snippet ? snippet.id : "";
  $("snippet-title").value = snippet ? snippet.title : "";
  $("snippet-subtitle").value = snippet ? snippet.subtitle : "";
  $("snippet-complexity").value = snippet ? snippet.complexity : "";
  $("snippet-notes").value = snippet ? snippet.notes : "";
  $("snippet-tested-on").value = snippet ? snippet.tested_on : "";
  $("snippet-language").value = snippet && snippet.language ? snippet.language : "cpp";

  initCodeEditor();
  setCodeEditorLanguage($("snippet-language").value);
  setCode(snippet ? snippet.code : "");
  $("similarity-warning").style.display = "none";

  $("snippet-formulas-list").innerHTML = "";
  (snippet && snippet.formulas ? snippet.formulas : []).forEach((f) => {
    addFormulaRow(f.latex, f.img, f.error);
  });
  $("snippet-verified").checked = snippet ? !!snippet.verified : false;
  $("snippet-delete-btn").style.display = snippet ? "inline-flex" : "none";

  const topicOptions = state.topics.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  const topicValue = snippet ? snippet.topic_id : (defaultTopicId || (state.topics[0] && state.topics[0].id));
  $("snippet-topic").innerHTML = topicOptions;
  $("snippet-topic").value = topicValue;
  $("snippet-topic-alt").innerHTML = topicOptions;
  $("snippet-topic-alt").value = topicValue;

  applyKindVisibility(kind);
  $("snippet-modal-backdrop").classList.add("open");
  // CodeMirror can't measure itself while its container is display:none --
  // refresh once it's actually visible so line numbers/wrapping are correct.
  requestAnimationFrame(() => { if (codeEditor) codeEditor.refresh(); });
}

function closeSnippetModal() {
  $("snippet-modal-backdrop").classList.remove("open");
  editingSnippetId = null;
}

async function saveSnippet(e) {
  e.preventDefault();
  const kind = $("snippet-kind").value;
  const topicId = kind === "code" ? $("snippet-topic").value : $("snippet-topic-alt").value;
  const payload = {
    kind,
    title: $("snippet-title").value.trim() || "Untitled",
    subtitle: $("snippet-subtitle").value.trim(),
    complexity: $("snippet-complexity").value.trim(),
    topic_id: topicId,
    code: kind === "code" ? getCode() : "",
    notes: (kind === "code" || kind === "note") ? $("snippet-notes").value : "",
    formulas: (kind === "code" || kind === "formula") ? collectFormulaLatexList() : [],
    tested_on: $("snippet-tested-on").value.trim(),
    verified: $("snippet-verified").checked,
    language: $("snippet-language").value,
    sort_order: 100,
  };
  if (editingSnippetId) {
    await fetch(`/api/snippet/${editingSnippetId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } else {
    await fetch("/api/snippet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
  closeSnippetModal();
  loadState();
}

async function deleteSnippet() {
  if (!editingSnippetId) return;
  const title = $("snippet-title").value.trim() || "this template";
  const ok = await showConfirm("Delete this template?", `"${title}" will move to Recently deleted for 30 days, then be removed for good.`, "Delete template");
  if (!ok) return;
  await fetch(`/api/snippet/${editingSnippetId}`, { method: "DELETE" });
  closeSnippetModal();
  loadState();
}

// ---------------- TOPIC MODAL ----------------

function openTopicModal() {
  $("topic-name").value = "";
  $("topic-color").value = "#5E85A6";
  updatePaletteActiveState("topic-color", "#5E85A6");
  $("topic-modal-backdrop").classList.add("open");
  $("topic-name").focus();
}

function closeTopicModal() {
  $("topic-modal-backdrop").classList.remove("open");
}

async function saveTopic(e) {
  e.preventDefault();
  const res = await fetch("/api/topic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: $("topic-name").value.trim(), color: $("topic-color").value }),
  });
  const data = await res.json();
  if (!data.ok) {
    setStatus(data.error, "error");
    return;
  }
  closeTopicModal();
  loadState();
}

// ---------------- BOOK SETTINGS (auto-save on blur) ----------------

async function saveSettings() {
  state.settings.book_title = $("book-title").value;
  state.settings.institution_name = $("institution-name").value;
  state.settings.team_name = $("team-name").value;
  state.settings.code_font = $("code-font").value;
  state.settings.code_theme = $("code-theme").value;
  state.settings.page_size = $("page-size").value;
  state.settings.accent_color = $("accent-color").value;
  state.settings.template_accent_color = $("template-accent-color").value;
  state.settings.cover_style = $("cover-style").value;
  state.settings.show_team_footer = $("show-team-footer").checked;
  state.settings.show_boilerplate = $("show-boilerplate").checked;
  state.settings.boilerplate_code = $("boilerplate-code").value;

  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      book_title: state.settings.book_title,
      institution_name: state.settings.institution_name,
      team_name: state.settings.team_name,
      code_font: state.settings.code_font,
      code_theme: state.settings.code_theme,
      page_size: state.settings.page_size,
      accent_color: state.settings.accent_color,
      template_accent_color: state.settings.template_accent_color,
      cover_style: state.settings.cover_style,
      show_team_footer: state.settings.show_team_footer,
      show_boilerplate: state.settings.show_boilerplate,
      boilerplate_code: state.settings.boilerplate_code,
    }),
  });
  applyThemeSettings();
  renderPreview();
}

// ---------------- BUILD ----------------



/**
 * Fetch the app's own stylesheet text so we can inline it into the
 * self-contained HTML document sent to Chrome headless. We cache the result
 * so subsequent builds don't make another network round-trip.
 */
let _cachedStyleText = null;
async function _getStyleText() {
  if (_cachedStyleText) return _cachedStyleText;
  // Fetch the live stylesheet (style.css) from the server
  const res = await fetch("/static/style.css");
  _cachedStyleText = await res.text();
  return _cachedStyleText;
}

/**
 * Serialize the current live preview into a complete self-contained HTML
 * document that Chrome headless can print to PDF.
 *
 * The document:
 *  - Inlines style.css (so Chrome doesn't need a running server to load it)
 *  - References Google Fonts and Prism.js CDN URLs (Chrome headless has internet)
 *  - Contains the exact innerHTML of #preview-scroll (all .a4-page divs)
 *  - Uses @media print rules (already in style.css) to make each .a4-page
 *    print as one physical page
 */
async function buildPreviewHtml(excludeUnverified) {
  const previewEl = $("preview-scroll");
  const pageCount = previewEl.querySelectorAll(".a4-page").length;
  const styleText = await _getStyleText();

  // ── Clone the live preview DOM so we can modify it without touching the screen ──
  const clone = previewEl.cloneNode(true);

  // ── Bake computed background-color as inline styles on every element ──────────
  // Chrome headless --print-to-pdf strips CSS background colors even with
  // print-color-adjust:exact. The only 100% reliable fix is to embed the actual
  // computed color as an inline style so it's in the HTML, not in a stylesheet.
  const liveEls  = previewEl.querySelectorAll("*");
  const cloneEls = clone.querySelectorAll("*");
  liveEls.forEach((el, i) => {
    const bg = window.getComputedStyle(el).backgroundColor;
    // Only set if not transparent (saves bytes and avoids overriding intentional whites)
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
      cloneEls[i].style.backgroundColor = bg;
    }
    // Also bake text color (token colors for syntax highlighting)
    const color = window.getComputedStyle(el).color;
    if (color) {
      cloneEls[i].style.color = color;
    }
    // Bake border-left-color (card accent stripe)
    const borderLeft = window.getComputedStyle(el).borderLeftColor;
    if (borderLeft && borderLeft !== "rgba(0, 0, 0, 0)") {
      cloneEls[i].style.borderLeftColor = borderLeft;
    }
  });

  const pagesHtml = clone.innerHTML;

  // Bake accent-color CSS variables so headless Chrome resolves them correctly
  const accent = state.settings.accent_color || "#2C2C2A";
  const templateAccent = state.settings.template_accent_color || accent;
  const accentVars = `
    :root {
      --accent: ${accent};
      --template-accent: ${templateAccent};
    }
  `;

  const codeTheme = state.settings.code_theme || "cream";

  const html = `<!DOCTYPE html>
<html data-code-theme="${codeTheme}">
<head>
  <meta charset="utf-8">
  <title>Codebook</title>
  <!-- Google Fonts: same as live preview -->
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=IBM+Plex+Mono:wght@400;500&family=Space+Mono:wght@400;700&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <!-- Prism CSS only for base token formatting. NO Prism JS scripts here!
       The live preview DOM already has syntax highlighting applied (tokens are
       already <span class="token ..."> elements with baked inline colors).
       Running Prism.highlightAll() again would re-tokenize the code and create
       new spans without the baked colors, making PDF colors differ from preview. -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css">
  <style>
    /* Baked CSS variables + full stylesheet */
    ${accentVars}
    ${styleText}
  </style>
</head>
<body>
  <div class="app">
    <div class="preview-area">
      <div class="preview-scroll">
        ${pagesHtml}
      </div>
    </div>
  </div>
  <!-- No Prism re-run: colors are baked as inline styles in the HTML -->
</body>
</html>`;

  return { html, pageCount };
}

async function buildPdf() {
  const buildBtn = $("build-btn");
  const originalHtml = buildBtn.innerHTML;
  const originalWidth = buildBtn.offsetWidth;
  buildBtn.style.width = originalWidth + "px"; // lock width so it doesn't jump
  buildBtn.innerHTML = `<svg class="sketchy-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 2c5.52 0 10 4.48 10 10s-4.48 10-10 10S2 17.52 2 12c0-2.5 1-4.8 2.5-6.5"/></svg> Building...`;
  buildBtn.classList.add("disabled");
  
  setStatus("Building...", "");
  const excludeUnverified = $("exclude-unverified").checked;

  try {
    setStatus("Preparing pages...", "");
    const { html, pageCount } = await buildPreviewHtml(excludeUnverified);

    setStatus("Generating PDF (this may take a moment)...", "");
    const res = await fetch("/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exclude_unverified: excludeUnverified, html }),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.over_limit) {
        setStatus(`Built — ${data.page_count} pages. That's over the 25-page contest limit.`, "warning");
      } else {
        setStatus(`Built — ${data.page_count} page${data.page_count !== 1 ? "s" : ""}.`, "success");
      }
      setDownloadEnabled(true);
    } else {
      setStatus("Build failed: " + data.error, "error");
      setDownloadEnabled(false);
    }
  } catch (err) {
    setStatus("Build failed: " + err.message, "error");
    setDownloadEnabled(false);
  } finally {
    buildBtn.innerHTML = originalHtml;
    buildBtn.style.width = "";
    buildBtn.classList.remove("disabled");
  }
}

// The Download link used to be clickable even before any PDF existed,
// which crashed the server with a raw FileNotFoundError instead of telling
// the person what to do. Now it starts disabled and only lights up after a
// build actually succeeds in this session.
function setDownloadEnabled(enabled) {
  const link = $("download-link");
  link.classList.toggle("disabled", !enabled);
  link.setAttribute("aria-disabled", enabled ? "false" : "true");
  link.title = enabled ? "" : "Build the PDF first";
}

// ── Sketch Notebook Palette ────────────────────────────────────────────────
// 24 colors curated to feel like a quality ink / watercolour set:
// warm charcoals, earthy reds, sage greens, slate blues, dusty mauves,
// and amber ochres. Nothing synthetic, nothing neon.
// Organised in visual rows so the swatch grid reads like a colour chart.
const SKETCH_COLORS = [
  // ── Row 1: Ink / Charcoal spectrum ──
  "#2B2620",  // warm charcoal (default ink)
  "#3D3530",  // dark espresso
  "#5A5248",  // warm mid-grey
  "#8C7B6E",  // taupe
  // ── Row 2: Earthy reds & terracotta ──
  "#A0391E",  // deep terracotta
  "#C2543A",  // coral-brick  (current marker-coral)
  "#B8533D",  // burnt sienna
  "#8B3A3A",  // muted crimson
  // ── Row 3: Greens & sage ──
  "#4A6741",  // forest ink
  "#6E8F73",  // sage          (current marker-sage)
  "#7DA882",  // mint sage
  "#4E7A68",  // teal-sage
  // ── Row 4: Blues & slates ──
  "#3A5F7A",  // deep slate blue
  "#5E85A6",  // dusty sky     (current marker-sky)
  "#7296A8",  // muted denim
  "#4A6680",  // ink navy
  // ── Row 5: Dusty mauves & warm purples ──
  "#7A5C7A",  // dusty plum
  "#A07898",  // faded rose-mauve
  // ── Row 6: Amber, ochre & warmth ──
  "#A06B2A",  // amber ochre
  "#B4780C",  // golden amber  (current warn)
  "#8F6030",  // raw umber
  "#7A5C3A",  // coffee brown
  // ── Row 7: Warm neutral accent ──
  "#556B55",  // olive-grey
  "#6B6455",  // muted ink-brown
];

function renderColorPalettes() {
  document.querySelectorAll(".sketch-palette").forEach(palette => {
    const targetId = palette.dataset.target;
    const targetInput = $(targetId);
    if (!targetInput) return;
    
    palette.innerHTML = "";
    SKETCH_COLORS.forEach(color => {
      const swatch = document.createElement("div");
      swatch.className = "color-swatch";
      swatch.style.backgroundColor = color;
      swatch.dataset.color = color;
      
      swatch.addEventListener("click", () => {
        targetInput.value = color;
        updatePaletteActiveState(targetId, color);
        targetInput.dispatchEvent(new Event('input'));
        targetInput.dispatchEvent(new Event('change'));
        
        if (targetId === "color-popover-swatch") {
          commitPopoverColor();
        }
      });
      
      palette.appendChild(swatch);
    });
    
    // Add custom color swatch
    const customSwatch = document.createElement("div");
    customSwatch.className = "color-swatch color-swatch-custom";
    customSwatch.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
    customSwatch.title = "Custom color";
    
    customSwatch.addEventListener("click", () => {
      targetInput.showPicker ? targetInput.showPicker() : targetInput.click();
    });
    
    targetInput.addEventListener("input", () => {
      updatePaletteActiveState(targetId, targetInput.value);
      if (targetId === "color-popover-swatch") commitPopoverColor();
    });
    
    palette.appendChild(customSwatch);
    
    // Initial active state
    updatePaletteActiveState(targetId, targetInput.value);
  });
}

function updatePaletteActiveState(targetId, colorValue) {
  const palette = document.querySelector(`.sketch-palette[data-target="${targetId}"]`);
  if (!palette) return;
  const upperColor = (colorValue || "").toUpperCase();
  let found = false;
  palette.querySelectorAll(".color-swatch:not(.color-swatch-custom)").forEach(swatch => {
    if (swatch.dataset.color.toUpperCase() === upperColor) {
      swatch.classList.add("active");
      found = true;
    } else {
      swatch.classList.remove("active");
    }
  });
  
  const customSwatch = palette.querySelector(".color-swatch-custom");
  if (customSwatch) {
    if (!found) {
      customSwatch.classList.add("active");
      customSwatch.style.backgroundColor = upperColor;
    } else {
      customSwatch.classList.remove("active");
      customSwatch.style.backgroundColor = "";
    }
  }
}

// ---------------- RESPONSIVENESS (P1.4) ----------------

function toggleSidebar() {
  const sidebar = $("sidebar");
  const btn = $("sidebar-toggle-btn");
  const nowOpen = sidebar.classList.toggle("open");
  btn.setAttribute("aria-expanded", nowOpen ? "true" : "false");
}

// Shrinks the A4 preview proportionally below ~1200px so it isn't wider
// than the space it's shown in on smaller laptop screens.
function updatePreviewScale() {
  const area = $("preview-area");
  const scroll = $("preview-scroll");
  if (!area || !scroll) return;
  const pageWidthMm = state.settings && state.settings.page_size === "Letter" ? 215.9 : 210;
  const pageWidthPx = mmToPx(pageWidthMm);
  const available = area.clientWidth - 48;
  const scale = available < pageWidthPx ? Math.max(0.4, available / pageWidthPx) : 1;
  scroll.style.zoom = scale;
}

let previewScaleResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(previewScaleResizeTimer);
  previewScaleResizeTimer = setTimeout(updatePreviewScale, 120);
});

// ---------------- WIRE UP ----------------

document.addEventListener("DOMContentLoaded", () => {
  renderColorPalettes();
  initMinimapScrollSync();
  loadState();
  setDownloadEnabled(false);
  $("download-link").addEventListener("click", (e) => {
    if ($("download-link").classList.contains("disabled")) {
      e.preventDefault();
      setStatus("Click \"Build PDF\" first, then Download.", "warning");
    }
  });

  $("book-title").addEventListener("blur", saveSettings);
  $("institution-name").addEventListener("blur", saveSettings);
  $("team-name").addEventListener("blur", saveSettings);
  $("code-font").addEventListener("change", saveSettings);
  $("code-theme").addEventListener("change", saveSettings);
  $("page-size").addEventListener("change", saveSettings);
  $("accent-color").addEventListener("input", saveSettings);
  $("template-accent-color").addEventListener("input", saveSettings);
  $("cover-style").addEventListener("change", saveSettings);
  $("show-team-footer").addEventListener("change", saveSettings);
  $("show-boilerplate").addEventListener("change", saveSettings);
  $("boilerplate-code").addEventListener("blur", saveSettings);

  document.addEventListener("click", (e) => {
    const popover = $("color-popover");
    if (popover && popover.classList.contains("open") && !popover.contains(e.target)) {
      commitPopoverColor();
    }
  });

  $("add-topic-btn").addEventListener("click", openTopicModal);
  $("topic-cancel-btn").addEventListener("click", closeTopicModal);
  $("topic-form").addEventListener("submit", saveTopic);

  $("snippet-cancel-btn").addEventListener("click", closeSnippetModal);
  $("snippet-form").addEventListener("submit", saveSnippet);
  $("snippet-delete-btn").addEventListener("click", deleteSnippet);

  // live preview as you type in the modal, without waiting for save
  ["snippet-title", "snippet-subtitle", "snippet-complexity", "snippet-notes"].forEach((id) => {
    $(id).addEventListener("input", livePreviewWhileEditing);
  });
  $("snippet-language").addEventListener("change", () => {
    setCodeEditorLanguage($("snippet-language").value);
    livePreviewWhileEditing();
    scheduleSimilarityCheck();
  });
  $("snippet-topic").addEventListener("change", () => {
    $("snippet-topic-alt").value = $("snippet-topic").value;
    scheduleSimilarityCheck();
  });
  $("snippet-topic-alt").addEventListener("change", () => {
    $("snippet-topic").value = $("snippet-topic-alt").value;
    livePreviewWhileEditing();
  });
  $("snippet-kind").addEventListener("change", () => {
    applyKindVisibility($("snippet-kind").value);
    livePreviewWhileEditing();
  });

  $("add-formula-btn").addEventListener("click", () => {
    addFormulaRow("", null, null, true);
    livePreviewWhileEditing();
  });

  $("build-btn").addEventListener("click", buildPdf);
  $("sidebar-toggle-btn").addEventListener("click", toggleSidebar);

  $("trash-btn").addEventListener("click", openTrashModal);
  $("trash-close-btn").addEventListener("click", closeTrashModal);
  $("trash-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "trash-modal-backdrop") closeTrashModal();
  });

  // close modals when clicking outside
  $("snippet-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "snippet-modal-backdrop") closeSnippetModal();
  });
  $("topic-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "topic-modal-backdrop") closeTopicModal();
  });
  $("confirm-modal-backdrop").addEventListener("click", (e) => {
    if (e.target.id === "confirm-modal-backdrop") _settleConfirm(false);
  });
  $("confirm-modal-cancel-btn").addEventListener("click", () => _settleConfirm(false));
  $("confirm-modal-confirm-btn").addEventListener("click", () => _settleConfirm(true));

  // Escape closes whichever modal/popover is currently open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("confirm-modal-backdrop").classList.contains("open")) { _settleConfirm(false); return; }
    if ($("trash-modal-backdrop").classList.contains("open")) { closeTrashModal(); return; }
    if ($("snippet-modal-backdrop").classList.contains("open")) { closeSnippetModal(); return; }
    if ($("topic-modal-backdrop").classList.contains("open")) { closeTopicModal(); return; }
    if ($("color-popover").classList.contains("open")) { closeColorPopover(); return; }
    if ($("sidebar").classList.contains("open")) { $("sidebar").classList.remove("open"); $("sidebar-toggle-btn").setAttribute("aria-expanded", "false"); return; }
  });

  // Cmd/Ctrl+S saves the open snippet modal; Cmd/Ctrl+B triggers Build (P3, cheap to add alongside P1.5)
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === "s" && $("snippet-modal-backdrop").classList.contains("open")) {
      e.preventDefault();
      $("snippet-form").requestSubmit();
    } else if (e.key === "b" && !document.querySelector(".modal-backdrop.open")) {
      e.preventDefault();
      buildPdf();
    }
  });
});

// Reflect in-progress modal edits onto the preview immediately (before save)
function livePreviewWhileEditing() {
  if (editingSnippetId == null && $("snippet-title").value.trim() === "") return;
  const kind = $("snippet-kind").value;
  const topicId = kind === "code" ? $("snippet-topic").value : $("snippet-topic-alt").value;
  const draft = {
    id: editingSnippetId || "draft",
    kind,
    title: $("snippet-title").value,
    subtitle: $("snippet-subtitle").value,
    complexity: $("snippet-complexity").value,
    code: kind === "code" ? getCode() : "",
    notes: (kind === "code" || kind === "note") ? $("snippet-notes").value : "",
    formulas: (kind === "code" || kind === "formula") ? collectFormulaDraftList() : [],
    verified: $("snippet-verified").checked,
    language: $("snippet-language").value,
    topic_id: topicId,
  };
  const cloned = JSON.parse(JSON.stringify(state));
  const topic = cloned.topics.find((t) => t.id === topicId);
  if (!topic) return;
  if (editingSnippetId) {
    const idx = topic.snippets.findIndex((s) => s.id === editingSnippetId);
    if (idx >= 0) topic.snippets[idx] = { ...topic.snippets[idx], ...draft };
  } else {
    topic.snippets.push(draft);
  }
  const backup = state;
  state = cloned;
  renderPreview();
  state = backup;
}
