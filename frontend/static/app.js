let state = { topics: [], settings: {} };
let editingSnippetId = null;
let activeSidebarTab = "style";
let collapsedTopics = new Set();
let initialCollapseDone = false;
let isPopulatingModal = false;
let _livePreviewTimer = null;
let _livePreviewRaf = null;

// Dual Canvas Studio Mode & In-Canvas Editor State
let canvasViewMode = "preview"; // "preview" | "editor"
let currentEditingSnippet = null;
let currentEditingTopicId = null;
let currentEditingKind = "code"; // "code" | "note" | "template"
let canvasCodeEditor = null;
let editorAutoSaveTimer = null;
let isProgrammaticSetting = false;
let _previewDirty = false;
let bridgeCurrentY = 0;
let bridgeTargetY = 0;
let bridgeAnimRunning = false;

const $ = (id) => document.getElementById(id);

// ---------------- CODE EDITOR (CodeMirror, P1.2) ----------------

const CM_MODES = {
  cpp: "text/x-c++src",
  c: "text/x-csrc",
  python: "text/x-python",
  java: "text/x-java",
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
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
  });
  codeEditor.on("change", () => {
    codeEditor.save();
  });
}

function initCanvasCodeEditor() {
  if (canvasCodeEditor || typeof CodeMirror === "undefined") return;
  const textarea = $("canvas-editor-code");
  if (!textarea) return;
  canvasCodeEditor = CodeMirror.fromTextArea(textarea, {
    mode: "text/x-c++src",
    theme: "default",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    viewportMargin: Infinity,
    lineWrapping: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    extraKeys: {
      "Ctrl-/": "toggleComment",
      "Cmd-/": "toggleComment",
    },
  });
  canvasCodeEditor.on("change", () => {
    canvasCodeEditor.save();
    if (isProgrammaticSetting) return;
    setEditorSaveStatus("unsaved");
    scheduleCanvasEditorAutoSave();
  });
}

function setCanvasEditorLanguage(lang) {
  if (!canvasCodeEditor) return;
  const mode = CM_MODES[lang] || CM_MODES.cpp;
  canvasCodeEditor.setOption("mode", mode);

  const ribbonTitle = document.querySelector(".editor-ribbon-title");
  if (ribbonTitle) {
    if (currentEditingKind === "template") {
      ribbonTitle.textContent = "C++ Setup Boilerplate (Page 2)";
    } else if (lang === "c") {
      ribbonTitle.textContent = "C 17 Monospace Editor";
    } else if (lang === "python") {
      ribbonTitle.textContent = "Python 3 Monospace Editor";
    } else {
      ribbonTitle.textContent = "C++ 20 Monospace Editor";
    }
  }
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

function showToast(msg, kind = "info", duration = 3200) {
  const container = $("toast-container");
  if (!container || !msg) return;
  const toast = document.createElement("div");
  toast.className = `glass-toast toast-${kind}`;

  const iconMap = {
    success: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`,
    error: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
    warning: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
  };

  toast.innerHTML = `
    ${iconMap[kind] || iconMap.info}
    <span>${escapeHtml(msg)}</span>
  `;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("is-leaving");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 220);
  }, duration);
}

function setStatus(msg, kind) {
  if (msg) showToast(msg, kind || "info");
  const el = $("status-msg");
  if (el) {
    el.textContent = msg;
    el.className = "status" + (kind ? " " + kind : "");
    if (msg) setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 4000);
  }
}

async function loadState() {
  // Check for login_token from OAuth redirect
  try {
    const urlParams = new URLSearchParams(window.location.search);
    const loginToken = urlParams.get("login_token");
    if (loginToken) {
      localStorage.setItem("codebook_auth_token", loginToken);
      urlParams.delete("login_token");
      const newQuery = urlParams.toString();
      const cleanUrl = window.location.pathname + (newQuery ? "?" + newQuery : "") + (window.location.hash || "");
      window.history.replaceState({}, document.title, cleanUrl);
    }
  } catch (e) {}

  const savedToken = localStorage.getItem("codebook_auth_token");
  const headers = {};
  if (savedToken) {
    headers["Authorization"] = `Bearer ${savedToken}`;
  }

  const res = await fetch("/api/state", { headers });
  state = await res.json();

  // If server provided a valid token, save it for future rehydration
  if (state.auth && state.auth.token) {
    localStorage.setItem("codebook_auth_token", state.auth.token);
  }

  // If client had a saved token but server returned guest, attempt explicit rehydration
  if (savedToken && (!state.auth || !state.auth.is_logged_in)) {
    try {
      const rhRes = await fetch("/api/auth/rehydrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: savedToken })
      });
      const rhData = await rhRes.json();
      if (rhData.ok && rhData.user) {
        localStorage.setItem("codebook_auth_token", rhData.token);
        // Refresh full state with the newly rehydrated user session
        const freshRes = await fetch("/api/state");
        state = await freshRes.json();
      } else {
        localStorage.removeItem("codebook_auth_token");
      }
    } catch (e) {}
  }

  if (!initialCollapseDone && state.topics && state.topics.length > 0) {
    state.topics.forEach((t) => collapsedTopics.add(t.id));
    initialCollapseDone = true;
  }
  renderAuthNav(state.auth);
  renderSidebar();
  showSidebarTab(activeSidebarTab || "style");
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(renderPreview);
  } else {
    renderPreview();
  }
}

// ---------------- AUTHENTICATION & MULTI-USER PROFILE ----------------

let currentAuthTab = "login";

function renderAuthNav(authData) {
  const authGroup = $("nav-auth-group");
  const loginBtn = $("nav-login-btn");
  const signupBtn = $("nav-signup-btn");
  const userPill = $("nav-user-pill");
  const userDropdown = $("nav-user-dropdown");
  const avatarBadge = $("user-avatar-badge");
  const displayName = $("user-display-name");
  const ddName = $("user-dropdown-name");
  const ddEmail = $("user-dropdown-email");
  const adminLink = $("user-admin-link");
  const adminDivider = $("user-admin-divider");
  const guestBanner = $("guest-signin-banner");

  const isLoggedIn = Boolean(authData && (authData.authenticated || authData.is_logged_in) && authData.user);

  if (isLoggedIn) {
    const user = authData.user;
    if (authGroup) authGroup.style.display = "none";
    if (loginBtn) loginBtn.style.display = "none";
    if (signupBtn) signupBtn.style.display = "none";
    if (userPill) userPill.style.display = "inline-flex";

    const name = user.name || user.email.split("@")[0] || "User";
    const initial = name.charAt(0).toUpperCase();

    if (avatarBadge) {
      if (user.avatar_url) {
        avatarBadge.style.background = "transparent";
        avatarBadge.innerHTML = `<img src="${user.avatar_url}" alt="${name}" referrerpolicy="no-referrer" onerror="this.onerror=null;this.style.display='none';this.parentElement.textContent='${initial}';" style="width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;">`;
      } else {
        avatarBadge.innerHTML = "";
        avatarBadge.textContent = initial;
        if (user.avatar_color) {
          avatarBadge.style.background = user.avatar_color;
        } else {
          avatarBadge.style.background = "#0284C7";
        }
      }
    }
    if (userPill) {
      userPill.title = `${name} (${user.email})`;
    }
    if (displayName) displayName.textContent = name;
    if (ddName) ddName.textContent = name;
    if (ddEmail) ddEmail.textContent = user.email;

    if (adminLink && adminDivider) {
      if (user.role === "admin") {
        adminLink.style.display = "flex";
        adminDivider.style.display = "block";
      } else {
        adminLink.style.display = "none";
        adminDivider.style.display = "none";
      }
    }
    const nudge = $("nav-cloud-nudge");
    if (nudge) nudge.style.display = "none";
    if (guestBanner) guestBanner.style.display = "none";
  } else {
    if (authGroup) authGroup.style.display = "inline-flex";
    if (loginBtn) loginBtn.style.display = "inline-flex";
    if (signupBtn) signupBtn.style.display = "inline-flex";
    if (userPill) userPill.style.display = "none";
    if (userDropdown) userDropdown.style.display = "none";
    if (adminLink) adminLink.style.display = "none";
    if (adminDivider) adminDivider.style.display = "none";
    if (guestBanner) guestBanner.style.display = "flex";

    const nudge = $("nav-cloud-nudge");
    if (nudge) {
      const isDismissed = sessionStorage.getItem("cloud_nudge_dismissed") === "1";
      nudge.style.display = isDismissed ? "none" : "flex";
    }
  }
}

function openAuthModal(defaultTab = "login") {
  const modal = $("auth-modal-backdrop");
  if (!modal) return;
  switchAuthTab(defaultTab);
  const errEl = $("auth-error-msg");
  if (errEl) errEl.style.display = "none";
  const pwdInput = $("auth-password");
  if (pwdInput) pwdInput.value = "";
  modal.style.display = "block";
  modal.classList.add("open");
  try {
    if (window.location.pathname !== "/login" && window.location.pathname !== "/signin" && !window.location.pathname.startsWith("/login")) {
      window.history.pushState({ authPage: true }, document.title, "/login");
    }
  } catch (_) {}
  const emailInput = $("auth-email");
  if (emailInput) setTimeout(() => emailInput.focus(), 80);
}

function closeAuthModal() {
  const modal = $("auth-modal-backdrop");
  if (modal) {
    modal.classList.remove("open");
    modal.style.display = "none";
  }
  const pwdInput = $("auth-password");
  if (pwdInput) pwdInput.value = "";
  const errEl = $("auth-error-msg");
  if (errEl) errEl.style.display = "none";
  try {
    if (window.location.pathname === "/login" || window.location.pathname === "/signin") {
      window.history.pushState({}, document.title, "/");
    } else if (window.location.hash === "#login") {
      window.history.pushState({}, document.title, window.location.pathname);
    }
  } catch (_) {}
}

function switchAuthTab(tab) {
  currentAuthTab = tab;
  const tabLogin = $("auth-tab-login");
  const tabReg = $("auth-tab-register");
  const nameField = $("auth-name-field");
  const title = $("auth-modal-title");
  const banner = $("auth-banner-note");
  const submitText = $("auth-submit-text");
  const errEl = $("auth-error-msg");

  if (errEl) errEl.style.display = "none";

  if (tab === "register") {
    if (tabLogin) { tabLogin.classList.remove("active"); tabLogin.setAttribute("aria-selected", "false"); }
    if (tabReg) { tabReg.classList.add("active"); tabReg.setAttribute("aria-selected", "true"); }
    if (nameField) nameField.style.display = "flex";
    if (title) title.innerHTML = '<span class="auth-title-prefix">Create</span> <span class="craft-brand-name brand-text-gebuk auth-title-brand">Codebook Studio</span> <span class="auth-title-prefix">Account</span>';
    if (banner) banner.textContent = "Create an account to securely save and sync your codebook to the cloud.";
    if (submitText) submitText.textContent = "Create Account";
  } else {
    if (tabLogin) { tabLogin.classList.add("active"); tabLogin.setAttribute("aria-selected", "true"); }
    if (tabReg) { tabReg.classList.remove("active"); tabReg.setAttribute("aria-selected", "false"); }
    if (nameField) nameField.style.display = "none";
    if (title) title.innerHTML = '<span class="auth-title-prefix">Sign In to</span> <span class="craft-brand-name brand-text-gebuk auth-title-brand">Codebook Studio</span>';
    if (banner) banner.textContent = "Sign in to access your saved topics, snippets, and sync across devices.";
    if (submitText) submitText.textContent = "Sign In";
  }
}

function toggleUserDropdown() {
  const dd = $("nav-user-dropdown");
  const pill = $("nav-user-pill");
  if (!dd) return;
  const isOpen = dd.style.display === "block";
  dd.style.display = isOpen ? "none" : "block";
  if (pill) pill.classList.toggle("open", !isOpen);
}

function closeUserDropdown() {
  const dd = $("nav-user-dropdown");
  const pill = $("nav-user-pill");
  if (dd) dd.style.display = "none";
  if (pill) pill.classList.remove("open");
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const errEl = $("auth-error-msg");
  const submitBtn = $("auth-submit-btn");
  const submitText = $("auth-submit-text");

  const email = ($("auth-email") ? $("auth-email").value.trim() : "");
  const password = ($("auth-password") ? $("auth-password").value : "");
  const name = ($("auth-name") ? $("auth-name").value.trim() : "");

  if (!email || !password) {
    if (errEl) {
      errEl.textContent = "Please fill in all required fields.";
      errEl.style.display = "block";
    }
    return;
  }
  if (password.length < 6) {
    if (errEl) {
      errEl.textContent = "Password must be at least 6 characters.";
      errEl.style.display = "block";
    }
    return;
  }

  const endpoint = currentAuthTab === "register" ? "/api/auth/register" : "/api/auth/login";
  const origBtnText = submitText ? submitText.textContent : "Submit";
  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = currentAuthTab === "register" ? "Creating..." : "Signing in...";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, name })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (errEl) {
        errEl.textContent = data.error || "Authentication failed. Please check your credentials.";
        errEl.style.display = "block";
      }
      return;
    }

    closeAuthModal();
    if (data.token) {
      localStorage.setItem("codebook_auth_token", data.token);
    }
    const userName = data.user && data.user.name ? data.user.name : "there";
    showToast(currentAuthTab === "register" ? `Welcome to Codebook, ${userName}!` : `Welcome back, ${userName}!`, "success");
    await loadState();
  } catch (err) {
    if (errEl) {
      errEl.textContent = "Network error. Please try again.";
      errEl.style.display = "block";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = origBtnText;
  }
}

async function handleLogout() {
  closeUserDropdown();
  localStorage.removeItem("codebook_auth_token");
  try {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      showToast("Signed out successfully", "info");
      await loadState();
    }
  } catch (err) {
    console.error("Logout error:", err);
    showToast("Error signing out", "error");
  }
}

function initAuth() {
  const loginBtn = $("nav-login-btn");
  if (loginBtn) {
    loginBtn.onclick = (e) => {
      if (e) e.preventDefault();
      openAuthModal("login");
    };
    loginBtn.addEventListener("click", (e) => {
      if (e) e.preventDefault();
      openAuthModal("login");
    });
  }

  const signupBtn = $("nav-signup-btn");
  if (signupBtn) {
    signupBtn.onclick = (e) => {
      if (e) e.preventDefault();
      openAuthModal("register");
    };
    signupBtn.addEventListener("click", (e) => {
      if (e) e.preventDefault();
      openAuthModal("register");
    });
  }

  const userPill = $("nav-user-pill");
  if (userPill) {
    userPill.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleUserDropdown();
    });
  }

  const logoutBtn = $("user-logout-btn");
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);

  const guestBannerBtn = $("guest-banner-signin-btn");
  if (guestBannerBtn) {
    guestBannerBtn.addEventListener("click", (e) => {
      if (e) e.preventDefault();
      openAuthModal("login");
    });
  }

  const closeBtn = $("auth-close-btn");
  if (closeBtn) {
    closeBtn.onclick = (e) => {
      if (e) e.preventDefault();
      closeAuthModal();
    };
    closeBtn.addEventListener("click", (e) => {
      if (e) e.preventDefault();
      closeAuthModal();
    });
  }

  const cancelBtn = $("auth-cancel-btn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeAuthModal);

  const backdrop = $("auth-modal-backdrop");
  if (backdrop) {
    backdrop.addEventListener("click", (e) => {
      if (e.target.id === "auth-modal-backdrop") closeAuthModal();
    });
  }

  const tabLogin = $("auth-tab-login");
  if (tabLogin) tabLogin.addEventListener("click", () => switchAuthTab("login"));

  const tabReg = $("auth-tab-register");
  if (tabReg) tabReg.addEventListener("click", () => switchAuthTab("register"));

  const form = $("auth-form");
  if (form) form.addEventListener("submit", handleAuthSubmit);

  // Close user dropdown when clicking anywhere outside
  document.addEventListener("click", (e) => {
    const userContainer = $("nav-user-container");
    if (userContainer && !userContainer.contains(e.target)) {
      closeUserDropdown();
    }
  });

  // Handle OAuth callback URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has("auth_success")) {
    const provider = urlParams.get("provider") || "Account";
    showToast(`Successfully signed in with ${provider}!`, "success");
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (urlParams.has("auth_error")) {
    const err = urlParams.get("auth_error");
    showToast(`Social sign-in failed (${err}). Please try again.`, "error");
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Auto-open dedicated full-page auth if user navigated to /login, /signin, or #login
  if (window.location.pathname === "/login" || window.location.pathname === "/signin" || window.location.hash === "#login") {
    openAuthModal("login");
  }

  window.addEventListener("popstate", () => {
    if (window.location.pathname === "/login" || window.location.pathname === "/signin") {
      openAuthModal("login");
    } else {
      const modal = $("auth-modal-backdrop");
      if (modal && modal.classList.contains("open")) {
        modal.classList.remove("open");
      }
    }
  });

  initCloudSaveNudge();
}

function initCloudSaveNudge() {
  const nudge = $("nav-cloud-nudge");
  const dismissBtn = $("nudge-dismiss-btn");
  const content = $("nudge-trigger-signup");
  if (!nudge) return;

  if (dismissBtn) {
    dismissBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      nudge.classList.add("is-dismissing");
      setTimeout(() => {
        nudge.style.display = "none";
        nudge.classList.remove("is-dismissing");
        sessionStorage.setItem("cloud_nudge_dismissed", "1");
      }, 200);
    });
  }

  if (content) {
    content.addEventListener("click", () => {
      openAuthModal("register");
    });
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
  const codeTheme = state.settings.code_theme || "nord";
  const accent = state.settings.accent_color || "#2C2C2A";
  const templateAccent = state.settings.template_accent_color || accent;
  const pageSize = PAGE_DIMENSIONS[state.settings.page_size] ? state.settings.page_size : "A4";
  root.setProperty("--code-font", `'${codeFont}', monospace`);
  root.setProperty("--accent", accent);
  const rgbMatch = accent.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (rgbMatch) {
    root.setProperty("--accent-rgb", `${parseInt(rgbMatch[1], 16)}, ${parseInt(rgbMatch[2], 16)}, ${parseInt(rgbMatch[3], 16)}`);
  }
  root.setProperty("--template-accent", templateAccent);
  root.setProperty("--page-w", PAGE_DIMENSIONS[pageSize].w);
  root.setProperty("--page-h", PAGE_DIMENSIONS[pageSize].h);
  document.documentElement.setAttribute("data-code-theme", codeTheme);

  const tmplFolderTrigger = $("template-group-color");
  if (tmplFolderTrigger) tmplFolderTrigger.style.color = "";
}

function showSidebarTab(tab) {
  activeSidebarTab = tab;
  const tabStyle = $("sidebar-tab-style");
  const tabVault = $("sidebar-tab-vault");
  const panelStyle = $("panel-style");
  const panelVault = $("panel-vault");

  if (tabStyle) {
    tabStyle.classList.toggle("active", tab === "style");
    tabStyle.setAttribute("aria-selected", tab === "style");
  }
  if (tabVault) {
    tabVault.classList.toggle("active", tab === "vault");
    tabVault.setAttribute("aria-selected", tab === "vault");
  }
  if (panelStyle) {
    panelStyle.classList.toggle("active", tab === "style");
    panelStyle.style.display = tab === "style" ? "flex" : "none";
  }
  if (panelVault) {
    panelVault.classList.toggle("active", tab === "vault");
    panelVault.style.display = tab === "vault" ? "flex" : "none";
  }
}

const ICON_COLLAPSE_ALL = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 6 12 10 17 6"></polyline><polyline points="7 18 12 14 17 18"></polyline></svg>`;

const ICON_EXPAND_ALL = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 10 12 6 17 10"></polyline><polyline points="7 14 12 18 17 14"></polyline></svg>`;

function updateCollapseAllBtnIcon() {
  const btn = $("vault-collapse-all-btn");
  if (!btn) return;
  const allCollapsed = state.topics.length > 0 && collapsedTopics.size === state.topics.length;
  if (allCollapsed) {
    btn.innerHTML = ICON_EXPAND_ALL;
    btn.title = "Expand all topic folders";
    btn.setAttribute("aria-label", "Expand all topic folders");
    btn.classList.add("is-collapsed");
  } else {
    btn.innerHTML = ICON_COLLAPSE_ALL;
    btn.title = "Collapse all topic folders";
    btn.setAttribute("aria-label", "Collapse all topic folders");
    btn.classList.remove("is-collapsed");
  }
}

function toggleTopicCollapse(topicId) {
  const isNowCollapsed = !collapsedTopics.has(topicId);
  if (isNowCollapsed) {
    collapsedTopics.add(topicId);
  } else {
    collapsedTopics.delete(topicId);
  }
  const folderEl = document.querySelector(`.obsidian-folder[data-topic-id="${topicId}"]`);
  if (folderEl) {
    const chevron = folderEl.querySelector(".obsidian-chevron");
    const children = folderEl.querySelector(".obsidian-folder-children");
    if (chevron) chevron.classList.toggle("collapsed", isNowCollapsed);
    if (children) children.classList.toggle("collapsed", isNowCollapsed);
  }
  updateCollapseAllBtnIcon();
}

function toggleCollapseAll() {
  const shouldCollapse = collapsedTopics.size !== state.topics.length;
  if (shouldCollapse) {
    state.topics.forEach((t) => collapsedTopics.add(t.id));
  } else {
    collapsedTopics.clear();
  }
  document.querySelectorAll(".obsidian-folder").forEach((folderEl) => {
    const chevron = folderEl.querySelector(".obsidian-chevron");
    const children = folderEl.querySelector(".obsidian-folder-children");
    if (chevron) chevron.classList.toggle("collapsed", shouldCollapse);
    if (children) children.classList.toggle("collapsed", shouldCollapse);
  });
  updateCollapseAllBtnIcon();
}

function renderSidebar() {
  $("book-title").value = state.settings.book_title || "";
  $("institution-name").value = state.settings.institution_name || "";
  $("team-name").value = state.settings.team_name || "";
  $("code-font").value = state.settings.code_font || "JetBrains Mono";
  if ($("code-theme")) $("code-theme").value = state.settings.code_theme || "nord";
  if ($("page-size")) $("page-size").value = state.settings.page_size || "A4";
  $("accent-color").value = state.settings.accent_color || "#2C2C2A";
  const tmplColor = state.settings.template_accent_color || state.settings.accent_color || "#5B4A8A";
  if ($("template-accent-color")) $("template-accent-color").value = tmplColor;
  updatePaletteActiveState("accent-color", $("accent-color").value);
  updatePaletteActiveState("template-accent-color", tmplColor);
  const tmplFolderTrigger = $("template-group-color");
  if (tmplFolderTrigger) tmplFolderTrigger.style.color = tmplColor;
  const tmplNameEl = $("template-group-name");
  if (tmplNameEl) {
    const tName = state.settings.template_title || "Template";
    tmplNameEl.textContent = tName;
    tmplNameEl.title = `${tName} (Double-click to rename)`;
  }
  let initialCover = state.settings.cover_style || "sketch";
  if (initialCover === "minimal") initialCover = "sketch";
  $("cover-style").value = initialCover;
  syncActiveCoverThumb($("cover-style").value);
  if ($("card-style")) {
    $("card-style").value = state.settings.card_style || "craft";
    syncActiveCardThumb($("card-style").value);
  }
  const footerSetting = state.settings.show_team_footer;
  $("show-team-footer").checked = !(footerSetting === false || footerSetting === 0 || footerSetting === "0");

  const boilerplateSetting = state.settings.show_boilerplate;
  const isBoilerplateOn = !(boilerplateSetting === false || boilerplateSetting === 0 || boilerplateSetting === "0");
  if ($("show-boilerplate")) $("show-boilerplate").checked = isBoilerplateOn;
  if ($("modal-show-boilerplate")) $("modal-show-boilerplate").checked = isBoilerplateOn;
  if ($("boilerplate-code")) $("boilerplate-code").value = state.settings.boilerplate_code || "";

  const flowSetting = state.settings.snippets_after_template;
  const isFlowOn = !(flowSetting === false || flowSetting === 0 || flowSetting === "0");
  syncSnippetsAfterTemplateCheckboxes(isFlowOn);

  const tmplBadge = $("template-status-badge");
  if (tmplBadge) tmplBadge.textContent = isBoilerplateOn ? "Page 2" : "Off";
  const tmplSnippetRow = $("template-snippet-row");
  if (tmplSnippetRow) {
    tmplSnippetRow.classList.toggle("is-disabled", !isBoilerplateOn);
    tmplSnippetRow.classList.toggle("is-active", currentEditingKind === "template" && canvasViewMode === "editor");
  }

  applyThemeSettings();

  // Total snippet count across all topics
  const totalSnippets = state.topics.reduce((sum, t) => sum + (t.snippets ? t.snippets.length : 0), 0);
  if ($("vault-topics-count")) $("vault-topics-count").textContent = totalSnippets;
  if ($("nav-topics-count")) $("nav-topics-count").textContent = totalSnippets;

  // Render Obsidian Topics Tree
  const container = $("topics-list");
  if (!container) return;
  container.innerHTML = "";

  state.topics.forEach((topic) => {
    const isCollapsed = collapsedTopics.has(topic.id);

    const folder = document.createElement("div");
    folder.className = "obsidian-folder";
    folder.dataset.topicId = topic.id;

    // Folder row
    const row = document.createElement("div");
    row.className = "obsidian-folder-row";
    row.innerHTML = `
      <span class="obsidian-drag-handle" title="Drag to reorder topic" aria-label="Reorder topic">
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
          <circle cx="3" cy="2" r="1.2"></circle>
          <circle cx="7" cy="2" r="1.2"></circle>
          <circle cx="3" cy="7" r="1.2"></circle>
          <circle cx="7" cy="7" r="1.2"></circle>
          <circle cx="3" cy="12" r="1.2"></circle>
          <circle cx="7" cy="12" r="1.2"></circle>
        </svg>
      </span>
      <span class="obsidian-chevron ${isCollapsed ? 'collapsed' : ''}" title="${isCollapsed ? 'Expand' : 'Collapse'}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </span>
      <span class="obsidian-folder-icon" title="${escapeHtml(topic.name)}">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
      </span>
      <span class="obsidian-folder-name" title="${escapeHtml(topic.name)} (Double-click to rename)">${escapeHtml(topic.name)}</span>
      <div class="obsidian-folder-actions">
        <button type="button" class="obsidian-action-btn add-code-btn" title="Add Code to ${escapeHtml(topic.name)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="7 8 3 12 7 16"></polyline>
            <polyline points="17 8 21 12 17 16"></polyline>
            <line x1="12" y1="9" x2="12" y2="15"></line>
            <line x1="9" y1="12" x2="15" y2="12"></line>
          </svg>
        </button>
        <button type="button" class="obsidian-action-btn add-note-btn" title="Add Note to ${escapeHtml(topic.name)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
            <polyline points="14 2 14 8 20 8"></polyline>
            <line x1="12" y1="18" x2="12" y2="12"></line>
            <line x1="9" y1="15" x2="15" y2="15"></line>
          </svg>
        </button>
        <button type="button" class="obsidian-action-btn rename-topic-btn" title="Rename ${escapeHtml(topic.name)} (or double-click name)">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
        </button>
        <button type="button" class="obsidian-action-btn delete-topic-btn" title="Delete folder ${escapeHtml(topic.name)}">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 5l14 14M5 19L19 5"/></svg>
        </button>
      </div>
    `;

    // Folder row events
    row.addEventListener("click", (e) => {
      if (
        e.target.closest(".obsidian-folder-actions") ||
        e.target.closest(".obsidian-drag-handle") ||
        e.target.closest(".obsidian-inline-input")
      ) return;
      toggleTopicCollapse(topic.id);
    });

    const folderNameEl = row.querySelector(".obsidian-folder-name");
    folderNameEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startInlineRenameTopic(topic, folder);
    });

    const renameBtn = row.querySelector(".rename-topic-btn");
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startInlineRenameTopic(topic, folder);
    });

    const chevron = row.querySelector(".obsidian-chevron");
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTopicCollapse(topic.id);
    });

    const addCodeBtn = row.querySelector(".add-code-btn");
    addCodeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSnippetEditor(null, topic.id, "code");
    });

    const addNoteBtn = row.querySelector(".add-note-btn");
    addNoteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSnippetEditor(null, topic.id, "note");
    });

    const deleteBtn = row.querySelector(".delete-topic-btn");
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteTopic(topic.id, deleteBtn);
    });

    folder.appendChild(row);

    // Folder children (collapsible container with vertical indent guideline)
    const childrenContainer = document.createElement("div");
    childrenContainer.className = `obsidian-folder-children ${isCollapsed ? 'collapsed' : ''}`;

    const indentGuide = document.createElement("div");
    indentGuide.className = "obsidian-indent-guide";
    indentGuide.setAttribute("aria-hidden", "true");
    childrenContainer.appendChild(indentGuide);

    const filesList = document.createElement("div");
    filesList.className = "obsidian-files-list";
    filesList.dataset.topicId = topic.id;

    if (topic.snippets.length === 0) {
      const emptyHint = document.createElement("div");
      emptyHint.className = "obsidian-empty-folder-hint";
      emptyHint.innerHTML = `
        <span class="obsidian-empty-folder-text">Empty topic</span>
        <button type="button" class="obsidian-empty-add-btn add-code-chip" title="Create code card in this topic">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 8 3 12 7 16"></polyline><polyline points="17 8 21 12 17 16"></polyline><line x1="12" y1="9" x2="12" y2="15"></line><line x1="9" y1="12" x2="15" y2="12"></line></svg>
          <span>+ Code</span>
        </button>
        <button type="button" class="obsidian-empty-add-btn add-note-chip" title="Create note card in this topic">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line></svg>
          <span>+ Note</span>
        </button>
      `;
      const chipCode = emptyHint.querySelector(".add-code-chip");
      chipCode.addEventListener("click", (e) => {
        e.stopPropagation();
        openSnippetEditor(null, topic.id, "code");
      });
      const chipNote = emptyHint.querySelector(".add-note-chip");
      chipNote.addEventListener("click", (e) => {
        e.stopPropagation();
        openSnippetEditor(null, topic.id, "note");
      });
      filesList.appendChild(emptyHint);
    } else {
      topic.snippets.forEach((s) => {
        const fileRow = document.createElement("div");
        fileRow.className = "obsidian-file-row";
        if (currentEditingSnippet && currentEditingSnippet.id === s.id && canvasViewMode === "editor") {
          fileRow.classList.add("is-active");
        }
        fileRow.dataset.snippetId = s.id;

        const isCode = s.kind === "code";
        const isNote = s.kind === "note";
        const iconClass = isCode ? "is-code" : (isNote ? "is-note" : "is-formula");
        const iconSvg = isCode
          ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`
          : (isNote
            ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>`
            : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>`);

        fileRow.innerHTML = `
          <span class="drag-handle" title="Drag to reorder" aria-hidden="true">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="9" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="18" r="1"/></svg>
          </span>
          <span class="obsidian-file-icon ${iconClass}">${iconSvg}</span>
          <span class="obsidian-file-title" title="${escapeHtml(s.title || "Untitled")}">${escapeHtml(s.title || "Untitled")}</span>
          <span class="obsidian-folder-actions obsidian-file-actions">
            <button type="button" class="obsidian-action-btn delete-snippet-btn" title="Delete ${escapeHtml(s.title || "snippet")}">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
            </button>
          </span>
        `;

        const fileDelBtn = fileRow.querySelector(".delete-snippet-btn");
        if (fileDelBtn) {
          fileDelBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const ok = await showConfirm(
              "Delete snippet?",
              `Are you sure you want to delete "${s.title || "Untitled"}"? It will be moved to Recently Deleted.`,
              "Delete snippet",
              fileDelBtn
            );
            if (!ok) return;
            const res = await fetch(`/api/snippet/${s.id}`, { method: "DELETE" });
            const data = await res.json();
            if (data.ok) {
              setStatus(`"${s.title || "Snippet"}" deleted.`, "success");
              if (currentEditingSnippet && currentEditingSnippet.id === s.id) {
                if (typeof closeCanvasEditor === "function") closeCanvasEditor();
              }
              await loadState();
            } else {
              setStatus(data.error || "Failed to delete snippet", "error");
            }
          });
        }

        fileRow.addEventListener("click", (e) => {
          if (e.target.closest(".drag-handle") || e.target.closest(".delete-snippet-btn")) return;
          openSnippetEditor(s, topic.id, s.kind);
        });

        filesList.appendChild(fileRow);
      });
    }

    childrenContainer.appendChild(filesList);
    folder.appendChild(childrenContainer);

    // Sortable drag-and-drop for files within this topic
    if (typeof Sortable !== "undefined") {
      Sortable.create(filesList, {
        handle: ".drag-handle",
        animation: 150,
        group: "obsidian-snippets",
        onEnd: async () => {
          const order = Array.from(filesList.children).map((el) => el.dataset.snippetId).filter(Boolean);
          await fetch("/api/reorder", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "snippets", order }),
          });
          loadState();
        },
      });
    }

    container.appendChild(folder);
  });

  // Sortable drag-and-drop for reordering topic folders
  if (typeof Sortable !== "undefined") {
    Sortable.create(container, {
      handle: ".obsidian-folder-row",
      filter: ".obsidian-folder-actions",
      preventOnFilter: false,
      animation: 150,
      draggable: ".obsidian-folder",
      onEnd: async () => {
        const order = Array.from(container.children).map((el) => el.dataset.topicId).filter(Boolean);
        await fetch("/api/reorder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "topics", order }),
        });
        loadState();
      },
    });
  }
  updateCollapseAllBtnIcon();
}

// ---------------- INLINE TOPIC RENAME & CREATE (P1 Studio UX - No Modals) ----------------

function startInlineRenameTopic(topic, folderEl) {
  const row = folderEl.querySelector(".obsidian-folder-row");
  if (!row) return;
  const nameSpan = row.querySelector(".obsidian-folder-name");
  if (!nameSpan || row.querySelector(".obsidian-inline-input")) return;

  nameSpan.style.display = "none";
  row.classList.add("inline-editing");

  const input = document.createElement("input");
  input.type = "text";
  input.className = "obsidian-inline-input";
  input.value = topic.name;
  input.title = "Press Enter to save, Esc to cancel";
  input.dataset.topicId = topic.id;

  nameSpan.insertAdjacentElement("afterend", input);
  input.focus();
  input.select();

  let isSettled = false;
  async function finishRename(save) {
    if (isSettled) return;
    isSettled = true;
    row.classList.remove("inline-editing");
    const newName = input.value.trim();
    input.remove();
    nameSpan.style.display = "";

    if (save && newName && newName !== topic.name) {
      nameSpan.textContent = newName;
      nameSpan.title = `${newName} (Double-click to rename)`;
      topic.name = newName;
      try {
        const res = await fetch(`/api/topic/${topic.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newName }),
        });
        const data = await res.json();
        if (!data.ok) {
          setStatus(data.error || "Failed to rename topic", "error");
        } else {
          setStatus(`Renamed to "${newName}"`, "success");
          if (canvasViewMode === "preview") renderPreview();
        }
      } catch (err) {
        console.error("Rename topic error:", err);
        setStatus("Network error while renaming", "error");
      }
    }
  }

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishRename(false);
    }
  });
  input.addEventListener("blur", () => finishRename(true));
}

function startInlineRenameTemplate() {
  const row = $("template-snippet-row");
  if (!row) return;
  const nameSpan = $("template-group-name");
  if (!nameSpan || row.querySelector(".obsidian-inline-input")) return;

  nameSpan.style.display = "none";
  row.classList.add("inline-editing");

  const currentName = state.settings.template_title || nameSpan.textContent || "Template";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "obsidian-inline-input";
  input.value = currentName;
  input.title = "Press Enter to save, Esc to cancel";

  nameSpan.insertAdjacentElement("afterend", input);
  input.focus();
  input.select();

  let isSettled = false;
  async function finishRename(save) {
    if (isSettled) return;
    isSettled = true;
    row.classList.remove("inline-editing");
    const newName = input.value.trim();
    input.remove();
    nameSpan.style.display = "";

    if (save && newName && newName !== currentName) {
      nameSpan.textContent = newName;
      nameSpan.title = `${newName} (Double-click to rename)`;
      state.settings.template_title = newName;

      // If currently editing template in canvas editor, update title there as well
      if (currentEditingKind === "template" && $("canvas-editor-title")) {
        $("canvas-editor-title").value = newName;
      }

      try {
        await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...state.settings,
            template_title: newName,
          }),
        });
        setStatus(`Template renamed to "${newName}"`, "success");
        if (canvasViewMode === "preview") renderPreview();
      } catch (err) {
        console.error("Rename template error:", err);
        setStatus("Network error while renaming template", "error");
      }
    }
  }

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("dblclick", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finishRename(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finishRename(false);
    }
  });
  input.addEventListener("blur", () => finishRename(true));
}

function triggerInlineNewTopic() {
  const container = $("topics-list");
  if (!container) return;

  // If already creating, focus the existing inline input
  const existingDraft = $("obsidian-inline-new-topic");
  if (existingDraft) {
    const inp = existingDraft.querySelector(".obsidian-inline-input");
    if (inp) {
      inp.focus();
      inp.select();
    }
    return;
  }

  const draft = document.createElement("div");
  draft.className = "obsidian-folder obsidian-folder-inline-new";
  draft.id = "obsidian-inline-new-topic";
  draft.innerHTML = `
    <div class="obsidian-folder-row inline-editing">
      <span class="obsidian-chevron" style="opacity: 0.3; pointer-events: none;">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </span>
      <span class="obsidian-folder-icon">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
      </span>
      <input type="text" class="obsidian-inline-input" id="inline-new-topic-input" placeholder="Topic name..." value="New Topic" />
      <div class="obsidian-inline-hints">
        <span class="obsidian-inline-hint-key">↵</span>
        <span class="obsidian-inline-hint-key">esc</span>
      </div>
    </div>
  `;

  container.appendChild(draft);
  draft.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const input = draft.querySelector("#inline-new-topic-input");
  input.focus();
  input.select();

  let isSettled = false;
  async function commitCreation(save) {
    if (isSettled) return;
    isSettled = true;
    const name = input.value.trim();
    draft.remove();

    if (!save || !name) return;

    try {
      const res = await fetch("/api/topic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStatus(data.error || "Failed to create topic", "error");
        return;
      }
      // Ensure the newly created topic is expanded
      collapsedTopics.delete(data.id);
      await loadState();
      setStatus(`Topic "${name}" created`, "success");

      setTimeout(() => {
        const newFolder = document.querySelector(`.obsidian-folder[data-topic-id="${data.id}"]`);
        if (newFolder) newFolder.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 60);
    } catch (err) {
      console.error("Create topic error:", err);
      setStatus("Network error while creating topic", "error");
    }
  }

  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCreation(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commitCreation(false);
    }
  });
  input.addEventListener("blur", () => commitCreation(true));
}

// ---------------- CONFIRM MODAL (replaces native browser confirm()) ----------------

let _confirmResolve = null;

function positionConfirmPopover(anchorEl) {
  const card = $("confirm-popover-card");
  if (!card) return;

  const cardWidth = 290;
  const cardHeight = 140;
  const margin = 10;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!anchorEl || !anchorEl.getBoundingClientRect) {
    card.style.left = `${Math.max(margin, Math.round((vw - cardWidth) / 2))}px`;
    card.style.top = `${Math.max(margin, Math.round((vh - cardHeight) / 2))}px`;
    return;
  }

  const rect = anchorEl.getBoundingClientRect();
  let left, top;

  if (rect.right + cardWidth + margin <= vw) {
    left = rect.right + margin;
    top = Math.max(margin, Math.min(rect.top - 8, vh - cardHeight - margin));
  } else if (rect.left - cardWidth - margin >= 0) {
    left = rect.left - cardWidth - margin;
    top = Math.max(margin, Math.min(rect.top - 8, vh - cardHeight - margin));
  } else {
    left = Math.max(margin, Math.min(rect.left, vw - cardWidth - margin));
    if (rect.bottom + cardHeight + margin <= vh) {
      top = rect.bottom + margin;
    } else {
      top = Math.max(margin, rect.top - cardHeight - margin);
    }
  }

  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;
}

function showConfirm(title, message, confirmLabel, anchorEl = null) {
  const titleEl = $("confirm-modal-title");
  const msgEl = $("confirm-modal-message");
  const btnEl = $("confirm-modal-confirm-btn");
  if (titleEl) titleEl.textContent = title;
  if (msgEl) msgEl.textContent = message;
  if (btnEl) btnEl.textContent = confirmLabel || "Delete";
  positionConfirmPopover(anchorEl);
  const backdrop = $("confirm-modal-backdrop");
  if (backdrop) backdrop.classList.add("open");
  return new Promise((resolve) => {
    _confirmResolve = resolve;
  });
}

function _settleConfirm(result) {
  const backdrop = $("confirm-modal-backdrop");
  if (backdrop) backdrop.classList.remove("open");
  if (_confirmResolve) {
    const resolve = _confirmResolve;
    _confirmResolve = null;
    resolve(result);
  }
}


async function deleteTopic(topicId, anchorEl = null) {
  const topic = state.topics.find((t) => t.id === topicId);
  const snippetCount = topic && topic.snippets ? topic.snippets.length : 0;
  const topicName = topic ? topic.name : "folder";
  const message = snippetCount > 0
    ? `Are you sure you want to delete folder "${topicName}" and its ${snippetCount} snippet${snippetCount > 1 ? 's' : ''}? They will be moved to Recently Deleted.`
    : `Are you sure you want to delete folder "${topicName}"? It will be moved to Recently Deleted.`;
  const ok = await showConfirm(
    "Delete folder?",
    message,
    "Delete folder",
    anchorEl
  );
  if (!ok) return;
  const res = await fetch(`/api/topic/${topicId}`, { method: "DELETE" });
  const data = await res.json();
  if (!data.ok) {
    setStatus(data.error || "Failed to delete folder", "error");
    return;
  }
  if (currentEditingSnippet && currentEditingSnippet.topic_id === topicId) {
    if (typeof closeCanvasEditor === "function") closeCanvasEditor();
  }
  setStatus(`Folder "${topicName}" deleted.`, "success");
  await loadState();
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
    row.querySelector('[data-action="purge"]').addEventListener("click", async (e) => {
      const ok = await showConfirm(
        "Delete forever?",
        `"${row.querySelector(".trash-item-title").textContent}" will be permanently removed. This can't be undone.`,
        "Delete forever",
        e.currentTarget
      );
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

// Computes a clean file slug for IDE card window bar:
// - If title length <= maxLen (default 12), use the full sanitized slug.
// - If title length > maxLen, construct an acronym from the first character of each word.
function getSnippetFileSlug(title, maxLen = 12) {
  if (!title) return "snippet";
  const clean = String(title).trim();
  const fullSlug = clean.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "snippet";
  if (fullSlug.length <= maxLen) {
    return fullSlug;
  }
  const splitStr = clean.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  const words = splitStr
    .split(/[\s_\-]+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean);
  if (words.length > 1) {
    const acronym = words.map((w) => w[0].toLowerCase()).join("");
    if (acronym) return acronym;
  }
  return fullSlug.slice(0, 10);
}

// Maps languages to canonical file extensions for IDE window tabs (e.g. python -> py, c++ -> cpp, kotlin -> kt)
function getLangExt(lang) {
  const l = (lang || "").toLowerCase().trim();
  const extMap = {
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
    "md": "md"
  };
  return extMap[l] || (l ? l.replace(/[^a-z0-9]/g, "") : "cpp") || "cpp";
}

function cardHtml(s, topic, cardWidthPx, isFirstInTopic) {
  const kind = s.kind || "code";
  const titleHtml = `<span class="card-title">${escapeHtml(s.title)}</span>`;

  const headerHtml = isFirstInTopic ? `
    <div class="card-topic-title" style="--th-color:${topic.color}">
      ${escapeHtml(topic.name).toUpperCase()}
    </div>
  ` : "";

  const hoverLauncherHtml = `
    <div class="card-hover-launcher">
      <!-- Left Column Variant: branches out to the left canvas outside the page -->
      <div class="hover-launcher-left">
        <svg class="hover-scribble-arrow-svg arrow-to-left" viewBox="0 0 150 48" fill="none">
          <circle class="arrow-origin-dot" cx="142" cy="38" r="2.5" fill="#0071E3"/>
          <path class="arrow-glow" d="M 142 38 C 102 4, 45 5, 22 24" stroke="rgba(0, 113, 227, 0.35)" stroke-width="4.5" stroke-linecap="round"/>
          <path class="arrow-main" d="M 142 38 C 102 4, 45 5, 22 24" stroke="#0071E3" stroke-width="2.4" stroke-linecap="round"/>
          <path class="arrow-head" d="M 33 22 L 22 24 L 26 14" stroke="#0071E3" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <button type="button" class="card-hover-frosted-btn" data-action="open-in-editor" data-snippet-id="${s.id}" title="Open in Studio Editor">
          <div class="hover-btn-ambient-halo"></div>
          <svg class="hover-btn-pen-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
          <span class="hover-btn-label">Open in Editor</span>
          <span class="hover-corner-arrow">↗</span>
        </button>
      </div>

      <!-- Right Column Variant: branches out to the right canvas outside the page -->
      <div class="hover-launcher-right">
        <svg class="hover-scribble-arrow-svg arrow-to-right" viewBox="0 0 150 48" fill="none">
          <circle class="arrow-origin-dot" cx="8" cy="38" r="2.5" fill="#0071E3"/>
          <path class="arrow-glow" d="M 8 38 C 48 4, 105 5, 128 24" stroke="rgba(0, 113, 227, 0.35)" stroke-width="4.5" stroke-linecap="round"/>
          <path class="arrow-main" d="M 8 38 C 48 4, 105 5, 128 24" stroke="#0071E3" stroke-width="2.4" stroke-linecap="round"/>
          <path class="arrow-head" d="M 117 22 L 128 24 L 124 14" stroke="#0071E3" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <button type="button" class="card-hover-frosted-btn" data-action="open-in-editor" data-snippet-id="${s.id}" title="Open in Studio Editor">
          <div class="hover-btn-ambient-halo"></div>
          <svg class="hover-btn-pen-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
            <path d="M12 20h9"></path>
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
          </svg>
          <span class="hover-btn-label">Open in Editor</span>
          <span class="hover-corner-arrow">↗</span>
        </button>
      </div>
    </div>
  `;

  const cardStyle = state.settings.card_style || "craft";
  const compText = escapeHtml(s.complexity || "");
  const lang = s.language || "cpp";

  const accentColor = state.settings.accent_color || "#2C2C2A";
  let topicBg = accentColor;
  if (cardStyle === "ide") topicBg = "#18181B";
  else if (cardStyle === "academic") topicBg = "#1C1917";
  else topicBg = accentColor; // Craft uses chosen accent color

  const topicDividerHtml = isFirstInTopic ? `
    <div class="topic-section-divider">
      <span class="topic-section-pill" style="background:${topicBg};">${escapeHtml(topic.name).toUpperCase()}</span>
      <span class="topic-section-line"></span>
    </div>
  ` : "";

  let innerCard = "";
  if (kind === "note") {
    const fileSlug = getSnippetFileSlug(s.title || "note", 12);
    const noteBodyHtml = `<div class="card-note-body">${markdownLite(s.notes || "")}</div>`;

    if (cardStyle === "ide") {
      innerCard = `
        <div class="card card-note card-theme-ide" data-snippet-id="${s.id}" id="preview-card-${s.id}">
          ${hoverLauncherHtml}
          <div class="card-windowbar">
            <span class="card-window-controls">
              <span class="card-window-dot" style="background:#EF4444"></span>
              <span class="card-window-dot" style="background:#F59E0B"></span>
              <span class="card-window-dot" style="background:#10B981"></span>
            </span>
            <span class="card-window-filetab">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>
              <span>${fileSlug}.md</span>
            </span>
            <span class="card-complexity">NOTE</span>
          </div>
          <div class="card-inner-body">
            <div class="card-title">${escapeHtml(s.title)}</div>
            ${noteBodyHtml}
          </div>
        </div>
      `;
    } else if (cardStyle === "academic") {
      innerCard = `
        <div class="card card-note card-theme-academic" data-snippet-id="${s.id}" id="preview-card-${s.id}">
          ${hoverLauncherHtml}
          <div class="card-academic-topbar">
            <span class="card-category-tag">[NOTE // ${escapeHtml(topic.name).toUpperCase()}]</span>
            <span class="card-complexity">MEMO</span>
          </div>
          <div class="card-title">${escapeHtml(s.title)}</div>
          ${noteBodyHtml}
        </div>
      `;
    } else {
      // Craft style (default) - uses chosen accent color
      const dotHtml = `<span class="card-title-dot" style="background:${accentColor}"></span>`;
      innerCard = `
        <div class="card card-note card-theme-craft" data-snippet-id="${s.id}" id="preview-card-${s.id}" style="border-left-color:${accentColor}">
          ${hoverLauncherHtml}
          <div class="card-head">
            <div class="card-title-row">
              ${dotHtml}
              <span class="card-title">${escapeHtml(s.title)}</span>
            </div>
            <span class="card-complexity">⏱ NOTE</span>
          </div>
          ${noteBodyHtml}
        </div>
      `;
    }
  } else if (kind === "formula") {
    innerCard = `
      <div class="card card-formula-card card-theme-${cardStyle}" data-snippet-id="${s.id}" id="preview-card-${s.id}" style="border-left-color:${cardStyle === 'craft' ? accentColor : topic.color}">
        ${hoverLauncherHtml}
        <div class="card-head"><span class="card-title">${escapeHtml(s.title)}</span></div>
        ${formulasHtml(s.formulas, true)}
      </div>
    `;
  } else {
    const notesHtml = (s.notes || "").trim() ? `<p class="card-notes">${escapeHtml(s.notes)}</p>` : "";
    const fontFamily = state.settings.code_font || "JetBrains Mono";
    const fontSize = cardWidthPx ? fitCodeFontSize(s.code, fontFamily, cardWidthPx) : CODE_FONT_BASE_SIZE;

    if (cardStyle === "ide") {
      const fileSlug = getSnippetFileSlug(s.title || "snippet", 12);
      const fileExt = getLangExt(s.language || "cpp");
      innerCard = `
        <div class="card card-theme-ide" data-snippet-id="${s.id}" id="preview-card-${s.id}">
          ${hoverLauncherHtml}
          <div class="card-windowbar">
            <span class="card-window-controls">
              <span class="card-window-dot" style="background:#EF4444"></span>
              <span class="card-window-dot" style="background:#F59E0B"></span>
              <span class="card-window-dot" style="background:#10B981"></span>
            </span>
            <span class="card-window-filetab">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>
              <span>${fileSlug}.${fileExt}</span>
            </span>
            ${compText ? `<span class="card-complexity">${compText}</span>` : `<span class="card-window-spacer"></span>`}
          </div>
          <div class="card-inner-body">
            <div class="card-title">${escapeHtml(s.title)}</div>
            ${notesHtml}
            ${formulasHtml(s.formulas, false)}
            <pre class="card-code" style="font-size:${fontSize}px"><code class="language-${lang}">${escapeHtml(s.code)}</code></pre>
          </div>
        </div>
      `;
    } else if (cardStyle === "academic") {
      innerCard = `
        <div class="card card-theme-academic" data-snippet-id="${s.id}" id="preview-card-${s.id}">
          ${hoverLauncherHtml}
          <div class="card-academic-topbar">
            <span class="card-category-tag">${escapeHtml(topic.name).toUpperCase()}</span>
            ${compText ? `<span class="card-complexity">${compText}</span>` : ""}
          </div>
          <div class="card-title">${escapeHtml(s.title)}</div>
          ${notesHtml}
          ${formulasHtml(s.formulas, false)}
          <pre class="card-code" style="font-size:${fontSize}px"><code class="language-${lang}">${escapeHtml(s.code)}</code></pre>
        </div>
      `;
    } else {
      // Craft Minimalist (Default / Option A) - uses chosen accent color
      innerCard = `
        <div class="card card-theme-craft" data-snippet-id="${s.id}" id="preview-card-${s.id}" style="border-left-color:${accentColor}">
          ${hoverLauncherHtml}
          <div class="card-head">
            <div class="card-title-row">
              <span class="card-title-dot" style="background:${accentColor}"></span>
              <span class="card-title">${escapeHtml(s.title)}</span>
            </div>
            ${compText ? `<span class="card-complexity">⏱ ${compText}</span>` : ""}
          </div>
          ${notesHtml}
          ${formulasHtml(s.formulas, false)}
          <pre class="card-code" style="font-size:${fontSize}px"><code class="language-${lang}">${escapeHtml(s.code)}</code></pre>
        </div>
      `;
    }
  }

  // We still use snippet-container to group elements if needed (or just as a wrapper for consistent margins)
  return `
    <div class="snippet-container" data-snippet-id="${s.id}" id="preview-snippet-${s.id}">
      ${topicDividerHtml}
      ${innerCard}
    </div>
  `;
}

function headerLeftHtml() {
  const on = state.settings.show_team_footer;
  const enabled = !(on === false || on === 0 || on === "0");
  const inst = (state.settings.institution_name || "").trim();
  const team = (state.settings.team_name || "").trim();
  if (!enabled || (!inst && !team)) return "";
  if (inst && team) {
    return `<span class="page-header-left"><span class="hdr-inst">${escapeHtml(inst)}</span><span class="hdr-sep">◆</span><span class="hdr-team">${escapeHtml(team)}</span></span>`;
  }
  return `<span class="page-header-left"><span class="hdr-inst">${escapeHtml(inst || team)}</span></span>`;
}

function syncSnippetsAfterTemplateCheckboxes(checked) {
  if ($("snippets-after-template")) $("snippets-after-template").checked = checked;
  if ($("modal-snippets-after-template")) $("modal-snippets-after-template").checked = checked;
  if ($("canvas-snippets-after-template")) $("canvas-snippets-after-template").checked = checked;
}

function templateCardHTML(label, chunkText, fontSize, cardStyle, tmplHoverLauncherHtml = "", isFlex1 = true) {
  const codeFlex = isFlex1 ? "flex: 1;" : "";
  const heightStyle = isFlex1 ? "height: 100%;" : "";
  if (cardStyle === "ide") {
    return `
      <div class="card card-template card-theme-ide" id="preview-template-card" style="display: flex; flex-direction: column; ${heightStyle}">
        ${tmplHoverLauncherHtml}
        <div class="card-windowbar template-card-header">
          <span class="card-window-controls">
            <span class="card-window-dot" style="background:#EF4444"></span>
            <span class="card-window-dot" style="background:#F59E0B"></span>
            <span class="card-window-dot" style="background:#10B981"></span>
          </span>
          <span class="card-window-filetab">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path></svg>
            <span>template.cpp &bull; ${escapeHtml(label)}</span>
          </span>
          <span class="tmpl-tag">SETUP BUFFER</span>
        </div>
        <pre class="card-code" style="font-size:${fontSize}px; ${codeFlex}"><code class="language-cpp">${escapeHtml(chunkText)}</code></pre>
      </div>
    `;
  } else if (cardStyle === "academic") {
    return `
      <div class="card card-template card-theme-academic" id="preview-template-card" style="display: flex; flex-direction: column; ${heightStyle}">
        ${tmplHoverLauncherHtml}
        <div class="template-card-header">
          <span class="tmpl-pill">CONTEST SETUP SPECIFICATION &mdash; ${escapeHtml(label).toUpperCase()}</span>
          <span class="tmpl-tag">// BOILERPLATE SETUP</span>
        </div>
        <pre class="card-code" style="font-size:${fontSize}px; ${codeFlex}"><code class="language-cpp">${escapeHtml(chunkText)}</code></pre>
      </div>
    `;
  } else {
    // Craft Minimalist (Default / Option A)
    return `
      <div class="card card-template card-theme-craft" id="preview-template-card" style="display: flex; flex-direction: column; ${heightStyle} border-left-color: var(--accent, #2C2C2A);">
        ${tmplHoverLauncherHtml}
        <div class="template-card-header">
          <div class="tmpl-pill">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            <span>${escapeHtml(label)}</span>
          </div>
          <span class="tmpl-tag">C++ SETUP</span>
        </div>
        <pre class="card-code" style="font-size:${fontSize}px; ${codeFlex}"><code class="language-cpp">${escapeHtml(chunkText)}</code></pre>
      </div>
    `;
  }
}

function measureTemplateCardHeight(chunkText, metrics) {
  const fontFamily = state.settings.code_font || "JetBrains Mono";
  const boilerplateWidthPx = boilerplateInnerWidthPx(metrics.contentWidthPx);
  const fontSize = fitCodeFontSize(chunkText, fontFamily, boilerplateWidthPx);
  const cardStyle = state.settings.card_style || "craft";

  const measureDiv = document.createElement("div");
  measureDiv.className = `card-theme-${cardStyle}`;
  measureDiv.style.cssText = `position: fixed; visibility: hidden; top: -99999px; left: 0; width: ${metrics.contentWidthPx}px; box-sizing: border-box;`;
  measureDiv.innerHTML = `
    <div class="snippet-container" style="box-sizing: border-box;">
      ${templateCardHTML("TEMPLATE", chunkText, fontSize, cardStyle, "", false)}
    </div>
  `;
  document.body.appendChild(measureDiv);
  const h = measureDiv.firstElementChild.getBoundingClientRect().height;
  document.body.removeChild(measureDiv);
  return h;
}

// Split arbitrary plain text (the boilerplate) into page-sized chunks by
// measuring off-screen with the exact card structure and font sizing
function buildTextPageChunks(text, metrics) {
  const fontFamily = state.settings.code_font || "JetBrains Mono";
  const boilerplateWidthPx = boilerplateInnerWidthPx(metrics.contentWidthPx);
  const fontSize = fitCodeFontSize(text, fontFamily, boilerplateWidthPx);
  const cardStyle = state.settings.card_style || "craft";

  const measureDiv = document.createElement("div");
  measureDiv.className = `card-theme-${cardStyle}`;
  measureDiv.style.cssText = `position: fixed; visibility: hidden; top: -99999px; left: 0; width: ${metrics.contentWidthPx}px; box-sizing: border-box;`;
  measureDiv.innerHTML = `
    <div class="snippet-container" style="box-sizing: border-box;">
      ${templateCardHTML("TEMPLATE", "", fontSize, cardStyle, "", false)}
    </div>
  `;
  document.body.appendChild(measureDiv);

  const codeEl = measureDiv.querySelector("code");
  const cardEl = measureDiv.querySelector(".card");
  const maxAvailable = metrics.availableHeightPx - 20;

  const lines = text.split("\n");
  const pages = [];
  let current = [];

  lines.forEach((line) => {
    const next = current.concat(line);
    codeEl.textContent = next.join("\n");
    if (cardEl.offsetHeight > maxAvailable && current.length > 0) {
      pages.push(current);
      current = [line];
      codeEl.textContent = line;
    } else {
      current = next;
    }
  });
  if (current.length) pages.push(current);

  document.body.removeChild(measureDiv);
  return pages.map((lns) => lns.join("\n"));
}

function hexToRgbaJs(hex, alpha) {
  let c = (hex || "#0284c7").replace("#", "").trim();
  if (c.length === 3) c = c.split("").map((ch) => ch + ch).join("");
  if (c.length !== 6) return `rgba(2, 132, 199, ${alpha})`;
  const r = parseInt(c.slice(0, 2), 16) || 0;
  const g = parseInt(c.slice(2, 4), 16) || 0;
  const b = parseInt(c.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// JS twin of _cover_html() in pdf_builder.py -- keep both in sync if you
// touch the markup. Each style is genuinely different markup, not just a
// CSS reskin, so the preview matches what the PDF actually produces.
function coverPageHtml(style, bookTitle, teamName, institutionName) {
  const title = escapeHtml(bookTitle);
  const team = escapeHtml(teamName);
  const inst = escapeHtml(institutionName);
  const accent = state.settings.accent_color || "#0284C7";

  if (style === "terminal") {
    const instBlock = inst ? `
      <div class="cover-term-row"><span class="cover-term-prompt" style="color: ${accent};">user@icpc:~$</span> <span class="cover-term-cmd">cat /etc/institution</span></div>
      <div class="cover-term-out cover-term-inst-out term-inst-out" style="color: ${accent};">${inst}</div>` : "";
    const teamBlock = team ? `
      <div class="cover-term-row"><span class="cover-term-prompt" style="color: ${accent};">user@icpc:~$</span> <span class="cover-term-cmd">whoami --team</span></div>
      <div class="cover-term-out cover-term-team-out term-team-out">${team}</div>` : "";
    return `
      <div class="cover-term-window">
        <div class="cover-term-titlebar">
          <div class="cover-term-traffic">
            <span class="cover-term-btn cover-term-btn-red"></span>
            <span class="cover-term-btn cover-term-btn-yellow"></span>
            <span class="cover-term-btn cover-term-btn-green"></span>
          </div>
          <span class="cover-term-tab">nvim — contest_reference.cpp</span>
          <span class="cover-term-session">[UTF-8 // C++20]</span>
        </div>
        <div class="cover-term-body">
          <div class="cover-term-row"><span class="cover-term-prompt" style="color: ${accent};">user@icpc:~$</span> <span class="cover-term-cmd">cat /etc/codebook/title</span></div>
          <div class="cover-term-out cover-term-title-highlight">${title}</div>
          ${instBlock}
          ${teamBlock}
          <div class="cover-term-row"><span class="cover-term-prompt" style="color: ${accent};">user@icpc:~$</span> <span class="cover-term-cursor" style="color: ${accent};">█</span></div>
        </div>
        <div class="cover-term-statusline">
          <span class="cover-term-mode" style="background: ${accent};">NORMAL</span>
          <span class="cover-term-filepath">codebook.cpp</span>
          <span class="cover-term-flags">[RO]</span>
          <span class="cover-term-status-right">
            <span>UTF-8</span>
            <span>C++20</span>
            <span>100%</span>
            <span>LN: 1, COL: 1</span>
          </span>
        </div>
      </div>`;
  }
  if (style === "sketch") {
    const instBlock = inst ? `<p class="cover-sketch-inst">${inst}</p>` : "";
    const teamBlock = team ? `<div class="cover-sketch-team-pill">${team}</div>` : "";
    return `
      <div class="cover-sketch-inner">
        <div class="cover-sketch-border"></div>
        <div class="cover-sketch-doodles" aria-hidden="true">
          <span class="csd csd-1">{</span>
          <span class="csd csd-2">}</span>
          <span class="csd csd-3">;</span>
          <span class="csd csd-4">#include</span>
          <span class="csd csd-5">//</span>
          <span class="csd csd-6">int main()</span>
          <span class="csd csd-7">&lt;&lt;</span>
          <span class="csd csd-8">return 0;</span>
          <span class="csd csd-9">∑</span>
          <span class="csd csd-10">O(n log n)</span>
          <span class="csd csd-11">∫</span>
          <span class="csd csd-12">nullptr</span>
          <span class="csd csd-13">matrix[N][N]</span>
          <span class="csd csd-14">λ</span>
        </div>
        <div class="cover-sketch-body">
          <h1 class="cover-sketch-title">${title}</h1>
          <div class="cover-sketch-rule-row">
            <span class="csk-line"></span>
            <span class="csk-diamond">◆</span>
            <span class="csk-line"></span>
          </div>
          <div class="cover-sketch-meta">
            ${instBlock}
            ${teamBlock}
          </div>
        </div>
      </div>`;
  }
  if (style === "blueprint") {
    const instVal = inst || "COMPETITIVE PROGRAMMING UNION";
    const teamVal = team || "UNREGISTERED TEAM";
    const accentBg = hexToRgbaJs(accent, 0.05);
    const accentBgSub = hexToRgbaJs(accent, 0.08);
    const accentBgSubtle = hexToRgbaJs(accent, 0.02);
    return `
      <div class="cover-bp-inner">
        <div class="cover-bp-corner cover-bp-tl">+</div>
        <div class="cover-bp-corner cover-bp-tr">+</div>
        <div class="cover-bp-corner cover-bp-bl">+</div>
        <div class="cover-bp-corner cover-bp-br">+</div>
        
        <div class="cover-bp-center">
          <div class="cover-bp-schematic">
            <svg class="cover-bp-desktop-svg" viewBox="0 0 240 130" width="240" height="130" fill="none" xmlns="http://www.w3.org/2000/svg">
              <!-- Dimension arrows above monitor -->
              <line x1="35" y1="8" x2="205" y2="8" stroke="${accent}" stroke-width="0.9" stroke-dasharray="3 2" opacity="0.6"/>
              <line x1="35" y1="4" x2="35" y2="12" stroke="${accent}" stroke-width="1"/>
              <line x1="205" y1="4" x2="205" y2="12" stroke="${accent}" stroke-width="1"/>
              <polygon points="35,8 40,6.5 40,9.5" fill="${accent}" opacity="0.8"/>
              <polygon points="205,8 200,6.5 200,9.5" fill="${accent}" opacity="0.8"/>
              <text x="120" y="7" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="4.5" fill="${accent}" font-weight="700" letter-spacing="1.2" opacity="0.85">DISP.UNIT // 27" PRECISION CAD REFERENCE</text>

              <!-- CAD Registration Corner Crosshairs -->
              <path d="M 23 18 L 29 18 M 26 15 L 26 21" stroke="${accent}" stroke-width="0.8" opacity="0.4"/>
              <path d="M 211 18 L 217 18 M 214 15 L 214 21" stroke="${accent}" stroke-width="0.8" opacity="0.4"/>

              <!-- Monitor Chassis -->
              <rect x="35" y="14" width="170" height="84" rx="3.5" stroke="${accent}" stroke-width="1.6" fill="${accentBg}"/>
              <rect x="38" y="17" width="164" height="78" rx="2" stroke="${accent}" stroke-width="0.8" stroke-dasharray="4 2" opacity="0.35"/>
              
              <!-- Screen Active Area -->
              <rect x="41" y="20" width="158" height="72" rx="2" stroke="${accent}" stroke-width="1" fill="${accentBgSubtle}"/>
              
              <!-- Screen Titlebar -->
              <line x1="41" y1="28" x2="199" y2="28" stroke="${accent}" stroke-width="0.9" opacity="0.4"/>
              <circle cx="48" cy="24" r="1.5" fill="${accent}" opacity="0.8"/>
              <circle cx="53" cy="24" r="1.5" fill="${accent}" opacity="0.8"/>
              <circle cx="58" cy="24" r="1.5" fill="${accent}" opacity="0.8"/>
              <rect x="68" y="21.5" width="46" height="6.5" rx="1" stroke="${accent}" stroke-width="0.6" fill="${accentBgSub}"/>
              <text x="91" y="26.2" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="3.8" fill="${accent}" opacity="0.9">codebook.cpp [RO]</text>

              <!-- Vertical Split in Editor -->
              <line x1="130" y1="28" x2="130" y2="92" stroke="${accent}" stroke-width="0.7" stroke-dasharray="2 2" opacity="0.35"/>

              <!-- Left Pane: Code & Gutter -->
              <line x1="50" y1="28" x2="50" y2="92" stroke="${accent}" stroke-width="0.5" opacity="0.25"/>
              <line x1="54" y1="36" x2="88" y2="36" stroke="${accent}" stroke-width="1.5" stroke-linecap="round"/>
              <line x1="62" y1="43" x2="118" y2="43" stroke="${accent}" stroke-width="1.4" stroke-linecap="round" opacity="0.85"/>
              <line x1="62" y1="50" x2="104" y2="50" stroke="${accent}" stroke-width="1.4" stroke-linecap="round" opacity="0.85"/>
              <line x1="72" y1="57" x2="122" y2="57" stroke="${accent}" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/>
              <line x1="72" y1="64" x2="112" y2="64" stroke="${accent}" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/>
              <line x1="62" y1="71" x2="94" y2="71" stroke="${accent}" stroke-width="1.4" stroke-linecap="round" opacity="0.85"/>
              <line x1="54" y1="78" x2="78" y2="78" stroke="${accent}" stroke-width="1.5" stroke-linecap="round"/>
              <rect x="82" y="75" width="5" height="5" fill="${accent}" opacity="0.85"/>
              <line x1="54" y1="85" x2="96" y2="85" stroke="${accent}" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="3 2" opacity="0.5"/>

              <!-- Right Pane: Algorithm Graph / DAG Blueprint -->
              <text x="165" y="36" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="4" fill="${accent}" font-weight="700" letter-spacing="0.8" opacity="0.8">DAG // TOPOLOGICAL</text>
              <!-- Tree Edges -->
              <line x1="162" y1="48" x2="150" y2="59" stroke="${accent}" stroke-width="1.1"/>
              <line x1="168" y1="48" x2="180" y2="59" stroke="${accent}" stroke-width="1.1"/>
              <line x1="145" y1="65.5" x2="140" y2="76" stroke="${accent}" stroke-width="0.9" stroke-dasharray="2 1.5"/>
              <line x1="149" y1="65.5" x2="153" y2="76" stroke="${accent}" stroke-width="0.9"/>
              <line x1="183" y1="66" x2="183" y2="76" stroke="${accent}" stroke-width="0.9"/>
              <!-- Tree Nodes -->
              <circle cx="165" cy="45" r="4" stroke="${accent}" stroke-width="1.2" fill="${accentBgSub}"/>
              <text x="165" y="46.5" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="3.5" fill="${accent}" font-weight="700">1</text>
              <circle cx="147" cy="62" r="3.8" stroke="${accent}" stroke-width="1.1" fill="${accentBg}"/>
              <text x="147" y="63.4" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="3.3" fill="${accent}" font-weight="700">2</text>
              <circle cx="183" cy="62" r="3.8" stroke="${accent}" stroke-width="1.1" fill="${accentBg}"/>
              <text x="183" y="63.4" text-anchor="middle" font-family="'JetBrains Mono', monospace" font-size="3.3" fill="${accent}" font-weight="700">3</text>
              <circle cx="183" cy="62" r="6.5" stroke="${accent}" stroke-width="0.6" stroke-dasharray="1.5 1.5" opacity="0.5"/>
              <circle cx="138" cy="79" r="3.2" stroke="${accent}" stroke-width="1" fill="${accentBg}"/>
              <circle cx="155" cy="79" r="3.2" stroke="${accent}" stroke-width="1" fill="${accentBg}"/>
              <circle cx="183" cy="79" r="3.2" stroke="${accent}" stroke-width="1" fill="${accentBg}"/>

              <!-- Monitor Stand -->
              <path d="M110 98 L130 98 L126 111 L114 111 Z" stroke="${accent}" stroke-width="1.3" fill="${accentBg}"/>
              <rect x="96" y="111" width="48" height="4.5" rx="1.8" stroke="${accent}" stroke-width="1.3" fill="${accentBgSub}"/>
              <line x1="102" y1="113.2" x2="138" y2="113.2" stroke="${accent}" stroke-width="0.6" opacity="0.6"/>

              <!-- Desk Surface / Mat Guideline -->
              <line x1="20" y1="118" x2="220" y2="118" stroke="${accent}" stroke-width="0.7" stroke-dasharray="4 2.5" opacity="0.45"/>

              <!-- Keyboard -->
              <polygon points="68,120 172,120 166,128 74,128" stroke="${accent}" stroke-width="1.2" fill="${accentBg}"/>
              <line x1="77" y1="122.5" x2="163" y2="122.5" stroke="${accent}" stroke-width="0.8" stroke-dasharray="2 1.5"/>
              <line x1="76" y1="125" x2="164" y2="125" stroke="${accent}" stroke-width="0.8" stroke-dasharray="2 1.5"/>
              <line x1="105" y1="126.8" x2="135" y2="126.8" stroke="${accent}" stroke-width="1.3"/>

              <!-- Ergonomic Mouse -->
              <rect x="182" y="121" width="11" height="7.5" rx="3.5" stroke="${accent}" stroke-width="1.1" fill="${accentBg}"/>
              <line x1="187.5" y1="121" x2="187.5" y2="124" stroke="${accent}" stroke-width="0.8"/>
            </svg>
          </div>
          <h1 class="cover-bp-title">${title}</h1>
          <div class="cover-bp-rule-accent"></div>
        </div>

        <div class="cover-bp-block">
          <table class="cover-bp-table">
            <tr>
              <td class="cover-bp-cell cover-bp-cell-main">
                <div class="cover-bp-label">INSTITUTION / UNIVERSITY</div>
                <div class="cover-bp-val-lg">${instVal}</div>
              </td>
            </tr>
            <tr>
              <td class="cover-bp-cell">
                <div class="cover-bp-label">CONTEST TEAM IDENTITY</div>
                <div class="cover-bp-val">${teamVal}</div>
              </td>
            </tr>
          </table>
        </div>
      </div>`;
  }

  // Fallback to Editorial (Sketch) cover
  return coverPageHtml("sketch", bookTitle, teamName, institutionName);
}

function renderPreview() {
  const root = $("preview-scroll");
  root.innerHTML = "";
  const cardStyle = state.settings.card_style || "craft";
  root.classList.remove("card-theme-craft", "card-theme-ide", "card-theme-academic");
  root.classList.add(`card-theme-${cardStyle}`);

  const bookTitle = state.settings.book_title || "Contest Codebook";
  const teamName = state.settings.team_name || "";
  const instName = state.settings.institution_name || "";
  let coverStyle = state.settings.cover_style || "sketch";
  if (coverStyle === "minimal") coverStyle = "sketch";
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

  const flowSnippetsSetting = state.settings.snippets_after_template;
  const snippetsAfterTemplate = !(flowSnippetsSetting === false || flowSnippetsSetting === 0 || flowSnippetsSetting === "0");

  let pages = [];
  let mixedFirstPage = null;
  let remainingHForMixed = 0;
  const gapBelowTemplate = 6 * 3.7795; // ~6mm
  const gapPx = 8 * 3.779527559; // 8mm to px
  const colWidth = Math.floor((metrics.contentWidthPx - gapPx) / 2);

  function renderCol(items) {
    return items.map(item => item.html).join("");
  }

  // Page 2 (if enabled): the pinned boilerplate/starter template, right after the cover.
  const showBoilerplate = !(state.settings.show_boilerplate === false || state.settings.show_boilerplate === 0 || state.settings.show_boilerplate === "0");
  const boilerplateCode = (state.settings.boilerplate_code || "").trim();
  if (showBoilerplate && boilerplateCode) {
    const chunks = buildTextPageChunks(boilerplateCode, metrics);
    const tmplTitle = (state.settings.template_title || "Template").toUpperCase();

    const arrowColor = state.settings.accent_color || "#18181B";
    const tmplHoverLauncherHtml = `
      <div class="card-hover-launcher">
        <div class="hover-launcher-right">
          <svg class="hover-scribble-arrow-svg arrow-to-right" viewBox="0 0 150 48" fill="none">
            <circle class="arrow-origin-dot" cx="8" cy="38" r="2.5" fill="${arrowColor}"/>
            <path class="arrow-glow" d="M 8 38 C 48 4, 105 5, 128 24" stroke="${arrowColor}" stroke-opacity="0.35" stroke-width="4.5" stroke-linecap="round"/>
            <path class="arrow-main" d="M 8 38 C 48 4, 105 5, 128 24" stroke="${arrowColor}" stroke-width="2.4" stroke-linecap="round"/>
            <path class="arrow-head" d="M 117 22 L 128 24 L 124 14" stroke="${arrowColor}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <button type="button" class="card-hover-frosted-btn" data-action="open-template-in-editor" title="Open Setup Template in Editor">
            <div class="hover-btn-ambient-halo"></div>
            <svg class="hover-btn-pen-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
              <path d="M12 20h9"></path>
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
            </svg>
            <span class="hover-btn-label">Open in Editor</span>
            <span class="hover-corner-arrow">↗</span>
          </button>
        </div>
      </div>
    `;

    // Render preceding full template pages if multiple
    for (let idx = 0; idx < chunks.length - 1; idx++) {
      const chunkText = chunks[idx];
      const page = document.createElement("div");
      page.className = "a4-page template-page";
      page.dataset.label = state.settings.template_title || "Template";
      if (idx === 0) page.id = "preview-template-anchor";
      const label = tmplTitle + ` — PART ${idx + 1}/${chunks.length}`;
      const fontSize = fitCodeFontSize(chunkText, fontFamily, boilerplateWidthPx);
      page.innerHTML = `
        <div class="snippet-container" style="height: calc(100% - 20px);">
          ${templateCardHTML(label, chunkText, fontSize, cardStyle, tmplHoverLauncherHtml, true)}
        </div>
        ${headerLeft}
        <span class="page-number">${pageNum}</span>
      `;
      root.appendChild(page);
      pageNum++;
    }

    // Handle LAST template chunk
    const lastIdx = chunks.length - 1;
    const lastChunkText = chunks[lastIdx];
    const label = tmplTitle + (chunks.length > 1 ? ` — PART ${lastIdx + 1}/${chunks.length}` : "");
    const fontSize = fitCodeFontSize(lastChunkText, fontFamily, boilerplateWidthPx);
    const lastChunkHeight = measureTemplateCardHeight(lastChunkText, metrics);
    const remainingH = metrics.availableHeightPx - lastChunkHeight - gapBelowTemplate;

    if (snippetsAfterTemplate && remainingH >= 70 && topicsWithSnippets.length > 0) {
      pages = buildContinuousPages(topicsWithSnippets, metrics, remainingH);
      if (pages.length > 0 && (pages[0].col1.length > 0 || pages[0].col2.length > 0)) {
        mixedFirstPage = pages[0];
        pages = pages.slice(1);
        remainingHForMixed = remainingH;
      }
    }

    if (mixedFirstPage) {
      // Mixed page: Template card at top + Snippets columns below on same page
      const page = document.createElement("div");
      page.className = "a4-page template-page mixed-template-page";
      page.dataset.label = state.settings.template_title || "Template";
      if (lastIdx === 0) page.id = "preview-template-anchor";

      page.innerHTML = `
        <div class="snippet-container template-snippet-container" style="margin-bottom: ${gapBelowTemplate}px;">
          ${templateCardHTML(label, lastChunkText, fontSize, cardStyle, tmplHoverLauncherHtml, false)}
        </div>
        <div style="display: flex; gap: ${gapPx}px; height: ${remainingHForMixed}px;">
          <div class="page-column col-left" style="width: ${colWidth}px; display: flex; flex-direction: column;">
            ${renderCol(mixedFirstPage.col1)}
          </div>
          <div class="page-column col-right" style="width: ${colWidth}px; display: flex; flex-direction: column;">
            ${renderCol(mixedFirstPage.col2)}
          </div>
        </div>
        ${headerLeft}
        <span class="page-number">${pageNum}</span>
      `;
      root.appendChild(page);
      pageNum++;
    } else {
      // Dedicated template page
      const page = document.createElement("div");
      page.className = "a4-page template-page";
      page.dataset.label = state.settings.template_title || "Template";
      if (lastIdx === 0) page.id = "preview-template-anchor";
      page.innerHTML = `
        <div class="snippet-container" style="height: calc(100% - 20px);">
          ${templateCardHTML(label, lastChunkText, fontSize, cardStyle, tmplHoverLauncherHtml, true)}
        </div>
        ${headerLeft}
        <span class="page-number">${pageNum}</span>
      `;
      root.appendChild(page);
      pageNum++;

      if (topicsWithSnippets.length > 0 && pages.length === 0) {
        pages = buildContinuousPages(topicsWithSnippets, metrics, null);
      }
    }
  } else {
    if (topicsWithSnippets.length > 0) {
      pages = buildContinuousPages(topicsWithSnippets, metrics, null);
    }
  }

  // Topic pages -- explicitly packed to perfectly balance filling columns without Blink engine bugs
  if (pages.length > 0) {
    pages.forEach((page) => {
      const domPage = document.createElement("div");
      domPage.className = "a4-page topic-page";
      
      const firstItem = page.col1.length > 0 ? page.col1[0] : (page.col2.length > 0 ? page.col2[0] : null);
      domPage.dataset.label = firstItem ? firstItem.topic.name : `Page ${pageNum}`;

      domPage.innerHTML = `
        <div style="display: flex; gap: ${gapPx}px; height: ${metrics.availableHeightPx}px;">
          <div class="page-column col-left" style="width: ${colWidth}px; display: flex; flex-direction: column;">
            ${renderCol(page.col1)}
          </div>
          <div class="page-column col-right" style="width: ${colWidth}px; display: flex; flex-direction: column;">
            ${renderCol(page.col2)}
          </div>
        </div>
        ${headerLeft}
        <span class="page-number">${pageNum}</span>
      `;
      root.appendChild(domPage);
      pageNum++;
    });
  }

  // Syntax-highlight the code just inserted (P1.2) -- same restrained
  // palette as the printed PDF, see the .token.* rules in style.css.
  if (typeof Prism !== "undefined") Prism.highlightAllUnder(root);
  renderThumbnails();
  updatePageBudget();
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
    thumb.title = `Page ${idx + 1}: ${pageEl.dataset.label || "Page"}`;
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
      if (canvasViewMode === "editor") {
        setCanvasMode("preview");
      }
      pageEl.scrollIntoView({ behavior: "instant", block: "center" });
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
  
  let _scrollSyncRaf = null;
  previewArea.addEventListener("scroll", () => {
    if (_scrollSyncRaf) return;
    _scrollSyncRaf = requestAnimationFrame(() => {
      _scrollSyncRaf = null;
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
        thumb.classList.toggle("active", idx === closestIdx);
      });
    });
  }, { passive: true });
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



function buildContinuousPages(topics, metrics, firstPageMaxH = null) {
  const cardW = cardInnerWidthPx(metrics.contentWidthPx);
  const gapPx = 8 * 3.779527559; // 8mm to px
  const colWidth = Math.floor((metrics.contentWidthPx - gapPx) / 2);
  const maxH = metrics.availableHeightPx;

  const cardStyle = state.settings.card_style || "craft";
  const measureDiv = document.createElement("div");
  measureDiv.className = `card-theme-${cardStyle}`;
  measureDiv.style.cssText = `position: fixed; visibility: hidden; top: -99999px; left: 0; width: ${colWidth}px;`;
  document.body.appendChild(measureDiv);

  const mbPx = 4 * 3.7795;
  const fontFamily = state.settings.code_font || "JetBrains Mono";
  
  const pages = [];
  let pageData = { col1: [], col2: [] };
  let currentColumnHeight = 0;
  let isLeftCol = true;
  let isFirstPage = Boolean(firstPageMaxH && firstPageMaxH >= 60);

  function getColMaxH() {
    return isFirstPage ? firstPageMaxH : maxH;
  }

  function newColumn() {
    if (isLeftCol) {
      isLeftCol = false;
    } else {
      pages.push(pageData);
      pageData = { col1: [], col2: [] };
      isLeftCol = true;
      isFirstPage = false;
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
      const remainingSpace = getColMaxH() + mbPx - currentColumnHeight;

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
        if (h > getColMaxH() + mbPx) {
          newColumn();
          if (isFirstPage && h > getColMaxH() + mbPx) {
            newColumn();
          }
        } else {
          newColumn();
        }
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
        let spaceForThisPart = getColMaxH() + mbPx - currentColumnHeight;
        if (spaceForThisPart < 60) {
          newColumn();
          spaceForThisPart = getColMaxH() + mbPx;
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
function applyKindVisibility(kind) {
  const isCode = kind === "code";
  const badge = $("snippet-modal-badge");
  const titleEl = $("snippet-modal-title");
  const titleRow = $("craft-title-complexity-row");
  const complexityField = $("field-complexity");
  const codeField = $("field-code");
  const noteField = $("field-note");

  if (badge) {
    badge.textContent = isCode ? "CODE" : "NOTE";
    badge.classList.toggle("is-note", !isCode);
  }
  if (titleEl) {
    titleEl.textContent = editingSnippetId
      ? (isCode ? "Edit Code Snippet" : "Edit Note")
      : (isCode ? "New Code Snippet" : "New Note");
  }

  if (isCode) {
    if (titleRow) titleRow.classList.remove("is-single-col");
    if (complexityField) complexityField.style.display = "flex";
    if (codeField) codeField.style.display = "flex";
    if (noteField) noteField.style.display = "none";
  } else {
    if (titleRow) titleRow.classList.add("is-single-col");
    if (complexityField) complexityField.style.display = "none";
    if (codeField) codeField.style.display = "none";
    if (noteField) noteField.style.display = "flex";
  }
}

// ---------------- IN-CANVAS DUAL STUDIO EDITOR ----------------

let isArrowEntryAnimating = false;

function playArrowEntryAnimation() {
  const mainPath = $("bridge-main-path");
  const glowPath = $("bridge-glow-path");
  const arrowhead = $("bridge-arrowhead");
  const btnWrap = $("bridge-button-wrapper");

  if (!mainPath) return;

  updateBridgeArrowPhysics(true);

  let length = 120;
  try {
    length = mainPath.getTotalLength() || 120;
  } catch (e) {
    length = 120;
  }

  isArrowEntryAnimating = true;

  mainPath.style.strokeDasharray = `${length}`;
  mainPath.style.strokeDashoffset = `${length}`;
  if (glowPath) {
    glowPath.style.strokeDasharray = `${length}`;
    glowPath.style.strokeDashoffset = `${length}`;
  }
  if (arrowhead) {
    arrowhead.style.opacity = "0";
    arrowhead.style.transform = "scale(0.5)";
    arrowhead.style.transformOrigin = "center";
  }
  if (btnWrap) {
    btnWrap.style.opacity = "0.7";
    btnWrap.style.transform = `translate3d(0, 0, 0) scale(0.95)`;
  }

  const startTime = performance.now();
  const duration = 460;

  function animateEntry(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    const offset = length * (1 - ease);

    mainPath.style.strokeDashoffset = `${offset.toFixed(1)}`;
    if (glowPath) {
      glowPath.style.strokeDashoffset = `${offset.toFixed(1)}`;
    }

    if (progress > 0.75 && arrowhead) {
      const headProgress = (progress - 0.75) / 0.25;
      arrowhead.style.opacity = `${headProgress.toFixed(2)}`;
      arrowhead.style.transform = `scale(${(0.5 + headProgress * 0.5).toFixed(2)})`;
    }

    if (btnWrap) {
      const btnScale = 0.95 + ease * 0.05;
      btnWrap.style.opacity = `${(0.7 + ease * 0.3).toFixed(2)}`;
      btnWrap.style.transform = `translate3d(0, 0, 0) scale(${btnScale.toFixed(3)})`;
    }

    if (progress < 1) {
      requestAnimationFrame(animateEntry);
    } else {
      isArrowEntryAnimating = false;
      mainPath.style.strokeDasharray = "";
      mainPath.style.strokeDashoffset = "";
      if (glowPath) {
        glowPath.style.strokeDasharray = "";
        glowPath.style.strokeDashoffset = "";
      }
      if (arrowhead) {
        arrowhead.style.opacity = "1";
        arrowhead.style.transform = "";
      }
      if (btnWrap) {
        btnWrap.style.opacity = "";
        btnWrap.style.transform = `translate3d(0, 0, 0)`;
      }
    }
  }

  requestAnimationFrame(animateEntry);
}

function updateBridgeArrowPhysics(force = false) {
  const appEl = document.querySelector(".app");
  if (appEl && appEl.classList.contains("compact-canvas")) return;

  const doc = document.querySelector(".craft-editor-doc");
  const origin = $("editor-header-arrow-origin");
  const btnWrap = $("bridge-button-wrapper");
  const glowPath = $("bridge-glow-path");
  const mainPath = $("bridge-main-path");
  const arrowhead = $("bridge-arrowhead");

  if (!doc || !btnWrap || !mainPath) return;

  const docRect = doc.getBoundingClientRect();
  let startX = doc.offsetWidth - 24;
  let startY = 40;

  if (origin) {
    const originRect = origin.getBoundingClientRect();
    startX = Math.round((originRect.left + originRect.width / 2) - docRect.left);
    startY = Math.round((originRect.top + originRect.height / 2) - docRect.top);
  }

  // Maximum downward travel distance along the document
  const maxTravel = Math.max(0, doc.offsetHeight - 90);
  const clampedTargetY = Math.min(Math.max(0, bridgeTargetY), maxTravel);

  if (!force) {
    bridgeCurrentY += (clampedTargetY - bridgeCurrentY) * 0.22;
  } else {
    bridgeCurrentY = clampedTargetY;
  }

  // Move button wrapper along the side of the doc
  if (!isArrowEntryAnimating) {
    btnWrap.style.transform = `translate3d(0, ${bridgeCurrentY.toFixed(1)}px, 0)`;
  }

  // Connection point: Landing gracefully on TOP of the frosted pill button!
  const endX = Math.round(doc.offsetWidth + 22 + 28);
  const endY = Math.round(40 + bridgeCurrentY - 1);

  const deltaX = endX - startX;
  const deltaY = endY - startY;

  // Organic curved Bézier path landing on top of the button
  let cp1X, cp1Y, cp2X, cp2Y;
  if (Math.abs(deltaY) < 18) {
    // Resting position at top: graceful arc up and over onto top of button
    cp1X = startX + deltaX * 0.45;
    cp1Y = startY - 26;
    cp2X = endX - 12;
    cp2Y = endY - 32;
  } else {
    // Extended position when scrolled down: swoops out past doc border and down
    cp1X = startX + deltaX * 0.50;
    cp1Y = startY + deltaY * 0.16;
    cp2X = endX - 8;
    cp2Y = endY - Math.max(38, deltaY * 0.18);
  }

  const pathD = `M ${startX} ${startY} C ${cp1X.toFixed(1)} ${cp1Y.toFixed(1)}, ${cp2X.toFixed(1)} ${cp2Y.toFixed(1)}, ${endX} ${endY}`;
  mainPath.setAttribute("d", pathD);
  if (glowPath) glowPath.setAttribute("d", pathD);

  // Dynamic situational arrowhead rotation based on curve tangent at landing point
  const tanX = endX - cp2X;
  const tanY = endY - cp2Y;
  const angle = Math.atan2(tanY, tanX);

  const headLen = 7.5;
  const spread = 0.52; // ~30 deg
  const w1x = endX - headLen * Math.cos(angle - spread);
  const w1y = endY - headLen * Math.sin(angle - spread);
  const w2x = endX - headLen * Math.cos(angle + spread);
  const w2y = endY - headLen * Math.sin(angle + spread);

  const headD = `M ${w1x.toFixed(1)} ${w1y.toFixed(1)} L ${endX} ${endY} L ${w2x.toFixed(1)} ${w2y.toFixed(1)}`;
  if (arrowhead) arrowhead.setAttribute("d", headD);

  if (Math.abs(clampedTargetY - bridgeCurrentY) > 0.15) {
    requestAnimationFrame(() => updateBridgeArrowPhysics(false));
  } else {
    bridgeAnimRunning = false;
  }
}

function setCanvasMode(mode) {
  canvasViewMode = mode;
  const editorCanvas = $("editor-canvas");
  const previewScroll = $("preview-scroll");
  const editorBtn = $("mode-editor-btn");
  const previewBtn = $("mode-preview-btn");
  const thumbnailsRail = $("thumbnails-rail");
  const zoomGroup = document.querySelector(".dock-zoom-group");
  const layoutGroup = document.querySelector(".dock-segmented-control[role='radiogroup']");
  const dividers = document.querySelectorAll(".dock-divider:not(.dock-divider-mode)");

  if (mode === "editor") {
    if (window.innerWidth <= 768 && typeof setMobileTab === "function") {
      setMobileTab("editor");
    }
    if (editorCanvas) editorCanvas.style.display = "flex";
    if (previewScroll) previewScroll.style.display = "none";
    if (editorBtn) {
      editorBtn.classList.add("active");
      editorBtn.setAttribute("aria-selected", "true");
    }
    if (previewBtn) {
      previewBtn.classList.remove("active");
      previewBtn.setAttribute("aria-selected", "false");
    }
    // Keep thumbnails rail visible in editor mode so canvas layout matches preview seamlessly
    if (thumbnailsRail) {
      thumbnailsRail.style.display = "";
      if (thumbnailsRail.children.length === 0) {
        renderThumbnails();
      }
    }
    if (zoomGroup) zoomGroup.style.display = "none";
    if (layoutGroup) layoutGroup.style.display = "none";
    dividers.forEach((d) => (d.style.display = "none"));

    // Instant swap to top (no laggy smooth scroll)
    const previewArea = $("preview-area");
    if (previewArea) previewArea.scrollTop = 0;

    requestAnimationFrame(() => {
      if (canvasCodeEditor) canvasCodeEditor.refresh();
      bridgeTargetY = 0;
      bridgeCurrentY = 0;
      playArrowEntryAnimation();
    });
  } else {
    // mode === "preview"
    if (window.innerWidth <= 768 && typeof setMobileTab === "function" && mobileActiveTab === "editor") {
      setMobileTab("preview");
    }
    if (editorCanvas) editorCanvas.style.display = "none";
    if (previewScroll) previewScroll.style.display = "flex";
    if (editorBtn) {
      editorBtn.classList.remove("active");
      editorBtn.setAttribute("aria-selected", "false");
    }
    if (previewBtn) {
      previewBtn.classList.add("active");
      previewBtn.setAttribute("aria-selected", "true");
    }
    if (thumbnailsRail) thumbnailsRail.style.display = "";
    if (zoomGroup) zoomGroup.style.display = "";
    if (layoutGroup) layoutGroup.style.display = "";
    dividers.forEach((d) => (d.style.display = ""));

    if (_previewDirty || !previewScroll || previewScroll.children.length === 0) {
      _previewDirty = false;
      renderPreview();
    } else {
      updatePreviewScale();
    }
  }
  renderSidebar(); // refresh active snippet indicator in vault tree
}

function setEditorSaveStatus(status) {
  const statusEl = $("canvas-editor-status");
  const statusText = $("canvas-editor-status-text");
  const pulseDot = statusEl ? statusEl.querySelector(".status-pulse-dot") : null;
  if (!statusEl || !statusText) return;

  if (status === "saving") {
    statusText.textContent = "Saving...";
    if (pulseDot) pulseDot.className = "status-pulse-dot is-saving";
  } else if (status === "unsaved") {
    statusText.textContent = "Unsaved changes";
    if (pulseDot) pulseDot.className = "status-pulse-dot is-saving";
  } else {
    statusText.textContent = "Saved";
    if (pulseDot) pulseDot.className = "status-pulse-dot";
  }
}

function scheduleCanvasEditorAutoSave() {
  clearTimeout(editorAutoSaveTimer);
  editorAutoSaveTimer = setTimeout(() => {
    saveCanvasEditor(false);
  }, 600);
}

function openTemplateEditor() {
  currentEditingKind = "template";
  currentEditingSnippet = null;
  currentEditingTopicId = null;

  isProgrammaticSetting = true;

  const badge = $("canvas-editor-badge");
  if (badge) {
    badge.textContent = "SETUP";
    badge.className = "editor-doc-badge is-template";
  }

  if ($("canvas-editor-title")) {
    $("canvas-editor-title").value = state.settings.template_title || "Template";
    $("canvas-editor-title").placeholder = "Template Name...";
  }

  const metaBar = $("canvas-editor-meta-bar");
  if (metaBar) metaBar.style.display = "flex";
  if ($("canvas-editor-complexity-chip")) $("canvas-editor-complexity-chip").style.display = "none";
  if ($("canvas-editor-lang-chip")) $("canvas-editor-lang-chip").style.display = "none";
  const flowChip = $("canvas-template-flow-chip");
  if (flowChip) {
    flowChip.style.display = "inline-flex";
    const flowSetting = state.settings.snippets_after_template;
    const isFlowOn = !(flowSetting === false || flowSetting === 0 || flowSetting === "0");
    const flowCheck = $("canvas-snippets-after-template");
    if (flowCheck) flowCheck.checked = isFlowOn;
  }

  const codeWorkspace = $("canvas-editor-code-workspace");
  const noteWorkspace = $("canvas-editor-note-workspace");
  if (codeWorkspace) codeWorkspace.style.display = "flex";
  if (noteWorkspace) noteWorkspace.style.display = "none";

  initCanvasCodeEditor();
  setCanvasEditorLanguage("cpp");

  const val = state.settings.boilerplate_code || "";
  if (canvasCodeEditor) {
    canvasCodeEditor.setValue(val);
  } else if ($("canvas-editor-code")) {
    $("canvas-editor-code").value = val;
  }

  const delBtn = $("canvas-editor-delete-btn");
  if (delBtn) delBtn.style.display = "none";

  isProgrammaticSetting = false;
  setEditorSaveStatus("saved");
  setCanvasMode("editor");

  requestAnimationFrame(() => {
    if (canvasCodeEditor) {
      canvasCodeEditor.refresh();
      canvasCodeEditor.focus();
    }
  });
}
window.openTemplateEditor = openTemplateEditor;
window.openCanvasEditorForTemplate = openTemplateEditor;

function autoResizeNoteTextarea() {
  const noteEl = $("canvas-editor-note");
  if (!noteEl) return;
  noteEl.style.height = "auto";
  noteEl.style.height = Math.max(380, noteEl.scrollHeight) + "px";
}

function openSnippetEditor(snippet, defaultTopicId, defaultKind = "code") {
  currentEditingSnippet = snippet;
  const kind = snippet && snippet.kind ? snippet.kind : (defaultKind || "code");
  currentEditingKind = kind;
  currentEditingTopicId = snippet
    ? snippet.topic_id
    : (defaultTopicId || (state.topics[0] && state.topics[0].id));

  isProgrammaticSetting = true;

  const isCode = kind === "code";
  const badge = $("canvas-editor-badge");
  if (badge) {
    badge.textContent = isCode ? "CODE" : "NOTE";
    badge.className = "editor-doc-badge" + (isCode ? "" : " is-note");
  }

  // Set Title & Complexity
  if ($("canvas-editor-title")) $("canvas-editor-title").value = snippet ? (snippet.title || "") : "";
  if ($("canvas-editor-complexity")) $("canvas-editor-complexity").value = snippet ? (snippet.complexity || "") : "";

  // Workspaces
  const codeWorkspace = $("canvas-editor-code-workspace");
  const noteWorkspace = $("canvas-editor-note-workspace");
  const metaBar = $("canvas-editor-meta-bar");
  const compChip = $("canvas-editor-complexity-chip");
  const langChip = $("canvas-editor-lang-chip");

  if (isCode) {
    if (codeWorkspace) codeWorkspace.style.display = "flex";
    if (noteWorkspace) noteWorkspace.style.display = "none";
    if (metaBar) metaBar.style.display = "flex";
    if (compChip) compChip.style.display = "inline-flex";
    if (langChip) langChip.style.display = "inline-flex";
    if ($("canvas-template-flow-chip")) $("canvas-template-flow-chip").style.display = "none";

    const lang = (snippet && snippet.language) ? snippet.language : "cpp";
    if ($("canvas-editor-lang")) $("canvas-editor-lang").value = lang;

    initCanvasCodeEditor();
    setCanvasEditorLanguage(lang);

    if (canvasCodeEditor) {
      canvasCodeEditor.setValue(snippet ? (snippet.code || "") : "");
    } else if ($("canvas-editor-code")) {
      $("canvas-editor-code").value = snippet ? (snippet.code || "") : "";
    }
  } else {
    if (codeWorkspace) codeWorkspace.style.display = "none";
    if (noteWorkspace) noteWorkspace.style.display = "flex";
    if (metaBar) metaBar.style.display = "none";
    if ($("canvas-editor-note")) {
      $("canvas-editor-note").value = snippet ? (snippet.notes || "") : "";
      autoResizeNoteTextarea();
    }
  }

  // Delete button
  const delBtn = $("canvas-editor-delete-btn");
  if (delBtn) delBtn.style.display = snippet ? "inline-flex" : "none";

  isProgrammaticSetting = false;
  setEditorSaveStatus("saved");
  setCanvasMode("editor");

  requestAnimationFrame(() => {
    if (isCode && canvasCodeEditor) {
      canvasCodeEditor.refresh();
    }
    if (!snippet || !snippet.title) {
      if ($("canvas-editor-title")) $("canvas-editor-title").focus();
    } else if (isCode && canvasCodeEditor) {
      canvasCodeEditor.focus();
    }
  });
}

async function saveCanvasEditor(returnToPreview = false) {
  setEditorSaveStatus("saving");

  if (currentEditingKind === "template") {
    const code = canvasCodeEditor ? canvasCodeEditor.getValue() : ($("canvas-editor-code") ? $("canvas-editor-code").value : "");
    const templateTitle = ($("canvas-editor-title") ? $("canvas-editor-title").value.trim() : "") || "Template";
    state.settings.boilerplate_code = code;
    state.settings.template_title = templateTitle;
    if ($("boilerplate-code")) $("boilerplate-code").value = code;
    if ($("template-group-name")) $("template-group-name").textContent = templateTitle;

    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...state.settings,
          boilerplate_code: code,
          template_title: templateTitle,
        }),
      });
      setEditorSaveStatus("saved");
      _previewDirty = true;
      if (returnToPreview) {
        setCanvasMode("preview");
        scrollToActiveItemInPreview();
        setStatus("Template page saved.", "success");
      }
    } catch (err) {
      console.error("Save template error:", err);
      setEditorSaveStatus("unsaved");
      setStatus("Failed to save template.", "error");
    }
    return;
  }

  const isCode = currentEditingKind === "code";
  const title = ($("canvas-editor-title") ? $("canvas-editor-title").value.trim() : "") || (isCode ? "Untitled Snippet" : "Untitled Note");
  const complexity = isCode && $("canvas-editor-complexity") ? $("canvas-editor-complexity").value.trim() : "";
  const topicId = currentEditingTopicId || (currentEditingSnippet ? currentEditingSnippet.topic_id : (state.topics[0] ? state.topics[0].id : "data-structures"));
  const lang = $("canvas-editor-lang") ? $("canvas-editor-lang").value : "cpp";
  const code = isCode ? (canvasCodeEditor ? canvasCodeEditor.getValue() : ($("canvas-editor-code") ? $("canvas-editor-code").value : "")) : "";
  const notes = !isCode && $("canvas-editor-note") ? $("canvas-editor-note").value : "";

  const payload = {
    kind: isCode ? "code" : "note",
    title,
    subtitle: "",
    complexity,
    topic_id: topicId,
    code,
    notes,
    formulas: [],
    language: lang,
    sort_order: (currentEditingSnippet && currentEditingSnippet.sort_order) || 100,
  };

  try {
    if (currentEditingSnippet && currentEditingSnippet.id) {
      const res = await fetch(`/api/snippet/${currentEditingSnippet.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok && data.snippet) {
        currentEditingSnippet = data.snippet;
      } else {
        currentEditingSnippet = { ...currentEditingSnippet, ...payload };
      }
    } else {
      const res = await fetch("/api/snippet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok && data.id) {
        currentEditingSnippet = data.snippet || { id: data.id, ...payload };
        if ($("canvas-editor-delete-btn")) $("canvas-editor-delete-btn").style.display = "inline-flex";
      }
    }

    setEditorSaveStatus("saved");

    // In-memory update of state so preview and sidebar stay instant
    const topic = state.topics.find((t) => String(t.id) === String(topicId));
    if (topic && currentEditingSnippet) {
      const idx = topic.snippets.findIndex((s) => s.id === currentEditingSnippet.id);
      if (idx >= 0) {
        topic.snippets[idx] = { ...topic.snippets[idx], ...currentEditingSnippet };
      } else {
        topic.snippets.push(currentEditingSnippet);
      }
    }
    _previewDirty = true;
    renderSidebar();

    if (returnToPreview) {
      setCanvasMode("preview");
      scrollToActiveItemInPreview();
      setStatus("Saved changes to book.", "success");
    }
  } catch (err) {
    console.error("Save error:", err);
    setEditorSaveStatus("unsaved");
    setStatus("Failed to save.", "error");
  }
}

async function deleteCanvasEditorSnippet() {
  if (currentEditingKind === "template") return;
  if (!currentEditingSnippet || !currentEditingSnippet.id) {
    setCanvasMode("preview");
    return;
  }
  const title = currentEditingSnippet.title || "this file";
  const ok = await showConfirm(
    "Delete this file?",
    `Are you sure you want to permanently delete "${title}"?`,
    "Delete file",
    $("canvas-editor-delete-btn")
  );
  if (!ok) return;

  await fetch(`/api/snippet/${currentEditingSnippet.id}`, { method: "DELETE" });
  currentEditingSnippet = null;
  setStatus("File deleted.", "success");
  await loadState();
  setCanvasMode("preview");
}

function scrollToActiveItemInPreview() {
  const previewArea = $("preview-area");
  if (!previewArea) return;

  const performScroll = () => {
    let targetEl = null;
    if (currentEditingKind === "template") {
      targetEl = document.getElementById("preview-template-anchor") ||
                 document.getElementById("preview-template-card") ||
                 document.querySelector(".template-page");
    } else if (currentEditingSnippet && currentEditingSnippet.id) {
      targetEl = document.getElementById(`preview-snippet-${currentEditingSnippet.id}`) ||
                 document.getElementById(`preview-card-${currentEditingSnippet.id}`) ||
                 document.querySelector(`[data-snippet-id="${currentEditingSnippet.id}"]`);
    }

    if (targetEl) {
      const elRect = targetEl.getBoundingClientRect();
      const areaRect = previewArea.getBoundingClientRect();
      const targetScrollTop = previewArea.scrollTop + (elRect.top - areaRect.top) - (previewArea.clientHeight / 2) + (elRect.height / 2);
      
      // INSTANT 0ms TELEPORT (No laggy slow scroll)
      previewArea.scrollTop = Math.max(0, targetScrollTop);

      targetEl.classList.remove("snippet-highlight-flash");
      void targetEl.offsetWidth; // Force CSS reflow
      targetEl.classList.add("snippet-highlight-flash");
      setTimeout(() => {
        targetEl.classList.remove("snippet-highlight-flash");
      }, 2000);
      return true;
    }
    return false;
  };

  // Immediate teleport in current frame
  if (!performScroll()) {
    requestAnimationFrame(performScroll);
  }
}

function copyCanvasEditorCode() {
  const code = canvasCodeEditor ? canvasCodeEditor.getValue() : ($("canvas-editor-code") ? $("canvas-editor-code").value : "");
  if (!code) return;
  navigator.clipboard.writeText(code).then(() => {
    const copyBtn = $("canvas-editor-copy-btn");
    if (copyBtn) {
      const origContent = copyBtn.innerHTML;
      copyBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Copied!</span>
      `;
      setTimeout(() => {
        copyBtn.innerHTML = origContent;
      }, 1600);
    }
  });
}

function openSnippetModal(snippet, defaultTopicId, defaultKind = "code") {
  openSnippetEditor(snippet, defaultTopicId, defaultKind);
}

function closeSnippetModal() {
  $("snippet-modal-backdrop").classList.remove("open");
  editingSnippetId = null;
}

async function saveSnippet(e) {
  e.preventDefault();
  const kind = $("snippet-kind") ? $("snippet-kind").value : "code";
  const topicId = $("snippet-topic") ? $("snippet-topic").value : (state.topics[0] ? state.topics[0].id : "general");
  const payload = {
    kind,
    title: ($("snippet-title") ? $("snippet-title").value.trim() : "") || (kind === "note" ? "Untitled Note" : "Untitled Snippet"),
    subtitle: "",
    complexity: kind === "code" && $("snippet-complexity") ? $("snippet-complexity").value.trim() : "",
    topic_id: topicId,
    code: kind === "code" ? getCode() : "",
    notes: kind === "note" && $("snippet-notes") ? $("snippet-notes").value : "",
    formulas: [],
    language: "cpp",
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
  const ok = await showConfirm(
    "Delete this template?",
    `Are you sure you want to permanently delete "${title}"?`,
    "Delete template",
    $("snippet-delete-btn")
  );
  if (!ok) return;
  await fetch(`/api/snippet/${editingSnippetId}`, { method: "DELETE" });
  closeSnippetModal();
  loadState();
}

// ---------------- TOPIC MODAL ----------------

function openTopicModal() {
  triggerInlineNewTopic();
}

function closeTopicModal() {
  const backdrop = $("topic-modal-backdrop");
  if (backdrop) backdrop.classList.remove("open");
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

// ---------------- TEMPLATE PAGE MODAL ----------------

let boilerplateCodeEditor = null;

function initBoilerplateEditor() {
  if (boilerplateCodeEditor || typeof CodeMirror === "undefined") return;
  const textarea = $("boilerplate-code");
  if (!textarea) return;
  boilerplateCodeEditor = CodeMirror.fromTextArea(textarea, {
    mode: "text/x-c++src",
    theme: "default",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    viewportMargin: Infinity,
  });
  boilerplateCodeEditor.on("change", () => {
    boilerplateCodeEditor.save();
    state.settings.boilerplate_code = $("boilerplate-code").value;
    renderPreview();
  });
}

function openTemplateModal() {
  const modal = $("template-modal-backdrop");
  if (!modal) return;
  initBoilerplateEditor();
  const val = state.settings.boilerplate_code || "";
  if (boilerplateCodeEditor) {
    boilerplateCodeEditor.setValue(val);
  } else if ($("boilerplate-code")) {
    $("boilerplate-code").value = val;
  }
  const color = state.settings.template_accent_color || state.settings.accent_color || "#5B4A8A";
  if ($("template-accent-color")) {
    $("template-accent-color").value = color;
    updatePaletteActiveState("template-accent-color", color);
  }
  const showSetting = state.settings.show_boilerplate;
  const isBoilerplateOn = !(showSetting === false || showSetting === 0 || showSetting === "0");
  if ($("modal-show-boilerplate")) $("modal-show-boilerplate").checked = isBoilerplateOn;
  modal.classList.add("open");
  requestAnimationFrame(() => {
    if (boilerplateCodeEditor) boilerplateCodeEditor.refresh();
  });
}

function closeTemplateModal() {
  const modal = $("template-modal-backdrop");
  if (modal) modal.classList.remove("open");
}

async function saveTemplateModal(e) {
  if (e) e.preventDefault();
  if (boilerplateCodeEditor) boilerplateCodeEditor.save();
  if ($("boilerplate-code")) {
    state.settings.boilerplate_code = $("boilerplate-code").value;
  }
  if ($("template-accent-color")) {
    state.settings.template_accent_color = $("template-accent-color").value;
  }
  if ($("modal-show-boilerplate")) {
    state.settings.show_boilerplate = $("modal-show-boilerplate").checked;
    if ($("show-boilerplate")) $("show-boilerplate").checked = state.settings.show_boilerplate;
  }
  closeTemplateModal();
  await saveSettings();
  renderSidebar();
  renderPreview();
  setStatus("Template page saved.", "success");
}

// ---------------- BOOK SETTINGS (debounced autosave & immediate save on blur) ----------------

let _settingsDebounceTimer = null;
function scheduleSettingsSave(delayMs = 600) {
  if (_settingsDebounceTimer) clearTimeout(_settingsDebounceTimer);
  _settingsDebounceTimer = setTimeout(() => {
    saveSettings();
  }, delayMs);
}

async function saveSettings() {
  if (_settingsDebounceTimer) {
    clearTimeout(_settingsDebounceTimer);
    _settingsDebounceTimer = null;
  }
  state.settings.book_title = $("book-title").value;
  state.settings.institution_name = $("institution-name").value;
  state.settings.team_name = $("team-name").value;
  state.settings.code_font = $("code-font").value;
  if ($("code-theme")) state.settings.code_theme = $("code-theme").value;
  state.settings.page_size = $("page-size") ? $("page-size").value : (state.settings.page_size || "A4");
  state.settings.accent_color = $("accent-color").value;
  state.settings.template_accent_color = $("template-accent-color") ? $("template-accent-color").value : (state.settings.template_accent_color || "#5B4A8A");
  state.settings.cover_style = $("cover-style").value;
  state.settings.card_style = $("card-style") ? $("card-style").value : (state.settings.card_style || "craft");
  state.settings.show_team_footer = $("show-team-footer").checked;
  state.settings.show_boilerplate = $("show-boilerplate") ? $("show-boilerplate").checked : (state.settings.show_boilerplate !== false);
  state.settings.boilerplate_code = $("boilerplate-code") ? $("boilerplate-code").value : (state.settings.boilerplate_code || "");
  const flowCheck = $("snippets-after-template") || $("modal-snippets-after-template") || $("canvas-snippets-after-template");
  if (flowCheck) {
    state.settings.snippets_after_template = flowCheck.checked ? "1" : "0";
  }

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
      card_style: state.settings.card_style,
      show_team_footer: state.settings.show_team_footer,
      show_boilerplate: state.settings.show_boilerplate,
      boilerplate_code: state.settings.boilerplate_code,
      template_title: state.settings.template_title || "Template",
      snippets_after_template: state.settings.snippets_after_template !== "0" && state.settings.snippets_after_template !== false ? "1" : "0",
    }),
  });
  if (actionHubState === "ready") setActionHubState("idle");
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
async function buildPreviewHtml() {
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

  // Strip UI interaction launchers from the cloned DOM before generating PDF HTML
  clone.querySelectorAll(".card-hover-launcher, .hover-launcher-left, .hover-launcher-right").forEach(el => el.remove());

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

  const codeTheme = state.settings.code_theme || "nord";

  const cardStyle = state.settings.card_style || "craft";

  const html = `<!DOCTYPE html>
<html data-code-theme="${codeTheme}" class="card-theme-${cardStyle}">
<head>
  <meta charset="utf-8">
  <title>Codebook</title>
  <!-- Full Google Fonts suite identical to live app for razor-sharp vector typography -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Caveat:wght@500;600;700&family=Fira+Code:wght@400;500;600;700&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Kalam:wght@400;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600&family=Plus+Jakarta+Sans:wght@500;600;700;800&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400;1,8..60,600&display=swap" rel="stylesheet">
  <!-- Prism CSS for token styling -->
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism.min.css">
  <style>
    /* Baked CSS variables + full stylesheet */
    ${accentVars}
    ${styleText}

    @page {
      size: 210mm 297mm;
      margin: 0;
    }
    @media print, all {
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        color-adjust: exact !important;
      }
      html, body {
        background: white !important;
        color: #000000 !important;
        margin: 0 !important;
        padding: 0 !important;
        height: auto !important;
        min-height: 0 !important;
        max-height: none !important;
        overflow: visible !important;
        position: static !important;
        -webkit-font-smoothing: antialiased;
        text-rendering: geometricPrecision;
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
        zoom: 1 !important;
        transform: none !important;
      }
      .a4-page {
        width: 210mm !important;
        min-height: 297mm !important;
        height: 297mm !important;
        max-height: 297mm !important;
        box-sizing: border-box !important;
        margin: 0 !important;
        padding: 14mm !important;
        box-shadow: none !important;
        border-radius: 0 !important;
        border: none !important;
        page-break-after: always !important;
        break-after: page !important;
        page-break-inside: avoid !important;
        break-inside: avoid !important;
        overflow: hidden !important;
        position: relative !important;
        zoom: 1 !important;
        transform: none !important;
      }
      .a4-page:last-child {
        page-break-after: avoid !important;
        break-after: avoid !important;
      }
      .card-hover-launcher, .hover-launcher-left, .hover-launcher-right, .mobile-bottom-nav, #mobile-bottom-nav, .mobile-nav-btn {
        display: none !important;
      }
    }
  </style>
</head>
<body class="card-theme-${cardStyle}">
  <div class="app">
    <div class="preview-area">
      <div class="preview-scroll card-theme-${cardStyle}">
        ${pagesHtml}
      </div>
    </div>
  </div>
  <!-- No Prism re-run: colors are baked as inline styles in the HTML -->
</body>
</html>`;

  return { html, pageCount };
}

// ---------------- ACTION HUB (Morphing Build / Save Flow) ----------------

let actionHubState = "idle"; // 'idle' | 'building' | 'ready'
let _progressInterval = null;

function updateNavBuildExport(state, stepText, pct) {
  const btn = $("nav-build-export-btn");
  const track = $("build-progress-track");
  const text = $("nav-build-export-text");
  if (!btn) return;

  const clamped = Math.max(0, Math.min(100, Math.round(pct || 0)));

  if (state === "building") {
    btn.disabled = true;
    btn.classList.add("is-building");
    btn.classList.remove("is-success", "is-error");
    if (track) track.style.width = clamped + "%";
    if (text && stepText) text.textContent = stepText;
  } else if (state === "success") {
    btn.classList.remove("is-building");
    btn.classList.add("is-success");
    if (track) track.style.width = "100%";
    if (text) text.textContent = stepText || "Saved to Device!";
    setTimeout(() => {
      btn.classList.remove("is-success");
      if (track) track.style.width = "0%";
      if (text) text.textContent = "Save / Print PDF";
      btn.disabled = false;
    }, 3200);
  } else if (state === "error") {
    btn.classList.remove("is-building");
    btn.classList.add("is-error");
    if (track) track.style.width = "100%";
    if (text) text.textContent = stepText || "Build Failed";
    setTimeout(() => {
      btn.classList.remove("is-error");
      if (track) track.style.width = "0%";
      if (text) text.textContent = "Save / Print PDF";
      btn.disabled = false;
    }, 3000);
  } else {
    btn.classList.remove("is-building", "is-success", "is-error");
    if (track) track.style.width = "0%";
    if (text) text.textContent = "Save / Print PDF";
    btn.disabled = false;
  }
}

function setActionHubState(state) {
  actionHubState = state;
  const hub = $("action-hub");
  if (hub) hub.dataset.state = state;
  const buildBtn = $("build-btn");
  const progressWrap = $("build-progress-wrap");
  const readyRow = $("hub-ready-row");

  if (state === "idle") {
    if (buildBtn) {
      buildBtn.style.display = "inline-flex";
      buildBtn.disabled = false;
      buildBtn.classList.remove("disabled");
    }
    if (progressWrap) progressWrap.style.display = "none";
    if (readyRow) readyRow.style.display = "none";
  } else if (state === "building") {
    if (buildBtn) buildBtn.style.display = "none";
    if (readyRow) readyRow.style.display = "none";
    if (progressWrap) {
      progressWrap.style.display = "flex";
      progressWrap.classList.remove("error", "success");
    }
  } else if (state === "ready") {
    if (buildBtn) buildBtn.style.display = "none";
    if (progressWrap) progressWrap.style.display = "none";
    if (readyRow) readyRow.style.display = "flex";
  }
}

function showBuildProgress(stepText, pct) {
  setActionHubState("building");
  updateNavBuildExport("building", stepText, pct);
  updateBuildProgress(stepText, pct);
}

function updateBuildProgress(stepText, pct) {
  updateNavBuildExport("building", stepText, pct);
  const wrap = $("build-progress-wrap");
  const stepEl = $("build-progress-step");
  const pctEl = $("build-progress-pct");
  const fillEl = $("build-progress-fill");
  if (!wrap || !fillEl) return;
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  wrap.setAttribute("aria-valuenow", clamped);
  if (stepText && stepEl) {
    stepEl.innerHTML = `<svg class="sketchy-spinner" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 2c5.52 0 10 4.48 10 10s-4.48 10-10 10S2 17.52 2 12c0-2.5 1-4.8 2.5-6.5"/></svg> <span>${escapeHtml(stepText)}</span>`;
  }
  if (pctEl) pctEl.textContent = clamped + "%";
  fillEl.style.width = clamped + "%";
}

function finishBuildProgress(success, finalMsg) {
  if (_progressInterval) {
    clearInterval(_progressInterval);
    _progressInterval = null;
  }
  if (success) {
    updateNavBuildExport("success", finalMsg || "PDF ready! Downloading...", 100);
    // Automatic download without having to click anything
    onPrintPdf();
  } else {
    updateNavBuildExport("error", finalMsg || "Build failed", 100);
  }
  const wrap = $("build-progress-wrap");
  const stepEl = $("build-progress-step");
  if (!wrap) return;
  if (success) {
    wrap.classList.add("success");
    if (stepEl) stepEl.textContent = finalMsg || "PDF ready!";
    updateBuildProgress(finalMsg || "PDF ready!", 100);
    setTimeout(() => {
      setActionHubState("ready");
    }, 600);
  } else {
    wrap.classList.add("error");
    if (stepEl) stepEl.textContent = finalMsg || "Build failed";
    updateBuildProgress(finalMsg || "Build failed", 100);
    setTimeout(() => {
      setActionHubState("idle");
    }, 2400);
  }
}

function setPrintEnabled(enabled) {
  if (enabled) {
    setActionHubState("ready");
  } else if (actionHubState !== "building") {
    setActionHubState("idle");
  }
}

function onPrintPdf(triggerReview = true) {
  const currentBookTitle = (state.settings && state.settings.book_title && state.settings.book_title.trim()) || "Contest Codebook";
  const safeTitle = currentBookTitle.replace(/[\\/*?:"<>|]+/g, "").trim() || "codebook";
  const a = document.createElement("a");
  a.href = "/download?t=" + Date.now();
  a.download = safeTitle + ".pdf";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setStatus("Saved to local storage (Downloads).", "success");
  if (triggerReview && window.ReviewManager) {
    window.ReviewManager.onDirectDownload();
  }
}

async function buildPdf() {
  if (actionHubState === "building") return;

  // 1. Ensure user is on Book Preview so all .a4-page nodes exist in the DOM
  if (typeof setAppTab === "function") {
    setAppTab("preview");
  }

  // 2. Count live pages currently rendered
  const pageNodes = document.querySelectorAll(".preview-scroll .a4-page");
  const count = pageNodes.length || 1;

  // 3. Immediately dispatch telemetry to backend (saves user, team, institution & use count)
  const inst = (state.settings && state.settings.institution_name) || "";
  const team = (state.settings && state.settings.team_name) || "";

  try {
    fetch("/api/track-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        page_count: count,
        institution_name: inst,
        team_name: team,
      }),
    }).catch(() => {});
  } catch (_) {}

  // 4. Visual feedback on button & status
  updateNavBuildExport("building", "Preparing Print...", 75);

  setTimeout(() => {
    updateNavBuildExport("success", "PDF Ready!", 100);
    const originalDocTitle = document.title;
    const currentBookTitle = (state.settings && state.settings.book_title && state.settings.book_title.trim()) || "Contest Codebook";
    document.title = currentBookTitle;
    if (window.ReviewManager) {
      window.ReviewManager.preparePrintTrigger();
    }
    window.print();
    setStatus(`Export ready — ${count} page${count !== 1 ? "s" : ""}. Choose 'Save as PDF' in the print dialog.`, "success");
    setTimeout(() => {
      document.title = originalDocTitle;
    }, 1500);
  }, 100);
}

// ---------------- CANVAS DOCK (Studio Controls) ----------------

let currentZoom = 1.0;
let isSpreadView = false;
let userHasCustomZoom = false;

function syncActiveCoverThumb(val) {
  const thumbs = document.querySelectorAll(".cover-thumb-card");
  thumbs.forEach((t) => {
    t.classList.toggle("active", t.dataset.style === val);
  });
}

function initCoverVisualPicker() {
  const select = $("cover-style");
  const thumbs = document.querySelectorAll(".cover-thumb-card");
  if (!select || !thumbs.length) return;

  thumbs.forEach((thumb) => {
    thumb.addEventListener("click", () => {
      const style = thumb.dataset.style;
      select.value = style;
      syncActiveCoverThumb(style);
      select.dispatchEvent(new Event("change"));
    });
  });

  select.addEventListener("change", () => syncActiveCoverThumb(select.value));
}

function syncActiveCardThumb(val) {
  const thumbs = document.querySelectorAll(".card-thumb-card");
  thumbs.forEach((t) => {
    t.classList.toggle("active", t.dataset.style === val);
  });
}

function initCardVisualPicker() {
  const select = $("card-style");
  const thumbs = document.querySelectorAll(".card-thumb-card");
  if (!select || !thumbs.length) return;

  thumbs.forEach((thumb) => {
    thumb.addEventListener("click", () => {
      const style = thumb.dataset.style;
      select.value = style;
      syncActiveCardThumb(style);
      select.dispatchEvent(new Event("change"));
    });
  });

  select.addEventListener("change", async () => {
    syncActiveCardThumb(select.value);
    state.settings.card_style = select.value;
    await saveSettings();
    renderPreview();
  });
}

function updatePageBudget(pageCount) {
  const budgetEl = $("dock-page-budget");
  const budgetText = $("dock-budget-text");
  const count = typeof pageCount === "number" ? pageCount : document.querySelectorAll(".preview-scroll .a4-page").length;
  if (budgetEl && budgetText) {
    budgetText.textContent = `${count} / 25 pages`;
    budgetEl.classList.toggle("budget-over", count > 25);
    budgetEl.title = count > 25 ? `Over ICPC 25-page limit by ${count - 25} pages!` : `${count} pages — within 25-page limit`;
  }
  const navTopics = $("nav-topics-count");
  if (navTopics) navTopics.textContent = state.topics.length;
}

function setZoom(val) {
  const minScale = window.innerWidth <= 768 ? 0.20 : 0.35;
  currentZoom = Math.max(minScale, Math.min(1.8, Math.round(val * 100) / 100));
  const scroll = $("preview-scroll");
  const label = $("zoom-level-btn");
  if (scroll) {
    scroll.style.zoom = currentZoom;
  }
  if (label) {
    label.textContent = `${Math.round(currentZoom * 100)}%`;
  }
}

function zoomIn() {
  userHasCustomZoom = true;
  setZoom(currentZoom + 0.08);
}

function zoomOut() {
  userHasCustomZoom = true;
  setZoom(currentZoom - 0.08);
}

function resetZoom() {
  userHasCustomZoom = true;
  setZoom(1.0);
}

function fitZoom() {
  const area = $("preview-area");
  const scroll = $("preview-scroll");
  if (!area || !scroll) return;
  const isMobile = window.innerWidth <= 768;
  const pageWidthMm = state.settings && state.settings.page_size === "Letter" ? 215.9 : 210;
  const pageWidthPx = mmToPx(pageWidthMm);
  const targetWidth = isMobile ? pageWidthPx + 16 : pageWidthPx + 64;
  const available = area.clientWidth || (isMobile ? window.innerWidth : 0);
  const minScale = isMobile ? 0.20 : 0.35;
  const scale = available < targetWidth ? Math.max(minScale, Math.round((available / targetWidth) * 100) / 100) : 1.0;
  setZoom(scale);
}

function setViewMode(mode) {
  isSpreadView = false;
  const scroll = $("preview-scroll");
  if (scroll) scroll.classList.remove("spread-view");
  userHasCustomZoom = false;
  fitZoom();
}

// ── Institution BCS Autocomplete & Formatter ───────────────────────────────
let institutionList = [];

const INSTITUTION_ACRONYMS = {
  "AHSANIA MISSION UNIVERSITY OF SCIENCE AND TECHNOLOGY": "AMUST",
  "AHSANULLAH UNIVERSITY OF SCIENCE AND TECHNOLOGY": "AUST",
  "AMERICAN INTERNATIONAL UNIVERSITY-BANGLADESH": "AIUB",
  "ASIAN UNIVERSITY OF BANGLADESH": "AUB",
  "ATISH DIPANKAR UNIVERSITY OF SCIENCE & TECHNOLOGY": "ADUST",
  "ATISH DIPANKAR UNIVERSITY OF SCIENCE AND TECHNOLOGY": "ADUST",
  "BANGAMATA SHEIKH FOJILATUNNESA MUJIB SCIENCE AND TECHNOLOGY UNIVERSITY": "BSFMSTU",
  "BANGLADESH AGRICULTURAL UNIVERSITY": "BAU",
  "BANGLADESH ARMY INTERNATIONAL UNIVERSITY OF SCIENCE AND TECHNOLOGY": "BAIUST",
  "BANGLADESH ARMY UNIVERSITY OF ENGINEERING AND TECHNOLOGY": "BAUET",
  "BANGLADESH ARMY UNIVERSITY OF SCIENCE & TECHNOLOGY": "BAUST",
  "BANGLADESH ARMY UNIVERSITY OF SCIENCE AND TECHNOLOGY": "BAUST",
  "BANGLADESH OLYMPIAD IN INFORMATICS": "BdOI",
  "BANGLADESH OPEN UNIVERSITY": "BOU",
  "BANGLADESH OPEN UNIVERSITY (DRC CAMPUS)": "BOU (DRC)",
  "BANGLADESH OPEN UNIVERSITY (DUET CAMPUS)": "BOU (DUET)",
  "BANGLADESH UNIVERSITY": "BU",
  "BANGLADESH UNIVERSITY OF BUSINESS AND TECHNOLOGY": "BUBT",
  "BANGLADESH UNIVERSITY OF ENGINEERING AND TECHNOLOGY": "BUET",
  "BANGLADESH UNIVERSITY OF PROFESSIONALS": "BUP",
  "BANGLADESH UNIVERSITY OF TEXTILES": "BUTEX",
  "BARISAL INFORMATION TECHNOLOGY COLLEGE": "BITC",
  "BEGUM ROKEYA UNIVERSITY": "BRUR",
  "BEGUM ROKEYA UNIVERSITY, RANGPUR": "BRUR",
  "BGC TRUST UNIVERSITY BANGLADESH": "BGCTUB",
  "BRAC UNIVERSITY": "BRACU",
  "BRAHMANBARIA POLYTECHNIC INSTITUTE": "BBPI",
  "BRAHMAPUTRA INTERNATIONAL UNIVERSITY": "BIU",
  "CANADIAN UNIVERSITY OF BANGLADESH": "CUB",
  "CCN UNIVERSITY OF SCIENCE AND TECHNOLOGY": "CCNUST",
  "CENTRAL UNIVERSITY OF SCIENCE AND TECHNOLOGY": "CUST",
  "CENTRAL WOMENS UNIVERSITY": "CWU",
  "CHANDPUR SCIENCE AND TECHNOLOGY UNIVERSITY": "CSTU",
  "CHATTOGRAM POLYTECHNIC INSTITUTE": "CPI",
  "CHITTAGONG INDEPENDENT UNIVERSITY": "CIU",
  "CHITTAGONG UNIVERSITY OF ENGINEERING AND TECHNOLOGY": "CUET",
  "CITY UNIVERSITY": "CityU",
  "CITY UNIVERSITY, BANGLADESH": "CityU",
  "COLLEGE OF BUSINESS SCIENCE AND TECHNOLOGY, MYMENSINGH": "CBST",
  "COLLEGE OF TECHNOLOGY (NARAYANGANJ)": "COT",
  "COMILLA POLYTECHNIC INSTITUTE": "ComPI",
  "COMILLA UNIVERSITY": "CoU",
  "DAFFODIL INSTITUTE OF IT (DIIT)": "DIIT",
  "DAFFODIL INTERNATIONAL COLLEGE": "DIC",
  "DAFFODIL INTERNATIONAL UNIVERSITY": "DIU",
  "DAFFODIL POLYTECHNIC INSTITUTE": "DPI",
  "DELTA COMPUTER SCIENCE COLLEGE, RANGPUR": "DCSC",
  "DHAKA CITY COLLEGE": "DCC",
  "DHAKA INTERNATIONAL UNIVERSITY": "DIU",
  "DHAKA UNIVERSITY OF ENGINEERING & TECHNOLOGY": "DUET",
  "EAST DELTA UNIVERSITY": "EDU",
  "EAST WEST UNIVERSITY": "EWU",
  "EASTERN UNIVERSITY": "EU",
  "EUROPEAN UNIVERSITY OF BANGLADESH": "EUB",
  "FAREAST INTERNATIONAL UNIVERSITY": "FIU",
  "FARIDPUR ENGINEERING COLLEGE": "FEC",
  "FENI UNIVERSITY": "FU",
  "GERMAN UNIVERSITY BANGLADESH": "GUB",
  "GONO BISHWABIDYALAY (GONO UNIVERSITY)": "GB",
  "GOPALGANJ SCIENCE AND TECHNOLOGY UNIVERSITY (GSTU)": "GSTU",
  "GREEN UNIVERSITY OF BANGLADESH": "GUB",
  "HAJEE MOHAMMAD DANESH SCIENCE AND TECHNOLOGY UNIVERSITY": "HSTU",
  "HAMDARD UNIVERSITY BANGLADESH": "HUB",
  "HEADWAY ENGINEERING INSTITUTE | SYLHET": "HEI",
  "IMPERIAL COLLEGE OF ENGINEERING, KHULNA": "ICE",
  "INDEPENDENT UNIVERSITY, BANGLADESH": "IUB",
  "INSTITUTE": "INST",
  "INSTITUTE OF SCIENCE AND TECHNOLOGY": "IST",
  "INSTITUTE OF SCIENCE TRADE & TECHNOLOGY (ISTT)": "ISTT",
  "INTERNATIONAL ISLAMI UNIVERSITY OF SCIENCE AND TECHNOLOGY BANGLADESH": "IIUSTB",
  "INTERNATIONAL ISLAMIC UNIVERSITY CHITTAGONG": "IIUC",
  "INTERNATIONAL ISLMAIC UNIVERSITY CHITTAGONG": "IIUC",
  "INTERNATIONAL OLYMPIAD IN INFORMATICS": "IOI",
  "INTERNATIONAL STANDARD UNIVERSITY": "ISU",
  "INTERNATIONAL UNIVERSITY OF BUSINESS AGRICULTURE & TECHNOLOGY": "IUBAT",
  "INTERNATIONAL UNIVERSITY OF SCHOLARS": "IUS",
  "IOI": "IOI",
  "IOI TEAM": "IOI",
  "IOI1": "IOI",
  "IOI2": "IOI",
  "ISLAMIC UNIVERSITY": "IU",
  "ISLAMIC UNIVERSITY OF TECHNOLOGY": "IUT",
  "JAGANNATH UNIVERSITY": "JnU",
  "JAHANGIRNAGAR UNIVERSITY": "JU",
  "JAMALPUR SCIENCE AND TECHNOLOGY UNIVERSITY": "JSTU",
  "JASHORE UNIVERSITY OF SCIENCE AND TECHNOLOGY": "JUST",
  "JATIYA KABI KAZI NAZRUL ISLAM UNIVERSITY": "JKKNIU",
  "KHULNA KHAN BAHADUR AHSANULLAH UNIVERSITY": "KKBAU",
  "KHULNA UNIVERSITY": "KU",
  "KHULNA UNIVERSITY OF ENGINEERING & TECHNOLOGY": "KUET",
  "KHWAJA YUNUS ALI UNIVERSITY": "KYAU",
  "KISHOREGANJ UNIVERSITY": "BSMRU",
  "LEADING UNIVERSITY": "LU",
  "MANARAT INTERNATIONAL UNIVERSITY": "MIU",
  "MAWLANA BHASHANI SCIENCE & TECHNOLOGY UNIVERSITY": "MBSTU",
  "METROPOLITAN UNIVERSITY": "MU",
  "MILITARY INSTITUTE OF SCIENCE & TECHNOLOGY": "MIST",
  "MILITARY INSTITUTE OF SCIENCE AND TECHNOLOGY|": "MIST",
  "MYMENSINGH ENGINEERING COLLEGE": "MEC",
  "NATIONAL INSTITUTE OF TEXTILE ENGINEERING AND RESEARCH": "NITER",
  "NATIONAL UNIVERSITY": "NU",
  "NATIONAL UNIVERSITY, BANGLADESH": "NU",
  "NAWAB FAIZUNNESA GOVT COLLEGE": "NFGC",
  "NETROKONA UNIVERSITY": "NU",
  "NOAKHALI SCIENCE & TECHNOLOGY UNIVERSITY": "NSTU",
  "NORTH EAST UNIVERSITY BANGLADESH": "NEUB",
  "NORTH SOUTH UNIVERSITY": "NSU",
  "NORTH SOUTH UNIVERSITY, BANGLADESH": "NSU",
  "NORTH WESTERN UNIVERSITY, KHULNA": "NWU",
  "NORTHERN UNIVERSITY BANGLADESH": "NUB",
  "NORTHERN UNIVERSITY OF BUSINESS AND TECHNOLOGY": "NUBTK",
  "NOTRE DAME UNIVERSITY BANGLADESH": "NDUB",
  "PABNA ENGINEERING COLLEGE": "PEC",
  "PABNA GOVERNMENT POLYTECHNIC INSTITUTE": "PGPI",
  "PABNA UNIVERSITY OF SCIENCE AND TECHNOLOGY": "PUST",
  "PATUAKHALI SCIENCE & TECHNOLOGY UNIVERSITY": "PSTU",
  "PIROJPUR SCIENCE AND TECHNOLOGY UNIVERSITY": "PRSTU",
  "PORT CITY INTERNATIONAL UNIVERSITY": "PCIU",
  "PREMIER UNIVERSITY": "PUC",
  "PRESIDENCY UNIVERSITY": "PU",
  "PRIME UNIVERSITY": "PrimeU",
  "PRIMEASIA UNIVERSITY": "PAU",
  "PUNDRA UNIVERSITY OF SCIENCE AND TECHNOLOGY": "PUB",
  "R. P. SHAHA UNIVERSITY": "RPSU",
  "RABINDRA MAITREE UNIVERSITY, KUSHTIA": "RMU",
  "RAJSHAHI UNIVERSITY OF ENGINEERING & TECHNOLOGY": "RUET",
  "RANGAMATI SCIENCE AND TECHNOLOGY UNIVERSITY": "RMSTU",
  "RANGPUR ENGINEERING COLLEGE": "REC",
  "RANGPUR POLYTECHNIC INSTITUTE": "RPI",
  "RESERVE1": "RES1",
  "RTM AL-KABIR TECHNICAL UNIVERSITY": "RTM-AKTU",
  "SHAHJALAL UNIVERSITY OF SCIENCE & TECHNOLOGY": "SUST",
  "SHANTO MARIAM UNIVERSITY OF CREATIVE TECHNOLOGY": "SMUCT",
  "SHEIKH FAZILATUNNESA MUJIB UNIVERSITY": "SFMU",
  "SHYAMOLI ENGINEERING COLLEGE": "SHEC",
  "SONARGAON UNIVERSITY": "SU",
  "SOUTHEAST UNIVERSITY": "SEU",
  "SOUTHERN UNIVERSITY BANGLADESH": "SUB",
  "STAMFORD UNIVERSITY BANGLADESH": "SUB",
  "STATE UNIVERSITY OF BANGLADESH": "SUB",
  "SUNAMGONJ SCIENCE & TECHNOLOGY UNIVERSITY": "SSTU",
  "SUNAMGONJ SCIENCE AND TECHNOLOGY UNIVERSITY": "SSTU",
  "SYLHET ENGINEERING COLLEGE": "SEC",
  "SYLHET INTERNATIONAL UNIVERSITY": "SIU",
  "TEESTA UNIVERSITY": "TU",
  "TEJGAON COLLEGE": "TC",
  "TEMP INSTITUTE": "TEMP",
  "TEMP UNIVERSITY": "TEMP",
  "THAKURGAON POLYTECHNIC INSTITUTE": "TPI",
  "TMSS ENGINEERING COLLEGE": "TEC",
  "UCSI": "UCSI",
  "UNITED COLLEGE OF AVIATION SCIENCE AND MANAGEMENT": "UCASM",
  "UNITED COLLEGE OF AVIATION, SCIENCE AND MANAGEMENT": "UCASM",
  "UNITED INTERNATIONAL UNIVERSITY": "UIU",
  "UNIVERSITY OF ASIA PACIFIC": "UAP",
  "UNIVERSITY OF BARISAL": "BU",
  "UNIVERSITY OF CHITTAGONG": "CU",
  "UNIVERSITY OF CREATIVE TECHNOLOGY, CHITTAGONG": "UCTC",
  "UNIVERSITY OF DHAKA": "DU",
  "UNIVERSITY OF FRONTIER TECHNOLOGY, BANGLADESH": "UFTB",
  "UNIVERSITY OF GLOBAL VILLAGE": "UGV",
  "UNIVERSITY OF INFORMATION TECHNOLOGY & SCIENCES": "UITS",
  "UNIVERSITY OF LIBERAL ARTS BANGLADESH": "ULAB",
  "UNIVERSITY OF RAJSHAHI": "RU",
  "UNIVERSITY OF SCIENCE AND TECHNOLOGY CHITTAGONG": "USTC",
  "UTTARA UNIVERSITY": "UU",
  "VARENDRA UNIVERSITY": "VU",
  "WORLD UNIVERSITY OF BANGLADESH": "WUB",
  "Z. H. SIKDER UNIVERSITY OF SCIENCE AND TECHNOLOGY": "ZHSUST",
};

const INSTITUTION_ALIASES = {
  "GOPALGANJ SCIENCE AND TECHNOLOGY UNIVERSITY (GSTU)": ["BSMRSTU", "GSTU"],
  "UNIVERSITY OF FRONTIER TECHNOLOGY, BANGLADESH": ["BDU", "UFTB"],
  "JAGANNATH UNIVERSITY": ["JNU", "JnU"],
  "COMILLA UNIVERSITY": ["COU", "CoU"],
  "BEGUM ROKEYA UNIVERSITY": ["BRUR"],
  "BEGUM ROKEYA UNIVERSITY, RANGPUR": ["BRUR"],
  "KISHOREGANJ UNIVERSITY": ["BSMRU", "KIU"],
  "NETROKONA UNIVERSITY": ["SHU", "NEU"],
  "PUNDRA UNIVERSITY OF SCIENCE AND TECHNOLOGY": ["PUB", "PUST"],
  "PRIME UNIVERSITY": ["PU", "PRIMEU"],
  "BGC TRUST UNIVERSITY BANGLADESH": ["BGC", "BGCTUB"],
  "STAMFORD UNIVERSITY BANGLADESH": ["STAMFORD", "SUB"],
  "SHYAMOLI ENGINEERING COLLEGE": ["SHEC", "SEC"],
  "CITY UNIVERSITY": ["CITYU", "CU"],
  "CITY UNIVERSITY, BANGLADESH": ["CITYU", "CU"],
  "DHAKA UNIVERSITY OF ENGINEERING & TECHNOLOGY": ["DUET"],
  "CHITTAGONG UNIVERSITY OF ENGINEERING AND TECHNOLOGY": ["CUET"],
  "RAJSHAHI UNIVERSITY OF ENGINEERING & TECHNOLOGY": ["RUET"],
  "KHULNA UNIVERSITY OF ENGINEERING & TECHNOLOGY": ["KUET"],
  "BANGLADESH UNIVERSITY OF ENGINEERING AND TECHNOLOGY": ["BUET"],
  "SHAHJALAL UNIVERSITY OF SCIENCE & TECHNOLOGY": ["SUST"],
  "ISLAMIC UNIVERSITY OF TECHNOLOGY": ["IUT"],
  "MILITARY INSTITUTE OF SCIENCE & TECHNOLOGY": ["MIST"],
  "MILITARY INSTITUTE OF SCIENCE AND TECHNOLOGY|": ["MIST"],
};

function formatInstitutionName(raw) {
  if (!raw) return "";
  const smallWords = /^(a|an|and|as|at|but|by|for|if|in|nor|of|on|or|the|to|via)$/i;

  let res = raw
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (word.startsWith("(") && word.endsWith(")")) {
        const inner = word.slice(1, -1);
        return "(" + formatInstitutionName(inner) + ")";
      }
      if (word.includes("-")) {
        return word
          .split("-")
          .map((sub, sIdx) => {
            if (sIdx > 0 && smallWords.test(sub)) return sub;
            return sub.charAt(0).toUpperCase() + sub.slice(1);
          })
          .join("-");
      }
      if (index > 0 && smallWords.test(word)) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");

  const replacements = [
    [/\bIut\b/gi, "IUT"],
    [/\bBuet\b/gi, "BUET"],
    [/\bCuet\b/gi, "CUET"],
    [/\bRuet\b/gi, "RUET"],
    [/\bKuet\b/gi, "KUET"],
    [/\bDuet\b/gi, "DUET"],
    [/\bMist\b/gi, "MIST"],
    [/\bAiub\b/gi, "AIUB"],
    [/\bBrac\b/gi, "BRAC"],
    [/\bNsu\b/gi, "NSU"],
    [/\bEwu\b/gi, "EWU"],
    [/\bUiu\b/gi, "UIU"],
    [/\bAust\b/gi, "AUST"],
    [/\bDiu\b/gi, "DIU"],
    [/\bBup\b/gi, "BUP"],
    [/\bSust\b/gi, "SUST"],
    [/\bDu\b/gi, "DU"],
    [/\bJu\b/gi, "JU"],
    [/\bCu\b/gi, "CU"],
    [/\bRu\b/gi, "RU"],
    [/\bKu\b/gi, "KU"],
    [/\bMec\b/gi, "MEC"],
    [/\bSec\b/gi, "SEC"],
    [/\bFec\b/gi, "FEC"],
    [/\bTec\b/gi, "TEC"],
    [/\bRec\b/gi, "REC"],
    [/\bPec\b/gi, "PEC"],
    [/\bBubt\b/gi, "BUBT"],
    [/\bBauet\b/gi, "BAUET"],
    [/\bBaiust\b/gi, "BAIUST"],
    [/\bBaust\b/gi, "BAUST"],
    [/\bButex\b/gi, "BUTEX"],
    [/\bIub\b/gi, "IUB"],
    [/\bIubat\b/gi, "IUBAT"],
    [/\bIiuc\b/gi, "IIUC"],
    [/\bJnu\b/gi, "JnU"],
    [/\bCou\b/gi, "CoU"],
    [/\bBrur\b/gi, "BRUR"],
    [/\bBsfmstu\b/gi, "BSFMSTU"],
    [/\bBsmrstu\b/gi, "BSMRSTU"],
    [/\bMbstu\b/gi, "MBSTU"],
    [/\bNstu\b/gi, "NSTU"],
    [/\bPust\b/gi, "PUST"],
    [/\bPstu\b/gi, "PSTU"],
    [/\bHstu\b/gi, "HSTU"],
    [/\bJstu\b/gi, "JSTU"],
    [/\bJust\b/gi, "JUST"],
    [/\bPrstu\b/gi, "PRSTU"],
    [/\bSstu\b/gi, "SSTU"],
    [/\bRmstu\b/gi, "RMSTU"],
    [/\bCstu\b/gi, "CSTU"],
    [/\bJkkniu\b/gi, "JKKNIU"],
    [/\bNiter\b/gi, "NITER"],
    [/\bDcc\b/gi, "DCC"],
    [/\bDiit\b/gi, "DIIT"],
    [/\bIstt\b/gi, "ISTT"],
    [/\bIst\b/gi, "IST"],
    [/\bUap\b/gi, "UAP"],
    [/\bUlab\b/gi, "ULAB"],
    [/\bUits\b/gi, "UITS"],
    [/\bUctc\b/gi, "UCTC"],
    [/\bUgv\b/gi, "UGV"],
    [/\bUftb\b/gi, "UFTB"],
    [/\bBdu\b/gi, "BDU"],
    [/\bWub\b/gi, "WUB"],
    [/\bZhsust\b/gi, "ZHSUST"],
    [/\bCpi\b/gi, "CPI"],
    [/\bDpi\b/gi, "DPI"],
    [/\bBbpi\b/gi, "BBPI"],
    [/\bRpi\b/gi, "RPI"],
    [/\bTpi\b/gi, "TPI"],
    [/\bBdoi\b/gi, "BdOI"],
    [/\bIoi\b/gi, "IOI"],
    [/\bUcsi\b/gi, "UCSI"],
    [/\bUcasm\b/gi, "UCASM"],
    [/\bNfgc\b/gi, "NFGC"],
    [/\bCbst\b/gi, "CBST"],
    [/\bCot\b/gi, "COT"],
    [/\bIce\b/gi, "ICE"],
    [/\bHei\b/gi, "HEI"],
    [/\bGstu\b/gi, "GSTU"],
    [/\bDrc\b/gi, "DRC"],
  ];

  for (const [pattern, replacement] of replacements) {
    res = res.replace(pattern, replacement);
  }
  return res;
}

async function loadInstitutions() {
  try {
    const res = await fetch("/api/institutions");
    if (res.ok) {
      institutionList = await res.json();
    }
  } catch (err) {
    console.warn("Failed to load institutions:", err);
  }
}

function initInstitutionAutocomplete() {
  const input = $("institution-name");
  const dropdown = $("institution-autocomplete-list");
  const toggleBtn = $("institution-toggle-btn");
  if (!input || !dropdown) return;

  let activeIndex = -1;
  let isSelecting = false;

  function renderDropdown(items, query = "") {
    dropdown.innerHTML = "";
    if (items.length === 0) {
      dropdown.innerHTML = `<div class="combobox-empty-item">No match found. Custom typing supported.</div>`;
      dropdown.style.display = "block";
      activeIndex = -1;
      return;
    }

    const maxItems = items.slice(0, 30);
    maxItems.forEach((item) => {
      const itemEl = document.createElement("div");
      itemEl.className = "combobox-item";
      itemEl.setAttribute("role", "option");

      const displayTitle = item.formatted;
      let titleHtml = escapeHtml(displayTitle);
      if (query) {
        const escaped = escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regex = new RegExp(`(${escaped})`, "gi");
        titleHtml = titleHtml.replace(regex, "<mark>$1</mark>");
      }

      const badgeHtml = item.acronym
        ? `<span class="combobox-item-badge">${escapeHtml(item.acronym)}</span>`
        : `<span class="combobox-item-badge">Univ</span>`;

      itemEl.innerHTML = `
        <div class="combobox-item-left">
          <svg class="combobox-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 21h18M3 10h18M5 6l7-3 7 3M4 10v11M20 10v11M8 14v3M12 14v3M16 14v3"/>
          </svg>
          <span class="combobox-item-text">${titleHtml}</span>
        </div>
        ${badgeHtml}
      `;

      const onSelect = (e) => {
        if (e) {
          e.preventDefault();
          e.stopPropagation();
        }
        selectInstitution(displayTitle);
      };
      itemEl.addEventListener("mousedown", onSelect);
      itemEl.addEventListener("click", onSelect);

      dropdown.appendChild(itemEl);
    });

    const footer = document.createElement("div");
    footer.className = "combobox-dropdown-footer";
    footer.innerHTML = `<span>${items.length} institutions</span><span>↑↓ navigate • ↵ select</span>`;
    dropdown.appendChild(footer);

    dropdown.style.display = "block";
    activeIndex = -1;
  }

  function selectInstitution(name) {
    isSelecting = true;
    input.value = name;
    dropdown.style.display = "none";
    activeIndex = -1;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    scheduleSettingsSave(50);
    setTimeout(() => {
      isSelecting = false;
      dropdown.style.display = "none";
    }, 120);
  }

  function filterAndShow(showAll = false) {
    if (isSelecting) return;
    const query = input.value.trim().toLowerCase();
    if (!showAll && !query) {
      dropdown.style.display = "none";
      return;
    }

    const processedList = institutionList.map((raw) => {
      const formatted = formatInstitutionName(raw);
      const acronym = INSTITUTION_ACRONYMS[raw] || "";
      const aliases = INSTITUTION_ALIASES[raw] || [];
      return { raw, formatted, acronym, aliases };
    });

    let matches = processedList;
    if (query) {
      matches = processedList.filter((item) => {
        const rawLow = item.raw.toLowerCase();
        const formLow = item.formatted.toLowerCase();
        const acLow = item.acronym.toLowerCase();
        const aliasMatch = item.aliases.some((al) => al.toLowerCase() === query || al.toLowerCase().includes(query));
        return (
          rawLow.includes(query) ||
          formLow.includes(query) ||
          acLow === query ||
          acLow.includes(query) ||
          aliasMatch
        );
      });
      // Sort exact acronym or alias match to the top
      matches.sort((a, b) => {
        const aAc = a.acronym.toLowerCase();
        const bAc = b.acronym.toLowerCase();
        const aAliasExact = a.aliases.some((al) => al.toLowerCase() === query);
        const bAliasExact = b.aliases.some((al) => al.toLowerCase() === query);

        const aExact = aAc === query || aAliasExact;
        const bExact = bAc === query || bAliasExact;

        if (aExact && !bExact) return -1;
        if (bExact && !aExact) return 1;
        return 0;
      });
    }

    renderDropdown(matches, query);
  }

  input.addEventListener("input", () => {
    if (isSelecting) return;
    filterAndShow(false);
  });

  input.addEventListener("focus", () => {
    if (isSelecting) return;
    if (input.value.trim()) {
      filterAndShow(false);
    }
  });

  if (toggleBtn) {
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (dropdown.style.display === "block") {
        dropdown.style.display = "none";
      } else {
        input.focus();
        filterAndShow(true);
      }
    });
  }

  input.addEventListener("keydown", (e) => {
    if (dropdown.style.display !== "block") return;
    const items = dropdown.querySelectorAll(".combobox-item");
    if (items.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      updateActiveItem(items);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      updateActiveItem(items);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      items[activeIndex].click();
    } else if (e.key === "Escape") {
      dropdown.style.display = "none";
    }
  });

  function updateActiveItem(items) {
    items.forEach((it, i) => {
      it.classList.toggle("active", i === activeIndex);
      if (i === activeIndex) {
        it.scrollIntoView({ block: "nearest" });
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target) && (!toggleBtn || !toggleBtn.contains(e.target))) {
      dropdown.style.display = "none";
    }
  });
}

// ── Sketch Notebook Palette ────────────────────────────────────────────────
// Classy curated palette: 11 refined, modern tones + 1 custom swatch (+) = 12 swatches (6x2 grid)
const SKETCH_COLORS = [
  "#030302",  // Deep Obsidian Ink (Default Black)
  "#0071E3",  // Apple Sapphire Blue
  "#2563EB",  // Royal Blue
  "#0F766E",  // Deep Emerald Teal
  "#16A34A",  // Clean Mint Green
  "#B91C1C",  // Crimson Red
  "#C2410C",  // Terracotta Rust
  "#D97706",  // Warm Amber Ochre
  "#6D28D9",  // Royal Violet
  "#374151",  // Slate Charcoal
  "#64748B",  // Cool Graphite
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
      });
      
      palette.appendChild(swatch);
    });
    
    // Add custom color swatch
    const customSwatch = document.createElement("div");
    customSwatch.className = "color-swatch color-swatch-custom";
    customSwatch.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>';
    customSwatch.title = "Custom color";
    
    customSwatch.addEventListener("click", () => {
      targetInput.showPicker ? targetInput.showPicker() : targetInput.click();
    });
    
    targetInput.addEventListener("input", () => {
      updatePaletteActiveState(targetId, targetInput.value);
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
  if (targetId === "accent-color") {
    const dot = $("active-accent-dot");
    const hex = $("active-accent-hex");
    if (dot) dot.style.backgroundColor = upperColor;
    if (hex) hex.textContent = upperColor;
  }
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

// ---------------- MOBILE WEB APP CONTROLLER ----------------
let mobileActiveTab = "style"; // "style" | "vault" | "editor" | "preview"

function setMobileTab(tab) {
  mobileActiveTab = tab;
  const appEl = document.querySelector(".app");
  if (appEl) {
    appEl.setAttribute("data-mobile-tab", tab);
  }

  // Update active button on mobile nav bar
  document.querySelectorAll(".mobile-nav-btn").forEach((btn) => {
    const bTab = btn.getAttribute("data-tab");
    const isActive = (tab === bTab) || (tab === "editor" && bTab === "vault");
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });

  if (tab === "style") {
    showSidebarTab("style");
  } else if (tab === "vault") {
    showSidebarTab("vault");
  } else if (tab === "preview") {
    if (canvasViewMode === "editor") {
      setCanvasMode("preview");
    }
    requestAnimationFrame(() => {
      if (typeof updatePreviewScale === "function") updatePreviewScale();
      const previewScroll = $("preview-scroll");
      if (!previewScroll || previewScroll.children.length === 0) {
        renderPreview();
      }
    });
  } else if (tab === "editor") {
    if (canvasViewMode !== "editor") {
      setCanvasMode("editor");
    }
    requestAnimationFrame(() => {
      if (canvasCodeEditor) canvasCodeEditor.refresh();
    });
  }
}
window.setMobileTab = setMobileTab;

// ---------------- RESPONSIVENESS (P1.4) ----------------

function toggleSidebar() {
  if (window.innerWidth <= 768) return; // On mobile, bottom navigation controls views
  const sidebar = $("sidebar");
  if (!sidebar) return;

  const isCollapsed = sidebar.classList.toggle("collapsed");
  const appEl = document.querySelector(".app");
  if (appEl) appEl.classList.toggle("sidebar-collapsed", isCollapsed);

  const navBtn = $("nav-toggle-sidebar-btn");
  if (navBtn) {
    navBtn.classList.toggle("active", !isCollapsed);
    navBtn.setAttribute("aria-pressed", !isCollapsed ? "true" : "false");
    navBtn.title = isCollapsed ? "Show sidebar (Ctrl+B)" : "Hide sidebar (Ctrl+B)";
  }

  try {
    localStorage.setItem("codebook_sidebar_collapsed", isCollapsed ? "true" : "false");
  } catch (_) {}

  if (typeof updatePreviewScale === "function") updatePreviewScale();
  if (typeof updateCanvasCompactState === "function") updateCanvasCompactState();
}

function toggleThumbnailsRail() {
  if (window.innerWidth <= 768) return;
  const rail = $("thumbnails-rail");
  if (!rail) return;

  const isCollapsed = rail.classList.toggle("collapsed");
  const appEl = document.querySelector(".app");
  if (appEl) appEl.classList.toggle("rail-collapsed", isCollapsed);

  const navBtn = $("nav-toggle-rail-btn");
  if (navBtn) {
    navBtn.classList.toggle("active", !isCollapsed);
    navBtn.setAttribute("aria-pressed", !isCollapsed ? "true" : "false");
    navBtn.title = isCollapsed ? "Show page thumbnails (Ctrl+M)" : "Hide page thumbnails (Ctrl+M)";
  }

  try {
    localStorage.setItem("codebook_rail_collapsed", isCollapsed ? "true" : "false");
  } catch (_) {}

  if (!isCollapsed && rail.children.length === 0) {
    if (typeof renderThumbnails === "function") renderThumbnails();
  }

  if (typeof updatePreviewScale === "function") updatePreviewScale();
  if (typeof updateCanvasCompactState === "function") updateCanvasCompactState();
}

// Shrinks the A4 preview proportionally below ~1200px so it isn't wider
// than the space it's shown in on smaller laptop screens.
function updatePreviewScale() {
  if (typeof updateCanvasCompactState === "function") updateCanvasCompactState();
  if (userHasCustomZoom) return;
  fitZoom();
}

function updateCanvasCompactState() {
  const area = $("preview-area");
  const appEl = document.querySelector(".app");
  if (!area || !appEl) return;
  // If available width in preview-area is less than 1180px, space is tight
  const isCompact = area.clientWidth < 1180;
  appEl.classList.toggle("compact-canvas", isCompact);
}

let previewScaleResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(previewScaleResizeTimer);
  previewScaleResizeTimer = setTimeout(() => {
    updatePreviewScale();
    updateCanvasCompactState();
  }, 100);
});

if (typeof ResizeObserver !== "undefined") {
  const canvasObserver = new ResizeObserver(() => {
    updateCanvasCompactState();
  });
  const previewAreaEl = $("preview-area");
  if (previewAreaEl) canvasObserver.observe(previewAreaEl);
}

// ---------------- UNIVERSAL COMMAND PALETTE (Ctrl+K / Cmd+K) ----------------

let isCmdPaletteOpen = false;
let cmdPaletteItems = [];
let selectedCmdIndex = 0;

function buildCommandPaletteIndex() {
  const items = [];

  // 1. All Snippets across Topics
  if (state && state.topics) {
    state.topics.forEach((topic) => {
      (topic.snippets || []).forEach((snippet) => {
        items.push({
          id: snippet.id,
          type: "snippet",
          kind: snippet.kind || "code",
          title: snippet.title || "Untitled Snippet",
          subtitle: `${topic.name} • ${snippet.complexity || (snippet.kind === "note" ? "Note" : "C++")}`,
          topicId: topic.id,
          snippet: snippet,
          icon: snippet.kind === "note"
            ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`
            : `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="16 18 22 12 16 6"></polyline><polyline points="8 6 2 12 8 18"></polyline></svg>`,
        });
      });
    });
  }

  // 2. Setup Template
  if (state?.settings?.show_boilerplate) {
    items.push({
      id: "template-page",
      type: "template",
      title: state.settings?.template_title || "Setup Template",
      subtitle: "Page 2 • Standard competitive C++ includes & pragmas",
      icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
    });
  }

  // 3. Quick Actions & Commands
  items.push({
    id: "action-build",
    type: "action",
    title: "Download PDF",
    subtitle: "Compile and download competition-ready PDF directly to your device (Ctrl+P)",
    action: () => buildPdf(),
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2.5c.5 4 3 6.5 7.5 7.5-4 .5-6.5 3-7.5 7.5-.5-4-3-6.5-7.5-7.5 4-.5 6.5-3 7.5-7.5z"/></svg>`,
  });

  items.push({
    id: "action-toggle-sidebar",
    type: "action",
    title: "Toggle Left Sidebar",
    subtitle: "Show or hide Style and Vault sidebar (Ctrl+B)",
    action: () => toggleSidebar(),
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="9" y1="3" x2="9" y2="21"></line></svg>`,
  });

  items.push({
    id: "action-toggle-rail",
    type: "action",
    title: "Toggle Page Thumbnails",
    subtitle: "Show or hide right-hand page minimap (Ctrl+M)",
    action: () => toggleThumbnailsRail(),
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="15" y1="3" x2="15" y2="21"></line></svg>`,
  });

  items.push({
    id: "action-new-snippet",
    type: "action",
    title: "New Code Snippet",
    subtitle: "Create a new algorithm template in current topic",
    action: () => {
      const firstTopicId = state.topics[0] ? state.topics[0].id : null;
      openSnippetEditor(null, firstTopicId, "code");
    },
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`,
  });

  items.push({
    id: "action-style-tab",
    type: "action",
    title: "Style & Book Settings",
    subtitle: "Fonts, institution name, team branding & cover themes",
    action: () => showSidebarTab("style"),
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>`,
  });

  items.push({
    id: "action-vault-tab",
    type: "action",
    title: "Obsidian Vault Topics",
    subtitle: "Manage algorithm folders and template order",
    action: () => showSidebarTab("vault"),
    icon: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  });

  return items;
}

function openCommandPalette() {
  const backdrop = $("cmd-palette-backdrop");
  const input = $("cmd-palette-input");
  if (!backdrop || !input) return;

  isCmdPaletteOpen = true;
  backdrop.style.display = "flex";
  input.value = "";
  selectedCmdIndex = 0;
  cmdPaletteItems = buildCommandPaletteIndex();
  renderCommandPaletteResults(cmdPaletteItems);
  input.focus();
}

function closeCommandPalette() {
  const backdrop = $("cmd-palette-backdrop");
  if (!backdrop) return;
  isCmdPaletteOpen = false;
  backdrop.style.display = "none";
}

function filterCommandPalette(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) {
    cmdPaletteItems = buildCommandPaletteIndex();
  } else {
    const all = buildCommandPaletteIndex();
    cmdPaletteItems = all.filter((item) => {
      const matchTitle = (item.title || "").toLowerCase().includes(q);
      const matchSub = (item.subtitle || "").toLowerCase().includes(q);
      return matchTitle || matchSub;
    });
  }
  selectedCmdIndex = 0;
  renderCommandPaletteResults(cmdPaletteItems);
}

function renderCommandPaletteResults(items) {
  const container = $("cmd-palette-results");
  const countEl = $("cmd-palette-count");
  if (!container) return;
  container.innerHTML = "";

  if (countEl) countEl.textContent = `${items.length} item${items.length !== 1 ? "s" : ""}`;

  if (items.length === 0) {
    container.innerHTML = `<div class="cmd-empty-msg">No matching snippets or commands found</div>`;
    return;
  }

  items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = `cmd-item ${idx === selectedCmdIndex ? "is-selected" : ""}`;
    row.dataset.index = idx;

    const actionHint = item.type === "snippet"
      ? `<span class="cmd-item-action-hint">↵ Jump</span>`
      : `<span class="cmd-item-action-hint">↵ Run</span>`;

    row.innerHTML = `
      <div class="cmd-item-left">
        <div class="cmd-item-icon">${item.icon}</div>
        <div class="cmd-item-info">
          <span class="cmd-item-title">${escapeHtml(item.title)}</span>
          <span class="cmd-item-meta">${escapeHtml(item.subtitle)}</span>
        </div>
      </div>
      ${actionHint}
    `;

    row.addEventListener("mouseenter", () => {
      selectedCmdIndex = idx;
      container.querySelectorAll(".cmd-item").forEach((el, i) => {
        el.classList.toggle("is-selected", i === idx);
      });
    });

    row.addEventListener("click", () => {
      executeCommandPaletteItem(item, false);
    });

    container.appendChild(row);
  });
}

function updateCmdSelectionHighlight() {
  const container = $("cmd-palette-results");
  if (!container) return;
  const items = container.querySelectorAll(".cmd-item");
  items.forEach((el, idx) => {
    el.classList.toggle("is-selected", idx === selectedCmdIndex);
    if (idx === selectedCmdIndex) {
      el.scrollIntoView({ block: "nearest" });
    }
  });
}

function executeCommandPaletteItem(item, isShiftKey = false) {
  closeCommandPalette();
  if (!item) return;

  if (item.type === "snippet") {
    if (isShiftKey) {
      openSnippetEditor(item.snippet, item.topicId, item.kind);
    } else {
      if (canvasViewMode === "editor") {
        setCanvasMode("preview");
      }
      currentEditingSnippet = item.snippet;
      currentEditingTopicId = item.topicId;
      currentEditingKind = item.kind;
      scrollToActiveItemInPreview();
    }
  } else if (item.type === "template") {
    if (isShiftKey) {
      openTemplateEditor();
    } else {
      if (canvasViewMode === "editor") setCanvasMode("preview");
      const anchor = $("preview-template-anchor") || document.querySelector(".template-page");
      if (anchor) anchor.scrollIntoView({ behavior: "instant", block: "center" });
    }
  } else if (item.type === "action" && typeof item.action === "function") {
    item.action();
  }
}

// ---------------- WIRE UP ----------------

document.addEventListener("DOMContentLoaded", () => {
  renderColorPalettes();
  initMinimapScrollSync();
  initCoverVisualPicker();
  initCardVisualPicker();
  loadInstitutions().then(() => {
    initInstitutionAutocomplete();
  });
  initAuth();
  loadState();
  setPrintEnabled(false);

  const navAdd = $("nav-add-btn");
  if (navAdd) {
    navAdd.addEventListener("click", () => {
      const firstTopic = state.topics[0];
      openSnippetModal(null, firstTopic ? firstTopic.id : null);
    });
  }
  const navExport = $("nav-export-btn");
  if (navExport) {
    navExport.addEventListener("click", () => {
      const buildBtn = $("build-btn");
      if (buildBtn) buildBtn.click();
    });
  }
  const tabDoc = $("nav-tab-document");
  if (tabDoc) {
    tabDoc.addEventListener("click", () => {
      const el = $("preview-scroll");
      if (el) el.scrollIntoView({ behavior: "smooth" });
    });
  }
  // Navbar Tab Switchers
  const tabTopics = $("nav-tab-topics");
  if (tabTopics) {
    tabTopics.addEventListener("click", () => {
      showSidebarTab("vault");
    });
  }
  const tabSettings = $("nav-tab-settings");
  if (tabSettings) {
    tabSettings.addEventListener("click", () => {
      showSidebarTab("style");
    });
  }
  if ($("nav-add-btn")) {
    $("nav-add-btn").addEventListener("click", () => {
      const firstTopicId = state.topics[0] ? state.topics[0].id : null;
      openSnippetModal(null, firstTopicId, "code");
    });
  }

  // Sidebar Tab Switchers (Style vs Vault)
  if ($("sidebar-tab-style")) $("sidebar-tab-style").addEventListener("click", () => showSidebarTab("style"));
  if ($("sidebar-tab-vault")) $("sidebar-tab-vault").addEventListener("click", () => showSidebarTab("vault"));

  // Obsidian Vault Toolbar Buttons
  if ($("vault-new-code-btn")) {
    $("vault-new-code-btn").addEventListener("click", () => {
      const firstTopicId = state.topics[0] ? state.topics[0].id : null;
      openSnippetModal(null, firstTopicId, "code");
    });
  }
  if ($("vault-new-note-btn")) {
    $("vault-new-note-btn").addEventListener("click", () => {
      const firstTopicId = state.topics[0] ? state.topics[0].id : null;
      openSnippetModal(null, firstTopicId, "note");
    });
  }
  if ($("vault-new-topic-btn")) {
    $("vault-new-topic-btn").addEventListener("click", triggerInlineNewTopic);
  }
  if ($("vault-collapse-all-btn")) {
    $("vault-collapse-all-btn").addEventListener("click", toggleCollapseAll);
  }

  function updateLiveTextSettings() {
    state.settings.book_title = $("book-title").value;
    state.settings.institution_name = $("institution-name").value;
    state.settings.team_name = $("team-name").value;

    const title = $("book-title").value || "Contest Codebook";
    const inst = $("institution-name").value || "";
    const team = $("team-name").value || "";

    document.querySelectorAll(".cover-sketch-title, .csk-title, .cover-min-title, .cover-minimal h1, .cover-banner-content h1, .cover-frame h1, .cover-geo-text h1, .cover-term-title-highlight, .cover-term-title-out, .cover-bp-title").forEach((el) => {
      el.textContent = title;
    });
    document.querySelectorAll(".cover-sketch-inst, .csk-inst, .cover-min-inst, .cover-inst, .term-inst-out, .cover-bp-val-lg").forEach((el) => el.textContent = inst || (el.classList.contains("cover-bp-val-lg") ? "COMPETITIVE PROGRAMMING UNION" : ""));
    document.querySelectorAll(".cover-sketch-team-pill, .cover-sketch-team, .csk-team, .cover-min-team, .cover-team, .term-team-out, .cover-bp-table .cover-bp-val").forEach((el) => {
      if (el.textContent && el.textContent.includes("COMPLIANT")) return;
      el.textContent = team || (el.classList.contains("cover-bp-val") ? "UNREGISTERED TEAM" : "");
    });
    document.querySelectorAll(".page-header-left").forEach((el) => {
      el.textContent = [inst, team].filter(Boolean).join(" • ");
    });

    scheduleSettingsSave(600);
  }

  ["book-title", "institution-name", "team-name"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.addEventListener("input", updateLiveTextSettings);
      el.addEventListener("blur", saveSettings);
    }
  });
  if ($("code-font")) $("code-font").addEventListener("change", saveSettings);
  if ($("code-theme")) $("code-theme").addEventListener("change", saveSettings);
  if ($("page-size")) $("page-size").addEventListener("change", saveSettings);
  if ($("accent-color")) $("accent-color").addEventListener("input", saveSettings);
  if ($("template-accent-color")) $("template-accent-color").addEventListener("input", saveSettings);
  if ($("cover-style")) $("cover-style").addEventListener("change", saveSettings);
  if ($("card-style")) $("card-style").addEventListener("change", saveSettings);
  if ($("show-team-footer")) $("show-team-footer").addEventListener("change", saveSettings);

  const handleFlowChange = async (e) => {
    const isChecked = e.target.checked;
    state.settings.snippets_after_template = isChecked ? "1" : "0";
    syncSnippetsAfterTemplateCheckboxes(isChecked);
    await saveSettings();
    renderPreview();
  };
  if ($("snippets-after-template")) $("snippets-after-template").addEventListener("change", handleFlowChange);
  if ($("modal-snippets-after-template")) $("modal-snippets-after-template").addEventListener("change", handleFlowChange);
  if ($("canvas-snippets-after-template")) $("canvas-snippets-after-template").addEventListener("change", handleFlowChange);

  const sb = $("show-boilerplate");
  if (sb) {
    sb.addEventListener("change", async () => {
      state.settings.show_boilerplate = sb.checked;
      const group = $("template-topic-group");
      if (group) group.classList.toggle("is-disabled", !sb.checked);
      const badge = $("template-status-badge");
      if (badge) badge.textContent = sb.checked ? "Page 2" : "Off";
      const count = $("template-group-count");
      if (count) count.textContent = sb.checked ? "1" : "0";
      if ($("modal-show-boilerplate")) $("modal-show-boilerplate").checked = sb.checked;
      await saveSettings();
      renderPreview();
    });
  }

  const tmplSnippetRow = $("template-snippet-row");
  if (tmplSnippetRow) {
    tmplSnippetRow.addEventListener("click", (e) => {
      if (
        e.target.closest("#template-folder-actions") ||
        e.target.closest(".obsidian-inline-input") ||
        e.target.closest(".obsidian-toggle")
      ) return;
      openTemplateEditor();
    });
  }

  const tmplNameEl = $("template-group-name");
  if (tmplNameEl) {
    tmplNameEl.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startInlineRenameTemplate();
    });
  }

  const tmplRenameBtn = $("rename-template-btn");
  if (tmplRenameBtn) {
    tmplRenameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startInlineRenameTemplate();
    });
  }

  const tmplCancelBtn = $("template-cancel-btn");
  if (tmplCancelBtn) tmplCancelBtn.addEventListener("click", closeTemplateModal);

  const tmplForm = $("template-form");
  if (tmplForm) tmplForm.addEventListener("submit", saveTemplateModal);

  const tmplBackdrop = $("template-modal-backdrop");
  if (tmplBackdrop) {
    tmplBackdrop.addEventListener("click", (e) => {
      if (e.target.id === "template-modal-backdrop") closeTemplateModal();
    });
  }

  if ($("boilerplate-code")) {
    $("boilerplate-code").addEventListener("input", () => {
      state.settings.boilerplate_code = $("boilerplate-code").value;
      renderPreview();
    });
  }


  if ($("add-topic-btn")) $("add-topic-btn").addEventListener("click", triggerInlineNewTopic);
  if ($("topic-cancel-btn")) $("topic-cancel-btn").addEventListener("click", closeTopicModal);
  if ($("topic-form")) $("topic-form").addEventListener("submit", saveTopic);

  if ($("snippet-cancel-btn")) $("snippet-cancel-btn").addEventListener("click", closeSnippetModal);
  if ($("snippet-form")) $("snippet-form").addEventListener("submit", saveSnippet);
  if ($("snippet-delete-btn")) $("snippet-delete-btn").addEventListener("click", deleteSnippet);

  const snippetCloseBtn = $("snippet-close-btn");
  if (snippetCloseBtn) {
    snippetCloseBtn.addEventListener("click", closeSnippetModal);
  }

  const navBuildExport = $("nav-build-export-btn");
  if (navBuildExport) {
    navBuildExport.addEventListener("click", buildPdf);
  }
  const buildBtn = $("build-btn");
  if (buildBtn) {
    buildBtn.addEventListener("click", buildPdf);
  }
  if ($("rebuild-btn")) $("rebuild-btn").addEventListener("click", buildPdf);
  const printBtn = $("print-btn");
  if (printBtn) {
    printBtn.addEventListener("click", onPrintPdf);
  }

  // Universal Command Palette (Ctrl+K / Cmd+K)
  const cmdTrigger = $("cmd-palette-trigger");
  if (cmdTrigger) cmdTrigger.addEventListener("click", openCommandPalette);

  const cmdClose = $("cmd-palette-close");
  if (cmdClose) cmdClose.addEventListener("click", closeCommandPalette);

  const cmdBackdrop = $("cmd-palette-backdrop");
  if (cmdBackdrop) {
    cmdBackdrop.addEventListener("click", (e) => {
      if (e.target === cmdBackdrop) closeCommandPalette();
    });
  }

  const cmdInput = $("cmd-palette-input");
  if (cmdInput) {
    cmdInput.addEventListener("input", (e) => filterCommandPalette(e.target.value));
    cmdInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (cmdPaletteItems.length > 0) {
          selectedCmdIndex = (selectedCmdIndex + 1) % cmdPaletteItems.length;
          updateCmdSelectionHighlight();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (cmdPaletteItems.length > 0) {
          selectedCmdIndex = (selectedCmdIndex - 1 + cmdPaletteItems.length) % cmdPaletteItems.length;
          updateCmdSelectionHighlight();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (cmdPaletteItems[selectedCmdIndex]) {
          executeCommandPaletteItem(cmdPaletteItems[selectedCmdIndex], e.shiftKey);
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeCommandPalette();
      }
    });
  }

  // Canvas Dock controls
  if ($("zoom-in-btn")) $("zoom-in-btn").addEventListener("click", zoomIn);
  if ($("zoom-out-btn")) $("zoom-out-btn").addEventListener("click", zoomOut);
  if ($("zoom-level-btn")) $("zoom-level-btn").addEventListener("click", resetZoom);
  if ($("zoom-fit-btn")) {
    $("zoom-fit-btn").addEventListener("click", () => {
      userHasCustomZoom = false;
      fitZoom();
    });
  }


  // Dual Segment Studio Switcher
  if ($("mode-editor-btn")) {
    $("mode-editor-btn").addEventListener("click", () => {
      if (canvasViewMode !== "editor") {
        if (currentEditingSnippet) {
          setCanvasMode("editor");
        } else {
          let firstSnippet = null;
          let firstTopicId = state.topics[0] ? state.topics[0].id : null;
          for (const t of state.topics) {
            if (t.snippets && t.snippets.length > 0) {
              firstSnippet = t.snippets[0];
              firstTopicId = t.id;
              break;
            }
          }
          if (firstSnippet) {
            openSnippetEditor(firstSnippet, firstTopicId, firstSnippet.kind);
          } else {
            openSnippetEditor(null, firstTopicId, "code");
          }
        }
      }
    });
  }
  if ($("mode-preview-btn")) {
    $("mode-preview-btn").addEventListener("click", () => {
      setCanvasMode("preview");
    });
  }

  // In-Canvas Studio Editor Buttons
  const handleBackToBook = async () => {
    await saveCanvasEditor(false);
    setCanvasMode("preview");
    scrollToActiveItemInPreview();
  };
  if ($("canvas-floating-back-btn")) {
    $("canvas-floating-back-btn").addEventListener("click", handleBackToBook);
  }
  if ($("canvas-header-back-btn")) {
    $("canvas-header-back-btn").addEventListener("click", handleBackToBook);
  }
  if ($("editor-header-arrow-origin")) {
    $("editor-header-arrow-origin").addEventListener("click", handleBackToBook);
  }

  // Scroll listener for responsive bridge arrow and floating button
  const previewAreaEl = $("preview-area");
  if (previewAreaEl) {
    previewAreaEl.addEventListener("scroll", () => {
      if (canvasViewMode !== "editor") return;
      bridgeTargetY = previewAreaEl.scrollTop;
      if (!bridgeAnimRunning) {
        bridgeAnimRunning = true;
        requestAnimationFrame(() => updateBridgeArrowPhysics(false));
      }
    }, { passive: true });
  }

  window.addEventListener("resize", () => {
    if (canvasViewMode === "editor") {
      updateBridgeArrowPhysics();
    }
  }, { passive: true });

  // Live preview card hover edit button delegation
  const previewScroll = $("preview-scroll");
  if (previewScroll) {
    previewScroll.addEventListener("click", (e) => {
      const editBtn = e.target.closest('[data-action="open-in-editor"]');
      if (editBtn) {
        e.stopPropagation();
        const snippetId = parseInt(editBtn.dataset.snippetId, 10);
        let foundSnippet = null;
        let foundTopicId = null;
        for (const t of state.topics) {
          const s = (t.snippets || []).find((sn) => sn.id === snippetId);
          if (s) {
            foundSnippet = s;
            foundTopicId = t.id;
            break;
          }
        }
        if (foundSnippet) {
          openSnippetEditor(foundSnippet, foundTopicId, foundSnippet.kind || "code");
        }
        return;
      }

      const editTmplBtn = e.target.closest('[data-action="open-template-in-editor"]');
      if (editTmplBtn) {
        e.stopPropagation();
        openTemplateEditor();
        return;
      }
    });
  }
  if ($("canvas-editor-save-btn")) {
    $("canvas-editor-save-btn").addEventListener("click", () => {
      saveCanvasEditor(true);
    });
  }
  if ($("canvas-editor-delete-btn")) {
    $("canvas-editor-delete-btn").addEventListener("click", deleteCanvasEditorSnippet);
  }
  if ($("canvas-editor-copy-btn")) {
    $("canvas-editor-copy-btn").addEventListener("click", copyCanvasEditorCode);
  }
  if ($("canvas-editor-lang")) {
    $("canvas-editor-lang").addEventListener("change", (e) => {
      setCanvasEditorLanguage(e.target.value);
      if (!isProgrammaticSetting) {
        setEditorSaveStatus("unsaved");
        scheduleCanvasEditorAutoSave();
      }
    });
  }
  ["canvas-editor-title", "canvas-editor-complexity", "canvas-editor-note"].forEach((id) => {
    const el = $(id);
    if (el) {
      el.addEventListener("input", () => {
        if (id === "canvas-editor-note") autoResizeNoteTextarea();
        if (isProgrammaticSetting) return;
        setEditorSaveStatus("unsaved");
        scheduleCanvasEditorAutoSave();
      });
      el.addEventListener("blur", () => {
        if (!isProgrammaticSetting) {
          saveCanvasEditor(false);
        }
      });
    }
  });

  setActionHubState("idle");
  initCraftHero();
  if (typeof ReviewManager !== "undefined") {
    ReviewManager.init();
  }
  if ($("nav-toggle-sidebar-btn")) $("nav-toggle-sidebar-btn").addEventListener("click", toggleSidebar);
  if ($("nav-toggle-rail-btn")) $("nav-toggle-rail-btn").addEventListener("click", toggleThumbnailsRail);
  if ($("sidebar-toggle-btn")) $("sidebar-toggle-btn").addEventListener("click", toggleSidebar);
  if ($("sidebar-collapse-inner-btn")) $("sidebar-collapse-inner-btn").addEventListener("click", toggleSidebar);

  // Mobile Bottom Navigation Bar wiring
  const mobTabStyle = $("mobile-tab-style");
  const mobTabVault = $("mobile-tab-vault");
  const mobTabPreview = $("mobile-tab-preview");
  const canvasMobBackBtn = $("canvas-mobile-back-btn");

  if (mobTabStyle) mobTabStyle.addEventListener("click", () => setMobileTab("style"));
  if (mobTabVault) mobTabVault.addEventListener("click", () => setMobileTab("vault"));
  if (mobTabPreview) mobTabPreview.addEventListener("click", () => setMobileTab("preview"));
  if (canvasMobBackBtn) canvasMobBackBtn.addEventListener("click", () => setMobileTab("vault"));

  if (window.innerWidth <= 768) {
    setMobileTab("style");
  }

  window.addEventListener("resize", () => {
    if (window.innerWidth <= 768) {
      const appEl = document.querySelector(".app");
      if (appEl && !appEl.hasAttribute("data-mobile-tab")) {
        setMobileTab("style");
      }
    }
  });

  // Restore sidebar state from localStorage on desktop (Default: EXPANDED)
  try {
    if (window.innerWidth > 768 && localStorage.getItem("codebook_sidebar_collapsed") === "true") {
      const sidebar = $("sidebar");
      if (sidebar) sidebar.classList.add("collapsed");
      const appEl = document.querySelector(".app");
      if (appEl) appEl.classList.add("sidebar-collapsed");
      const navSidebarBtn = $("nav-toggle-sidebar-btn");
      if (navSidebarBtn) {
        navSidebarBtn.classList.remove("active");
        navSidebarBtn.setAttribute("aria-pressed", "false");
        navSidebarBtn.title = "Show sidebar (Ctrl+B)";
      }
      if (typeof updatePreviewScale === "function") updatePreviewScale();
    } else if (window.innerWidth > 768) {
      const sidebar = $("sidebar");
      if (sidebar) sidebar.classList.remove("collapsed");
      const appEl = document.querySelector(".app");
      if (appEl) appEl.classList.remove("sidebar-collapsed");
      const navSidebarBtn = $("nav-toggle-sidebar-btn");
      if (navSidebarBtn) {
        navSidebarBtn.classList.add("active");
        navSidebarBtn.setAttribute("aria-pressed", "true");
        navSidebarBtn.title = "Hide sidebar (Ctrl+B)";
      }
    }
  } catch (_) {}

  // Restore thumbnails rail state from localStorage (Default: COLLAPSED)
  try {
    const railStored = localStorage.getItem("codebook_rail_collapsed");
    if (railStored === "false") {
      // User explicitly expanded it
      const rail = $("thumbnails-rail");
      if (rail) rail.classList.remove("collapsed");
      const appEl = document.querySelector(".app");
      if (appEl) appEl.classList.remove("rail-collapsed");
      const navRailBtn = $("nav-toggle-rail-btn");
      if (navRailBtn) {
        navRailBtn.classList.add("active");
        navRailBtn.setAttribute("aria-pressed", "true");
        navRailBtn.title = "Hide page thumbnails (Ctrl+M)";
      }
      if (typeof updatePreviewScale === "function") updatePreviewScale();
    } else {
      // Default: COLLAPSED
      const rail = $("thumbnails-rail");
      if (rail) rail.classList.add("collapsed");
      const appEl = document.querySelector(".app");
      if (appEl) appEl.classList.add("rail-collapsed");
      const navRailBtn = $("nav-toggle-rail-btn");
      if (navRailBtn) {
        navRailBtn.classList.remove("active");
        navRailBtn.setAttribute("aria-pressed", "false");
        navRailBtn.title = "Show page thumbnails (Ctrl+M)";
      }
      if (typeof updatePreviewScale === "function") updatePreviewScale();
    }
  } catch (_) {}

  if ($("trash-btn")) $("trash-btn").addEventListener("click", openTrashModal);
  if ($("trash-close-btn")) $("trash-close-btn").addEventListener("click", closeTrashModal);
  if ($("trash-modal-backdrop")) {
    $("trash-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "trash-modal-backdrop") closeTrashModal();
    });
  }

  // close modals when clicking outside
  if ($("snippet-modal-backdrop")) {
    $("snippet-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "snippet-modal-backdrop") closeSnippetModal();
    });
  }
  if ($("topic-modal-backdrop")) {
    $("topic-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "topic-modal-backdrop") closeTopicModal();
    });
  }
  if ($("confirm-modal-backdrop")) {
    $("confirm-modal-backdrop").addEventListener("click", (e) => {
      if (e.target.id === "confirm-modal-backdrop") _settleConfirm(false);
    });
  }
  if ($("confirm-modal-cancel-btn")) $("confirm-modal-cancel-btn").addEventListener("click", () => _settleConfirm(false));
  if ($("confirm-modal-confirm-btn")) $("confirm-modal-confirm-btn").addEventListener("click", () => _settleConfirm(true));

  // Escape closes whichever modal/popover is currently open.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isCmdPaletteOpen) {
      closeCommandPalette();
      return;
    }
    if (canvasViewMode === "editor" && !document.querySelector(".modal-backdrop.open")) {
      setCanvasMode("preview");
      return;
    }
    if ($("auth-modal-backdrop") && $("auth-modal-backdrop").classList.contains("open")) { closeAuthModal(); return; }
    closeUserDropdown();
    if ($("template-modal-backdrop") && $("template-modal-backdrop").classList.contains("open")) { closeTemplateModal(); return; }
    if ($("confirm-modal-backdrop") && $("confirm-modal-backdrop").classList.contains("open")) { _settleConfirm(false); return; }
    if ($("trash-modal-backdrop") && $("trash-modal-backdrop").classList.contains("open")) { closeTrashModal(); return; }
    if ($("snippet-modal-backdrop") && $("snippet-modal-backdrop").classList.contains("open")) { closeSnippetModal(); return; }
    if ($("topic-modal-backdrop") && $("topic-modal-backdrop").classList.contains("open")) { closeTopicModal(); return; }
    if ($("sidebar") && $("sidebar").classList.contains("open")) {
      $("sidebar").classList.remove("open");
      if ($("sidebar-toggle-btn")) $("sidebar-toggle-btn").setAttribute("aria-expanded", "false");
      return;
    }
  });

  // Cmd/Ctrl+K toggles Command Palette; Cmd/Ctrl+S saves; Cmd/Ctrl+B triggers Build; Zoom shortcuts
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (isCmdPaletteOpen) {
        closeCommandPalette();
      } else {
        openCommandPalette();
      }
      return;
    }
    if (e.key.toLowerCase() === "p") {
      e.preventDefault();
      buildPdf();
      return;
    }
    if (e.key === "s") {
      if (canvasViewMode === "editor") {
        e.preventDefault();
        saveCanvasEditor(false);
      } else if ($("template-modal-backdrop") && $("template-modal-backdrop").classList.contains("open")) {
        e.preventDefault();
        $("template-form").requestSubmit();
      } else if ($("snippet-modal-backdrop").classList.contains("open")) {
        e.preventDefault();
        $("snippet-form").requestSubmit();
      }
    } else if (e.key === "\\" || e.key.toLowerCase() === "b") {
      if (e.shiftKey && e.key.toLowerCase() === "b") {
        e.preventDefault();
        buildPdf();
      } else if (!document.querySelector(".modal-backdrop.open")) {
        e.preventDefault();
        toggleSidebar();
      }
    } else if (e.key.toLowerCase() === "m") {
      if (!document.querySelector(".modal-backdrop.open")) {
        e.preventDefault();
        toggleThumbnailsRail();
      }
    } else if (e.key === "=" || e.key === "+") {
      e.preventDefault();
      zoomIn();
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomOut();
    } else if (e.key === "0") {
      e.preventDefault();
      userHasCustomZoom = false;
      fitZoom();
    }
  });

  updateCanvasCompactState();
});

function scheduleLivePreview() {
  if (isPopulatingModal) return;
  clearTimeout(_livePreviewTimer);
  _livePreviewTimer = setTimeout(() => {
    cancelAnimationFrame(_livePreviewRaf);
    _livePreviewRaf = requestAnimationFrame(() => {
      livePreviewWhileEditing();
    });
  }, 40);
}

// Reflect in-progress modal edits onto the preview immediately (before save)
function livePreviewWhileEditing() {
  if (isPopulatingModal) return;
  const kind = $("snippet-kind").value;
  const topicId = kind === "code" ? $("snippet-topic").value : $("snippet-topic-alt").value;
  const titleVal = $("snippet-title").value.trim();
  const codeVal = kind === "code" ? getCode() : "";
  const notesVal = $("snippet-notes").value.trim();

  // If creating new snippet and all content is still completely empty, don't generate draft
  if (!editingSnippetId && !titleVal && !codeVal && !notesVal) return;

  const draft = {
    id: editingSnippetId || "draft",
    kind,
    title: titleVal || (kind === "note" ? "Note" : "Code Snippet"),
    subtitle: $("snippet-subtitle").value,
    complexity: $("snippet-complexity").value,
    code: codeVal,
    notes: (kind === "code" || kind === "note") ? $("snippet-notes").value : "",
    formulas: (kind === "code" || kind === "formula") ? collectFormulaDraftList() : [],
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

// Craft.do Sky Blue Hero Interactive Controller
function initCraftHero() {
  const hero = $("craft-sky-hero");
  const restoreBar = $("hero-restore-bar");
  const scrollBtn = $("hero-scroll-studio-btn");
  const collapseBtn = $("hero-collapse-btn");
  const restoreBtn = $("hero-restore-btn");

  if (!hero) return;

  const isCollapsed = localStorage.getItem("craft_hero_collapsed") === "true";
  if (isCollapsed) {
    hero.classList.add("is-collapsed");
    if (restoreBar) restoreBar.style.display = "flex";
  }

  if (scrollBtn) {
    scrollBtn.addEventListener("click", () => {
      const dock = $("canvas-dock");
      if (dock) {
        dock.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  }

  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      hero.classList.add("is-collapsed");
      if (restoreBar) restoreBar.style.display = "flex";
      localStorage.setItem("craft_hero_collapsed", "true");
    });
  }

  if (restoreBtn) {
    restoreBtn.addEventListener("click", () => {
      hero.classList.remove("is-collapsed");
      if (restoreBar) restoreBar.style.display = "none";
      localStorage.setItem("craft_hero_collapsed", "false");
    });
  }
}

// ==========================================================================
// REVIEW & FEEDBACK SYSTEM CONTROLLER
// ==========================================================================

const ReviewManager = {
  STORAGE_KEY: "cb_review_data",
  currentRating: 0,
  selectedTags: new Set(),
  printTriggerArmed: false,
  printStartTime: 0,

  getState() {
    try {
      return JSON.parse(localStorage.getItem(this.STORAGE_KEY)) || {};
    } catch (_) {
      return {};
    }
  },

  saveState(updates) {
    const current = this.getState();
    const next = { ...current, ...updates };
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(next));
    } catch (_) {}
  },

  shouldAutoPrompt() {
    // If developer mode or admin, do not auto-prompt review modal
    if (state && (state.is_dev_or_admin || (state.auth && state.auth.user && state.auth.user.role === "admin"))) {
      return false;
    }
    const s = this.getState();
    if (s.completed) return false; // Already submitted a review
    if (s.snoozeUntil && Date.now() < s.snoozeUntil) return false; // Snoozed
    return true;
  },

  snooze(days = 7) {
    const snoozeUntil = Date.now() + days * 24 * 60 * 60 * 1000;
    this.saveState({ snoozeUntil });
  },

  markCompleted() {
    this.saveState({ completed: true, completedAt: Date.now() });
  },

  init() {
    this.bindEvents();
    this.listenToPrintEvents();
  },

  preparePrintTrigger() {
    this.printTriggerArmed = true;
    this.printStartTime = Date.now();
  },

  listenToPrintEvents() {
    window.addEventListener("beforeprint", () => {
      this.printStartTime = Date.now();
      this.printTriggerArmed = true;
    });

    window.addEventListener("afterprint", () => {
      if (!this.printTriggerArmed) return;
      this.printTriggerArmed = false;

      const duration = Date.now() - (this.printStartTime || 0);

      // Only single print-to-PDF is used; no duplicate HTTP download.
      // If user kept the print dialog open for >= 1000ms (configured and saved PDF to device):
      if (duration >= 1000) {
        updateNavBuildExport("success", "Saved to Device!", 100);
        setStatus("PDF saved to your device.", "success");

        if (this.shouldAutoPrompt()) {
          setTimeout(() => {
            this.open("print");
          }, 1200);
        }
      } else {
        // Quick cancel (< 1000ms) - restore button immediately
        updateNavBuildExport("idle", "Save / Print PDF", 0);
      }
    });
  },

  onDirectDownload() {
    if (this.shouldAutoPrompt()) {
      setTimeout(() => {
        this.open("download");
      }, 3200);
    }
  },

  open(source = "manual") {
    const backdrop = $("review-modal-backdrop");
    if (!backdrop) return;

    this.resetForm();

    const badgeText = $("review-badge-text");
    const titleEl = $("review-widget-title");
    const descEl = $("review-widget-desc");
    const guestGroup = $("review-guest-name-group");

    if (source === "print" || source === "download") {
      if (badgeText) badgeText.textContent = "PDF Ready";
      if (titleEl) titleEl.textContent = "How did your PDF turn out?";
      if (descEl) descEl.textContent = "Help us refine layout density and typography for upcoming contests.";
    } else {
      if (badgeText) badgeText.textContent = "Feedback";
      if (titleEl) titleEl.textContent = "Enjoying Codebook Studio?";
      if (descEl) descEl.textContent = "Share your rating and thoughts with the community.";
    }

    // If user is already authenticated, hide the guest name input
    const isLoggedIn = state && state.auth && state.auth.is_logged_in;
    if (guestGroup) {
      guestGroup.style.display = isLoggedIn ? "none" : "block";
    }

    backdrop.classList.remove("is-closing");
    backdrop.style.display = "flex";
  },

  close(snoozeDays = 7) {
    const backdrop = $("review-modal-backdrop");
    if (!backdrop) return;

    if (snoozeDays > 0) {
      this.snooze(snoozeDays);
    }

    backdrop.classList.add("is-closing");
    setTimeout(() => {
      backdrop.style.display = "none";
      backdrop.classList.remove("is-closing");
    }, 220);
  },

  resetForm() {
    this.currentRating = 0;
    this.selectedTags.clear();

    const starBtns = document.querySelectorAll(".review-star-btn");
    starBtns.forEach(b => {
      b.classList.remove("is-active", "is-hovered");
    });

    const hint = $("review-rating-hint");
    if (hint) {
      hint.textContent = "Click a star to rate";
      hint.classList.remove("is-highlighted");
    }

    const form = $("review-expandable-form");
    if (form) form.style.display = "none";

    const guestInput = $("review-guest-name");
    if (guestInput) guestInput.value = "";

    const textarea = $("review-textarea");
    if (textarea) textarea.value = "";

    const tagPills = document.querySelectorAll(".review-tag-pill");
    tagPills.forEach(p => p.classList.remove("active"));

    const bodyView = $("review-widget-body");
    const successView = $("review-widget-success");
    if (bodyView) bodyView.style.display = "block";
    if (successView) successView.style.display = "none";

    const submitBtn = $("review-submit-btn");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = "<span>Send Feedback</span>";
    }
  },

  setRating(rating) {
    this.currentRating = rating;
    const starBtns = document.querySelectorAll(".review-star-btn");
    starBtns.forEach(btn => {
      const val = parseInt(btn.dataset.rating, 10);
      btn.classList.toggle("is-active", val <= rating);
      btn.classList.remove("is-hovered");
    });

    const hints = {
      1: "1 star — Needs improvement",
      2: "2 stars — Fair",
      3: "3 stars — Good",
      4: "4 stars — Great experience",
      5: "5 stars — Tournament Ready"
    };

    const hint = $("review-rating-hint");
    if (hint) {
      hint.textContent = hints[rating] || "";
      hint.classList.add("is-highlighted");
    }

    // Expand detailed form smoothly
    const form = $("review-expandable-form");
    if (form && form.style.display === "none") {
      form.style.display = "block";
    }

    // Contextualize placeholder (no emojis)
    const textarea = $("review-textarea");
    if (textarea) {
      if (rating >= 4) {
        textarea.placeholder = "What worked best for you? (optional)";
      } else {
        textarea.placeholder = "What was missing or what can we fix for your contest? (optional)";
      }
    }
  },

  bindEvents() {
    // Star buttons hover & click
    const starBtns = document.querySelectorAll(".review-star-btn");
    starBtns.forEach(btn => {
      const val = parseInt(btn.dataset.rating, 10);

      btn.addEventListener("mouseenter", () => {
        starBtns.forEach(b => {
          const bVal = parseInt(b.dataset.rating, 10);
          b.classList.toggle("is-hovered", bVal <= val);
        });
      });

      btn.addEventListener("click", () => {
        this.setRating(val);
      });
    });

    const starsRow = $("review-stars-row");
    if (starsRow) {
      starsRow.addEventListener("mouseleave", () => {
        starBtns.forEach(b => {
          b.classList.remove("is-hovered");
          const bVal = parseInt(b.dataset.rating, 10);
          b.classList.toggle("is-active", bVal <= this.currentRating);
        });
      });
    }

    // Tag pills
    const tagPills = document.querySelectorAll(".review-tag-pill");
    tagPills.forEach(pill => {
      pill.addEventListener("click", () => {
        const tag = pill.dataset.tag;
        if (this.selectedTags.has(tag)) {
          this.selectedTags.delete(tag);
          pill.classList.remove("active");
        } else {
          this.selectedTags.add(tag);
          pill.classList.add("active");
        }
      });
    });

    // Close and Later buttons
    const closeBtn = $("review-close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => this.close(7));
    }

    const laterBtn = $("review-later-btn");
    if (laterBtn) {
      laterBtn.addEventListener("click", () => this.close(7));
    }

    // Click outside on backdrop to dismiss
    const backdrop = $("review-modal-backdrop");
    if (backdrop) {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) {
          this.close(7);
        }
      });
    }

    // Manual trigger from user menu
    const userReviewTrigger = $("user-review-trigger-btn");
    if (userReviewTrigger) {
      userReviewTrigger.addEventListener("click", () => {
        const userDropdown = $("nav-user-dropdown");
        if (userDropdown) userDropdown.style.display = "none";
        this.open("manual");
      });
    }

    // Submit button
    const submitBtn = $("review-submit-btn");
    if (submitBtn) {
      submitBtn.addEventListener("click", () => this.submitReview());
    }
  },

  async submitReview() {
    if (this.currentRating < 1) {
      showToast("Please select a rating from 1 to 5 stars.", "warning");
      return;
    }

    const submitBtn = $("review-submit-btn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending...";
    }

    const comment = ($("review-textarea") ? $("review-textarea").value : "").trim();
    const guestName = ($("review-guest-name") ? $("review-guest-name").value : "").trim();
    const isPublic = $("review-public-check") ? $("review-public-check").checked : true;
    const instName = (state.settings && state.settings.institution_name) || "";
    const teamName = (state.settings && state.settings.team_name) || "";

    const payload = {
      rating: this.currentRating,
      comment: comment,
      user_name: guestName,
      tags: Array.from(this.selectedTags),
      is_public: isPublic,
      institution_name: instName,
      team_name: teamName,
    };

    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (data && data.ok) {
        this.markCompleted();
        const bodyView = $("review-widget-body");
        const successView = $("review-widget-success");
        if (bodyView) bodyView.style.display = "none";
        if (successView) successView.style.display = "block";

        setTimeout(() => {
          this.close(0);
        }, 2200);
      } else {
        showToast(data.error || "Failed to submit review", "error");
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = "Send Feedback";
        }
      }
    } catch (err) {
      console.error("Submit review error:", err);
      showToast("Could not send review right now.", "error");
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Send Feedback";
      }
    }
  }
};

window.ReviewManager = ReviewManager;

