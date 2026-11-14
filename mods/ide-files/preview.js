import { div, svg } from "gpui-kit";
import { v_flex, h_flex, EditorState, Input, TextView, HoverCard } from "gpui-base";
import { exec, readTextFile, writeTextFile, theme, settings, notify, window } from "herdr";
import { getFileIcon, ICON_PREFIX } from "./icons.js";
import {
  LANG,
  LINE_H,
  GIT_COLOR,
  isMarkdownFile,
  buildSearchRegExp,
  formatRef,
  pasteIntoTerminal,
} from "./utils.js";

const SYNTAX_KEYWORDS = new Set([
  "import", "export", "from", "default", "const", "let", "var", "function", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "class", "interface", "type", "enum", "struct", "impl", "trait", "fn", "pub", "use", "mod",
  "async", "await", "try", "catch", "finally", "throw", "new", "delete", "typeof", "instanceof",
  "in", "of", "void", "yield", "with", "as", "is", "keyof", "infer", "extends", "implements",
  "private", "protected", "public", "static", "readonly", "override", "abstract", "declare",
  "namespace", "module", "package", "func", "defer", "go", "select", "chan", "map", "range",
  "fallthrough", "def", "lambda", "pass", "raise", "elif", "except", "global", "nonlocal",
  "assert", "del", "and", "or", "not", "where", "match", "mut", "ref", "move", "loop", "unsafe",
  "extern", "crate", "super", "dyn", "then", "fi", "done", "esac", "local",
]);

const SYNTAX_CONSTANTS = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity",
  "None", "True", "False", "nil", "iota", "self", "this", "Self",
]);

const SYNTAX_TYPES = new Set([
  "string", "number", "boolean", "any", "unknown", "never", "object", "symbol", "bigint",
  "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64",
  "uintptr", "float32", "float64", "byte", "rune", "error", "bool", "str", "float", "list",
  "dict", "set", "tuple", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32",
  "u64", "u128", "usize", "f32", "f64", "char",
]);

const TOKEN_RE =
  /(\/\/.*$|#.*$|--.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b0x[0-9a-fA-F_]+\b|\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|@[A-Za-z_][A-Za-z0-9_]*|\b[A-Za-z_$][A-Za-z0-9_$]*\b)/g;

function tokenizeSyntaxLine(lineText, ext, t, enabled = true) {
  if (!lineText) return [{ start: 0, end: 0, color: t.foreground }];
  if (!enabled) return [{ start: 0, end: lineText.length, color: t.foreground }];
  const trimmed = lineText.trimStart();
  const isHashCommentLang =
    ext === "py" || ext === "sh" || ext === "bash" || ext === "zsh" ||
    ext === "yaml" || ext === "yml" || ext === "toml" || ext === "rb" ||
    ext === "conf" || ext === "ini" || ext === "gitignore" || ext === "dockerfile";
  if (
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("* ") ||
    trimmed === "*" ||
    trimmed.startsWith("*/") ||
    (isHashCommentLang && trimmed.startsWith("#"))
  ) {
    return [{ start: 0, end: lineText.length, color: t.dim }];
  }

  const spans = [];
  let lastIdx = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(lineText)) !== null) {
    const start = m.index;
    const tok = m[0];
    const end = start + tok.length;

    if (tok.startsWith("#") && !isHashCommentLang) {
      continue;
    }
    if (tok.startsWith("--") && ext !== "sql" && ext !== "lua") {
      continue;
    }

    if (start > lastIdx) {
      spans.push({ start: lastIdx, end: start, color: t.foreground });
    }

    let color = t.foreground;
    const ch0 = tok[0];
    if (
      tok.startsWith("//") ||
      tok.startsWith("/*") ||
      (ch0 === "#" && isHashCommentLang) ||
      tok.startsWith("--")
    ) {
      color = t.dim;
    } else if (ch0 === '"' || ch0 === "'" || ch0 === "`") {
      const after = lineText.slice(end).trimStart();
      if ((ext === "json" || ext === "jsonc") && after.startsWith(":")) {
        color = t.ansi4;
      } else {
        color = t.ansi2;
      }
    } else if (ch0 === "@") {
      color = t.ansi3;
    } else if (ch0 >= "0" && ch0 <= "9") {
      color = t.ansi1;
    } else if (SYNTAX_KEYWORDS.has(tok)) {
      color = t.ansi5;
    } else if (SYNTAX_CONSTANTS.has(tok)) {
      color = t.ansi6;
    } else if (SYNTAX_TYPES.has(tok)) {
      color = t.ansi3;
    } else if (/^[A-Z][A-Z0-9_]{2,}$/.test(tok)) {
      color = t.ansi6;
    } else if (/^[A-Z][A-Za-z0-9_]*$/.test(tok)) {
      color = t.ansi3;
    } else {
      const rest = lineText.slice(end);
      if (/^\s*\(/.test(rest)) {
        color = t.ansi4;
      }
    }

    spans.push({ start, end, color });
    lastIdx = end;
  }

  if (lastIdx < lineText.length) {
    spans.push({ start: lastIdx, end: lineText.length, color: t.foreground });
  }
  return spans;
}

function parseRemoteCommitBaseUrl(rawUrl) {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  let host = "";
  let repoPath = "";
  const sshMatch = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/i.exec(trimmed);
  if (sshMatch) {
    host = sshMatch[1];
    repoPath = sshMatch[2];
  } else {
    const httpMatch = /^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
    if (httpMatch) {
      host = httpMatch[1];
      repoPath = httpMatch[2];
    }
  }
  if (!host || !repoPath) return null;
  repoPath = repoPath.replace(/\/+$/, "");
  if (host.includes("gitlab")) {
    return `https://${host}/${repoPath}/-/commit`;
  }
  return `https://${host}/${repoPath}/commit`;
}

function parseDiffRows(lines) {
  let old = 0;
  let next = 0;
  return lines.map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line, targetLine: Math.max(1, next) };
    }
    const kind = line[0];
    if (kind === "-") {
      return {
        kind,
        number: old++,
        targetLine: Math.max(1, next),
        text: line.slice(1) || " ",
      };
    }
    if (kind === "+") {
      const ln = next++;
      return { kind, number: ln, targetLine: ln, text: line.slice(1) || " " };
    }
    if (kind === " ") {
      old++;
      const ln = next++;
      return { kind, number: ln, targetLine: ln, text: line.slice(1) || " " };
    }
    return { kind: "", text: line, targetLine: next > 0 ? next : null };
  });
}

function computeSimpleMemoryDiff(oldText, newText) {
  const oldLines = (oldText || "").replace(/\r\n/g, "\n").split("\n");
  const newLines = (newText || "").replace(/\r\n/g, "\n").split("\n");
  if (oldText === newText) return ["No uncommitted or unsaved changes"];
  const maxLen = Math.max(oldLines.length, newLines.length);
  const out = [`@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  for (let i = 0; i < Math.min(maxLen, 1200); i++) {
    const o = oldLines[i];
    const n = newLines[i];
    if (o === n) {
      if (o !== undefined) out.push(` ${o}`);
    } else {
      if (o !== undefined) out.push(`-${o}`);
      if (n !== undefined) out.push(`+${n}`);
    }
  }
  return out;
}

export const previewMethods = {
  openFileFind(cx, initialQuery) {
    if (!this.file) return;
    this.findOpen = true;
    this.rawEditor = false;
    this.mdPreview = false;
    this.diffView = false;
    if (typeof initialQuery === "string" && initialQuery.length > 0) {
      this.findQuery = initialQuery;
      this.findInput.set_value(initialQuery);
    }
    this.recomputeFileMatches(true);
    this.findInput.focus();
    cx.notify();
  },

  closeFileFind(cx) {
    this.findOpen = false;
    this.findFocused = false;
    this.handle.focus();
    cx.notify();
  },

  enterEditMode(lineNo, col, cx) {
    if (!this.file || this.fileTruncated || !this.lines.length) return;
    const ln = Math.max(1, Math.min(this.lines.length, lineNo || 1));
    const lineText = this.lines[ln - 1] ?? "";
    const targetCol = Math.max(0, Math.min(lineText.length, col ?? 0));
    this.rawEditor = true;
    this.mdPreview = false;
    this.findOpen = false;
    this.diffView = false;
    this.moreMenuOpen = false;
    this.contextMenu = null;
    this.selectingLines = false;
    this.selectingGutter = false;
    this.editCursorLine = ln;
    this.editCursorCol = targetCol;
    this.editLineTyped = false;
    this.selAnchor = { lineNo: ln, col: targetCol };
    this.selFocus = { lineNo: ln, col: targetCol };
    this.syncLineSelectionFromChar();
    try {
      this.editLineInput.set_value(lineText);
      const utf8BytePos = encodeURIComponent(lineText.slice(0, targetCol)).replace(
        /%[0-9A-F]{2}/g,
        "_",
      ).length;
      this.editLineInput.set_selected_range({ start: utf8BytePos, end: utf8BytePos });
      this.editLineInput.focus();
    } catch {}
    cx.notify();
  },

  exitEditMode(cx) {
    if (!this.rawEditor) return;
    this.rawEditor = false;
    this.editInputFocused = false;
    const ln = Math.max(1, Math.min(this.lines.length || 1, this.editCursorLine || 1));
    const col = Math.max(
      0,
      Math.min((this.lines[ln - 1] || "").length, this.editCursorCol || 0),
    );
    this.selAnchor = { lineNo: ln, col };
    this.selFocus = { lineNo: ln, col };
    this.syncLineSelectionFromChar();
    try {
      this.handle.focus();
    } catch {}
    cx.notify();
  },

  moveEditLine(delta, cx) {
    if (!this.rawEditor || !this.lines.length) return;
    const nextLn = Math.max(
      1,
      Math.min(this.lines.length, (this.editCursorLine || 1) + delta),
    );
    if (nextLn === this.editCursorLine) return;
    const nextText = this.lines[nextLn - 1] ?? "";
    const nextCol = Math.min(nextText.length, this.editCursorCol ?? 0);
    this.enterEditMode(nextLn, nextCol, cx);
    this.ensureEditLineVisible(nextLn);
    cx.notify();
  },

  ensureEditLineVisible(lineNo) {
    const viewH = Math.max(120, this.linesViewHeight || 500);
    const lineTop = (lineNo - 1) * LINE_H;
    const lineBottom = lineTop + LINE_H;
    if (lineTop < this.lineScroll) {
      this.lineScroll = Math.max(0, lineTop - LINE_H);
    } else if (lineBottom > this.lineScroll + viewH - LINE_H) {
      const maxScroll = Math.max(0, this.lines.length * LINE_H - viewH + 8);
      this.lineScroll = Math.min(maxScroll, lineBottom - viewH + LINE_H * 2);
    }
  },

  splitEditLineAtCursor(cx) {
    if (!this.rawEditor || !this.file || this.fileTruncated) return;
    const idx = Math.max(0, Math.min(this.lines.length - 1, (this.editCursorLine || 1) - 1));
    const curVal = this.editLineInput.value();
    const indentMatch = /^(\s*)/.exec(curVal);
    const indent = indentMatch ? indentMatch[1] : "";
    this.lines[idx] = curVal;
    this.lines.splice(idx + 1, 0, indent);
    this.syncRawTextFromLines(cx);
    this.enterEditMode(idx + 2, indent.length, cx);
    this.ensureEditLineVisible(idx + 2);
  },

  mergeEditLineWithPrev(cx) {
    if (!this.rawEditor || !this.file || this.fileTruncated) return;
    const idx = Math.max(0, Math.min(this.lines.length - 1, (this.editCursorLine || 1) - 1));
    if (idx <= 0) return;
    const prevLine = this.lines[idx - 1] ?? "";
    const curLine = this.lines[idx] ?? "";
    const joinCol = prevLine.length;
    this.lines[idx - 1] = prevLine + curLine;
    this.lines.splice(idx, 1);
    this.syncRawTextFromLines(cx);
    this.enterEditMode(idx, joinCol, cx);
    this.ensureEditLineVisible(idx);
  },

  syncRawTextFromLines(cx) {
    if (!this.file || this.fileTruncated) return;
    const nextVal = this.lines.join("\n");
    this.rawText = nextVal;
    try {
      this.code?.set_value(nextVal);
    } catch {}
    const isDirty = this.diskText !== null && nextVal !== this.diskText;
    this.fileDirty = isDirty;
    if (isDirty) {
      this.dirtyFiles.set(this.file, {
        rawText: nextVal,
        diskText: this.diskText,
      });
      if (this.autoSave) {
        this.scheduleSaveEditedFile(this.file, nextVal, cx);
      }
    } else {
      this.dirtyFiles.delete(this.file);
    }
    cx.notify();
  },

  formatCodeText(text) {
    if (!text) return text;
    return text
      .split("\n")
      .map(line => line.replace(/[ \t]+$/, ""))
      .join("\n");
  },

  async saveCurrentFile(cx, silent = false) {
    if (!this.file || !this.root || this.fileTruncated) return;
    const path = this.file;
    const root = this.root;
    let nextVal = this.rawText;
    if (this.formatOnSave) {
      const formatted = this.formatCodeText(nextVal);
      if (formatted !== nextVal) {
        nextVal = formatted;
        this.rawText = nextVal;
        this.lines = nextVal.split("\n");
        if (this.rawEditor) {
          const idx = Math.max(
            0,
            Math.min(this.lines.length - 1, (this.editCursorLine || 1) - 1),
          );
          try {
            this.editLineInput.set_value(this.lines[idx] ?? "");
          } catch {}
        }
        try {
          this.code?.set_value(nextVal);
        } catch {}
      }
    }

    try {
      await writeTextFile(`${root}/${path}`, nextVal, this.diskText);
      this.diskText = nextVal;
    } catch {
      try {
        const latest = await readTextFile(`${root}/${path}`, { on: this.on });
        await writeTextFile(`${root}/${path}`, nextVal, latest);
        this.diskText = nextVal;
      } catch (e) {
        if (!silent) {
          notify({
            title: "Save Failed",
            body: String(e?.message || e),
            timeout: 2200,
          });
        }
        return;
      }
    }

    this.fileDirty = false;
    this.dirtyFiles.delete(path);
    if (!silent) {
      notify({
        title: "Saved",
        body: path,
        timeout: 1400,
      });
    }
    if (this.gitBlame) {
      this.loadGitBlame(path, cx);
    }
    if (this.diffView) {
      this.loadFileDiff(path, cx);
    }
    this.refresh(cx);
    cx.notify();
  },

  discardCurrentChanges(cx) {
    if (!this.file || this.diskText == null) return;
    const path = this.file;
    const restored = this.diskText;
    this.saveSeq = (this.saveSeq || 0) + 1;
    this.rawText = restored;
    this.lines = restored.replace(/\r\n/g, "\n").split("\n");
    this.fileDirty = false;
    this.dirtyFiles.delete(path);
    try {
      this.code?.set_value(restored);
    } catch {}
    if (this.rawEditor) {
      const ln = Math.max(1, Math.min(this.lines.length || 1, this.editCursorLine || 1));
      const lineText = this.lines[ln - 1] ?? "";
      this.editCursorLine = ln;
      this.editCursorCol = Math.min(lineText.length, this.editCursorCol || 0);
      try {
        this.editLineInput.set_value(lineText);
      } catch {}
    }
    if (this.findOpen && this.findQuery) {
      this.recomputeFileMatches(false);
    }
    if (this.diffView) {
      this.loadFileDiff(path, cx);
    }
    notify({
      title: "Changes Discarded",
      body: `Reverted unsaved edits in ${path}`,
      timeout: 1500,
    });
    cx.notify();
  },

  revealInFinder(path, cx) {
    if (!path || !this.root) return;
    const fullPath = `${this.root}/${path}`;
    const on = this.on;
    cx.spawn(async () => {
      try {
        const plat = window()?.platform;
        if (!on && plat === "windows") {
          await exec("explorer", ["/select,", fullPath.replace(/\//g, "\\")], { on });
        } else if (!on && plat === "linux") {
          const dir = fullPath.slice(0, Math.max(0, fullPath.lastIndexOf("/")));
          await exec("xdg-open", [dir || fullPath], { on });
        } else {
          await exec("open", ["-R", fullPath], { on });
        }
      } catch {}
    });
  },

  loadGitBlame(path, cx) {
    if (!path || !this.root) return;
    const root = this.root;
    const on = this.on;
    const slash = path.lastIndexOf("/");
    const fileDir = slash >= 0 ? `${root}/${path.slice(0, slash)}` : root;
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    this.blameLoading = true;
    cx.spawn(async cx => {
      try {
        const [r, remoteRes] = await Promise.all([
          exec(
            "git",
            [
              "--no-optional-locks",
              "blame",
              "--line-porcelain",
              "--",
              fileName,
            ],
            { cwd: fileDir, on },
          ).catch(() => null),
          exec(
            "git",
            ["--no-optional-locks", "config", "--get", "remote.origin.url"],
            { cwd: fileDir, on },
          ).catch(() => null),
        ]);
        if (this.file !== path) return;
        const commitBaseUrl =
          remoteRes?.code === 0 ? parseRemoteCommitBaseUrl(remoteRes.stdout) : null;
        const rawByLine = new Map();
        if (r && r.code === 0 && r.stdout) {
          let curLine = null;
          let curAuthor = "";
          let curMail = "";
          let curTime = 0;
          let curSummary = "";
          let curHash = "";
          let curFullHash = "";
          for (const raw of r.stdout.split("\n")) {
            const hdr = /^([0-9a-f]{7,40})\s+\d+\s+(\d+)/.exec(raw);
            if (hdr) {
              curFullHash = hdr[1];
              curHash = hdr[1].slice(0, 8);
              curLine = Number(hdr[2]);
              curAuthor = "";
              curMail = "";
              curTime = 0;
              curSummary = "";
              continue;
            }
            if (raw.startsWith("author ")) {
              curAuthor = raw.slice(7).trim();
            } else if (raw.startsWith("author-mail ")) {
              curMail = raw.slice(12).trim().replace(/^<|>$/g, "");
            } else if (raw.startsWith("author-time ")) {
              curTime = Number(raw.slice(12).trim()) || 0;
            } else if (raw.startsWith("summary ")) {
              curSummary = raw.slice(8).trim();
            } else if (raw.startsWith("\t") && curLine != null) {
              let dateStr = "";
              let timeStr = "";
              if (curTime > 0) {
                const d = new Date(curTime * 1000);
                const yyyy = d.getFullYear();
                const mm = String(d.getMonth() + 1).padStart(2, "0");
                const dd = String(d.getDate()).padStart(2, "0");
                const hh = String(d.getHours()).padStart(2, "0");
                const min = String(d.getMinutes()).padStart(2, "0");
                dateStr = `${yyyy}-${mm}-${dd}`;
                timeStr = `${yyyy}-${mm}-${dd} ${hh}:${min}`;
              }
              const uncommitted = /^0+$/.test(curHash);
              const shortLabel = uncommitted
                ? "Uncommitted"
                : `${curAuthor || "unknown"}${dateStr ? ` ${dateStr}` : ""}`;
              rawByLine.set(curLine, {
                hash: uncommitted ? "uncommitted" : curHash,
                fullHash: uncommitted ? "00000000" : curFullHash,
                commitUrl:
                  !uncommitted && commitBaseUrl && curFullHash
                    ? `${commitBaseUrl}/${curFullHash}`
                    : null,
                uncommitted,
                author: curAuthor || "unknown",
                mail: curMail,
                dateStr,
                timeStr,
                summary: curSummary || (uncommitted ? "Not Committed Yet" : ""),
                shortLabel,
              });
              curLine = null;
            }
          }
        }
        // Aggregate contiguous lines with the same commit hash into blocks
        // with alternating grayscale shades, showing annotation only on the first line of each block.
        const map = new Map();
        const maxLn = Math.max(this.lines.length, rawByLine.size);
        let prevHash = null;
        let blockIdx = -1;
        for (let ln = 1; ln <= maxLn; ln++) {
          const entry = rawByLine.get(ln);
          if (!entry) continue;
          const isFirst = entry.hash !== prevHash;
          if (isFirst) {
            blockIdx++;
            prevHash = entry.hash;
          }
          map.set(ln, {
            ...entry,
            isFirst,
            shade: blockIdx % 2,
          });
        }
        this.blameByLine = map;
      } finally {
        if (this.file === path) this.blameLoading = false;
        cx.notify();
      }
    });
  },

  loadCommitDiff(hash, shortHash, path, cx) {
    if (!hash || !this.root) return;
    const root = this.root;
    const on = this.on;
    const slash = path ? path.lastIndexOf("/") : -1;
    const fileDir = slash >= 0 ? `${root}/${path.slice(0, slash)}` : root;
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    this.diffView = true;
    this.rawEditor = false;
    this.mdPreview = false;
    this.diffLoading = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const r = await exec(
          "git",
          [
            "--no-optional-locks",
            "show",
            "--no-ext-diff",
            "--no-color",
            "--format=format:",
            hash,
            "--",
            fileName,
          ],
          { cwd: fileDir, on },
        ).catch(() => null);
        if (this.file !== path) return;
        if (r && r.code === 0 && r.stdout.trim()) {
          const all = r.stdout.replace(/\n$/, "").split("\n");
          const first = all.findIndex(l => l.startsWith("@@"));
          const body = first >= 0 ? all.slice(first) : all;
          this.diffRows = parseDiffRows([
            `@@ Commit ${shortHash || hash.slice(0, 8)} @@`,
            ...body.slice(0, 1500),
          ]);
        } else {
          this.diffRows = parseDiffRows([`No diff found for commit ${shortHash || hash}`]);
        }
      } finally {
        if (this.file === path) this.diffLoading = false;
        cx.notify();
      }
    });
  },

  loadFileDiff(path, cx) {
    if (!path || !this.root) return;
    const root = this.root;
    const on = this.on;
    const slash = path.lastIndexOf("/");
    const fileDir = slash >= 0 ? `${root}/${path.slice(0, slash)}` : root;
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    this.diffLoading = true;
    cx.spawn(async cx => {
      try {
        if (this.fileDirty && this.diskText != null) {
          const memLines = computeSimpleMemoryDiff(this.diskText, this.rawText);
          this.diffRows = parseDiffRows(memLines);
          return;
        }
        const r = await exec(
          "git",
          [
            "--no-optional-locks",
            "diff",
            "HEAD",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--",
            fileName,
          ],
          { cwd: fileDir, on },
        ).catch(() => null);
        if (this.file !== path) return;
        if (r && r.code === 0 && r.stdout.trim()) {
          const all = r.stdout.replace(/\n$/, "").split("\n");
          const first = all.findIndex(l => l.startsWith("@@"));
          const body = first >= 0 ? all.slice(first) : all;
          this.diffRows = parseDiffRows(body.slice(0, 1500));
        } else {
          this.diffRows = parseDiffRows(["No uncommitted or unsaved changes"]);
        }
      } finally {
        if (this.file === path) this.diffLoading = false;
        cx.notify();
      }
    });
  },

  scrollToLine(lineNo) {
    if (!this.lines.length) return;
    const totalH = this.lines.length * LINE_H;
    const viewH = this.linesViewHeight || 480;
    const maxScroll = Math.max(0, totalH - viewH);
    const targetTop = (lineNo - 1) * LINE_H - Math.floor(viewH / 2) + LINE_H;
    this.lineScroll = Math.max(0, Math.min(maxScroll, targetTop));
  },

  recomputeFileMatches(jumpToNearest = false, preferredLineNo = null) {
    this.findMatches = [];
    this.findMatchesByLine = new Map();
    this.findRegexError = null;
    if (!this.findOpen || !this.findQuery || !this.lines.length) {
      this.findActiveIdx = 0;
      return;
    }
    const { re, error } = buildSearchRegExp(this.findQuery, {
      caseSensitive: this.findCase,
      wholeWord: this.findWord,
      regex: this.findRegex,
    });
    if (error || !re) {
      this.findRegexError = error;
      this.findActiveIdx = 0;
      return;
    }

    for (let i = 0; i < this.lines.length; i++) {
      const lineText = this.lines[i];
      if (!lineText) continue;
      re.lastIndex = 0;
      let m;
      let safety = 0;
      while ((m = re.exec(lineText)) !== null && safety++ < 200) {
        if (m[0].length === 0) {
          re.lastIndex++;
          continue;
        }
        const start = m.index;
        const end = start + m[0].length;
        const lineNo = i + 1;
        const globalIdx = this.findMatches.length;
        const item = { lineNo, start, end, text: m[0], globalIdx };
        this.findMatches.push(item);
        let arr = this.findMatchesByLine.get(lineNo);
        if (!arr) {
          arr = [];
          this.findMatchesByLine.set(lineNo, arr);
        }
        arr.push(item);
      }
    }

    if (!this.findMatches.length) {
      this.findActiveIdx = 0;
      return;
    }

    if (preferredLineNo != null) {
      const idx = this.findMatches.findIndex(m => m.lineNo >= preferredLineNo);
      this.findActiveIdx = idx >= 0 ? idx : 0;
    } else if (jumpToNearest) {
      const curTopLine = Math.floor(this.lineScroll / LINE_H) + 1;
      const idx = this.findMatches.findIndex(m => m.lineNo >= curTopLine);
      this.findActiveIdx = idx >= 0 ? idx : 0;
    } else {
      this.findActiveIdx = Math.min(this.findActiveIdx, this.findMatches.length - 1);
    }

    const active = this.findMatches[this.findActiveIdx];
    if (active) {
      this.selStart = active.lineNo;
      this.selEnd = active.lineNo;
      this.selAnchor = { lineNo: active.lineNo, col: active.start };
      this.selFocus = { lineNo: active.lineNo, col: active.end };
      this.scrollToLine(active.lineNo);
    }
  },

  stepFileMatch(delta, cx) {
    if (!this.findMatches.length) return;
    const n = this.findMatches.length;
    this.findActiveIdx = (this.findActiveIdx + delta + n) % n;
    const active = this.findMatches[this.findActiveIdx];
    if (active) {
      this.selStart = active.lineNo;
      this.selEnd = active.lineNo;
      this.selAnchor = { lineNo: active.lineNo, col: active.start };
      this.selFocus = { lineNo: active.lineNo, col: active.end };
      this.scrollToLine(active.lineNo);
    }
    cx.notify();
  },

  addRecentFile(path) {
    if (!path) return;
    this.recents = [path, ...(this.recents || []).filter(p => p !== path)].slice(0, 20);
    this.persistFolders();
  },

  revealFileInTree(path, cx) {
    if (!path || !path.includes("/")) return;
    const parts = path.split("/");
    parts.pop();
    let cur = "";
    const toLoad = [];
    for (const seg of parts) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!this.folders.has(cur)) {
        this.folders.add(cur);
        if (!this.entries.has(cur) && !this.pending.has(cur)) {
          toLoad.push(cur);
        }
      }
    }
    if (toLoad.length && cx && this.context) {
      const context = this.context;
      for (const folderPath of toLoad) {
        this.pending.add(folderPath);
      }
      cx.spawn(async cx => {
        try {
          for (const folderPath of toLoad) {
            if (!this.current(context)) return;
            await this.loadFolder(folderPath, context);
          }
        } catch {} finally {
          if (this.context === context) {
            for (const folderPath of toLoad) this.pending.delete(folderPath);
          }
          cx.notify();
        }
      });
    }
    this.persistFolders();
  },

  navigateBack(cx) {
    if (this.historyIdx > 0) {
      this.historyIdx--;
      const target = this.history[this.historyIdx] ?? null;
      this.show(target, cx, { fromHistory: true });
    } else if (this.file) {
      this.history = [null, ...this.history];
      this.historyIdx = 0;
      this.show(null, cx, { fromHistory: true });
    }
    cx.notify();
  },

  navigateForward(cx) {
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      const target = this.history[this.historyIdx] ?? null;
      this.show(target, cx, { fromHistory: true });
      cx.notify();
    }
  },

  ensureWorkspaceIndex(cx) {
    if (!this.root || this.wsIndexLoading || this.wsIndexRoot === this.root) return;
    const root = this.root;
    const on = this.on;
    this.wsIndexLoading = true;
    cx.spawn(async cx => {
      try {
        const script = `
export PATH="$PATH:$HOME/.pi/agent/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
if command -v rg >/dev/null 2>&1; then
  rg --files --hidden --follow --no-messages -g '!.git' -g '!node_modules' -g '!.worktree' . | head -n 4000
  exit 0
fi
find . \\( -name .git -o -name node_modules -o -name .worktree \\) -prune -o -type f -print | head -n 4000
`;
        const r = await exec("sh", ["-c", script], { cwd: root, on }).catch(() => null);
        if (this.root !== root) return;
        const files = [];
        const foldersSet = new Set();
        for (const raw of (r?.stdout || "").split("\n")) {
          const clean = raw.trim().replace(/^\.\/+/, "").replace(/^\/+/, "");
          if (!clean) continue;
          const slash = clean.lastIndexOf("/");
          const name = slash >= 0 ? clean.slice(slash + 1) : clean;
          const dir = slash >= 0 ? clean.slice(0, slash) : "";
          files.push({ path: clean, name, dir, isDir: false });
          if (dir) {
            const segs = dir.split("/");
            let acc = "";
            for (const s of segs) {
              acc = acc ? `${acc}/${s}` : s;
              foldersSet.add(acc);
            }
          }
        }
        const folders = [...foldersSet].map(p => {
          const slash = p.lastIndexOf("/");
          return {
            path: p,
            name: slash >= 0 ? p.slice(slash + 1) : p,
            dir: slash >= 0 ? p.slice(0, slash) : "",
            isDir: true,
          };
        });
        this.wsIndex = [...files, ...folders];
        this.wsIndexRoot = root;
      } finally {
        if (this.root === root) this.wsIndexLoading = false;
        cx.notify();
      }
    });
  },

  filteredQuickEntries() {
    const q = (this.quickQuery || "").trim().toLowerCase();
    if (!q) return [];
    const tokens = q.split(/\s+/).filter(Boolean);
    const pool = this.wsIndex?.length
      ? this.wsIndex
      : [...(this.entries.get("") || [])].map(e => ({
          path: e.name,
          name: e.name,
          dir: "",
          isDir: e.dir,
        }));
    const scored = [];
    for (const item of pool) {
      const pathLower = item.path.toLowerCase();
      const nameLower = item.name.toLowerCase();
      if (!tokens.every(t => pathLower.includes(t))) continue;
      let score = 0;
      if (nameLower === q) score += 100;
      else if (nameLower.startsWith(q)) score += 60;
      else if (nameLower.includes(q)) score += 30;
      if (!item.isDir) score += 5;
      score -= Math.min(20, item.path.length * 0.15);
      scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.path.localeCompare(b.item.path));
    return scored.slice(0, 50).map(s => s.item);
  },

  show(path, cx, jumpOpts = null) {
    if (this.file && this.file !== path && this.fileDirty && this.diskText != null) {
      this.dirtyFiles.set(this.file, {
        rawText: this.rawText,
        diskText: this.diskText,
      });
    }

    if (!jumpOpts?.fromHistory) {
      const curHist = this.history[this.historyIdx] ?? null;
      if (curHist !== (path ?? null)) {
        this.history = this.history.slice(0, this.historyIdx + 1);
        this.history.push(path ?? null);
        this.historyIdx = this.history.length - 1;
      }
    }

    try {
      this.code?.release();
    } catch {}
    this.code = null;
    this.file = path;
    this.rawText = "";
    this.fileError = null;
    this.fileDirty = false;
    this.rawEditor = false;
    this.moreMenuOpen = false;
    this.lines = [];
    this.lineScroll = 0;
    this.selStart = null;
    this.selEnd = null;
    this.selAnchor = null;
    this.selFocus = null;
    this.selectingLines = false;
    this.drag = null;
    this.contextMenu = null;
    this.findMatches = [];
    this.findMatchesByLine = new Map();
    this.blameByLine = new Map();
    this.diffRows = [];
    if (!path) {
      this.findOpen = false;
      this.diffView = false;
      this.persistFolders();
      return;
    }

    this.addRecentFile(path);
    this.revealFileInTree(path, cx);

    if (isMarkdownFile(path) && !jumpOpts?.query && jumpOpts?.lineNo == null) {
      this.mdPreview = true;
    } else {
      this.mdPreview = false;
    }

    if (!cx) return;

    try {
      this.handle.focus();
    } catch {}
    if (jumpOpts?.query) {
      this.rawEditor = false;
      this.mdPreview = false;
      this.findQuery = jumpOpts.query;
      try {
        this.findInput.set_value(jumpOpts.query);
      } catch {}
      if (typeof jumpOpts.caseSensitive === "boolean") this.findCase = jumpOpts.caseSensitive;
      if (typeof jumpOpts.wholeWord === "boolean") this.findWord = jumpOpts.wholeWord;
      if (typeof jumpOpts.regex === "boolean") this.findRegex = jumpOpts.regex;
    }

    const root =
      this.root ||
      (this.selectedFeature && this.baseRoot
        ? `${this.baseRoot}/${this.selectedFeature}`
        : this.baseRoot);
    const on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path) return;
        if (text === null) {
          this.fileError = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.fileError = "Binary file · no text preview";
          return;
        }
        const truncated = text.length > 400000;
        const savedDirty = !truncated ? this.dirtyFiles?.get(path) : null;
        const clipped = savedDirty
          ? savedDirty.rawText
          : truncated
            ? text.slice(0, 400000) + "\n… (file truncated)"
            : text;
        this.rawText = clipped;
        this.diskText = truncated ? null : text;
        this.fileTruncated = truncated;
        this.fileDirty = Boolean(savedDirty && savedDirty.rawText !== text);
        this.lines = clipped.replace(/\r\n/g, "\n").split("\n");
        const t = theme();
        const ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.fileExt = (ext || "txt").toLowerCase();
        try {
          this.code = EditorState.new({
            language: LANG[this.fileExt] ?? this.fileExt,
            readonly: truncated,
            value: clipped,
            line_numbers: this.showLineNumbers !== false,
            soft_wrap: Boolean(this.wordWrap),
            font_family: settings().font_family,
            font_size: 12,
            syntax: {
              keyword: t.ansi5,
              string: t.ansi2,
              comment: t.dim,
              function: t.ansi4,
              type: t.ansi3,
              number: t.ansi1,
              constant: t.ansi6,
            },
          });
          this.code.on("change", (_e, cx) => {
            if (!this.code || this.file !== path || this.fileTruncated) return;
            const nextVal = this.code.value();
            if (nextVal === this.rawText) return;
            this.rawText = nextVal;
            this.lines = nextVal.replace(/\r\n/g, "\n").split("\n");
            const isDirty = this.diskText !== null && nextVal !== this.diskText;
            this.fileDirty = isDirty;
            if (isDirty) {
              this.dirtyFiles.set(path, {
                rawText: nextVal,
                diskText: this.diskText,
              });
              if (this.autoSave) {
                this.scheduleSaveEditedFile(path, nextVal, cx);
              }
            } else {
              this.dirtyFiles.delete(path);
            }
            cx.notify();
          });
        } catch {}
        if ((this.findOpen || jumpOpts?.query) && this.findQuery) {
          const prevOpen = this.findOpen;
          this.findOpen = true;
          this.recomputeFileMatches(false, jumpOpts?.lineNo ?? null);
          this.findOpen = prevOpen;
        }
        if (jumpOpts?.lineNo != null) {
          this.rawEditor = false;
          this.mdPreview = false;
          const ln = Math.max(1, Math.min(this.lines.length || 1, jumpOpts.lineNo));
          const lineLen = (this.lines[ln - 1] || "").length;
          this.selStart = ln;
          this.selEnd = ln;
          this.selAnchor = { lineNo: ln, col: 0 };
          this.selFocus = { lineNo: ln, col: lineLen };
          this.pendingScrollLine = ln;
          this.scrollToLine(ln);
        }
        if (this.gitBlame) {
          this.loadGitBlame(path, cx);
        }
        if (this.diffView) {
          this.loadFileDiff(path, cx);
        }
      } catch {
        if (this.file === path) {
          this.fileError = "Cannot preview this file (binary, too large, or unreadable)";
        }
      } finally {
        cx.notify();
      }
    });
  },

  scheduleSaveEditedFile(path, nextVal, cx) {
    this.saveSeq = (this.saveSeq || 0) + 1;
    const seq = this.saveSeq;
    cx.spawn(async cx => {
      await cx.sleep(350);
      if (this.saveSeq !== seq || this.file !== path || !this.root) return;
      await this.saveCurrentFile(cx, true);
    });
  },

  normalizedCharSelection() {
    if (!this.selAnchor || !this.selFocus) return null;
    const a = this.selAnchor;
    const b = this.selFocus;
    if (a.lineNo === b.lineNo && a.col === b.col) {
      return { start: a, end: b, empty: true };
    }
    if (a.lineNo < b.lineNo || (a.lineNo === b.lineNo && a.col < b.col)) {
      return { start: a, end: b, empty: false };
    }
    return { start: b, end: a, empty: false };
  },

  syncLineSelectionFromChar() {
    const norm = this.normalizedCharSelection();
    if (!norm || norm.empty) {
      this.selStart = null;
      this.selEnd = null;
      return;
    }
    this.selStart = norm.start.lineNo;
    this.selEnd = norm.end.lineNo;
  },

  selectedRange() {
    const norm = this.normalizedCharSelection();
    if (norm && !norm.empty) {
      return [norm.start.lineNo, norm.end.lineNo];
    }
    if (this.selStart == null) return null;
    const a = Math.min(this.selStart, this.selEnd ?? this.selStart);
    const b = Math.max(this.selStart, this.selEnd ?? this.selStart);
    return [a, b];
  },

  getSelectedText() {
    const norm = this.normalizedCharSelection();
    if (!norm || norm.empty) return "";
    const { start, end } = norm;
    if (start.lineNo === end.lineNo) {
      return (this.lines[start.lineNo - 1] || "").slice(start.col, end.col);
    }
    const out = [];
    out.push((this.lines[start.lineNo - 1] || "").slice(start.col));
    for (let ln = start.lineNo + 1; ln < end.lineNo; ln++) {
      out.push(this.lines[ln - 1] || "");
    }
    out.push((this.lines[end.lineNo - 1] || "").slice(0, end.col));
    return out.join("\n");
  },

  colFromLocalX(lineText, localX) {
    if (!lineText) return 0;
    const gutterOffset = this.showLineNumbers === false ? 8 : 54;
    const textX = Math.max(0, (localX ?? gutterOffset) - gutterOffset);
    let acc = 0;
    for (let i = 0; i < lineText.length; i++) {
      const code = lineText.charCodeAt(i);
      const w =
        code === 9
          ? 7.22 * 4
          : code >= 0x2e80 && code <= 0x9fff
            ? 14.44
            : 7.22;
      if (textX < acc + w / 2) {
        return i;
      }
      acc += w;
    }
    return lineText.length;
  },

  wordBoundsAt(lineText, col) {
    if (!lineText) return [0, 0];
    const idx = Math.max(0, Math.min(col, lineText.length - 1));
    const isWord = ch => /[A-Za-z0-9_$\u4e00-\u9fa5]/.test(ch);
    if (!isWord(lineText[idx])) {
      return [idx, Math.min(lineText.length, idx + 1)];
    }
    let s = idx;
    let e = idx + 1;
    while (s > 0 && isWord(lineText[s - 1])) s--;
    while (e < lineText.length && isWord(lineText[e])) e++;
    return [s, e];
  },

  buildLineMenuItems(lineNo) {
    const norm = this.normalizedCharSelection();
    const hasCharSel = Boolean(norm && !norm.empty);
    const [a, b] =
      hasCharSel && lineNo >= norm.start.lineNo && lineNo <= norm.end.lineNo
        ? [norm.start.lineNo, norm.end.lineNo]
        : [lineNo, lineNo];
    if (!hasCharSel || lineNo < norm.start.lineNo || lineNo > norm.end.lineNo) {
      const len = (this.lines[lineNo - 1] || "").length;
      this.selAnchor = { lineNo, col: 0 };
      this.selFocus = { lineNo, col: len };
      this.syncLineSelectionFromChar();
    }
    const lineRef = formatRef(this.file, false, a, b);
    const fileRef = formatRef(this.file, false);
    const snippet = this.getSelectedText() || (this.lines[lineNo - 1] ?? "");
    return [
      { label: "Find in File (⌘F)", action: "find", value: "" },
      { label: `Add to Chat (${lineRef})`, action: "chat", value: lineRef, divider: true },
      { label: `Add Whole File (${fileRef})`, action: "chat", value: fileRef },
      { label: `Copy ${lineRef}`, action: "copy", value: lineRef, divider: true },
      { label: "Copy Selected Text", action: "copy", value: snippet },
    ];
  },

  renderFileFindBar(t) {
    if (!this.findOpen) return null;
    const total = this.findMatches.length;
    const cur = total > 0 ? this.findActiveIdx + 1 : 0;
    const noResults = Boolean(this.findQuery) && total === 0 && !this.findRegexError;

    return h_flex()
      .id("file-find-bar")
      .h(34)
      .flex_none()
      .px(8)
      .gap(6)
      .items_center()
      .bg(t.popover)
      .border_b(1)
      .border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(
        h_flex()
          .id("file-find-box")
          .flex_1()
          .min_w(0)
          .h(25)
          .px(6)
          .gap(4)
          .items_center()
          .rounded(4)
          .bg(t.background)
          .border_1()
          .border_color(
            this.findRegexError || noResults
              ? "#e06c75"
              : this.findFocused
                ? t.accent
                : t.border,
          )
          .child(
            svg(`${ICON_PREFIX}/codicon-search.svg`).size(12).flex_none().text_color(t.dim),
          )
          .child(Input.new(this.findInput).flex_1().h_full().text_size(12).text_color(t.foreground))
          .child(
            this.renderOptionToggle(
              t,
              "find-opt-case",
              "Aa",
              this.findCase,
              "Match Case",
              (_e, cx) => {
                this.findCase = !this.findCase;
                this.recomputeFileMatches(true);
                cx.notify();
              },
            ),
          )
          .child(
            this.renderOptionToggle(
              t,
              "find-opt-word",
              "[ ]",
              this.findWord,
              "Match Whole Word",
              (_e, cx) => {
                this.findWord = !this.findWord;
                this.recomputeFileMatches(true);
                cx.notify();
              },
            ),
          )
          .child(
            this.renderOptionToggle(
              t,
              "find-opt-regex",
              ".*",
              this.findRegex,
              "Use Regular Expression",
              (_e, cx) => {
                this.findRegex = !this.findRegex;
                this.recomputeFileMatches(true);
                cx.notify();
              },
            ),
          ),
      )
      .child(
        div()
          .flex_none()
          .min_w(54)
          .text_size(11)
          .text_color(this.findRegexError || noResults ? "#e06c75" : t.dim)
          .child(
            this.findRegexError
              ? "Invalid"
              : !this.findQuery
                ? "No results"
                : total === 0
                  ? "No results"
                  : `${cur} of ${total}`,
          ),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(2)
          .items_center()
          .child(
            this.headerIconButton(
              t,
              "find-prev-btn",
              "arrow-up",
              "Previous Match (⇧↵)",
              (_e, cx) => {
                this.stepFileMatch(-1, cx);
              },
            ),
          )
          .child(
            this.headerIconButton(
              t,
              "find-next-btn",
              "arrow-down",
              "Next Match (↵)",
              (_e, cx) => {
                this.stepFileMatch(1, cx);
              },
            ),
          )
          .child(
            this.headerIconButton(t, "find-close-btn", "close", "Close (Esc)", (_e, cx) => {
              this.closeFileFind(cx);
            }),
          ),
      );
  },

  renderLineContentWithMatches(lineText, lineMatches, selCols, highlightBreak, t) {
    if (!lineText) {
      return h_flex()
        .flex_1()
        .min_w(0)
        .items_center()
        .child(
          div()
            .flex_none()
            .when(Boolean(highlightBreak), el => el.bg("#3568a888"))
            .child(" "),
        );
    }
    const ext = this.fileExt || "txt";
    const syntaxSpans = tokenizeSyntaxLine(lineText, ext, t, this.lspEnabled !== false);
    const selStart = selCols ? selCols[0] : -1;
    const selEnd = selCols ? selCols[1] : -1;
    const hasSel = selStart >= 0 && selEnd > selStart;

    if ((!lineMatches || !lineMatches.length) && !hasSel && !highlightBreak) {
      return h_flex()
        .flex_1()
        .min_w(0)
        .overflow_hidden()
        .items_center()
        .children(
          syntaxSpans.map(sp =>
            div()
              .flex_none()
              .text_color(sp.color)
              .child(lineText.slice(sp.start, sp.end)),
          ),
        );
    }

    const activeOnLine =
      lineMatches && lineMatches.length
        ? lineMatches.find(m => m.globalIdx === this.findActiveIdx) || lineMatches[0]
        : null;
    let offset = 0;
    const segments = [];
    if (activeOnLine && activeOnLine.start > 36) {
      const firstStart = lineMatches[0].start;
      offset = Math.max(0, Math.min(firstStart, activeOnLine.start - 18));
      if (offset > 0) {
        segments.push(div().flex_none().text_color(t.dim).child("…"));
      }
    }

    const pushSyntaxAndSelSlice = (from, to) => {
      if (from >= to) return;
      for (const sp of syntaxSpans) {
        if (sp.end <= from || sp.start >= to) continue;
        const s = Math.max(from, sp.start);
        const e = Math.min(to, sp.end);
        if (s >= e) continue;
        if (!hasSel || e <= selStart || s >= selEnd) {
          segments.push(
            div().flex_none().text_color(sp.color).child(lineText.slice(s, e)),
          );
          continue;
        }
        if (s < selStart) {
          segments.push(
            div().flex_none().text_color(sp.color).child(lineText.slice(s, selStart)),
          );
        }
        const hs = Math.max(s, selStart);
        const he = Math.min(e, selEnd);
        if (hs < he) {
          segments.push(
            div()
              .flex_none()
              .bg("#3568a899")
              .text_color(sp.color)
              .child(lineText.slice(hs, he)),
          );
        }
        if (e > selEnd) {
          segments.push(
            div().flex_none().text_color(sp.color).child(lineText.slice(selEnd, e)),
          );
        }
      }
    };

    let cursor = offset;
    for (const m of lineMatches || []) {
      if (m.end <= offset) continue;
      const s = Math.max(offset, m.start);
      if (s > cursor) {
        pushSyntaxAndSelSlice(cursor, s);
      }
      const isCurrent = m.globalIdx === this.findActiveIdx;
      segments.push(
        div()
          .flex_none()
          .rounded(2)
          .bg(isCurrent ? "#e2b06199" : "#e2b06140")
          .when(isCurrent, el => el.border_1().border_color("#e2b061"))
          .text_color(isCurrent ? "#ffffff" : t.foreground)
          .child(lineText.slice(s, m.end)),
      );
      cursor = m.end;
    }
    if (cursor < lineText.length) {
      pushSyntaxAndSelSlice(cursor, lineText.length);
    }
    if (highlightBreak) {
      segments.push(div().flex_none().bg("#3568a888").child(" "));
    }

    return h_flex().flex_1().min_w(0).overflow_hidden().items_center().children(segments);
  },

  renderBlameBlock(blockId, topPx, heightPx, blameInfo, isDark, t) {
    const shadeBg = blameInfo
      ? blameInfo.shade === 0
        ? isDark
          ? "#ffffff12"
          : "#0000000d"
        : isDark
          ? "#ffffff05"
          : "#00000004"
      : null;
    const barColor = blameInfo
      ? blameInfo.shade === 0
        ? isDark
          ? "#ffffff42"
          : "#00000038"
        : isDark
          ? "#ffffff1c"
          : "#00000018"
      : null;

    const showLabel = Boolean(blameInfo && blameInfo.showHeader);
    const isBlockStart = Boolean(blameInfo && blameInfo.isFirst && blameInfo.startLineNo > 1);
    const blockBox = h_flex()
      .w(148)
      .h_full()
      .pr(8)
      .items_start()
      .when(Boolean(shadeBg), el => el.bg(shadeBg))
      .when(isBlockStart, el =>
        el.border_t(1).border_color(isDark ? "#ffffff1a" : "#00000016"),
      )
      .border_r(1)
      .border_color(isDark ? "#ffffff12" : "#00000010")
      .child(
        div()
          .w(3)
          .h_full()
          .mr(6)
          .flex_none()
          .when(Boolean(barColor), el => el.bg(barColor)),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .h(LINE_H)
          .items_center()
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.dim)
              .child(showLabel ? blameInfo.shortLabel : ""),
          ),
      );

    const inner = blameInfo
      ? HoverCard.new(`blame-hc-${blockId}`)
          .open_delay(180)
          .close_delay(140)
          .anchor("top_left")
          .trigger(blockBox)
          .content(
            v_flex()
              .w(280)
              .p(10)
              .gap(4)
              .rounded(8)
              .bg(t.popover)
              .border_1()
              .border_color(t.border)
              .shadow_md()
              .text_size(11.5)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .justify_between()
                  .child(
                    div()
                      .font_semibold()
                      .text_color(t.foreground)
                      .truncate()
                      .child(
                        blameInfo.uncommitted
                          ? "Uncommitted Changes"
                          : `${blameInfo.author}${blameInfo.mail ? ` <${blameInfo.mail}>` : ""}`,
                      ),
                  ),
              )
              .when(Boolean(blameInfo.timeStr || !blameInfo.uncommitted), el =>
                el.child(
                  h_flex()
                    .gap(6)
                    .items_center()
                    .text_size(11)
                    .text_color(t.dim)
                    .child(
                      div()
                        .id(`blame-hash-link-${blockId}`)
                        .px(3)
                        .py(0.5)
                        .rounded(3)
                        .cursor_pointer()
                        .text_color(t.accent)
                        .border_b(1)
                        .border_color(t.accent)
                        .hover(s => s.bg(t.hover))
                        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                        .on_click((e, cx) => {
                          cx.stop_propagation();
                          if (blameInfo.uncommitted) return;
                          cx.write_to_clipboard(blameInfo.fullHash || blameInfo.hash);
                          if (blameInfo.commitUrl && !e.modifiers?.alt) {
                            try {
                              cx.open_url(blameInfo.commitUrl);
                            } catch {}
                            notify({
                              title: "Opened Commit & Copied Hash",
                              body: `${blameInfo.hash} → ${blameInfo.commitUrl}`,
                              timeout: 1600,
                            });
                          } else {
                            this.loadCommitDiff(
                              blameInfo.fullHash || blameInfo.hash,
                              blameInfo.hash,
                              this.file,
                              cx,
                            );
                            notify({
                              title: "Showing Commit Diff",
                              body: `Commit ${blameInfo.hash} (hash copied)`,
                              timeout: 1500,
                            });
                          }
                        })
                        .child(blameInfo.hash),
                    )
                    .when(Boolean(blameInfo.timeStr), row =>
                      row.child(div().child(`· ${blameInfo.timeStr}`)),
                    ),
                ),
              )
              .when(Boolean(blameInfo.summary), el =>
                el
                  .child(div().my(2).h(1).bg(t.border))
                  .child(
                    div()
                      .text_size(11.5)
                      .text_color(t.muted)
                      .child(blameInfo.summary),
                  ),
              ),
          )
      : blockBox;

    return div()
      .id(`blame-block-wrap-${blockId}`)
      .absolute()
      .left(0)
      .w(148)
      .top(topPx)
      .h(heightPx)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(inner);
  },

  renderInlineDiffView(t) {
    const rows = this.diffRows || [];
    const totalRows = rows.length;
    const font = settings().font_family ?? "JetBrains Mono";
    const viewH = Math.max(120, this.linesViewHeight || 500);
    const maxScroll = Math.max(0, totalRows * LINE_H - viewH + 8);
    this.lineScroll = Math.max(0, Math.min(this.lineScroll || 0, maxScroll));

    const startIdx = Math.max(0, Math.floor(this.lineScroll / LINE_H) - 3);
    const endIdx = Math.min(
      totalRows,
      Math.ceil((this.lineScroll + viewH) / LINE_H) + 3,
    );

    const visibleRows = [];
    for (let idx = startIdx; idx < endIdx; idx++) {
      const row = rows[idx];
      if (!row) continue;
      const topPx = idx * LINE_H - this.lineScroll + 4;
      const { kind, number, targetLine, text } = row;
      if (kind === "@") {
        visibleRows.push(
          h_flex()
            .id(`file-diff-row-${idx}`)
            .absolute()
            .left(0)
            .right(10)
            .top(topPx)
            .h(LINE_H)
            .px(12)
            .items_center()
            .bg(t.raised)
            .text_color(t.dim)
            .child(div().w_full().truncate().child(text)),
        );
      } else {
        visibleRows.push(
          h_flex()
            .id(`file-diff-row-${idx}`)
            .absolute()
            .left(0)
            .right(10)
            .top(topPx)
            .h(LINE_H)
            .pr(8)
            .gap(6)
            .items_center()
            .cursor_pointer()
            .when(kind === "+", e => e.bg(t.ansi2 + "18"))
            .when(kind === "-", e => e.bg(t.ansi1 + "18"))
            .hover(s =>
              s.bg(
                kind === "+"
                  ? t.ansi2 + "2c"
                  : kind === "-"
                    ? t.ansi1 + "2c"
                    : t.hover,
              ),
            )
            .on_mouse_down("left", (e, cx) => {
              if (e.click_count >= 2 && targetLine) {
                cx.stop_propagation();
                this.diffView = false;
                this.enterEditMode(targetLine, 0, cx);
                this.scrollToLine(targetLine);
              }
            })
            .when(this.showLineNumbers !== false, rEl =>
              rEl.child(
                div()
                  .w(36)
                  .flex_none()
                  .text_right()
                  .text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim)
                  .child(number === undefined ? "" : String(number)),
              ),
            )
            .child(
              div()
                .w(12)
                .flex_none()
                .text_center()
                .text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim)
                .child(kind === "+" || kind === "-" ? kind : " "),
            )
            .child(div().flex_1().min_w(0).truncate().child(text)),
        );
      }
    }

    return div()
      .id("files-diff-scroll")
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .font_family(font)
      .text_size(12)
      .on_size_change((size, cx) => {
        if (size.height > 0 && Math.abs((this.linesViewHeight || 0) - size.height) > 1) {
          this.linesViewHeight = size.height;
          cx.notify();
        }
      })
      .on_scroll_wheel((e, cx) => {
        if (maxScroll <= 0) return;
        this.lineScroll = Math.max(0, Math.min(maxScroll, this.lineScroll - e.delta.y));
        cx.notify();
      })
      .children(visibleRows);
  },

  renderLinesView(t) {
    const normSel = this.normalizedCharSelection();
    const totalLines = this.lines.length;
    const font = settings().font_family ?? "JetBrains Mono";
    const viewH = Math.max(120, this.linesViewHeight || 500);
    const panelW = Math.max(260, (this.panelSize?.width || 680) - (this.rightSidebarCollapsed ? 0 : 260));
    const gutterW = (this.gitBlame ? 148 : 0) + (this.showLineNumbers === false ? 8 : 54);
    const charsPerRow = this.wordWrap
      ? Math.max(24, Math.floor((panelW - gutterW - 28) / 7.22))
      : 0;

    // Build visual rows (supporting optional soft wordWrap)
    let visualRows = null;
    let totalVisualRows = totalLines;
    if (this.wordWrap && !this.rawEditor && charsPerRow > 0) {
      visualRows = [];
      for (let i = 0; i < totalLines; i++) {
        const full = this.lines[i] ?? "";
        if (full.length <= charsPerRow) {
          visualRows.push({ lineNo: i + 1, subIdx: 0, text: full, colOffset: 0, fullText: full });
        } else {
          let pos = 0;
          let sub = 0;
          while (pos < full.length) {
            const slice = full.slice(pos, pos + charsPerRow);
            visualRows.push({
              lineNo: i + 1,
              subIdx: sub++,
              text: slice,
              colOffset: pos,
              fullText: full,
            });
            pos += charsPerRow;
          }
        }
      }
      totalVisualRows = visualRows.length;
    }

    const totalH = Math.max(viewH, totalVisualRows * LINE_H + 8);
    const maxScroll = Math.max(0, totalVisualRows * LINE_H - viewH + 8);
    this.lineScroll = Math.max(0, Math.min(this.lineScroll, maxScroll));

    const startIdx = Math.max(0, Math.floor(this.lineScroll / LINE_H) - 3);
    const endIdx = Math.min(
      totalVisualRows,
      Math.ceil((this.lineScroll + viewH) / LINE_H) + 3,
    );

    const isDark = settings().dark !== false;
    const blameW = this.gitBlame ? 148 : 0;
    const visibleBlameBlocks = [];
    if (this.gitBlame) {
      let idx = startIdx;
      while (idx < endIdx) {
        const vRow = visualRows ? visualRows[idx] : null;
        const lineNo = vRow ? vRow.lineNo : idx + 1;
        const subIdx = vRow ? vRow.subIdx : 0;
        const blameInfo = this.blameByLine?.get(lineNo) || null;
        const curHash = blameInfo?.hash ?? null;
        let runEnd = idx + 1;
        while (runEnd < endIdx) {
          const nextVRow = visualRows ? visualRows[runEnd] : null;
          const nextLineNo = nextVRow ? nextVRow.lineNo : runEnd + 1;
          const nextBlame = this.blameByLine?.get(nextLineNo) || null;
          if ((nextBlame?.hash ?? null) !== curHash) break;
          runEnd++;
        }
        const topPx = idx * LINE_H - this.lineScroll + 4;
        const heightPx = (runEnd - idx) * LINE_H;
        const blockMeta = blameInfo
          ? {
              ...blameInfo,
              startLineNo: lineNo,
              showHeader: Boolean(blameInfo.isFirst && subIdx === 0),
            }
          : null;
        visibleBlameBlocks.push(
          this.renderBlameBlock(
            `${lineNo}-${subIdx}`,
            topPx,
            heightPx,
            blockMeta,
            isDark,
            t,
          ),
        );
        idx = runEnd;
      }
    }

    const visibleRows = [];
    for (let idx = startIdx; idx < endIdx; idx++) {
      const vRow = visualRows ? visualRows[idx] : null;
      const lineNo = vRow ? vRow.lineNo : idx + 1;
      const subIdx = vRow ? vRow.subIdx : 0;
      const colOffset = vRow ? vRow.colOffset : 0;
      const lineText = vRow ? vRow.text : (this.lines[idx] ?? "");
      const fullLineText = vRow ? vRow.fullText : lineText;
      const isEditingLine = Boolean(
        this.rawEditor && !this.findOpen && this.editCursorLine === lineNo && subIdx === 0,
      );

      const hasLineSel = Boolean(
        !this.rawEditor &&
          normSel &&
          !normSel.empty &&
          lineNo >= normSel.start.lineNo &&
          lineNo <= normSel.end.lineNo,
      );
      let selCols = null;
      let highlightBreak = false;
      if (hasLineSel) {
        const scFull = lineNo === normSel.start.lineNo ? normSel.start.col : 0;
        const ecFull = lineNo === normSel.end.lineNo ? normSel.end.col : fullLineText.length;
        const sc = Math.max(0, scFull - colOffset);
        const ec = Math.min(lineText.length, ecFull - colOffset);
        if (sc < ec) selCols = [sc, ec];
        if (lineNo < normSel.end.lineNo && colOffset + lineText.length >= fullLineText.length) {
          highlightBreak = true;
        }
      }
      const lineMatches = subIdx === 0 ? this.findMatchesByLine.get(lineNo) : null;
      const hasActiveMatch = Boolean(lineMatches?.some(m => m.globalIdx === this.findActiveIdx));

      visibleRows.push(
        h_flex()
          .id(`line-${lineNo}-${subIdx}`)
          .absolute()
          .left(blameW)
          .right(10)
          .top(idx * LINE_H - this.lineScroll + 4)
          .h(LINE_H)
          .px(8)
          .gap(this.showLineNumbers === false ? 0 : 10)
          .items_center()
          .cursor_text()
          .when(isEditingLine, el => el.bg(t.selected))
          .when(!isEditingLine && hasActiveMatch, el => el.bg("#e2b06122"))
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.contextMenu = null;
            this.moreMenuOpen = false;
            const localX = e.local_position?.x ?? (this.showLineNumbers === false ? 8 : 54);
            const inGutter = this.showLineNumbers !== false && localX < 49;
            const colInSlice = inGutter ? 0 : this.colFromLocalX(lineText, localX);
            const col = Math.min(fullLineText.length, colOffset + colInSlice);

            if (this.rawEditor) {
              if (!isEditingLine || !inGutter) {
                this.enterEditMode(lineNo, col, cx);
              }
              return;
            }

            const now = Date.now();
            const isDouble =
              !inGutter &&
              (e.click_count === 2 ||
                (this.lastContentClick &&
                  this.lastContentClick.lineNo === lineNo &&
                  Math.abs(this.lastContentClick.col - col) <= 2 &&
                  now - this.lastContentClick.ts < 360));
            this.lastContentClick = { lineNo, col, ts: isDouble ? 0 : now };

            if (isDouble && !this.fileTruncated) {
              this.enterEditMode(lineNo, col, cx);
              return;
            }

            this.handle.focus();
            if (e.click_count >= 3 || inGutter) {
              this.selAnchor = { lineNo, col: 0 };
              this.selFocus = { lineNo, col: fullLineText.length };
              this.selectingLines = inGutter;
              this.selectingGutter = inGutter;
              this.syncLineSelectionFromChar();
            } else if (e.modifiers?.shift && this.selAnchor) {
              this.selFocus = { lineNo, col };
              this.selectingLines = true;
              this.selectingGutter = false;
              this.syncLineSelectionFromChar();
            } else {
              this.selAnchor = { lineNo, col };
              this.selFocus = { lineNo, col };
              this.selectingLines = true;
              this.selectingGutter = false;
              this.syncLineSelectionFromChar();
            }
            cx.notify();
          })
          .on_mouse_move((e, cx) => {
            if (!this.selectingLines || this.rawEditor) return;
            const localX = e.local_position?.x ?? (this.showLineNumbers === false ? 8 : 54);
            if (this.selectingGutter) {
              const anchorLine = this.selAnchor?.lineNo ?? lineNo;
              if (lineNo >= anchorLine) {
                this.selAnchor = { lineNo: anchorLine, col: 0 };
                this.selFocus = { lineNo, col: fullLineText.length };
              } else {
                const anchorLen = (this.lines[anchorLine - 1] || "").length;
                this.selAnchor = { lineNo: anchorLine, col: anchorLen };
                this.selFocus = { lineNo, col: 0 };
              }
              this.syncLineSelectionFromChar();
              cx.notify();
              return;
            }
            const col = Math.min(
              fullLineText.length,
              colOffset + this.colFromLocalX(lineText, localX),
            );
            if (this.selFocus?.lineNo !== lineNo || this.selFocus?.col !== col) {
              this.selFocus = { lineNo, col };
              this.syncLineSelectionFromChar();
              cx.notify();
            }
          })
          .on_mouse_up("left", (e, cx) => {
            cx.stop_propagation();
            this.selectingLines = false;
            this.selectingGutter = false;
            cx.notify();
          })
          .on_mouse_down("right", () => {
            this.pendingMenu = this.buildLineMenuItems(lineNo);
          })
          .when(this.showLineNumbers !== false, rowEl =>
            rowEl.child(
              div()
                .w(36)
                .flex_none()
                .text_right()
                .cursor_pointer()
                .text_color(
                  isEditingLine
                    ? t.accent
                    : hasActiveMatch
                      ? "#e2b061"
                      : hasLineSel
                        ? t.accent
                        : t.dim,
                )
                .child(subIdx === 0 ? String(lineNo) : "·"),
            ),
          )
          .child(
            isEditingLine
              ? h_flex()
                  .id(`edit-line-box-${lineNo}`)
                  .flex_1()
                  .min_w(0)
                  .h_full()
                  .items_center()
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(
                    Input.new(this.editLineInput)
                      .flex_1()
                      .h_full()
                      .font_family(font)
                      .text_size(12)
                      .text_color(t.foreground),
                  )
              : this.renderLineContentWithMatches(
                  lineText,
                  lineMatches,
                  selCols,
                  highlightBreak,
                  t,
                ),
          ),
      );
    }

    const thumbH =
      totalVisualRows * LINE_H > viewH
        ? Math.max(24, Math.round((viewH / totalH) * viewH))
        : 0;
    const thumbTop =
      maxScroll > 0 && thumbH > 0
        ? Math.round((this.lineScroll / maxScroll) * (viewH - thumbH))
        : 0;

    const matchTickBuckets = new Set();
    const rulerTicks = [];
    if (totalLines > 0 && this.findMatches.length > 0) {
      for (const m of this.findMatches) {
        const y = Math.min(
          viewH - 3,
          Math.max(2, Math.round(((m.lineNo - 1) / totalLines) * viewH)),
        );
        const bucket = Math.floor(y / 3);
        const isCurrent = m.globalIdx === this.findActiveIdx;
        if (!isCurrent && matchTickBuckets.has(bucket)) continue;
        matchTickBuckets.add(bucket);
        rulerTicks.push(
          div()
            .absolute()
            .left(1)
            .right(1)
            .top(y)
            .h(isCurrent ? 3 : 2)
            .rounded(1)
            .bg(isCurrent ? "#e2b061" : "#e2b06188"),
        );
      }
    }

    return div()
      .id("files-lines-scroll")
      .relative()
      .flex_1()
      .min_h(0)
      .overflow_hidden()
      .font_family(font)
      .text_size(12)
      .on_size_change((size, cx) => {
        if (size.height > 0 && Math.abs((this.linesViewHeight || 0) - size.height) > 1) {
          this.linesViewHeight = size.height;
          if (this.pendingScrollLine != null) {
            this.scrollToLine(this.pendingScrollLine);
            this.pendingScrollLine = null;
          }
          cx.notify();
        }
      })
      .on_scroll_wheel((e, cx) => {
        if (maxScroll <= 0) return;
        this.pendingScrollLine = null;
        this.lineScroll = Math.max(0, Math.min(maxScroll, this.lineScroll - e.delta.y));
        cx.notify();
      })
      .on_mouse_up("left", (_e, cx) => {
        if (this.selectingLines || this.drag || this.scrollbarDrag) {
          this.selectingLines = false;
          this.drag = null;
          this.scrollbarDrag = false;
          cx.notify();
        }
      })
      .children(visibleBlameBlocks)
      .children(visibleRows)
      .child(
        div()
          .id("files-lines-scrollbar")
          .absolute()
          .top_0()
          .bottom_0()
          .right_0()
          .w(10)
          .cursor_pointer()
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            if (maxScroll <= 0) return;
            this.scrollbarDrag = true;
            const y = e.local_position?.y ?? 0;
            const ratio = Math.max(0, Math.min(1, (y - thumbH / 2) / Math.max(1, viewH - thumbH)));
            this.lineScroll = Math.round(ratio * maxScroll);
            cx.notify();
          })
          .on_mouse_move((e, cx) => {
            if (!this.scrollbarDrag || maxScroll <= 0) return;
            const y = e.local_position?.y ?? 0;
            const ratio = Math.max(0, Math.min(1, (y - thumbH / 2) / Math.max(1, viewH - thumbH)));
            this.lineScroll = Math.round(ratio * maxScroll);
            cx.notify();
          })
          .on_mouse_up("left", (e, cx) => {
            cx.stop_propagation();
            this.scrollbarDrag = false;
            cx.notify();
          })
          .children(rulerTicks)
          .when(thumbH > 0, trk =>
            trk.child(
              div()
                .absolute()
                .left(2)
                .right(2)
                .top(thumbTop)
                .h(thumbH)
                .rounded(3)
                .bg(t.muted)
                .opacity(0.42),
            ),
          ),
      );
  },

  renderQuickItemRow(item, idx, t) {
    const absPath = `${this.root}/${item.path}`;
    const fileMark = !item.isDir ? this.marks[absPath] : null;
    const icon = !item.isDir ? getFileIcon(item.name) : null;
    const ref = formatRef(item.path, item.isDir);

    return h_flex()
      .id(`quick-item-${idx}-${item.path}`)
      .h(28)
      .flex_none()
      .px(8)
      .gap(8)
      .rounded(6)
      .items_center()
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.contextMenu = null;
        const target = this.rememberTarget();
        this.drag = {
          kind: "entry",
          path: item.path,
          dir: item.isDir,
          ref,
          startX: e.position.x,
          startY: e.position.y,
          moved: false,
          sent: false,
          target,
        };
      })
      .on_mouse_up("left", (e, cx) => {
        cx.stop_propagation();
        const d = this.drag;
        this.drag = null;
        if (!d || d.sent) {
          cx.notify();
          return;
        }
        const dist = Math.hypot(e.position.x - d.startX, e.position.y - d.startY);
        if (d.moved && dist > 16) {
          pasteIntoTerminal(d.ref, cx, d.target);
        } else if (item.isDir) {
          this.rightSidebarCollapsed = false;
          this.searchMode = false;
          if (!this.folders.has(item.path)) {
            this.revealFileInTree(`${item.path}/_`, cx);
          } else {
            this.toggle(item.path, cx);
          }
        } else {
          this.show(item.path, cx);
        }
        cx.notify();
      })
      .on_mouse_down("right", () => {
        this.pendingMenu = this.buildEntryMenuItems(item.path, item.isDir);
      })
      .child(
        h_flex()
          .w(18)
          .flex_none()
          .items_center()
          .justify_center()
          .child(
            item.isDir
              ? svg("mods/ide-files/folder.svg").size(14).text_color(t.muted)
              : fileMark
                ? div()
                    .text_size(11)
                    .font_semibold()
                    .text_color(GIT_COLOR[fileMark] ?? t.muted)
                    .child(fileMark)
                : svg(icon.svg).size(15).text_color(icon.color),
          ),
      )
      .child(
        div()
          .flex_none()
          .max_w(240)
          .truncate()
          .text_size(13)
          .text_color(t.foreground)
          .child(item.name),
      )
      .when(Boolean(item.dir), el =>
        el.child(
          div()
            .flex_1()
            .min_w(0)
            .truncate()
            .text_size(12)
            .text_color(t.dim)
            .child(item.dir),
        ),
      );
  },

  renderQuickOpenHome(t, cx) {
    this.ensureWorkspaceIndex(cx);
    const hasQuery = Boolean((this.quickQuery || "").trim());
    const matches = hasQuery ? this.filteredQuickEntries() : [];

    // Build Recents list when query is empty
    const recentItems = [];
    if (!hasQuery) {
      const seen = new Set();
      for (const rel of this.recents || []) {
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        const slash = rel.lastIndexOf("/");
        recentItems.push({
          path: rel,
          name: slash >= 0 ? rel.slice(slash + 1) : rel,
          dir: slash >= 0 ? rel.slice(0, slash) : "",
          isDir: false,
        });
      }
      // If recents is empty, populate with modified git files or root files
      if (!recentItems.length && this.root) {
        const prefix = `${this.root}/`;
        for (const abs of Object.keys(this.marks || {}).slice(0, 8)) {
          if (!abs.startsWith(prefix)) continue;
          const rel = abs.slice(prefix.length);
          if (!rel || seen.has(rel)) continue;
          seen.add(rel);
          const slash = rel.lastIndexOf("/");
          recentItems.push({
            path: rel,
            name: slash >= 0 ? rel.slice(slash + 1) : rel,
            dir: slash >= 0 ? rel.slice(0, slash) : "",
            isDir: false,
          });
        }
      }
      if (!recentItems.length) {
        for (const e of (this.entries.get("") || []).filter(x => !x.dir).slice(0, 8)) {
          recentItems.push({ path: e.name, name: e.name, dir: "", isDir: false });
        }
      }
    }

    return v_flex()
      .id("files-quick-home")
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .px(28)
      .pt(36)
      .pb(16)
      .gap(16)
      .child(
        h_flex()
          .id("files-quick-input-box")
          .w_full()
          .max_w(460)
          .h(32)
          .px(12)
          .gap(8)
          .items_center()
          .rounded(16)
          .bg(t.raised)
          .border_1()
          .border_color(this.quickFocused ? t.accent : t.border)
          .cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            svg(`${ICON_PREFIX}/codicon-search.svg`)
              .size(13.5)
              .flex_none()
              .text_color(this.quickFocused || hasQuery ? t.accent : t.dim),
          )
          .child(
            Input.new(this.quickInput)
              .flex_1()
              .h_full()
              .text_size(13)
              .text_color(t.foreground),
          )
          .when(hasQuery, box =>
            box.child(
              div()
                .id("files-quick-clear")
                .size(18)
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .rounded(9)
                .cursor_pointer()
                .text_color(t.muted)
                .hover(s => s.bg(t.hover).text_color(t.foreground))
                .on_click((e, cx) => {
                  cx.stop_propagation();
                  this.quickQuery = "";
                  this.quickInput.set_value("");
                  cx.notify();
                })
                .child(svg(`${ICON_PREFIX}/codicon-close.svg`).size(11.5)),
            ),
          ),
      )
      .child(
        v_flex()
          .id("files-quick-list")
          .flex_1()
          .min_h(0)
          .w_full()
          .max_w(460)
          .overflow_y_scrollbar()
          .gap(2)
          .child(
            div()
              .px(8)
              .pb(6)
              .text_size(12)
              .text_color(t.dim)
              .child(hasQuery ? `Results (${matches.length})` : "Recents"),
          )
          .children(
            (hasQuery ? matches : recentItems).map((item, i) =>
              this.renderQuickItemRow(item, i, t),
            ),
          )
          .when(hasQuery && !matches.length, el =>
            el.child(
              div()
                .px(8)
                .py(12)
                .text_size(12.5)
                .text_color(t.dim)
                .child(
                  this.wsIndexLoading
                    ? "Indexing workspace files…"
                    : `No files or folders matching "${this.quickQuery}"`,
                ),
            ),
          )
          .when(!hasQuery && !recentItems.length, el =>
            el.child(
              div()
                .px(8)
                .py(12)
                .text_size(12.5)
                .text_color(t.dim)
                .child("Select a file from the tree on the right or search above."),
            ),
          ),
      );
  },

  renderBreadcrumbs(t) {
    if (!this.file) return div().flex_1();
    const parts = this.file.split("/");
    const fileName = parts.pop() || this.file;
    const crumbs = [];
    let acc = "";
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      acc = acc ? `${acc}/${seg}` : seg;
      const folderPath = acc;
      crumbs.push(
        div()
          .id(`crumb-${folderPath}`)
          .flex_none()
          .cursor_pointer()
          .text_size(12.5)
          .text_color(t.muted)
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.rightSidebarCollapsed = false;
            this.searchMode = false;
            if (!this.folders.has(folderPath)) {
              this.toggle(folderPath, cx);
            }
            cx.notify();
          })
          .child(seg),
      );
      crumbs.push(
        svg(`${ICON_PREFIX}/codicon-chevron-right.svg`)
          .size(11)
          .flex_none()
          .mx(2)
          .text_color(t.dim),
      );
    }
    crumbs.push(
      h_flex()
        .flex_1()
        .min_w(0)
        .items_center()
        .child(
          div()
            .min_w(0)
            .truncate()
            .text_size(12.5)
            .text_color(t.foreground)
            .child(fileName),
        )
        .when(this.fileDirty, el =>
          el.child(
            div()
              .id("files-dirty-indicator")
              .flex_none()
              .ml(1.5)
              .mt(-4)
              .text_size(12)
              .font_bold()
              .text_color("#e2b061")
              .tooltip("Unsaved changes (⌘S to save)")
              .child("*"),
          ),
        ),
    );
    return h_flex().flex_1().min_w(0).items_center().overflow_hidden().children(crumbs);
  },

  renderMoreMenuActionRow(t, id, label, shortcut, enabled, onClick) {
    return h_flex()
      .id(id)
      .h(28)
      .mx(5)
      .px(9)
      .rounded(6)
      .items_center()
      .justify_between()
      .when(enabled, el =>
        el
          .cursor_pointer()
          .text_color(t.foreground)
          .hover(s => s.bg(t.hover)),
      )
      .when(!enabled, el => el.text_color(t.dim).opacity(0.5))
      .on_click((e, cx) => {
        cx.stop_propagation();
        if (!enabled) return;
        this.moreMenuOpen = false;
        onClick(e, cx);
      })
      .child(div().text_size(12.5).child(label))
      .when(Boolean(shortcut), el =>
        el.child(div().text_size(11.5).text_color(t.dim).child(shortcut)),
      );
  },

  renderMoreMenuToggleRow(t, id, label, checked, onToggle) {
    return h_flex()
      .id(id)
      .h(28)
      .mx(5)
      .px(9)
      .rounded(6)
      .items_center()
      .justify_between()
      .cursor_pointer()
      .text_color(t.foreground)
      .hover(s => s.bg(t.hover))
      .on_click((e, cx) => {
        cx.stop_propagation();
        onToggle(e, cx);
      })
      .child(div().text_size(12.5).child(label))
      .child(
        div()
          .w(30)
          .h(17)
          .p(2)
          .rounded(9)
          .flex_none()
          .flex()
          .items_center()
          .when(checked, el => el.bg("#3ea868").justify_end())
          .when(!checked, el => el.bg(t.raised).border_1().border_color(t.border))
          .child(div().size(13).rounded(7).bg("#ffffff")),
      );
  },

  renderMoreMenuOverlay(t) {
    if (!this.moreMenuOpen || !this.file) return null;
    const rightOffset = !this.rightSidebarCollapsed ? 268 : 8;

    return div()
      .id("files-more-menu-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.moreMenuOpen = false;
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.moreMenuOpen = false;
        cx.notify();
      })
      .child(
        v_flex()
          .id("files-more-menu-popup")
          .absolute()
          .top(38)
          .right(rightOffset)
          .w(218)
          .py(6)
          .gap(1)
          .rounded(10)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_md()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .child(
            this.renderMoreMenuActionRow(
              t,
              "more-save-file",
              "Save File",
              "⌘S",
              Boolean(this.file && !this.fileTruncated),
              (_e, cx) => this.saveCurrentFile(cx),
            ),
          )
          .child(
            this.renderMoreMenuActionRow(
              t,
              "more-discard-changes",
              "Discard Changes",
              "",
              Boolean(this.fileDirty),
              (_e, cx) => this.discardCurrentChanges(cx),
            ),
          )
          .child(div().mx(10).my(4).h(1).bg(t.border))
          .child(
            this.renderMoreMenuActionRow(
              t,
              "more-reveal-finder",
              "Reveal in Finder",
              "",
              Boolean(this.file),
              (_e, cx) => this.revealInFinder(this.file, cx),
            ),
          )
          .child(
            this.renderMoreMenuActionRow(
              t,
              "more-copy-rel-path",
              "Copy Relative Path",
              "",
              Boolean(this.file),
              (_e, cx) => {
                cx.write_to_clipboard(this.file);
                notify({ title: "Copied", body: this.file, timeout: 1400 });
                cx.notify();
              },
            ),
          )
          .child(div().mx(10).my(4).h(1).bg(t.border))
          .child(
            this.renderMoreMenuToggleRow(
              t,
              "more-toggle-diff",
              "Diff View",
              Boolean(this.diffView),
              (_e, cx) => {
                this.diffView = !this.diffView;
                if (this.diffView) {
                  this.rawEditor = false;
                  this.mdPreview = false;
                  this.loadFileDiff(this.file, cx);
                }
                cx.notify();
              },
            ),
          )
          .child(div().mx(10).my(4).h(1).bg(t.border))
          .child(
            this.renderMoreMenuToggleRow(
              t,
              "more-toggle-lsp",
              "LSP",
              this.lspEnabled !== false,
              (_e, cx) => {
                this.lspEnabled = this.lspEnabled === false;
                this.persistPrefs?.();
                cx.notify();
              },
            ),
          )
          .child(div().mx(10).my(4).h(1).bg(t.border))
          .child(
            this.renderMoreMenuToggleRow(
              t,
              "more-toggle-line-numbers",
              "Line Numbers",
              this.showLineNumbers !== false,
              (_e, cx) => {
                this.showLineNumbers = this.showLineNumbers === false;
                this.persistPrefs?.();
                cx.notify();
              },
            ),
          )
          .child(
            this.renderMoreMenuToggleRow(
              t,
              "more-toggle-word-wrap",
              "Word Wrap",
              Boolean(this.wordWrap),
              (_e, cx) => {
                this.wordWrap = !this.wordWrap;
                this.persistPrefs?.();
                cx.notify();
              },
            ),
          )
          .child(
            this.renderMoreMenuToggleRow(
              t,
              "more-toggle-git-blame",
              "Git Blame",
              Boolean(this.gitBlame),
              (_e, cx) => {
                this.gitBlame = !this.gitBlame;
                this.persistPrefs?.();
                if (this.gitBlame && this.file) {
                  this.loadGitBlame(this.file, cx);
                }
                cx.notify();
              },
            ),
          )
          .child(
            this.renderMoreMenuToggleRow(
              t,
              "more-toggle-auto-save",
              "Auto Save",
              Boolean(this.autoSave),
              (_e, cx) => {
                this.autoSave = !this.autoSave;
                this.persistPrefs?.();
                if (this.autoSave && this.fileDirty && this.file) {
                  this.saveCurrentFile(cx, true);
                }
                cx.notify();
              },
            ),
          )
          .child(
            this.renderMoreMenuToggleRow(
              t,
              "more-toggle-format-on-save",
              "Format on Save",
              Boolean(this.formatOnSave),
              (_e, cx) => {
                this.formatOnSave = !this.formatOnSave;
                this.persistPrefs?.();
                cx.notify();
              },
            ),
          ),
      );
  },

  renderUnifiedTopBar(t, range, activeRef) {
    const canBack = this.historyIdx > 0 || Boolean(this.file);
    const canForward = this.historyIdx < this.history.length - 1;
    const isMd = isMarkdownFile(this.file);

    return h_flex()
      .id("files-unified-topbar")
      .h(36)
      .flex_none()
      .px(8)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .flex_none()
          .gap(2)
          .items_center()
          .child(
            div()
              .id("files-nav-back")
              .size(22)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(4)
              .when(canBack, el =>
                el
                  .cursor_pointer()
                  .text_color(t.muted)
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.navigateBack(cx)),
              )
              .when(!canBack, el => el.text_color(t.dim).opacity(0.45))
              .tooltip("Back")
              .child(svg(`${ICON_PREFIX}/codicon-arrow-left.svg`).size(13.5)),
          )
          .child(
            div()
              .id("files-nav-forward")
              .size(22)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(4)
              .when(canForward, el =>
                el
                  .cursor_pointer()
                  .text_color(t.muted)
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.navigateForward(cx)),
              )
              .when(!canForward, el => el.text_color(t.dim).opacity(0.45))
              .tooltip("Forward")
              .child(svg(`${ICON_PREFIX}/codicon-arrow-right.svg`).size(13.5)),
          ),
      )
      .child(this.renderBreadcrumbs(t))
      .when(Boolean(this.file), hdr =>
        hdr.child(
          h_flex()
            .flex_none()
            .gap(4)
            .items_center()
            .when(isMd, row =>
              row
                .child(
                  div()
                    .id("files-md-preview-btn")
                    .px(8)
                    .h(22)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(this.mdPreview, el =>
                      el.bg(t.raised).border_1().border_color(t.border).text_color(t.foreground),
                    )
                    .when(!this.mdPreview, el =>
                      el.text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)),
                    )
                    .text_size(11.5)
                    .on_click((_e, cx) => {
                      this.mdPreview = true;
                      this.rawEditor = false;
                      this.findOpen = false;
                      cx.notify();
                    })
                    .child("Preview"),
                )
                .child(
                  div()
                    .id("files-md-source-btn")
                    .px(8)
                    .h(22)
                    .flex()
                    .items_center()
                    .rounded(5)
                    .cursor_pointer()
                    .when(!this.mdPreview, el =>
                      el.bg(t.raised).border_1().border_color(t.border).text_color(t.foreground),
                    )
                    .when(this.mdPreview, el =>
                      el.text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)),
                    )
                    .text_size(11.5)
                    .on_click((_e, cx) => {
                      this.mdPreview = false;
                      cx.notify();
                    })
                    .child("Source"),
                ),
            )
            .child(
              this.headerIconButton(
                t,
                "files-more-menu-btn",
                "ellipsis",
                "Editor Actions & Settings (...)",
                (_e, cx) => {
                  this.moreMenuOpen = !this.moreMenuOpen;
                  this.contextMenu = null;
                  cx.notify();
                },
                this.moreMenuOpen,
              ),
            )
            .when(!isMd || !this.mdPreview, row =>
              row.child(
                this.headerIconButton(
                  t,
                  "files-mode-toggle",
                  this.rawEditor ? "edit" : "eye",
                  this.rawEditor
                    ? "编辑模式 (Esc 或点击返回只读模式)"
                    : "只读模式 (双击内容或点击进入编辑模式)",
                  (_e, cx) => {
                    if (this.rawEditor) {
                      this.exitEditMode(cx);
                    } else {
                      const startLn = this.selAnchor?.lineNo || 1;
                      const startCol = this.selAnchor?.col || 0;
                      this.enterEditMode(startLn, startCol, cx);
                    }
                  },
                  this.rawEditor,
                ),
              ),
            ),
        ),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(2)
          .items_center()
          .child(
            this.headerIconButton(
              t,
              "files-search-toggle",
              "search",
              "Search in Files (⌘⇧F)",
              (_e, cx) => {
                if (this.rightSidebarCollapsed) {
                  this.rightSidebarCollapsed = false;
                  this.openWorkspaceSearch(cx);
                } else if (this.searchMode) {
                  this.closeWorkspaceSearch(cx);
                } else {
                  this.openWorkspaceSearch(cx);
                }
              },
              !this.rightSidebarCollapsed && this.searchMode,
            ),
          )
          .child(
            this.headerIconButton(
              t,
              "files-sidebar-toggle",
              "panel-right",
              this.rightSidebarCollapsed
                ? "Show File Tree / Search Sidebar"
                : "Hide File Tree / Search Sidebar",
              (_e, cx) => {
                this.rightSidebarCollapsed = !this.rightSidebarCollapsed;
                cx.notify();
              },
              !this.rightSidebarCollapsed,
            ),
          ),
      );
  },

  renderFilePreviewPane(t, cx) {
    if (!this.file) {
      return this.renderQuickOpenHome(t, cx);
    }
    const isMd = isMarkdownFile(this.file);
    return v_flex()
      .id("files-preview-pane")
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .when(this.findOpen, sub => sub.child(this.renderFileFindBar(t)))
      .child(
        this.lines.length
          ? isMd && this.mdPreview && !this.findOpen && !this.diffView
            ? div()
                .id("files-md-scroll")
                .flex_1()
                .min_h(0)
                .p(16)
                .overflow_y_scrollbar()
                .on_mouse_down("left", (e, cx) => {
                  if (e.click_count >= 2 && !this.fileTruncated) {
                    cx.stop_propagation();
                    this.enterEditMode(1, 0, cx);
                  }
                })
                .child(
                  TextView.markdown("files-md-view", this.rawText || "")
                    .selectable(true)
                    .scrollable(false)
                    .w_full(),
                )
            : this.diffView && !this.findOpen
              ? this.renderInlineDiffView(t)
              : this.renderLinesView(t)
          : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"),
      );
  },
};
