import { spaces, panes, agents, terminals, focused, run, hc, notify, appHome, shared } from "herdr";

export const BRIDGE_PORT = 17501;
export const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`;

export function annotationsDir() {
  return `${appHome()}/data/annotations`;
}

export function queueFilePath() {
  return `${annotationsDir()}/queue.json`;
}

export function commandFilePath() {
  return `${annotationsDir()}/command.json`;
}

export function contextFilePath() {
  return `${annotationsDir()}/context.json`;
}

export function extStatusFilePath() {
  return `${annotationsDir()}/ext-status.json`;
}

export function bundledExtensionDir() {
  return `${appHome()}/mods/ide-review/chrome-extension`;
}

export function truncateSessionName(raw, maxLen = 16) {
  const s = String(raw || "").trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

export function resolveAgentSessionName(a, termMap, sharedSessions) {
  const term = termMap?.get(a.address);
  const fromLabel = term?.labels?.["herdr.session"];
  if (fromLabel) return String(fromLabel).trim();
  const fromShared = sharedSessions?.[a.address];
  if (fromShared) return String(fromShared).trim();
  if (a.title && a.title.startsWith("π - ")) {
    const parts = a.title.slice(4).split(" - ");
    if (parts.length >= 2) return parts.slice(0, -1).join(" - ").trim();
  }
  const tabName = a.tab_name || a.tabName || "";
  if (tabName && !/^tb?\d+$|^\d+$/.test(tabName) && tabName !== (a.program?.name || a.programName)) {
    return tabName.trim();
  }
  const title = (a.title || "").trim();
  if (
    title &&
    title !== (a.program?.name || a.programName) &&
    !/^[~/]|^[A-Za-z]:\\/.test(title) &&
    !title.includes("@")
  ) {
    return title;
  }
  return "";
}

export function formatAgentDisplayLabel(a, termMap = null, sharedSessions = null) {
  const agentName = a.program?.name || a.programName || a.title || "Agent";
  const spaceName = a.space_name || a.spaceName || "space";
  const rawSession =
    a.sessionName !== undefined
      ? a.sessionName
      : resolveAgentSessionName(a, termMap, sharedSessions);
  const shortSession = truncateSessionName(rawSession || a.address || "", 16);
  return shortSession
    ? `${agentName} · ${spaceName} (${shortSession})`
    : `${agentName} · ${spaceName}`;
}

export function currentWorkspaceContext() {
  const allSpaces = spaces();
  const activeSpace = allSpaces.find(s => s.active) || allSpaces[0] || null;
  const f = focused();
  const allPanes = panes();
  const focusedPane = f?.pane ? allPanes.find(p => p.pane === f.pane) : null;
  const allAgents = agents();
  const termMap = new Map(terminals().map(t => [t.address, t]));
  let sharedSessions = null;
  try {
    sharedSessions = shared("ide.agent_sessions") || null;
  } catch {}
  const activeAgent =
    allAgents.find(a => a.focused) ||
    (f?.terminal ? allAgents.find(a => a.address === f.terminal) : null) ||
    (activeSpace ? allAgents.find(a => a.space === activeSpace.id) : null) ||
    allAgents[0] ||
    null;

  const cwd = focusedPane?.cwd || f?.cwd || activeSpace?.folder || "";
  return {
    updatedAt: Date.now(),
    cwd,
    focused: f
      ? {
          space: f.space,
          tab: f.tab,
          pane: f.pane,
          terminal: f.terminal || activeAgent?.address || null,
          cwd: f.cwd || cwd,
        }
      : null,
    activeSpace: activeSpace
      ? {
          id: activeSpace.id,
          name: activeSpace.name,
          folder: activeSpace.folder,
          branch: activeSpace.branch,
        }
      : null,
    agents: allAgents.map(a => {
      const sessionName = resolveAgentSessionName(a, termMap, sharedSessions);
      const item = {
        address: a.address,
        pane: a.pane,
        space: a.space,
        spaceName: a.space_name,
        tab: a.tab,
        tabName: a.tab_name,
        status: a.status,
        app: a.app || a.program?.key || "agent",
        programName: a.program?.name || a.title || "Agent",
        title: a.title,
        sessionName,
        focused: a.focused,
      };
      item.displayLabel = formatAgentDisplayLabel(item, termMap, sharedSessions);
      return item;
    }),
  };
}

export function normalizeSourceRef(sourceFile, lineNumber, endLineNumber, workspaceCwd) {
  if (!sourceFile) return null;
  let clean = String(sourceFile)
    .trim()
    .replace(/^webpack-internal:\/\/\/(\.\/)?/, "")
    .replace(/^vite:\/\/\/?/, "")
    .replace(/^file:\/\//, "")
    .replace(/\?.*$/, "");

  const cwd = (workspaceCwd || "").replace(/\/+$/, "");
  if (cwd && clean.startsWith(cwd + "/")) {
    clean = clean.slice(cwd.length + 1);
  } else {
    // Also check if sourceFile contains /src/ or /app/ or /pages/ or /components/ when workspace root differs slightly
    const parentCwd = cwd ? cwd.split("/").slice(0, -1).join("/") : "";
    if (parentCwd && clean.startsWith(parentCwd + "/")) {
      clean = clean.slice(parentCwd.length + 1);
    }
  }

  clean = clean.replace(/^\.?\/+/, "");
  if (!clean) return null;
  const quoted = /\s/.test(clean) ? `"${clean}"` : clean;
  if (lineNumber != null && Number.isFinite(Number(lineNumber)) && Number(lineNumber) > 0) {
    const start = Number(lineNumber);
    const end =
      endLineNumber != null && Number.isFinite(Number(endLineNumber)) && Number(endLineNumber) > start
        ? Number(endLineNumber)
        : start;
    return start === end ? `@${quoted}#L${start}` : `@${quoted}#L${start}-L${end}`;
  }
  return `@${quoted}`;
}

export function formatAnnotationItemMarkdown(item, displayIndex, workspaceCwd) {
  const lines = [];
  const badge = `#${displayIndex}`;
  const kindLabel =
    item.kind === "area"
      ? "区域框选 (Area)"
      : item.kind === "selection"
        ? "文本批注 (Text Selection)"
        : "元素标注 (Element)";

  const note = (item.note || "").trim() || "请检查并优化此元素";
  lines.push(`### 标注 ${badge} — ${note}`);
  lines.push(`- **类型**: ${kindLabel}`);

  const sourceRef = normalizeSourceRef(
    item.source?.fileName,
    item.source?.lineNumber,
    item.source?.endLineNumber,
    workspaceCwd,
  );
  if (sourceRef || item.source?.componentPath) {
    const comp = item.source?.componentPath ? ` (\`${item.source.componentPath}\`)` : "";
    lines.push(`- **源码定位**: ${sourceRef ? `${sourceRef}${comp}` : comp.trim()}`);
  }

  if (item.selector) {
    const tagDesc = item.tagName ? `\`<${item.tagName}>\`` : "";
    lines.push(`- **DOM 选择器**: \`${item.selector}\` ${tagDesc}`.trim());
  }

  if (item.selectedText) {
    lines.push(`- **选中文本**: "${item.selectedText.slice(0, 240)}"`);
  } else if (item.text) {
    lines.push(`- **元素文本**: "${item.text.slice(0, 180)}"`);
  }

  if (item.rect) {
    const r = item.rect;
    lines.push(
      `- **位置与尺寸**: \`${Math.round(r.width)}×${Math.round(r.height)}px\` (at \`x:${Math.round(r.x)}, y:${Math.round(r.y)}\`)`,
    );
  }

  if (item.styles && Object.keys(item.styles).length > 0) {
    const stylePairs = Object.entries(item.styles)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("; ");
    if (stylePairs) {
      lines.push(`- **关键样式**: \`${stylePairs}\``);
    }
  }

  if (item.htmlSnippet) {
    lines.push(`- **DOM 结构**: \`${item.htmlSnippet.slice(0, 220)}\``);
  }

  if (Array.isArray(item.groupedElements) && item.groupedElements.length > 0) {
    const sub = item.groupedElements
      .slice(0, 8)
      .map(g => {
        const sRef = normalizeSourceRef(g.source?.fileName, g.source?.lineNumber, null, workspaceCwd);
        return `\`${g.selector || g.tagName}\`${sRef ? ` (${sRef})` : ""}${g.text ? ` "${g.text.slice(0, 40)}"` : ""}`;
      })
      .join(", ");
    lines.push(`- **框选包含元素 (${item.groupedElements.length})**: ${sub}`);
  }

  return lines.join("\n");
}

export function formatBatchPrompt(batch, options = {}) {
  if (!batch) return "";
  const workspaceCwd = options.workspaceCwd ?? currentWorkspaceContext().cwd ?? "";
  const includeScreenshot = options.includeScreenshot !== false;
  const activeItems = (batch.items || []).filter(it => it.enabled !== false);
  if (activeItems.length === 0 && !batch.globalNote) return "";

  const out = [];
  const pageTitle = batch.title ? ` (${batch.title})` : "";
  out.push(
    `请根据以下浏览器页面视觉标注修改前端代码（页面: \`${batch.url || "localhost"}\`${pageTitle}）：`,
  );

  if (batch.globalNote && batch.globalNote.trim()) {
    out.push(`\n**整体修改要求**: ${batch.globalNote.trim()}`);
  }

  if (includeScreenshot && batch.screenshotAbsPath) {
    const quotedShot = /\s/.test(batch.screenshotAbsPath)
      ? `"${batch.screenshotAbsPath}"`
      : batch.screenshotAbsPath;
    out.push(`\n**带标号页面截图**: @${quotedShot}`);
  }

  out.push("");
  activeItems.forEach((item, idx) => {
    const num = item.index || idx + 1;
    out.push(formatAnnotationItemMarkdown(item, num, workspaceCwd));
    out.push("");
  });

  return out.join("\n").trim();
}

export function formatMultiBatchPrompt(batches, options = {}) {
  const validBatches = (batches || []).filter(
    b => b && ((b.items || []).some(it => it.enabled !== false) || b.globalNote),
  );
  if (validBatches.length === 0) return "";
  if (validBatches.length === 1) {
    return formatBatchPrompt(validBatches[0], options);
  }

  const workspaceCwd = options.workspaceCwd ?? currentWorkspaceContext().cwd ?? "";
  const includeScreenshot = options.includeScreenshot !== false;
  const out = [];
  out.push(
    `请根据以下 ${validBatches.length} 个浏览器页面的视觉走查标注修改前端代码：`,
  );

  validBatches.forEach((batch, bIdx) => {
    const activeItems = (batch.items || []).filter(it => it.enabled !== false);
    const pageTitle = batch.title ? ` (${batch.title})` : "";
    out.push(`\n---\n## 页面 ${bIdx + 1}: \`${batch.url || "localhost"}\`${pageTitle}`);

    if (batch.globalNote && batch.globalNote.trim()) {
      out.push(`**页面整体要求**: ${batch.globalNote.trim()}`);
    }

    if (includeScreenshot && batch.screenshotAbsPath) {
      const quotedShot = /\s/.test(batch.screenshotAbsPath)
        ? `"${batch.screenshotAbsPath}"`
        : batch.screenshotAbsPath;
      out.push(`**带标号页面截图**: @${quotedShot}`);
    }

    out.push("");
    activeItems.forEach((item, idx) => {
      const num = item.index || idx + 1;
      out.push(formatAnnotationItemMarkdown(item, num, workspaceCwd));
      out.push("");
    });
  });

  return out.join("\n").trim();
}

export function resolveTargetAgent(preferredTerminal, preferredPane) {
  const allAgents = agents();
  const allPanes = panes();
  const termMap = new Map(terminals().map(t => [t.address, t]));
  let sharedSessions = null;
  try {
    sharedSessions = shared("ide.agent_sessions") || null;
  } catch {}
  const f = focused();

  if (preferredTerminal && preferredTerminal !== "default") {
    const a = allAgents.find(x => x.address === preferredTerminal);
    if (a) {
      return {
        space: a.space || null,
        tab: a.tab || null,
        pane: a.pane || null,
        terminal: a.address,
        label: formatAgentDisplayLabel(a, termMap, sharedSessions),
      };
    }
    const p = allPanes.find(x => x.terminal === preferredTerminal);
    if (p) {
      return {
        space: null,
        tab: p.tab || null,
        pane: p.pane,
        terminal: p.terminal,
        label: p.title || preferredTerminal,
      };
    }
    return {
      space: null,
      tab: null,
      pane: null,
      terminal: preferredTerminal,
      label: preferredTerminal,
    };
  }

  if (preferredPane) {
    const p = allPanes.find(x => x.pane === preferredPane);
    if (p) {
      const a = allAgents.find(x => x.pane === p.pane || x.address === p.terminal);
      return {
        space: a?.space || null,
        tab: p.tab || a?.tab || null,
        pane: p.pane,
        terminal: p.terminal || a?.address || null,
        label: a
          ? formatAgentDisplayLabel(a, termMap, sharedSessions)
          : p.title || "Agent",
      };
    }
  }

  if (f?.pane || f?.terminal) {
    const p = f.pane ? allPanes.find(x => x.pane === f.pane) : null;
    const term = f.terminal || p?.terminal || null;
    const a = term ? allAgents.find(x => x.address === term) : null;
    return {
      space: f.space || a?.space || null,
      tab: f.tab || p?.tab || a?.tab || null,
      pane: f.pane || a?.pane || null,
      terminal: term,
      label: a
        ? formatAgentDisplayLabel(a, termMap, sharedSessions)
        : p?.program?.name || p?.title || term || "Active Pane",
    };
  }

  const activeSpace = spaces().find(s => s.active);
  const spaceAgent =
    (activeSpace &&
      allAgents.find(a => a.space === activeSpace.id && a.focused)) ||
    (activeSpace && allAgents.find(a => a.space === activeSpace.id)) ||
    allAgents[0];

  if (spaceAgent) {
    return {
      space: spaceAgent.space || null,
      tab: spaceAgent.tab || null,
      pane: spaceAgent.pane || null,
      terminal: spaceAgent.address,
      label: formatAgentDisplayLabel(spaceAgent, termMap, sharedSessions),
    };
  }

  return { space: null, tab: null, pane: null, terminal: null, label: "Terminal" };
}

export function focusTargetAgentPane(resolved) {
  if (!resolved) return;
  if (resolved.terminal) {
    try {
      run("agent.focus", { terminal: resolved.terminal });
    } catch {}
  }
  if (resolved.space) {
    try {
      run("space.select", { id: resolved.space });
    } catch {}
  }
  if (resolved.tab) {
    try {
      run("tab.select", { id: resolved.tab });
    } catch {}
  }
  if (resolved.pane) {
    try {
      run("pane.focus", { pane: resolved.pane });
    } catch {}
  } else if (resolved.terminal) {
    try {
      run("pane.focus", { terminal: resolved.terminal });
    } catch {}
  }
}

export function pastePromptIntoAgent(text, cx, target = {}) {
  if (!text || !text.trim()) return false;
  const resolved = resolveTargetAgent(target.terminal, target.pane);
  cx.write_to_clipboard(`${text} `);
  focusTargetAgentPane(resolved);
  run("terminal.paste");
  notify({
    title: "UI Review pasted to Agent",
    body: `Pasted into ${resolved.label}`,
    level: "success",
    timeout: 3000,
  });
  return true;
}

export async function sendPromptToAgent(text, cx, target = {}) {
  if (!text || !text.trim()) return false;
  const resolved = resolveTargetAgent(target.terminal, target.pane);
  cx.write_to_clipboard(text);
  focusTargetAgentPane(resolved);
  run("terminal.paste");
  if (resolved.terminal) {
    if (typeof cx?.sleep === "function") {
      await cx.sleep(120);
    }
    await hc(["keys", resolved.terminal, "enter"]);
  }
  notify({
    title: "UI Review sent to Agent",
    body: `Sent & running in ${resolved.label}`,
    level: "success",
    timeout: 3000,
  });
  return true;
}
