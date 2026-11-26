import { spaces, panes, agents, terminals, focused, shared, setShared, run } from "herdr";

export const LANG = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  jsx: "js",
  mjs: "js",
  toml: "yaml",
  jsonc: "json",
  svelte: "html",
  vue: "html",
};

export const PER_FOLDER = 500;
export const TOTAL = 5000;
export const LINE_H = 20;
export const RIGHT_SIDEBAR_WIDTH = 260;
export const SEARCH_SIDEBAR_WIDTH = 260;
export const SPLIT_PREVIEW_WIDTH = 720;

export function isMarkdownFile(path) {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx") || lower.endsWith(".markdown");
}

// Git status colors
export const GIT_COLOR = {
  M: "#e2b061", // Modified: warm amber-gold
  U: "#63c29f", // Untracked: teal-green
  A: "#63c29f", // Added: teal-green
  D: "#e06c75", // Deleted: coral red
  C: "#e06c75", // Conflict: coral red
};

export const GIT_DOT_COLOR = {
  M: "#b88746",
  U: "#4fa384",
  A: "#4fa384",
  D: "#c25a62",
  C: "#c25a62",
};

export const STATUS_PRIORITY = { C: 5, D: 4, M: 3, A: 2, U: 1 };

let lastFocusedPaneId = null;
let lastFocusedTerminal = null;

export function location() {
  const space = spaces().find(s => s.active);
  const f = focused();
  if (f?.pane) {
    lastFocusedPaneId = f.pane;
    lastFocusedTerminal = null;
    try {
      if (shared("ide.last_focused_pane") !== f.pane) {
        setShared("ide.last_focused_pane", f.pane);
      }
    } catch {}
  } else if (f?.terminal) {
    lastFocusedTerminal = f.terminal;
  }

  let effectiveLastPaneId = lastFocusedPaneId;
  if (!effectiveLastPaneId) {
    try {
      effectiveLastPaneId = shared("ide.last_focused_pane") || null;
    } catch {}
  }

  const activeTab = space?.tabs?.find(t => t.active);
  const allPanes = panes();
  const pane =
    (f?.pane && allPanes.find(p => p.pane === f.pane)) ||
    (effectiveLastPaneId &&
      allPanes.find(
        p => p.pane === effectiveLastPaneId && (!activeTab || p.tab === activeTab.id),
      )) ||
    (activeTab && allPanes.find(p => p.tab === activeTab.id && p.program?.agent)) ||
    (activeTab && allPanes.find(p => p.tab === activeTab.id)) ||
    null;

  const allAgents = agents();
  const allTerminals = terminals();
  const termMap = new Map(allTerminals.map(t => [t.address, t]));

  const rawTermAddr =
    (f?.pane === null && f?.terminal ? f.terminal : null) ||
    pane?.terminal ||
    f?.agent ||
    f?.terminal ||
    (!pane && lastFocusedTerminal ? lastFocusedTerminal : null) ||
    null;

  let rootTermAddr = rawTermAddr;
  const visited = new Set();
  while (rootTermAddr && !visited.has(rootTermAddr)) {
    visited.add(rootTermAddr);
    const tObj = termMap.get(rootTermAddr);
    if (tObj?.parent && termMap.has(tObj.parent)) {
      rootTermAddr = tObj.parent;
    } else {
      break;
    }
  }

  const agent =
    (rootTermAddr && allAgents.find(a => a.address === rootTermAddr)) ||
    (rawTermAddr && allAgents.find(a => a.address === rawTermAddr)) ||
    (pane?.pane && allAgents.find(a => a.pane === pane.pane)) ||
    (activeTab && allAgents.find(a => a.tab === activeTab.id)) ||
    null;

  const term =
    (agent?.address && termMap.get(agent.address)) ||
    (rootTermAddr && termMap.get(rootTermAddr)) ||
    (rawTermAddr && termMap.get(rawTermAddr)) ||
    null;

  const agentKey =
    agent?.address ||
    rootTermAddr ||
    (pane?.pane ? `pane:${pane.pane}` : null) ||
    (activeTab?.id ? `tab:${activeTab.id}` : null) ||
    "default";

  const agentCandidates = [];
  const pushCandidate = val => {
    if (!val || typeof val !== "string") return;
    const trimmed = val.trim();
    if (trimmed && !agentCandidates.includes(trimmed)) {
      agentCandidates.push(trimmed);
    }
  };

  const cwdList = [
    term?.foreground?.cwd,
    pane?.cwd,
    f?.cwd,
    term?.cwd,
    space?.folder,
  ].filter(Boolean);
  for (const c of cwdList) {
    const wtMatch = /^(.*)\/(\.worktrees?|worktrees?)\/([^/]+)(?:\/.*)?$/.exec(c);
    if (wtMatch && wtMatch[2] && wtMatch[3]) {
      pushCandidate(`${wtMatch[2]}/${wtMatch[3]}`);
      pushCandidate(wtMatch[3]);
    }
  }

  pushCandidate(term?.labels?.["herdr.session"]);

  try {
    const sharedSessions = shared("ide.agent_sessions");
    if (sharedSessions && agent?.address) {
      pushCandidate(sharedSessions[agent.address]);
    }
    if (sharedSessions && rootTermAddr) {
      pushCandidate(sharedSessions[rootTermAddr]);
    }
  } catch {}

  const progName = agent?.program?.name || pane?.program?.name || term?.program?.name || "";
  for (const rawTitle of [agent?.title, term?.title, pane?.title]) {
    if (!rawTitle || typeof rawTitle !== "string") continue;
    const t = rawTitle.trim();
    if (t.startsWith("π - ")) {
      const parts = t.slice(4).split(" - ");
      if (parts.length >= 2) {
        pushCandidate(parts.slice(0, -1).join(" - ").trim());
      }
      continue;
    }
    if (
      t &&
      t !== progName &&
      !/^[~/]|^[A-Za-z]:\\/.test(t) &&
      !t.includes("@")
    ) {
      pushCandidate(t);
    }
  }

  const tabName = activeTab?.name || agent?.tab_name || "";
  if (
    tabName &&
    !/^tb?\d+$|^\d+$/.test(tabName) &&
    tabName !== progName &&
    (activeTab?.named || tabName !== progName)
  ) {
    pushCandidate(tabName);
  }

  const on =
    f?.pane === null && f?.terminal
      ? f.terminal.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);

  return {
    cwd: pane?.cwd || term?.foreground?.cwd || term?.cwd || f?.cwd || space?.folder,
    on,
    space: space?.id,
    agentKey,
    agentCandidates,
  };
}

export function matchAgentWorktreeFeature(wtFeatures, agentCandidates) {
  if (!Array.isArray(wtFeatures) || wtFeatures.length === 0) return null;
  if (!Array.isArray(agentCandidates) || agentCandidates.length === 0) return null;

  for (const raw of agentCandidates) {
    const cand = String(raw || "").trim();
    if (!cand) continue;

    const byRel = wtFeatures.find(f => f.relPath === cand);
    if (byRel) return byRel.relPath;

    const byName = wtFeatures.find(f => f.name === cand);
    if (byName) return byName.relPath;

    if (cand.includes("/")) {
      const tail = cand.split("/").pop()?.trim();
      if (tail) {
        const byTail = wtFeatures.find(f => f.name === tail);
        if (byTail) return byTail.relPath;
      }
    }

    const lower = cand.toLowerCase();
    const byLower = wtFeatures.find(f => f.name.toLowerCase() === lower);
    if (byLower) return byLower.relPath;
  }

  return null;
}

export const locationKey = () => JSON.stringify(location());

export function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSearchRegExp(
  query,
  { caseSensitive = false, wholeWord = false, regex = false } = {},
) {
  if (!query) return { re: null, error: null };
  try {
    let source = regex ? query : escapeRegExp(query);
    if (wholeWord) source = `\\b(?:${source})\\b`;
    const flags = caseSensitive ? "g" : "gi";
    return { re: new RegExp(source, flags), error: null };
  } catch (e) {
    return { re: null, error: String(e?.message || e) };
  }
}

export function globTokenToRegExp(token) {
  const p = token
    .trim()
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
  if (!p) return null;
  const hasGlob = /[*?[\]{}]/.test(p);
  if (!hasGlob) {
    const esc = escapeRegExp(p);
    return new RegExp(esc, "i");
  }
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        if (p[i + 2] === "/") {
          out += "(?:.+/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const close = p.indexOf("}", i);
      if (close > i) {
        const inner = p
          .slice(i + 1, close)
          .split(",")
          .map(s => escapeRegExp(s.trim()))
          .join("|");
        out += `(?:${inner})`;
        i = close;
      } else {
        out += "\\{";
      }
    } else if (".+^$()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`(?:^|/)${out}(?:$|/)`, "i");
}

export function compileFileMatchers(raw) {
  if (!raw || !raw.trim()) return [];
  const tokens = [];
  let cur = "";
  let depth = 0;
  for (const ch of raw) {
    if (ch === "{") depth++;
    else if (ch === "}" && depth > 0) depth--;
    if (ch === "," && depth === 0) {
      if (cur.trim()) tokens.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) tokens.push(cur.trim());
  return tokens.map(globTokenToRegExp).filter(Boolean);
}

export function applyPreserveCase(matched, replacement) {
  if (!matched || !replacement) return replacement;
  const isAllUpper = matched === matched.toUpperCase() && matched !== matched.toLowerCase();
  if (isAllUpper) return replacement.toUpperCase();
  const isAllLower = matched === matched.toLowerCase() && matched !== matched.toUpperCase();
  if (isAllLower) return replacement.toLowerCase();
  const isCapitalized =
    matched[0] === matched[0].toUpperCase() &&
    matched[0] !== matched[0].toLowerCase() &&
    matched.slice(1) === matched.slice(1).toLowerCase();
  if (isCapitalized) return replacement[0].toUpperCase() + replacement.slice(1).toLowerCase();
  return replacement;
}

export {
  normalizePosixPath,
  resolveRefPath,
  formatRef,
  offsetToLineCol,
  normalizeSelectionBounds,
  isWholeLineSelection,
  formatSelectionRef,
  formatSelectionBadge,
  rangeToLineColSelection,
} from "./selection.js";

export function pasteIntoTerminal(text, cx, target) {
  const f = target || focused();
  cx.write_to_clipboard(`${text} `);
  if (f?.pane) run("pane.focus", { pane: f.pane });
  else if (f?.terminal) run("pane.focus", { terminal: f.terminal });
  run("terminal.paste");
}
