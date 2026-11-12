import { spaces, panes, focused, run } from "herdr";

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

export function location() {
  const space = spaces().find(s => s.active);
  const f = focused();
  if (f?.pane) {
    lastFocusedPaneId = f.pane;
  }
  const activeTab = space?.tabs?.find(t => t.active);
  const allPanes = panes();
  const pane =
    (f?.pane && allPanes.find(p => p.pane === f.pane)) ||
    (lastFocusedPaneId &&
      allPanes.find(
        p => p.pane === lastFocusedPaneId && (!activeTab || p.tab === activeTab.id),
      )) ||
    (activeTab && allPanes.find(p => p.tab === activeTab.id)) ||
    null;
  const on =
    f?.pane === null && f?.terminal
      ? f.terminal.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
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

export function formatRef(path, dir, startLine, endLine) {
  const clean = dir && !path.endsWith("/") ? `${path}/` : path;
  const quoted = /\s/.test(clean) ? `"${clean}"` : clean;
  if (!dir && startLine != null) {
    const a = Math.min(startLine, endLine ?? startLine);
    const b = Math.max(startLine, endLine ?? startLine);
    return a === b ? `@${quoted}#L${a}` : `@${quoted}#L${a}-L${b}`;
  }
  return `@${quoted}`;
}

export function pasteIntoTerminal(text, cx, target) {
  const f = target || focused();
  cx.write_to_clipboard(`${text} `);
  if (f?.pane) run("pane.focus", { pane: f.pane });
  else if (f?.terminal) run("pane.focus", { terminal: f.terminal });
  run("terminal.paste");
}
