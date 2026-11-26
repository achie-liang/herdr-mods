export function normalizePosixPath(p) {
  if (!p || typeof p !== "string") return "";
  const replaced = p.replace(/\\/g, "/");
  if (replaced === "/") return "/";
  return replaced.replace(/\/+$/, "");
}

export function resolveRefPath(relPath, filesRoot, agentCwd) {
  if (!relPath || !filesRoot || !agentCwd) return relPath;
  const root = normalizePosixPath(filesRoot);
  const cwd = normalizePosixPath(agentCwd);
  if (!root || !cwd || root === cwd) return relPath;

  const cleanRel = relPath.replace(/^\/+/, "").replace(/\/+$/, "");
  const targetAbs = cleanRel ? `${root}/${cleanRel}` : root;

  const fromParts = cwd.split("/").filter(Boolean);
  const toParts = targetAbs.split("/").filter(Boolean);
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }
  const ups = fromParts.length - common;
  const rest = toParts.slice(common);
  const rel = [...Array(ups).fill(".."), ...rest].join("/");
  return rel || ".";
}

export function formatRef(
  path,
  dir,
  startLine = null,
  endLine = null,
  startCol = null,
  endCol = null,
) {
  const clean = dir && !path.endsWith("/") ? `${path}/` : path;
  const quoted = /\s/.test(clean) ? `"${clean}"` : clean;
  if (!dir && startLine != null) {
    let a = startLine;
    let b = endLine ?? startLine;
    let sc =
      typeof startCol === "number" && Number.isFinite(startCol)
        ? Math.max(0, Math.floor(startCol))
        : null;
    let ec =
      typeof endCol === "number" && Number.isFinite(endCol)
        ? Math.max(0, Math.floor(endCol))
        : null;
    if (a > b) {
      [a, b] = [b, a];
      [sc, ec] = [ec, sc];
    } else if (a === b && sc != null && ec != null && sc > ec) {
      [sc, ec] = [ec, sc];
    }
    if (sc != null && ec != null) {
      return `@${quoted}#L${a}:${sc}-L${b}:${ec}`;
    }
    return a === b ? `@${quoted}#L${a}` : `@${quoted}#L${a}-L${b}`;
  }
  return `@${quoted}`;
}

export function offsetToLineCol(text, offset) {
  const src = typeof text === "string" ? text : "";
  const clamped = Math.max(0, Math.min(src.length, Math.floor(offset ?? 0)));
  let lineNo = 1;
  let lineStart = 0;
  for (let i = 0; i < clamped; i++) {
    if (src.charCodeAt(i) === 10) {
      lineNo++;
      lineStart = i + 1;
    }
  }
  let col = clamped - lineStart;
  if (
    col > 0 &&
    clamped < src.length &&
    src.charCodeAt(clamped) === 10 &&
    src.charCodeAt(clamped - 1) === 13
  ) {
    col -= 1;
  }
  return { lineNo, col };
}

export function normalizeSelectionBounds(selection, lines = null) {
  if (!selection?.start || !selection?.end) return null;
  let start = {
    lineNo: Math.max(1, Math.floor(selection.start.lineNo)),
    col: Math.max(0, Math.floor(selection.start.col)),
  };
  let end = {
    lineNo: Math.max(1, Math.floor(selection.end.lineNo)),
    col: Math.max(0, Math.floor(selection.end.col)),
  };
  if (start.lineNo > end.lineNo || (start.lineNo === end.lineNo && start.col > end.col)) {
    [start, end] = [end, start];
  }
  if (start.lineNo === end.lineNo && start.col === end.col) {
    return null;
  }
  if (end.lineNo > start.lineNo && end.col === 0) {
    const prevLineNo = end.lineNo - 1;
    const prevLen = lines ? (lines[prevLineNo - 1] || "").length : 0;
    end = { lineNo: prevLineNo, col: prevLen };
  }
  return { start, end };
}

export function isWholeLineSelection(start, end, lines = null) {
  if (!start || !end) return false;
  if (start.col !== 0) return false;
  if (!lines) return false;
  const endLineText = lines[end.lineNo - 1] ?? "";
  return end.col >= endLineText.length;
}

export function formatSelectionRef(path, selection, lines = null) {
  if (!path) return null;
  const norm = normalizeSelectionBounds(selection, lines);
  if (!norm) return formatRef(path, false);
  const { start, end } = norm;
  if (isWholeLineSelection(start, end, lines)) {
    return formatRef(path, false, start.lineNo, end.lineNo);
  }
  return formatRef(path, false, start.lineNo, end.lineNo, start.col, end.col);
}

export function formatSelectionBadge(selection, lines = null) {
  const norm = normalizeSelectionBounds(selection, lines);
  if (!norm) return "";
  const { start, end } = norm;
  if (isWholeLineSelection(start, end, lines)) {
    return start.lineNo === end.lineNo ? `L${start.lineNo}` : `L${start.lineNo}-L${end.lineNo}`;
  }
  return `L${start.lineNo}:${start.col}-L${end.lineNo}:${end.col}`;
}

export function rangeToLineColSelection(text, range, fallbackText = "", lines = null) {
  const src = typeof text === "string" ? text : "";
  if (!src) return null;
  const effectiveLines = lines ?? src.split(/\r?\n/);

  let s = null;
  let e = null;
  if (range && typeof range.start === "number" && typeof range.end === "number") {
    s = Math.max(0, Math.min(src.length, Math.min(range.start, range.end)));
    e = Math.max(0, Math.min(src.length, Math.max(range.start, range.end)));
  } else if (fallbackText) {
    const needle = String(fallbackText).trim();
    if (needle) {
      const idx = src.indexOf(needle);
      if (idx >= 0) {
        s = idx;
        e = idx + needle.length;
      }
    }
  }

  if (s == null || e == null || e <= s) return null;
  const start = offsetToLineCol(src, s);
  const end = offsetToLineCol(src, e);
  const norm = normalizeSelectionBounds({ start, end }, effectiveLines);
  if (!norm) return null;
  return {
    start: norm.start,
    end: norm.end,
    range: { start: s, end: e },
  };
}
