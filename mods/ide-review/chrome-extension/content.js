(function () {
  const SCRIPT_VERSION = "1.4.1";
  if (window.__herdrAnnotatorVersion === SCRIPT_VERSION) return;
  if (typeof window.__herdrAnnotatorCleanup === "function") {
    try {
      window.__herdrAnnotatorCleanup();
    } catch {}
  }
  window.__herdrAnnotatorVersion = SCRIPT_VERSION;
  window.__herdrAnnotatorLoaded = true;

  const MAX_CUSTOM_TAGS = 6;
  const CUSTOM_TAGS_STORAGE_KEY = "__herdr_ui_review_custom_tags__";

  const IMPORTANT_STYLE_KEYS = [
    "display",
    "position",
    "width",
    "height",
    "padding",
    "margin",
    "color",
    "backgroundColor",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "borderRadius",
    "border",
    "gap",
    "alignItems",
    "justifyContent",
  ];

  const state = {
    active: false,
    currentUrl: location.href,
    items: [], // { id, kind, element, rect, pageRect, note, tagName, selector, text, selectedText, htmlSnippet, styles, source, groupedElements }
    hoveredEl: null,
    childStack: [],
    lastPointer: { x: 0, y: 0 },
    drag: null, // { startX, startY, curX, curY, moved }
    editingDraft: null, // item currently in popover
    isNewDraft: false,
    drawerOpen: false,
    globalNote: "",
    customTags: [],
    addingTag: false,
    sending: false,
    silentStageTimer: null,
    toast: null,
    toastTimer: null,
    bridge: {
      online: false,
      cwd: "",
      activeSpace: null,
      focused: null,
      agents: [],
      selectedTerminal: "",
    },
  };

  let hostEl = null;
  let shadow = null;
  let els = {};
  let inspectSeq = 0;
  const pendingInspects = new Map();

  function loadCustomTags() {
    try {
      const raw = localStorage.getItem(CUSTOM_TAGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          state.customTags = parsed
            .map(s => String(s || "").trim())
            .filter(Boolean)
            .slice(0, MAX_CUSTOM_TAGS);
        }
      }
    } catch {}
    try {
      chrome.storage?.local?.get([CUSTOM_TAGS_STORAGE_KEY], res => {
        const list = res?.[CUSTOM_TAGS_STORAGE_KEY];
        if (Array.isArray(list)) {
          state.customTags = list
            .map(s => String(s || "").trim())
            .filter(Boolean)
            .slice(0, MAX_CUSTOM_TAGS);
          try {
            localStorage.setItem(
              CUSTOM_TAGS_STORAGE_KEY,
              JSON.stringify(state.customTags),
            );
          } catch {}
          renderCustomTagChips();
        }
      });
    } catch {}
  }

  function saveCustomTags() {
    const clean = state.customTags
      .map(s => String(s || "").trim())
      .filter(Boolean)
      .slice(0, MAX_CUSTOM_TAGS);
    state.customTags = clean;
    try {
      localStorage.setItem(CUSTOM_TAGS_STORAGE_KEY, JSON.stringify(clean));
    } catch {}
    try {
      chrome.storage?.local?.set({ [CUSTOM_TAGS_STORAGE_KEY]: clean });
    } catch {}
  }

  function effectiveAgentTerminal() {
    if (state.bridge.selectedTerminal) return state.bridge.selectedTerminal;
    const focusedAgent =
      state.bridge.agents.find(a => a.focused) ||
      (state.bridge.focused?.terminal
        ? state.bridge.agents.find(
            a => a.address === state.bridge.focused.terminal,
          )
        : null) ||
      state.bridge.agents[0];
    return focusedAgent?.address || state.bridge.focused?.terminal || "default";
  }

  function storageKeyForPageAndAgent(
    url = location.href,
    agent = effectiveAgentTerminal(),
  ) {
    return `__herdr_ui_review_v2__:${agent}::${url}`;
  }

  function savePageStateToSession() {
    try {
      const agent = effectiveAgentTerminal();
      const data = {
        url: location.href,
        targetTerminal: agent,
        globalNote: state.globalNote || "",
        items: serializeItemsForTransport(),
      };
      sessionStorage.setItem(
        storageKeyForPageAndAgent(location.href, agent),
        JSON.stringify(data),
      );
    } catch {}
  }

  function clearAllSessionDraftsForAgent(agent = effectiveAgentTerminal()) {
    try {
      const prefix = `__herdr_ui_review_v2__:${agent}::`;
      const keysToRemove = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(prefix)) keysToRemove.push(k);
      }
      keysToRemove.forEach(k => sessionStorage.removeItem(k));
    } catch {}
  }

  function loadPageStateFromSession(
    url = location.href,
    agent = effectiveAgentTerminal(),
  ) {
    try {
      const raw = sessionStorage.getItem(storageKeyForPageAndAgent(url, agent));
      if (!raw) {
        state.items = [];
        state.globalNote = "";
        if (els.globalNote) els.globalNote.value = "";
        return;
      }
      const parsed = JSON.parse(raw);
      state.globalNote = parsed.globalNote || "";
      if (els.globalNote) els.globalNote.value = state.globalNote;
      const savedItems = Array.isArray(parsed.items) ? parsed.items : [];
      state.items = savedItems.map(it => {
        let el = null;
        if (it.selector && it.kind !== "area") {
          try {
            el = document.querySelector(it.selector);
          } catch {}
        }
        return {
          ...it,
          element: el,
          pageRect: it.rect
            ? {
                x: it.rect.x + window.scrollX,
                y: it.rect.y + window.scrollY,
                width: it.rect.width,
                height: it.rect.height,
              }
            : null,
        };
      });
    } catch {
      state.items = [];
    }
  }

  function scheduleSilentStage() {
    clearTimeout(state.silentStageTimer);
    state.silentStageTimer = setTimeout(() => {
      if (state.active && !state.editingDraft && !state.sending) {
        dispatchToHerdr("silent_stage", { silent: true });
      }
    }, 260);
  }

  function checkUrlChange() {
    if (location.href === state.currentUrl) return;
    state.currentUrl = location.href;
    cancelDraft();
    loadPageStateFromSession(location.href, effectiveAgentTerminal());
    renderDockAndPins();
    if (state.active) {
      showToast(
        "已切换页面 — 上一页标注已同步至 Herdr Review 面板",
        2400,
      );
    }
  }

  window.addEventListener("__herdr_inspect_response", e => {
    const reqId = e.detail?.reqId;
    if (reqId && pendingInspects.has(reqId)) {
      const resolve = pendingInspects.get(reqId);
      pendingInspects.delete(reqId);
      resolve(e.detail?.source || null);
    }
  });

  function inspectElementSourceSyncOrAsync(el) {
    return new Promise(resolve => {
      if (!el || !(el instanceof Element)) {
        resolve(null);
        return;
      }
      const reqId = `req-${++inspectSeq}`;
      const timer = setTimeout(() => {
        if (pendingInspects.has(reqId)) {
          pendingInspects.delete(reqId);
          resolve(null);
        }
      }, 60);
      pendingInspects.set(reqId, res => {
        clearTimeout(timer);
        resolve(res);
      });
      try {
        el.dispatchEvent(
          new CustomEvent("__herdr_inspect_request", {
            bubbles: true,
            detail: { reqId },
          }),
        );
      } catch {
        clearTimeout(timer);
        pendingInspects.delete(reqId);
        resolve(null);
      }
    });
  }

  function buildCssSelector(el) {
    if (!el || !(el instanceof Element)) return "";
    if (el.id && !/^\d/.test(el.id) && !el.id.includes(":")) {
      return `#${el.id}`;
    }
    const parts = [];
    let cur = el;
    let depth = 0;
    while (
      cur &&
      cur.nodeType === 1 &&
      cur !== document.body &&
      cur !== document.documentElement &&
      depth < 4
    ) {
      let seg = cur.tagName.toLowerCase();
      const testId =
        cur.getAttribute("data-testid") || cur.getAttribute("data-test-id");
      if (testId) {
        seg += `[data-testid="${testId}"]`;
        parts.unshift(seg);
        break;
      }
      if (cur.id && !/^\d/.test(cur.id) && !cur.id.includes(":")) {
        seg += `#${cur.id}`;
        parts.unshift(seg);
        break;
      }
      const classes = Array.from(cur.classList || [])
        .filter(
          c =>
            c &&
            c.length < 36 &&
            !/^[a-z0-9]{5,8}$/i.test(c) &&
            !c.startsWith("css-"),
        )
        .slice(0, 2);
      if (classes.length > 0) {
        seg += "." + classes.join(".");
      } else if (cur.parentElement) {
        const siblings = Array.from(cur.parentElement.children).filter(
          s => s.tagName === cur.tagName,
        );
        if (siblings.length > 1) {
          const idx = siblings.indexOf(cur) + 1;
          seg += `:nth-of-type(${idx})`;
        }
      }
      parts.unshift(seg);
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function extractKeyStyles(el) {
    if (!el || !(el instanceof Element)) return {};
    const cs = window.getComputedStyle(el);
    const out = {};
    for (const key of IMPORTANT_STYLE_KEYS) {
      const val = cs[key];
      if (
        !val ||
        val === "none" ||
        val === "normal" ||
        val === "auto" ||
        val === "0px" ||
        val === "rgba(0, 0, 0, 0)"
      ) {
        continue;
      }
      const kebab = key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
      out[kebab] = val;
    }
    return out;
  }

  function extractCleanText(el) {
    if (!el) return "";
    const raw = (
      el.innerText ||
      el.textContent ||
      el.getAttribute?.("placeholder") ||
      el.getAttribute?.("aria-label") ||
      el.value ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    return raw.slice(0, 200);
  }

  function extractHtmlSnippet(el) {
    if (!el || !(el instanceof Element)) return "";
    const clone = el.cloneNode(false);
    const outer = clone.outerHTML || "";
    const text = extractCleanText(el).slice(0, 60);
    if (!outer.includes("></")) return outer.slice(0, 200);
    return outer.replace("></", `>${text}</`).slice(0, 200);
  }

  function formatShortSource(src) {
    if (!src) return "";
    let file = src.fileName || "";
    if (file) {
      const segs = file.split("/").filter(Boolean);
      file = segs.slice(-2).join("/");
    }
    const line = src.lineNumber ? `:${src.lineNumber}` : "";
    if (file) return `${file}${line}`;
    if (src.componentPath) return src.componentPath.split(" > ").pop();
    return "";
  }

  function normalizeSourceDisplay(src) {
    if (!src) return "";
    let clean = (src.fileName || "").trim();
    const cwd = (state.bridge.cwd || "").replace(/\/+$/, "");
    if (cwd && clean.startsWith(cwd + "/")) {
      clean = clean.slice(cwd.length + 1);
    }
    clean = clean.replace(/^\.?\/+/, "");
    const line = src.lineNumber ? `#L${src.lineNumber}` : "";
    const fileRef = clean ? `@${clean}${line}` : "";
    const comp = src.componentPath ? ` (${src.componentPath})` : "";
    return `${fileRef}${comp}`.trim();
  }

  function ensureShadowUI() {
    if (hostEl && shadow) return;
    hostEl = document.createElement("div");
    hostEl.id = "__herdr-annotator-host";
    hostEl.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;";
    shadow = hostEl.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
      }
      .mono {
        font-family: "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
      }
      #root {
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 2147483647;
      }
      #root[data-hidden="true"] {
        display: none !important;
      }
      #root[data-capturing="true"] .hide-on-capture {
        opacity: 0 !important;
        visibility: hidden !important;
      }
      /* Hover Inspector Box */
      #hover-box {
        position: fixed;
        pointer-events: none;
        border: 2px solid #3b82f6;
        background: rgba(59, 130, 246, 0.08);
        border-radius: 6px;
        transition: all 0.04s cubic-bezier(0.16, 1, 0.3, 1);
        display: none;
      }
      #hover-label {
        position: fixed;
        pointer-events: none;
        display: none;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        border-radius: 6px;
        background: rgba(15, 23, 42, 0.94);
        color: #f8fafc;
        font-size: 11.5px;
        line-height: 1.2;
        white-space: nowrap;
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
        border: 1px solid rgba(255, 255, 255, 0.12);
        backdrop-filter: blur(8px);
      }
      .hover-tag {
        color: #93c5fd;
        font-weight: 600;
      }
      .hover-src {
        color: #6ee7b7;
        background: rgba(16, 185, 129, 0.16);
        padding: 1px 5px;
        border-radius: 4px;
        font-size: 10.5px;
      }
      .hover-dim {
        color: #94a3b8;
        font-size: 10.5px;
      }
      /* Area Drag Box */
      #drag-box {
        position: fixed;
        pointer-events: none;
        border: 2px dashed #ec4899;
        background: rgba(236, 72, 153, 0.1);
        border-radius: 6px;
        display: none;
      }
      /* Pinned Annotation Highlights & Badges */
      .pin-box {
        position: fixed;
        pointer-events: none;
        border: 2px solid #f43f5e;
        background: rgba(244, 63, 94, 0.07);
        border-radius: 6px;
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.45);
      }
      .pin-box[data-kind="area"] {
        border-style: dashed;
      }
      .pin-badge {
        position: fixed;
        pointer-events: auto;
        cursor: pointer;
        min-width: 22px;
        height: 22px;
        padding: 0 6px;
        border-radius: 999px;
        background: #f43f5e;
        color: #ffffff;
        font-size: 11.5px;
        font-weight: 700;
        white-space: nowrap;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 3px 10px rgba(244, 63, 94, 0.45), 0 0 0 2px #ffffff;
        user-select: none;
        transition: transform 0.12s ease;
      }
      .pin-badge:hover {
        transform: scale(1.12);
      }
      /* Popover Editor */
      #popover {
        position: fixed;
        pointer-events: auto;
        width: 390px;
        max-width: calc(100vw - 24px);
        overflow: hidden;
        background: rgba(17, 24, 39, 0.97);
        color: #f9fafb;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.42);
        padding: 12px 14px;
        display: none;
        flex-direction: column;
        gap: 9px;
        backdrop-filter: blur(12px);
      }
      .pop-header {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
        min-width: 0;
      }
      .pop-badge {
        background: #f43f5e;
        color: #fff;
        font-weight: 700;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .pop-selector {
        color: #93c5fd;
        font-size: 11.5px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
      }
      .pop-src {
        font-size: 11px;
        color: #6ee7b7;
        background: rgba(16, 185, 129, 0.12);
        border: 1px solid rgba(16, 185, 129, 0.25);
        padding: 3px 8px;
        border-radius: 5px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .pop-chips {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .pop-chip {
        background: rgba(255, 255, 255, 0.07);
        color: #cbd5e1;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 11px;
        white-space: nowrap;
        max-width: 100%;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        cursor: pointer;
        transition: all 0.1s;
      }
      .pop-chip:hover {
        background: rgba(59, 130, 246, 0.22);
        color: #fff;
        border-color: rgba(59, 130, 246, 0.5);
      }
      .pop-chip-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 180px;
      }
      .pop-chip-del {
        color: #94a3b8;
        font-size: 12px;
        line-height: 1;
        padding: 0 2px;
        border-radius: 3px;
      }
      .pop-chip-del:hover {
        color: #fda4af;
        background: rgba(244, 63, 94, 0.25);
      }
      .pop-chip-add {
        color: #93c5fd;
        border-style: dashed;
        border-color: rgba(147, 197, 253, 0.35);
        background: rgba(59, 130, 246, 0.08);
      }
      .pop-tag-input {
        background: rgba(3, 7, 18, 0.85);
        color: #f8fafc;
        border: 1px solid #3b82f6;
        border-radius: 6px;
        padding: 3px 8px;
        font-size: 11px;
        width: 150px;
        outline: none;
      }
      #pop-input {
        width: 100%;
        min-height: 70px;
        max-height: 160px;
        resize: vertical;
        background: rgba(3, 7, 18, 0.75);
        color: #f8fafc;
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        padding: 8px 10px;
        font-size: 12.5px;
        line-height: 1.45;
        outline: none;
      }
      #pop-input:focus {
        border-color: #3b82f6;
        box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
      }
      .pop-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        min-width: 0;
      }
      .pop-hint {
        font-size: 11px;
        color: #94a3b8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        flex: 1;
      }
      .btn {
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(255, 255, 255, 0.08);
        color: #f1f5f9;
        padding: 6px 12px;
        border-radius: 7px;
        font-size: 12px;
        font-weight: 500;
        white-space: nowrap;
        flex-shrink: 0;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        transition: all 0.12s;
      }
      .btn:hover {
        background: rgba(255, 255, 255, 0.15);
      }
      .btn-primary {
        background: #2563eb;
        border-color: #3b82f6;
        color: #ffffff;
        font-weight: 600;
      }
      .btn-primary:hover {
        background: #1d4ed8;
      }
      .btn-accent {
        background: #10b981;
        border-color: #059669;
        color: #052e16;
        font-weight: 700;
      }
      .btn-accent:hover {
        background: #34d399;
      }
      .btn-danger {
        color: #fda4af;
        border-color: rgba(244, 63, 94, 0.3);
      }
      .btn-danger:hover {
        background: rgba(244, 63, 94, 0.2);
      }
      /* Bottom Floating Dock */
      #dock-wrap {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        pointer-events: auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        max-width: calc(100vw - 24px);
      }
      #drawer {
        width: 680px;
        max-width: calc(100vw - 32px);
        max-height: 300px;
        background: rgba(15, 23, 42, 0.97);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        box-shadow: 0 18px 42px rgba(0, 0, 0, 0.45);
        padding: 12px 14px;
        display: none;
        flex-direction: column;
        gap: 9px;
        color: #f8fafc;
        backdrop-filter: blur(12px);
      }
      #drawer[data-open="true"] {
        display: flex;
      }
      .drawer-list {
        overflow-y: auto;
        max-height: 190px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .drawer-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.08);
        font-size: 12px;
      }
      .drawer-item-note {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: #f1f5f9;
      }
      .drawer-item-meta {
        font-size: 11px;
        color: #93c5fd;
        max-width: 180px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex-shrink: 0;
      }
      #global-note {
        width: 100%;
        background: rgba(3, 7, 18, 0.7);
        color: #f8fafc;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 7px;
        padding: 7px 10px;
        font-size: 12px;
        outline: none;
      }
      #dock {
        display: flex;
        align-items: center;
        flex-wrap: nowrap;
        gap: 9px;
        padding: 8px 14px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.96);
        border: 1px solid rgba(255, 255, 255, 0.15);
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.42);
        color: #f8fafc;
        backdrop-filter: blur(12px);
        white-space: nowrap;
      }
      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: #10b981;
        box-shadow: 0 0 8px rgba(16, 185, 129, 0.7);
      }
      .status-dot[data-online="false"] {
        background: #f59e0b;
        box-shadow: none;
      }
      #agent-select {
        background: rgba(255, 255, 255, 0.08);
        color: #f8fafc;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 999px;
        padding: 5px 11px;
        font-size: 12px;
        outline: none;
        min-width: 170px;
        max-width: 240px;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .dock-sep {
        width: 1px;
        height: 18px;
        flex-shrink: 0;
        background: rgba(255, 255, 255, 0.14);
      }
      #toast {
        position: fixed;
        top: 18px;
        left: 50%;
        transform: translateX(-50%);
        padding: 8px 16px;
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.96);
        color: #f8fafc;
        border: 1px solid rgba(16, 185, 129, 0.45);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
        font-size: 12.5px;
        font-weight: 500;
        white-space: nowrap;
        display: none;
        pointer-events: none;
      }
    `;

    const root = document.createElement("div");
    root.id = "root";
    root.setAttribute("data-hidden", "true");
    root.innerHTML = `
      <div id="pins-layer"></div>
      <div id="hover-box" class="hide-on-capture"></div>
      <div id="hover-label" class="hide-on-capture"></div>
      <div id="drag-box" class="hide-on-capture"></div>
      <div id="popover" class="hide-on-capture">
        <div class="pop-header">
          <span class="pop-badge" id="pop-badge">#1</span>
          <span class="pop-selector mono" id="pop-selector"></span>
          <button class="btn btn-danger" id="pop-del-btn" style="padding:3px 9px;font-size:11px;display:none;">Delete</button>
        </div>
        <div class="pop-src mono" id="pop-src" style="display:none;"></div>
        <div class="pop-chips" id="pop-chips"></div>
        <textarea id="pop-input" placeholder="输入修改意见…"></textarea>
        <div class="pop-footer">
          <span class="pop-hint">⌘↵ 发送给 Agent · Esc 取消</span>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="btn" id="pop-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="pop-save-btn">Save #1</button>
          </div>
        </div>
      </div>
      <div id="dock-wrap" class="hide-on-capture">
        <div id="drawer" data-open="false">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
            <span style="font-size:12px;font-weight:600;color:#cbd5e1;white-space:nowrap;">已标注列表 (自动同步至 Herdr Review)</span>
            <span style="font-size:11px;color:#94a3b8;white-space:nowrap;">左键标注 · ⌘+左键跳转页面 · Alt+滚轮切父子级</span>
          </div>
          <input id="global-note" placeholder="整体修改要求（可选，如：保持现有主题色，统一调整表单间距）…" />
          <div class="drawer-list" id="drawer-list"></div>
        </div>
        <div id="dock">
          <span class="status-dot" id="status-dot" data-online="false" title="Herdr Bridge Status"></span>
          <select id="agent-select" title="Target Herdr Agent"></select>
          <div class="dock-sep"></div>
          <button class="btn" id="btn-drawer" style="border-radius:999px;">0 items ▴</button>
          <button class="btn btn-primary" id="btn-paste" style="border-radius:999px;" title="Capture annotated screenshot & paste into Herdr Agent (⌘Enter)">Paste to Agent ⌘↵</button>
          <button class="btn btn-accent" id="btn-send" style="border-radius:999px;" title="Capture & run immediately in Herdr Agent (⇧⌘Enter)">Send & Run ⇧⌘↵</button>
          <button class="btn" id="btn-copy" style="border-radius:999px;" title="Copy structured Markdown prompt">Copy MD</button>
          <button class="btn btn-danger" id="btn-clear" style="border-radius:999px;" title="Clear annotations for this Agent">Clear</button>
          <button class="btn" id="btn-exit" style="border-radius:999px;padding:6px 10px;" title="Exit UI Review (Esc)">✕</button>
        </div>
      </div>
      <div id="toast" class="hide-on-capture"></div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(root);
    document.documentElement.appendChild(hostEl);

    els = {
      root,
      pinsLayer: shadow.getElementById("pins-layer"),
      hoverBox: shadow.getElementById("hover-box"),
      hoverLabel: shadow.getElementById("hover-label"),
      dragBox: shadow.getElementById("drag-box"),
      popover: shadow.getElementById("popover"),
      popBadge: shadow.getElementById("pop-badge"),
      popSelector: shadow.getElementById("pop-selector"),
      popSrc: shadow.getElementById("pop-src"),
      popChips: shadow.getElementById("pop-chips"),
      popInput: shadow.getElementById("pop-input"),
      popSaveBtn: shadow.getElementById("pop-save-btn"),
      popCancelBtn: shadow.getElementById("pop-cancel-btn"),
      popDelBtn: shadow.getElementById("pop-del-btn"),
      drawer: shadow.getElementById("drawer"),
      drawerList: shadow.getElementById("drawer-list"),
      globalNote: shadow.getElementById("global-note"),
      statusDot: shadow.getElementById("status-dot"),
      agentSelect: shadow.getElementById("agent-select"),
      btnDrawer: shadow.getElementById("btn-drawer"),
      btnPaste: shadow.getElementById("btn-paste"),
      btnSend: shadow.getElementById("btn-send"),
      btnCopy: shadow.getElementById("btn-copy"),
      btnClear: shadow.getElementById("btn-clear"),
      btnExit: shadow.getElementById("btn-exit"),
      toast: shadow.getElementById("toast"),
    };

    loadCustomTags();
    renderCustomTagChips();

    // Bind popover controls
    els.popSaveBtn.addEventListener("click", e => {
      e.stopPropagation();
      commitDraft();
    });
    els.popCancelBtn.addEventListener("click", e => {
      e.stopPropagation();
      cancelDraft();
    });
    els.popDelBtn.addEventListener("click", e => {
      e.stopPropagation();
      if (state.editingDraft) {
        deleteItem(state.editingDraft.id);
      }
    });
    els.popInput.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        cancelDraft();
        return;
      }
      // Cmd+Enter / Ctrl+Enter saves & dispatches immediately; normal Enter inserts a newline!
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commitDraft({ skipSilentStage: true });
        dispatchToHerdr(e.shiftKey ? "send" : "paste");
      }
    });

    // Bind dock controls
    els.agentSelect.addEventListener("change", e => {
      if (state.editingDraft) commitDraft();
      state.bridge.selectedTerminal = e.target.value;
      loadPageStateFromSession(location.href, effectiveAgentTerminal());
      renderDockAndPins();
    });
    els.globalNote.addEventListener("input", e => {
      state.globalNote = e.target.value;
      savePageStateToSession();
      scheduleSilentStage();
    });
    els.globalNote.addEventListener("keydown", e => e.stopPropagation());
    els.btnDrawer.addEventListener("click", e => {
      e.stopPropagation();
      state.drawerOpen = !state.drawerOpen;
      renderDockAndPins();
    });
    els.btnPaste.addEventListener("click", e => {
      e.stopPropagation();
      clearTimeout(state.silentStageTimer);
      if (state.editingDraft) commitDraft({ skipSilentStage: true });
      dispatchToHerdr("paste");
    });
    els.btnSend.addEventListener("click", e => {
      e.stopPropagation();
      clearTimeout(state.silentStageTimer);
      if (state.editingDraft) commitDraft({ skipSilentStage: true });
      dispatchToHerdr("send");
    });
    els.btnCopy.addEventListener("click", e => {
      e.stopPropagation();
      if (state.editingDraft) commitDraft({ skipSilentStage: true });
      copyMarkdownToClipboard();
    });
    els.btnClear.addEventListener("click", e => {
      e.stopPropagation();
      clearCurrentAgentAnnotations(true);
    });
    els.btnExit.addEventListener("click", e => {
      e.stopPropagation();
      setAnnotatorActive(false);
    });
  }

  function renderCustomTagChips() {
    if (!els.popChips) return;
    els.popChips.innerHTML = "";

    state.customTags.forEach((tagText, idx) => {
      const chip = document.createElement("span");
      chip.className = "pop-chip";

      const txt = document.createElement("span");
      txt.className = "pop-chip-text";
      txt.textContent = tagText;
      txt.title = tagText;
      txt.addEventListener("click", e => {
        e.stopPropagation();
        const cur = els.popInput.value.trim();
        els.popInput.value = cur ? `${cur}；${tagText}` : tagText;
        els.popInput.focus();
      });

      const del = document.createElement("span");
      del.className = "pop-chip-del";
      del.textContent = "×";
      del.title = "删除该标签";
      del.addEventListener("click", e => {
        e.stopPropagation();
        state.customTags.splice(idx, 1);
        saveCustomTags();
        renderCustomTagChips();
      });

      chip.appendChild(txt);
      chip.appendChild(del);
      els.popChips.appendChild(chip);
    });

    if (state.customTags.length < MAX_CUSTOM_TAGS) {
      if (state.addingTag) {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "pop-tag-input";
        inp.placeholder = "输入常用标签，回车添加";
        inp.maxLength = 32;
        const finishAdd = save => {
          if (!state.addingTag) return;
          const val = inp.value.trim();
          state.addingTag = false;
          if (
            save &&
            val &&
            state.customTags.length < MAX_CUSTOM_TAGS &&
            !state.customTags.includes(val)
          ) {
            state.customTags.push(val);
            saveCustomTags();
          }
          renderCustomTagChips();
        };
        inp.addEventListener("keydown", e => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            finishAdd(true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finishAdd(false);
          }
        });
        inp.addEventListener("blur", () => finishAdd(true));
        els.popChips.appendChild(inp);
        setTimeout(() => inp.focus(), 10);
      } else {
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "pop-chip pop-chip-add";
        addBtn.textContent =
          state.customTags.length === 0 ? "+ 添加常用标签" : "+";
        addBtn.title = `自定义快捷评论标签 (${state.customTags.length}/${MAX_CUSTOM_TAGS})`;
        addBtn.addEventListener("click", e => {
          e.stopPropagation();
          state.addingTag = true;
          renderCustomTagChips();
        });
        els.popChips.appendChild(addBtn);
      }
    }
  }

  function clearCurrentAgentAnnotations(notifyServer = false) {
    const agent = effectiveAgentTerminal();
    state.items = [];
    state.globalNote = "";
    if (els.globalNote) els.globalNote.value = "";
    clearAllSessionDraftsForAgent(agent);
    cancelDraft();
    renderDockAndPins();
    if (notifyServer) {
      chrome.runtime.sendMessage(
        {
          type: "HERDR_CLEAR_AGENT_ANNOTATIONS",
          targetTerminal: agent,
        },
        () => {},
      );
      showToast("已清空当前 Agent 的标注列表");
    }
  }

  function showToast(text, duration = 2600) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.style.display = "block";
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      if (els.toast) els.toast.style.display = "none";
    }, duration);
  }

  function refreshBridgeStatus() {
    chrome.runtime.sendMessage({ type: "HERDR_BRIDGE_STATUS" }, res => {
      if (chrome.runtime.lastError || !res?.ok || !res.data?.ok) {
        state.bridge.online = false;
        renderBridgeSelect();
        return;
      }
      const d = res.data;
      state.bridge.online = true;
      state.bridge.cwd = d.cwd || "";
      state.bridge.activeSpace = d.activeSpace || null;
      state.bridge.focused = d.focused || null;
      state.bridge.agents = Array.isArray(d.agents) ? d.agents : [];

      if (
        !state.bridge.selectedTerminal ||
        !state.bridge.agents.some(
          a => a.address === state.bridge.selectedTerminal,
        )
      ) {
        const defaultAgent =
          state.bridge.agents.find(a => a.focused) ||
          (d.focused?.terminal
            ? state.bridge.agents.find(a => a.address === d.focused.terminal)
            : null) ||
          (d.activeSpace?.id
            ? state.bridge.agents.find(a => a.space === d.activeSpace.id)
            : null) ||
          state.bridge.agents[0];
        if (defaultAgent) {
          state.bridge.selectedTerminal = defaultAgent.address;
        }
      }

      loadPageStateFromSession(location.href, effectiveAgentTerminal());
      renderBridgeSelect();
      renderDockAndPins();
    });
  }

  function renderBridgeSelect() {
    if (!els.statusDot || !els.agentSelect) return;
    els.statusDot.setAttribute(
      "data-online",
      state.bridge.online ? "true" : "false",
    );
    const currentTarget = effectiveAgentTerminal();
    els.agentSelect.innerHTML = "";

    if (!state.bridge.agents.length) {
      const opt = document.createElement("option");
      opt.value = currentTarget;
      opt.textContent = state.bridge.online
        ? "To: Active Agent"
        : "Herdr Bridge Offline (:17501)";
      els.agentSelect.appendChild(opt);
      return;
    }

    for (const a of state.bridge.agents) {
      const opt = document.createElement("option");
      opt.value = a.address;
      opt.textContent = `To: ${a.programName} · ${a.spaceName || "space"} (${a.address})`;
      els.agentSelect.appendChild(opt);
    }
    els.agentSelect.value = currentTarget;
  }

  function isEventInsideOurUI(e) {
    if (!hostEl) return false;
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(hostEl);
  }

  function isEventInsideElement(e, targetEl) {
    if (!targetEl) return false;
    const path = e.composedPath ? e.composedPath() : [];
    return path.includes(targetEl);
  }

  function getElementAtPoint(x, y) {
    const el = document.elementFromPoint(x, y);
    if (
      !el ||
      el === hostEl ||
      el === document.documentElement ||
      el === document.body
    ) {
      return el === document.body ? document.body : null;
    }
    return el;
  }

  async function updateHoverHighlight(el) {
    if (!state.active || state.editingDraft || state.drag?.moved) {
      if (els.hoverBox) els.hoverBox.style.display = "none";
      if (els.hoverLabel) els.hoverLabel.style.display = "none";
      return;
    }
    if (!el || !(el instanceof Element)) {
      els.hoverBox.style.display = "none";
      els.hoverLabel.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) {
      els.hoverBox.style.display = "none";
      els.hoverLabel.style.display = "none";
      return;
    }

    els.hoverBox.style.display = "block";
    els.hoverBox.style.left = `${r.left}px`;
    els.hoverBox.style.top = `${r.top}px`;
    els.hoverBox.style.width = `${r.width}px`;
    els.hoverBox.style.height = `${r.height}px`;

    const src = await inspectElementSourceSyncOrAsync(el);
    if (state.hoveredEl !== el) return;

    const tag = el.tagName.toLowerCase();
    const cls = Array.from(el.classList || [])
      .filter(c => c && c.length < 28)
      .slice(0, 2)
      .join(".");
    const tagStr = cls ? `<${tag}.${cls}>` : `<${tag}>`;
    const shortSrc = formatShortSource(src);
    const dimStr = `${Math.round(r.width)}×${Math.round(r.height)}`;

    els.hoverLabel.innerHTML = `
      <span class="hover-tag mono">${tagStr}</span>
      ${shortSrc ? `<span class="hover-src mono">${shortSrc}</span>` : ""}
      <span class="hover-dim mono">${dimStr}</span>
    `;
    els.hoverLabel.style.display = "flex";
    const labelTop =
      r.top >= 30 ? r.top - 28 : Math.min(window.innerHeight - 28, r.bottom + 6);
    const labelLeft = Math.max(8, Math.min(window.innerWidth - 280, r.left));
    els.hoverLabel.style.left = `${labelLeft}px`;
    els.hoverLabel.style.top = `${labelTop}px`;
  }

  function openPopoverForDraft(draft, isNew) {
    state.editingDraft = draft;
    state.isNewDraft = isNew;
    state.addingTag = false;
    renderCustomTagChips();
    els.hoverBox.style.display = "none";
    els.hoverLabel.style.display = "none";

    const idx = isNew
      ? state.items.length + 1
      : state.items.findIndex(i => i.id === draft.id) + 1;
    els.popBadge.textContent = `#${idx}`;
    els.popSelector.textContent =
      draft.kind === "area"
        ? `Area (${(draft.groupedElements || []).length} elements)`
        : draft.selector || `<${draft.tagName}>`;

    const srcDisplay = normalizeSourceDisplay(draft.source);
    if (srcDisplay) {
      els.popSrc.textContent = srcDisplay;
      els.popSrc.style.display = "block";
    } else {
      els.popSrc.style.display = "none";
    }

    els.popDelBtn.style.display = isNew ? "none" : "inline-flex";
    els.popSaveBtn.textContent = isNew ? `Add #${idx}` : `Save #${idx}`;
    els.popInput.value = draft.note || "";
    els.popover.style.display = "flex";

    const r = draft.rect || {
      x: window.innerWidth / 2 - 205,
      y: 120,
      width: 100,
      height: 40,
    };
    const popW = 410;
    const popH = 245;
    let left = r.x + r.width + 12;
    let top = r.y;
    if (left + popW > window.innerWidth - 12) {
      left = Math.max(12, r.x - popW - 12);
    }
    if (left < 12 || (left + popW > r.x && left < r.x + r.width)) {
      left = Math.max(12, Math.min(window.innerWidth - popW - 12, r.x));
      top =
        r.y + r.height + popH + 20 < window.innerHeight
          ? r.y + r.height + 10
          : Math.max(12, r.y - popH - 10);
    }
    top = Math.max(12, Math.min(window.innerHeight - popH - 70, top));
    els.popover.style.left = `${left}px`;
    els.popover.style.top = `${top}px`;

    setTimeout(() => els.popInput.focus(), 10);
  }

  function commitDraft(opts = {}) {
    const draft = state.editingDraft;
    if (!draft) return;
    draft.note = els.popInput.value.trim() || "请检查并优化此元素";
    if (state.isNewDraft) {
      state.items.push(draft);
    }
    state.editingDraft = null;
    state.isNewDraft = false;
    els.popover.style.display = "none";
    savePageStateToSession();
    renderDockAndPins();
    if (!opts.skipSilentStage) {
      scheduleSilentStage();
    }
  }

  function cancelDraft() {
    state.editingDraft = null;
    state.isNewDraft = false;
    if (els.popover) els.popover.style.display = "none";
    renderDockAndPins();
  }

  function deleteItem(id) {
    state.items = state.items.filter(i => i.id !== id);
    savePageStateToSession();
    if (state.editingDraft?.id === id) {
      cancelDraft();
    } else {
      renderDockAndPins();
    }
    scheduleSilentStage();
  }

  function computeLiveViewportRect(item) {
    if (
      item.element &&
      document.contains(item.element) &&
      item.kind !== "area"
    ) {
      const r = item.element.getBoundingClientRect();
      return {
        x: r.left,
        y: r.top,
        width: r.width,
        height: r.height,
      };
    }
    if (item.pageRect) {
      return {
        x: item.pageRect.x - window.scrollX,
        y: item.pageRect.y - window.scrollY,
        width: item.pageRect.width,
        height: item.pageRect.height,
      };
    }
    return item.rect;
  }

  function renderDockAndPins() {
    if (!els.pinsLayer) return;
    els.pinsLayer.innerHTML = "";

    const listToRender = [...state.items];
    if (state.editingDraft && state.isNewDraft) {
      listToRender.push(state.editingDraft);
    }

    listToRender.forEach((item, idx) => {
      const num = idx + 1;
      const r = computeLiveViewportRect(item);
      if (!r) return;
      item.rect = r;

      const box = document.createElement("div");
      box.className = "pin-box";
      box.setAttribute("data-kind", item.kind || "element");
      box.style.left = `${r.x}px`;
      box.style.top = `${r.y}px`;
      box.style.width = `${Math.max(4, r.width)}px`;
      box.style.height = `${Math.max(4, r.height)}px`;

      const badge = document.createElement("div");
      badge.className = "pin-badge";
      badge.textContent = `${num}`;
      badge.title = `#${num}: ${item.note || item.selector} (Click to edit)`;
      badge.style.left = `${Math.max(4, r.x - 10)}px`;
      badge.style.top = `${Math.max(4, r.y - 10)}px`;
      badge.addEventListener("click", e => {
        e.stopPropagation();
        openPopoverForDraft(item, false);
      });

      els.pinsLayer.appendChild(box);
      els.pinsLayer.appendChild(badge);
    });

    const count = state.items.length;
    els.btnDrawer.textContent = `${count} item${count === 1 ? "" : "s"} ${
      state.drawerOpen ? "▾" : "▴"
    }`;
    els.drawer.setAttribute("data-open", state.drawerOpen ? "true" : "false");

    els.drawerList.innerHTML = "";
    if (count === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:11.5px;color:#94a3b8;padding:6px 2px;";
      empty.textContent =
        "暂无标注 — 点击页面元素或拖拽框选即可添加标注（自动按当前所选 Agent 同步至 Herdr Review）。";
      els.drawerList.appendChild(empty);
    } else {
      state.items.forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = "drawer-item";
        const shortSrc = formatShortSource(item.source);
        row.innerHTML = `
          <span class="pop-badge">#${idx + 1}</span>
          <span class="drawer-item-note">${item.note || ""}</span>
          <span class="drawer-item-meta mono">${shortSrc || item.selector || ""}</span>
        `;
        const editBtn = document.createElement("button");
        editBtn.className = "btn";
        editBtn.style.cssText = "padding:3px 8px;font-size:11px;";
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", e => {
          e.stopPropagation();
          openPopoverForDraft(item, false);
        });
        const delBtn = document.createElement("button");
        delBtn.className = "btn btn-danger";
        delBtn.style.cssText = "padding:3px 8px;font-size:11px;";
        delBtn.textContent = "×";
        delBtn.addEventListener("click", e => {
          e.stopPropagation();
          deleteItem(item.id);
        });
        row.appendChild(editBtn);
        row.appendChild(delBtn);
        els.drawerList.appendChild(row);
      });
    }
  }

  async function createElementDraft(el) {
    const r = el.getBoundingClientRect();
    const source = await inspectElementSourceSyncOrAsync(el);
    const selText = (window.getSelection?.()?.toString() || "").trim();
    return {
      id: `item-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: selText ? "selection" : "element",
      element: el,
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      pageRect: {
        x: r.left + window.scrollX,
        y: r.top + window.scrollY,
        width: r.width,
        height: r.height,
      },
      note: "",
      tagName: el.tagName.toLowerCase(),
      selector: buildCssSelector(el),
      text: extractCleanText(el),
      selectedText: selText,
      htmlSnippet: extractHtmlSnippet(el),
      styles: extractKeyStyles(el),
      source,
      groupedElements: [],
    };
  }

  async function createAreaDraft(boxRect) {
    const candidates = Array.from(
      document.querySelectorAll(
        "button, a, input, select, textarea, label, h1, h2, h3, h4, p, span, img, svg, [role='button']",
      ),
    ).filter(el => {
      if (hostEl && hostEl.contains(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return false;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return (
        cx >= boxRect.x &&
        cx <= boxRect.x + boxRect.width &&
        cy >= boxRect.y &&
        cy <= boxRect.y + boxRect.height
      );
    });

    const grouped = [];
    for (const el of candidates.slice(0, 8)) {
      const src = await inspectElementSourceSyncOrAsync(el);
      grouped.push({
        tagName: el.tagName.toLowerCase(),
        selector: buildCssSelector(el),
        text: extractCleanText(el).slice(0, 60),
        source: src,
      });
    }

    const centerEl = getElementAtPoint(
      boxRect.x + boxRect.width / 2,
      boxRect.y + boxRect.height / 2,
    );
    const containerSource = centerEl
      ? await inspectElementSourceSyncOrAsync(centerEl)
      : grouped[0]?.source || null;

    return {
      id: `area-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      kind: "area",
      element: centerEl,
      rect: boxRect,
      pageRect: {
        x: boxRect.x + window.scrollX,
        y: boxRect.y + window.scrollY,
        width: boxRect.width,
        height: boxRect.height,
      },
      note: "",
      tagName: centerEl ? centerEl.tagName.toLowerCase() : "section",
      selector: centerEl ? buildCssSelector(centerEl) : "area-selection",
      text: "",
      selectedText: "",
      htmlSnippet: "",
      styles: centerEl ? extractKeyStyles(centerEl) : {},
      source: containerSource,
      groupedElements: grouped,
    };
  }

  function serializeItemsForTransport() {
    return state.items.map((it, idx) => ({
      id: it.id,
      index: idx + 1,
      enabled: true,
      kind: it.kind,
      note: it.note,
      tagName: it.tagName,
      selector: it.selector,
      text: it.text,
      selectedText: it.selectedText,
      htmlSnippet: it.htmlSnippet,
      rect: computeLiveViewportRect(it),
      styles: it.styles,
      source: it.source,
      groupedElements: it.groupedElements || [],
    }));
  }

  function buildLocalMarkdown(items) {
    const lines = [];
    lines.push(
      `请根据以下浏览器页面视觉标注修改前端代码（页面: \`${location.href}\` (${document.title || "page"})）：`,
    );
    if (state.globalNote.trim()) {
      lines.push(`\n**整体修改要求**: ${state.globalNote.trim()}`);
    }
    lines.push("");
    items.forEach((it, idx) => {
      const num = idx + 1;
      lines.push(`### 标注 #${num} — ${it.note || "请优化此元素"}`);
      const src = normalizeSourceDisplay(it.source);
      if (src) lines.push(`- **源码定位**: ${src}`);
      if (it.selector)
        lines.push(`- **DOM 选择器**: \`${it.selector}\` (\`<${it.tagName}>\`)`);
      if (it.selectedText) lines.push(`- **选中文本**: "${it.selectedText}"`);
      else if (it.text) lines.push(`- **元素文本**: "${it.text}"`);
      if (it.rect) {
        lines.push(
          `- **位置尺寸**: \`${Math.round(it.rect.width)}×${Math.round(it.rect.height)}px\` @ (\`${Math.round(it.rect.x)}, ${Math.round(it.rect.y)}\`)`,
        );
      }
      const stylePairs = Object.entries(it.styles || {})
        .map(([k, v]) => `${k}: ${v}`)
        .join("; ");
      if (stylePairs) lines.push(`- **关键样式**: \`${stylePairs}\``);
      lines.push("");
    });
    return lines.join("\n").trim();
  }

  async function copyMarkdownToClipboard() {
    const items = serializeItemsForTransport();
    if (!items.length) {
      showToast("请先点击页面元素添加至少 1 条标注");
      return;
    }
    const md = buildLocalMarkdown(items);
    await navigator.clipboard.writeText(md);
    showToast(`✓ 已复制 ${items.length} 条标注的 Markdown`);
  }

  async function dispatchToHerdr(action, opts = {}) {
    if (!opts.silent) {
      clearTimeout(state.silentStageTimer);
    }
    if (state.sending && opts.silent) return;
    const items = serializeItemsForTransport();
    const targetTerminal = effectiveAgentTerminal();

    if (!items.length && !opts.silent) {
      showToast("请先点击页面元素添加至少 1 条标注");
      return;
    }

    if (!opts.silent) {
      state.sending = true;
    }
    renderDockAndPins();

    els.root.setAttribute("data-capturing", "true");
    await new Promise(r =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );

    const payload = {
      url: location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      globalNote: state.globalNote,
      action,
      replaceSameUrl: true,
      targetTerminal,
      items,
    };

    chrome.runtime.sendMessage(
      {
        type: "HERDR_CAPTURE_AND_SEND",
        captureScreenshot: items.length > 0,
        payload,
      },
      async res => {
        els.root.removeAttribute("data-capturing");
        state.sending = false;
        if (opts.silent) return;
        if (chrome.runtime.lastError || !res?.ok) {
          const md = buildLocalMarkdown(items);
          try {
            await navigator.clipboard.writeText(md);
          } catch {}
          showToast(
            "Herdr Bridge 未连接 — 已将标注 Markdown 复制到剪贴板！",
            3500,
          );
          return;
        }

        // Auto-clear annotations after sending to Agent!
        if (action === "paste" || action === "send") {
          const sentCount = items.length;
          clearCurrentAgentAnnotations(false);
          const label =
            action === "send"
              ? `✓ 已发送 ${sentCount} 条标注到 Agent 并开始执行（列表已清空）`
              : `✓ 已粘贴 ${sentCount} 条标注与截图到 Agent 输入框（列表已清空）`;
          showToast(label, 3000);
          return;
        }

        showToast(`✓ 已同步 ${items.length} 条标注到 Herdr Review`, 2600);
      },
    );
  }

  // Event listeners on document when annotator is active
  function onMouseMove(e) {
    if (!state.active) return;
    state.lastPointer = { x: e.clientX, y: e.clientY };

    if (state.drag) {
      state.drag.curX = e.clientX;
      state.drag.curY = e.clientY;
      const dx = Math.abs(e.clientX - state.drag.startX);
      const dy = Math.abs(e.clientY - state.drag.startY);
      if (dx > 10 || dy > 10) {
        state.drag.moved = true;
      }
      if (state.drag.moved) {
        els.hoverBox.style.display = "none";
        els.hoverLabel.style.display = "none";
        const x = Math.min(state.drag.startX, state.drag.curX);
        const y = Math.min(state.drag.startY, state.drag.curY);
        const w = Math.abs(state.drag.curX - state.drag.startX);
        const h = Math.abs(state.drag.curY - state.drag.startY);
        els.dragBox.style.display = "block";
        els.dragBox.style.left = `${x}px`;
        els.dragBox.style.top = `${y}px`;
        els.dragBox.style.width = `${w}px`;
        els.dragBox.style.height = `${h}px`;
        return;
      }
    }

    if (state.editingDraft || isEventInsideOurUI(e)) {
      els.hoverBox.style.display = "none";
      els.hoverLabel.style.display = "none";
      return;
    }

    const target = getElementAtPoint(e.clientX, e.clientY);
    if (target !== state.hoveredEl) {
      state.hoveredEl = target;
      state.childStack = [];
      updateHoverHighlight(target);
    }
  }

  function onMouseDown(e) {
    if (!state.active || e.button !== 0) return;

    // Auto-collapse drawer when clicking anywhere outside drawer & drawer toggle button
    if (
      state.drawerOpen &&
      !isEventInsideElement(e, els.drawer) &&
      !isEventInsideElement(e, els.btnDrawer)
    ) {
      state.drawerOpen = false;
      renderDockAndPins();
      if (!isEventInsideOurUI(e) && !state.editingDraft) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }

    // If clicking inside our UI (e.g. dock or popover), let our UI handle it;
    // but if editingDraft is open and user clicked dock outside popover, commit draft first!
    if (isEventInsideOurUI(e)) {
      if (state.editingDraft && !isEventInsideElement(e, els.popover)) {
        const isSendOrPasteBtn =
          isEventInsideElement(e, els.btnSend) ||
          isEventInsideElement(e, els.btnPaste);
        commitDraft({ skipSilentStage: isSendOrPasteBtn });
      }
      return;
    }

    // Clicking on blank page while comment popover is open -> save & close popover!
    if (state.editingDraft) {
      commitDraft();
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // Allow Cmd+Click (or Ctrl+Click) to pass through natively to navigate links/tabs on the page
    if (e.metaKey || e.ctrlKey) {
      setTimeout(checkUrlChange, 80);
      setTimeout(checkUrlChange, 350);
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    state.drag = {
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
      moved: false,
    };
  }

  async function onMouseUp(e) {
    if (!state.active || e.button !== 0) return;
    if (isEventInsideOurUI(e)) return;
    if (e.metaKey || e.ctrlKey) return;
    if (!state.drag) return;

    const drag = state.drag;
    state.drag = null;
    els.dragBox.style.display = "none";
    e.preventDefault();
    e.stopPropagation();

    if (drag.moved) {
      const boxRect = {
        x: Math.min(drag.startX, drag.curX),
        y: Math.min(drag.startY, drag.curY),
        width: Math.abs(drag.curX - drag.startX),
        height: Math.abs(drag.curY - drag.startY),
      };
      const draft = await createAreaDraft(boxRect);
      renderDockAndPins();
      openPopoverForDraft(draft, true);
      return;
    }

    const el = state.hoveredEl || getElementAtPoint(e.clientX, e.clientY);
    if (!el) return;
    const draft = await createElementDraft(el);
    renderDockAndPins();
    openPopoverForDraft(draft, true);
  }

  function onClickCapture(e) {
    if (!state.active) return;
    if (isEventInsideOurUI(e)) return;
    if (e.metaKey || e.ctrlKey) {
      setTimeout(checkUrlChange, 80);
      setTimeout(checkUrlChange, 350);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onWheel(e) {
    if (!state.active) return;
    if (e.altKey && state.hoveredEl && !state.editingDraft) {
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY < 0) {
        const parent = state.hoveredEl.parentElement;
        if (
          parent &&
          parent !== document.body &&
          parent !== document.documentElement
        ) {
          state.childStack.push(state.hoveredEl);
          state.hoveredEl = parent;
          updateHoverHighlight(parent);
        }
      } else if (e.deltaY > 0 && state.childStack.length > 0) {
        const child = state.childStack.pop();
        state.hoveredEl = child;
        updateHoverHighlight(child);
      }
      return;
    }
    requestAnimationFrame(() => renderDockAndPins());
  }

  function onKeyDown(e) {
    if (!state.active) return;
    if (isEventInsideOurUI(e)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (state.editingDraft) {
        cancelDraft();
      } else if (state.drawerOpen) {
        state.drawerOpen = false;
        renderDockAndPins();
      } else {
        setAnnotatorActive(false);
      }
      return;
    }

    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      if (state.editingDraft) commitDraft();
      dispatchToHerdr(e.shiftKey ? "send" : "paste");
      return;
    }

    if (!state.editingDraft && state.hoveredEl) {
      if (e.key === "ArrowUp") {
        const parent = state.hoveredEl.parentElement;
        if (
          parent &&
          parent !== document.body &&
          parent !== document.documentElement
        ) {
          e.preventDefault();
          state.childStack.push(state.hoveredEl);
          state.hoveredEl = parent;
          updateHoverHighlight(parent);
        }
      } else if (e.key === "ArrowDown" && state.childStack.length > 0) {
        e.preventDefault();
        const child = state.childStack.pop();
        state.hoveredEl = child;
        updateHoverHighlight(child);
      }
    }
  }

  function onScrollOrResize() {
    if (!state.active) return;
    requestAnimationFrame(() => {
      renderDockAndPins();
      if (state.hoveredEl && !state.editingDraft) {
        updateHoverHighlight(state.hoveredEl);
      }
    });
  }

  function setAnnotatorActive(next) {
    ensureShadowUI();
    state.active = Boolean(next);
    if (state.active) {
      state.currentUrl = location.href;
      els.root.setAttribute("data-hidden", "false");
      refreshBridgeStatus();
      renderDockAndPins();
      window.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("mousedown", onMouseDown, true);
      window.addEventListener("mouseup", onMouseUp, true);
      window.addEventListener("click", onClickCapture, true);
      window.addEventListener("wheel", onWheel, { capture: true, passive: false });
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("scroll", onScrollOrResize, true);
      window.addEventListener("resize", onScrollOrResize, true);
      window.addEventListener("popstate", checkUrlChange, true);
      window.addEventListener("hashchange", checkUrlChange, true);
      showToast(
        "Herdr UI Review 已开启 — 点击元素添加评论，点击空白处自动保存",
      );
    } else {
      if (state.editingDraft) commitDraft();
      state.drawerOpen = false;
      els.root.setAttribute("data-hidden", "true");
      window.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", onMouseUp, true);
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize, true);
      window.removeEventListener("popstate", checkUrlChange, true);
      window.removeEventListener("hashchange", checkUrlChange, true);
    }
  }

  // Global shortcut listener (Option+Shift+A / Alt+Shift+A)
  function onGlobalShortcut(e) {
    if (
      e.altKey &&
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      e.code === "KeyA"
    ) {
      e.preventDefault();
      e.stopPropagation();
      setAnnotatorActive(!state.active);
    }
  }
  window.addEventListener("keydown", onGlobalShortcut, true);

  window.__herdrAnnotatorCleanup = function () {
    setAnnotatorActive(false);
    window.removeEventListener("keydown", onGlobalShortcut, true);
    if (hostEl && hostEl.parentNode) {
      hostEl.parentNode.removeChild(hostEl);
    }
    hostEl = null;
    shadow = null;
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "HERDR_PING_VERSION") {
      sendResponse({ ok: true, version: SCRIPT_VERSION });
      return;
    }
    if (msg?.type === "HERDR_TOGGLE_ANNOTATOR") {
      setAnnotatorActive(!state.active);
      sendResponse({ ok: true, active: state.active, version: SCRIPT_VERSION });
    }
  });
})();
