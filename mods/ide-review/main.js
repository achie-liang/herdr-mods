import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import {
  exec,
  readTextFile,
  writeTextFile,
  watchFolder,
  theme,
  settings,
  notify,
  nextCommand,
  appHome,
} from "herdr";
import {
  BRIDGE_PORT,
  annotationsDir,
  queueFilePath,
  contextFilePath,
  extStatusFilePath,
  bundledExtensionDir,
  currentWorkspaceContext,
  normalizeSourceRef,
  formatAnnotationItemMarkdown,
  formatBatchPrompt,
  formatMultiBatchPrompt,
  resolveTargetAgent,
  pastePromptIntoAgent,
  sendPromptToAgent,
} from "./format.js";

const ICON_REVIEW = "mods/ide-review/review.svg";
const ICON_SEND = "mods/ide-review/send.svg";
const ICON_COPY = "mods/ide-review/copy.svg";
const ICON_TRASH = "mods/ide-review/trash.svg";
const ICON_CHECK = "mods/ide-review/check.svg";

function formatTimeAgo(ts) {
  if (!ts) return "";
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 10) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

export default class IdeReview extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.batches = [];
    this.activeBatchId = null;
    this.includeScreenshot = true;
    this.sendAllPages = true;
    this.showScreenshotPreview = true;
    this.bridgeOnline = false;
    this.extStatus = { installed: false, connected: false };
    this.installingExt = false;
    this.selectedAgentAddress = null;
    this.agentMenuOpen = false;
    this.editingItemId = null;
    this.scroll = ScrollHandle.new();
    this.watching = false;
    this.lastQueueRaw = null;
    this.lastExtRaw = null;

    this.globalNoteInput = InputState.new({
      placeholder: "Overall instructions for this batch (optional)…",
    });
    this.globalNoteInput.on("change", (_e, cx) => {
      const batch = this.activeBatch();
      if (batch) {
        batch.globalNote = this.globalNoteInput.value();
        this.persistQueue(cx);
      }
      cx.notify();
    });

    this.itemEditInput = InputState.new({
      placeholder: "Describe what the agent should fix or optimize…",
    });
    this.itemEditInput.on("submit", (_e, cx) => {
      this.commitItemEdit(cx);
    });

    cx.spawn(async cx => {
      for (;;) {
        const cmd = await nextCommand();
        if (!cmd) continue;
        if (cmd === "focus") {
          this.handle.focus();
        } else if (cmd === "paste_all") {
          this.pasteActiveBatch(cx);
        } else if (cmd === "send_all") {
          this.sendActiveBatch(cx);
        }
        cx.notify();
      }
    });

    this.bootstrapBridge(cx);
    this.reloadQueue(cx);
    cx.timer.every(5000, cx => {
      this.syncContextFile();
      this.refreshExtStatus(cx);
      this.reloadQueue(cx);
    });
  }

  async refreshExtStatus(cx) {
    try {
      const base = appHome();
      const script = `${base}/mods/ide-review/bridge.mjs`;
      await exec("node", [script, "--check-ext", "--app-home", base]);
      await this.reloadQueue(cx);
    } catch {}
  }

  async bootstrapBridge(cx) {
    try {
      const base = appHome();
      const script = `${base}/mods/ide-review/bridge.mjs`;
      await exec("node", [script, "--daemon", "--app-home", base]);
      this.bridgeOnline = true;
      await this.syncContextFile();
      this.startWatch(cx);
      cx.notify();
    } catch {
      this.bridgeOnline = false;
      cx.notify();
    }
  }

  async syncContextFile() {
    try {
      const ctx = currentWorkspaceContext();
      const path = contextFilePath();
      const prev = await readTextFile(path);
      await writeTextFile(path, JSON.stringify(ctx, null, 2), prev);
    } catch {}
  }

  startWatch(cx) {
    if (this.watching) return;
    this.watching = true;
    const dir = annotationsDir();
    cx.spawn(async cx => {
      try {
        while (this.watching) {
          await watchFolder(dir);
          await this.reloadQueue(cx);
        }
      } catch {
        this.watching = false;
      }
    });
  }

  async reloadQueue(cx) {
    try {
      const extRaw = await readTextFile(extStatusFilePath());
      if (extRaw && extRaw !== this.lastExtRaw) {
        this.lastExtRaw = extRaw;
        try {
          this.extStatus = JSON.parse(extRaw) || { installed: false, connected: false };
        } catch {}
      }

      const raw = await readTextFile(queueFilePath());
      if (raw === null) {
        this.batches = [];
        this.lastQueueRaw = null;
        cx.notify();
        return;
      }
      if (raw === this.lastQueueRaw) {
        cx.notify();
        return;
      }
      this.lastQueueRaw = raw;
      const parsed = JSON.parse(raw);
      this.batches = Array.isArray(parsed?.batches) ? parsed.batches : [];
      this.syncActiveBatchForAgent();
      this.bridgeOnline = true;
      cx.notify();
    } catch {}
  }

  effectiveAgentAddress() {
    if (this.selectedAgentAddress) return this.selectedAgentAddress;
    const def = resolveTargetAgent(null, null);
    return def.terminal || null;
  }

  batchesForAgent(agentAddr = this.effectiveAgentAddress()) {
    if (!this.batches.length) return [];
    if (!agentAddr) return this.batches;
    const ctx = currentWorkspaceContext();
    const knownAddrs = new Set(ctx.agents.map(a => a.address));
    const defaultAddr = resolveTargetAgent(null, null).terminal;

    return this.batches.filter(b => {
      const bt = b.targetTerminal;
      if (!bt || bt === "default" || !knownAddrs.has(bt)) {
        return !defaultAddr || agentAddr === defaultAddr;
      }
      return bt === agentAddr;
    });
  }

  countItemsForAgent(agentAddr) {
    return this.batchesForAgent(agentAddr).reduce(
      (sum, b) => sum + (Array.isArray(b.items) ? b.items.length : 0),
      0,
    );
  }

  syncActiveBatchForAgent() {
    const visible = this.batchesForAgent();
    if (visible.length > 0 && !visible.some(b => b.id === this.activeBatchId)) {
      this.activeBatchId = visible[0].id;
      this.globalNoteInput.set_value(visible[0].globalNote || "");
    } else if (visible.length === 0) {
      this.activeBatchId = null;
      this.globalNoteInput.set_value("");
    } else {
      const cur = this.activeBatch();
      if (cur && this.globalNoteInput.value() !== (cur.globalNote || "")) {
        this.globalNoteInput.set_value(cur.globalNote || "");
      }
    }
  }

  async persistQueue(cx) {
    try {
      const path = queueFilePath();
      const prev = await readTextFile(path);
      const nextRaw = JSON.stringify({ batches: this.batches }, null, 2);
      this.lastQueueRaw = nextRaw;
      await writeTextFile(path, nextRaw, prev);
      cx.notify();
    } catch {}
  }

  activeBatch() {
    const visible = this.batchesForAgent();
    if (!visible.length) return null;
    return visible.find(b => b.id === this.activeBatchId) || visible[0];
  }

  selectBatch(id, cx) {
    this.activeBatchId = id;
    this.editingItemId = null;
    const b = this.activeBatch();
    this.globalNoteInput.set_value(b?.globalNote || "");
    cx.notify();
  }

  startItemEdit(item, cx) {
    this.editingItemId = item.id;
    this.itemEditInput.set_value(item.note || "");
    this.itemEditInput.focus();
    cx.notify();
  }

  commitItemEdit(cx) {
    const batch = this.activeBatch();
    if (!batch || !this.editingItemId) return;
    const item = (batch.items || []).find(it => it.id === this.editingItemId);
    if (item) {
      item.note = this.itemEditInput.value().trim();
    }
    this.editingItemId = null;
    this.persistQueue(cx);
  }

  toggleItemEnabled(item, cx) {
    item.enabled = item.enabled === false;
    this.persistQueue(cx);
  }

  deleteItem(itemId, cx) {
    const batch = this.activeBatch();
    if (!batch) return;
    batch.items = (batch.items || [])
      .filter(it => it.id !== itemId)
      .map((it, idx) => ({ ...it, index: idx + 1 }));
    if (batch.items.length === 0) {
      this.deleteBatch(batch.id, cx);
      return;
    }
    this.persistQueue(cx);
  }

  deleteBatch(batchId, cx) {
    this.batches = this.batches.filter(b => b.id !== batchId);
    this.syncActiveBatchForAgent();
    this.persistQueue(cx);
  }

  clearAllBatches(cx) {
    const visibleIds = new Set(this.batchesForAgent().map(b => b.id));
    this.batches = this.batches.filter(b => !visibleIds.has(b.id));
    this.activeBatchId = null;
    this.editingItemId = null;
    this.globalNoteInput.set_value("");
    this.persistQueue(cx);
    notify({
      title: "Cleared annotations",
      body: "Cleared staged annotations for current Agent.",
      level: "info",
      timeout: 2200,
    });
  }

  targetSpec() {
    const addr = this.effectiveAgentAddress();
    if (addr) {
      return { terminal: addr, pane: null };
    }
    const batch = this.activeBatch();
    return {
      terminal: batch?.targetTerminal || null,
      pane: batch?.targetPane || null,
    };
  }

  batchesToSendNow() {
    const visible = this.batchesForAgent();
    const batch = this.activeBatch();
    if (!batch) return [];
    return this.sendAllPages && visible.length > 1 ? visible : [batch];
  }

  buildOutboundPrompt() {
    const list = this.batchesToSendNow();
    if (!list.length) return "";
    return formatMultiBatchPrompt(list, {
      includeScreenshot: this.includeScreenshot,
    });
  }

  consumeSentBatches(sentList, cx) {
    const sentIds = new Set((sentList || []).map(b => b.id));
    if (!sentIds.size) return;
    this.batches = this.batches.filter(b => !sentIds.has(b.id));
    this.syncActiveBatchForAgent();
    this.persistQueue(cx);
  }

  pasteActiveBatch(cx) {
    const toSend = this.batchesToSendNow();
    const text = this.buildOutboundPrompt();
    if (!text) return;
    pastePromptIntoAgent(text, cx, this.targetSpec());
    this.consumeSentBatches(toSend, cx);
  }

  sendActiveBatch(cx) {
    const toSend = this.batchesToSendNow();
    const text = this.buildOutboundPrompt();
    if (!text) return;
    const spec = this.targetSpec();
    this.consumeSentBatches(toSend, cx);
    cx.spawn(async cx => {
      await sendPromptToAgent(text, cx, spec);
      cx.notify();
    });
  }

  copyActiveBatch(cx) {
    const text = this.buildOutboundPrompt();
    if (!text) return;
    cx.write_to_clipboard(text);
    notify({
      title: "Copied Markdown prompt",
      body: "Copied UI Review annotations to clipboard",
      level: "info",
      timeout: 2200,
    });
  }

  pasteSingleItem(item, cx) {
    const ctx = currentWorkspaceContext();
    const md = formatAnnotationItemMarkdown(item, item.index || 1, ctx.cwd);
    pastePromptIntoAgent(md, cx, this.targetSpec());
  }

  installChromeExt(cx) {
    if (this.installingExt) return;
    this.installingExt = true;
    cx.notify();
    const base = appHome();
    const script = `${base}/mods/ide-review/bridge.mjs`;
    cx.spawn(async cx => {
      try {
        const res = await exec("node", [
          script,
          "--install-ext",
          "--app-home",
          base,
        ]);
        let parsed = null;
        try {
          parsed = JSON.parse((res.stdout || "").trim().split("\n").pop() || "{}");
        } catch {}
        await this.reloadQueue(cx);
        if (parsed?.status?.installed || this.extStatus?.installed) {
          const v =
            parsed?.status?.installedVersion ||
            this.extStatus?.installedVersion ||
            this.extStatus?.bundledVersion ||
            "1.2.0";
          notify({
            title: "Chrome 插件已就绪",
            body: `Herdr UI Review (v${v}) 已安装并同步到最新版本！`,
            level: "success",
            timeout: 4000,
          });
        } else {
          notify({
            title: "已打开 Chrome 扩展安装页",
            body: "插件路径已复制到剪贴板，开启右上角「开发者模式」后将 Finder 里的文件夹拖入即可完成安装。",
            level: "info",
            timeout: 5000,
          });
        }
      } catch (e) {
        notify({
          title: "安装启动失败",
          body: String(e?.message || e),
          level: "error",
          timeout: 3500,
        });
      } finally {
        this.installingExt = false;
        cx.notify();
      }
    });
  }

  revealExtInFinder() {
    const extPath = bundledExtensionDir();
    exec("open", ["-R", extPath]).catch(() => {});
  }

  renderTopBar(t, batch, cx) {
    const stop = (_e, cx) => cx.stop_propagation();
    const ctx = currentWorkspaceContext();
    const currentAgentAddr = this.effectiveAgentAddress();
    const resolvedTarget = resolveTargetAgent(
      currentAgentAddr || batch?.targetTerminal,
      batch?.targetPane,
    );
    const visibleBatches = this.batchesForAgent(currentAgentAddr);
    const activeCount = batch
      ? this.sendAllPages && visibleBatches.length > 1
        ? visibleBatches.reduce(
            (sum, b) =>
              sum + (b.items || []).filter(i => i.enabled !== false).length,
            0,
          )
        : (batch.items || []).filter(i => i.enabled !== false).length
      : 0;

    return v_flex()
      .w_full()
      .flex_none()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .h(38)
          .px(10)
          .gap(8)
          .items_center()
          .child(
            h_flex()
              .gap(6)
              .items_center()
              .child(svg(ICON_REVIEW).size(15).text_color(t.accent))
              .child(
                div()
                  .text_size(12.5)
                  .font_semibold()
                  .text_color(t.foreground)
                  .child("UI Review"),
              ),
          )
          .child(
            h_flex()
              .id("bridge-status-pill")
              .h(22)
              .px(7)
              .gap(5)
              .items_center()
              .rounded(5)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => this.bootstrapBridge(cx))
              .child(
                div()
                  .size(6)
                  .rounded(3)
                  .bg(this.bridgeOnline ? t.done : t.blocked),
              )
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child(
                    this.bridgeOnline
                      ? `Bridge :${BRIDGE_PORT}`
                      : "Start Bridge",
                  ),
              ),
          )
          // Chrome Extension Status / One-Click Install or Update Pill
          .child(
            this.extStatus?.installed && !this.extStatus?.needsUpdate
              ? h_flex()
                  .id("ext-status-pill")
                  .h(22)
                  .px(7)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .hover(s => s.bg(t.hover))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.installChromeExt(cx))
                  .child(
                    div()
                      .size(6)
                      .rounded(3)
                      .bg(this.extStatus?.connected ? t.done : t.accent),
                  )
                  .child(
                    div()
                      .text_size(11)
                      .text_color(t.muted)
                      .child(
                        `Chrome Ext v${this.extStatus?.installedVersion || this.extStatus?.version || "1.1.0"}`,
                      ),
                  )
              : h_flex()
                  .id("ext-install-pill")
                  .h(22)
                  .px(8)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(t.selected)
                  .border(1)
                  .border_color(
                    this.extStatus?.needsUpdate ? t.working : t.accent,
                  )
                  .hover(s => s.bg(t.hover))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.installChromeExt(cx))
                  .child(
                    div()
                      .text_size(11)
                      .font_semibold()
                      .text_color(
                        this.extStatus?.needsUpdate ? t.working : t.accent,
                      )
                      .child(
                        this.installingExt
                          ? this.extStatus?.needsUpdate
                            ? "正在更新插件…"
                            : "正在安装插件…"
                          : this.extStatus?.needsUpdate
                            ? `↑ 一键更新插件 (v${this.extStatus?.installedVersion || "1.0.0"} → v${this.extStatus?.bundledVersion || "1.1.0"})`
                            : "+ 一键安装 Chrome 插件",
                      ),
                  ),
          )
          .child(div().flex_1())
          // Target Agent Picker Button
          .child(
            h_flex()
              .id("target-agent-picker")
              .h(24)
              .px(8)
              .gap(5)
              .items_center()
              .rounded(5)
              .bg(t.surface)
              .border(1)
              .border_color(this.agentMenuOpen ? t.accent : t.border)
              .hover(s => s.bg(t.hover))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                this.agentMenuOpen = !this.agentMenuOpen;
                cx.notify();
              })
              .child(
                div()
                  .text_size(11)
                  .text_color(t.muted)
                  .child("To:"),
              )
              .child(
                div()
                  .max_w(150)
                  .truncate()
                  .text_size(11.5)
                  .text_color(t.foreground)
                  .child(resolvedTarget.label),
              )
              .child(
                div()
                  .text_size(10)
                  .text_color(t.dim)
                  .child("▾"),
              ),
          )
          .when(Boolean(batch), el =>
            el
              .child(
                h_flex()
                  .id("btn-copy-batch")
                  .h(25)
                  .px(8)
                  .gap(4)
                  .items_center()
                  .rounded(5)
                  .bg(t.surface)
                  .border(1)
                  .border_color(t.border)
                  .text_size(11.5)
                  .text_color(t.foreground)
                  .hover(s => s.bg(t.hover))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.copyActiveBatch(cx))
                  .child(svg(ICON_COPY).size(12).text_color(t.muted))
                  .child("Copy"),
              )
              .child(
                h_flex()
                  .id("btn-paste-batch")
                  .h(25)
                  .px(9)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(t.selected)
                  .border(1)
                  .border_color(t.accent)
                  .text_size(11.5)
                  .text_color(t.foreground)
                  .hover(s => s.bg(t.hover))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.pasteActiveBatch(cx))
                  .child(`Paste (${activeCount})`),
              )
              .child(
                h_flex()
                  .id("btn-send-batch")
                  .h(25)
                  .px(9)
                  .gap(5)
                  .items_center()
                  .rounded(5)
                  .bg(t.accent)
                  .text_size(11.5)
                  .font_semibold()
                  .text_color(t.accent_foreground)
                  .hover(s => s.opacity(0.9))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => this.sendActiveBatch(cx))
                  .child(svg(ICON_SEND).size(12).text_color(t.accent_foreground))
                  .child("Send & Run"),
              ),
          ),
      )
      // Agent dropdown row when open
      .when(this.agentMenuOpen, el =>
        el.child(
          h_flex()
            .px(10)
            .py(6)
            .gap(6)
            .flex_wrap()
            .items_center()
            .bg(t.popover)
            .border_t(1)
            .border_color(t.border)
            .child(
              div()
                .text_size(11)
                .text_color(t.muted)
                .child("View & Send annotations for Agent:"),
            )
            .children(
              ctx.agents.map(a => {
                const chosen = currentAgentAddr === a.address;
                const count = this.countItemsForAgent(a.address);
                return div()
                  .id(`agent-opt-${a.address}`)
                  .px(8)
                  .py(3)
                  .rounded(4)
                  .text_size(11)
                  .bg(chosen ? t.selected : t.surface)
                  .text_color(chosen ? t.foreground : t.muted)
                  .hover(s => s.bg(t.hover))
                  .on_mouse_down("left", stop)
                  .on_click((_e, cx) => {
                    this.selectedAgentAddress = a.address;
                    this.agentMenuOpen = false;
                    this.syncActiveBatchForAgent();
                    cx.notify();
                  })
                  .child(
                    `${a.programName} · ${a.spaceName} (${a.address})${
                      count > 0 ? ` [${count}]` : ""
                    }`,
                  );
              }),
            ),
        ),
      );
  }

  renderBatchStrip(t, activeBatch) {
    const visibleBatches = this.batchesForAgent();
    if (!visibleBatches.length) return null;
    const stop = (_e, cx) => cx.stop_propagation();

    return v_flex()
      .w_full()
      .flex_none()
      .px(10)
      .py(7)
      .gap(6)
      .bg(t.surface)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .flex_wrap()
          .children(
            visibleBatches.map(b => {
              const isSelected = b.id === activeBatch?.id;
              let hostPath = b.url || "page";
              try {
                const u = new URL(b.url);
                hostPath = `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
              } catch {}
              const count = (b.items || []).length;
              return h_flex()
                .id(`batch-tab-${b.id}`)
                .h(24)
                .px(8)
                .gap(6)
                .items_center()
                .rounded(5)
                .border(1)
                .border_color(isSelected ? t.accent : t.border)
                .bg(isSelected ? t.selected : t.chrome)
                .text_size(11.3)
                .text_color(isSelected ? t.foreground : t.muted)
                .hover(s => s.bg(t.hover))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => this.selectBatch(b.id, cx))
                .child(
                  div()
                    .max_w(190)
                    .truncate()
                    .child(`${hostPath} (${count})`),
                )
                .child(
                  div()
                    .text_size(10.5)
                    .text_color(t.dim)
                    .child(formatTimeAgo(b.createdAt)),
                )
                .child(
                  div()
                    .id(`batch-del-${b.id}`)
                    .px(2)
                    .text_color(t.dim)
                    .hover(s => s.text_color(t.blocked))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.deleteBatch(b.id, cx);
                    })
                    .child("×"),
                );
            }),
          )
          .child(div().flex_1())
          .when(visibleBatches.length > 1, el =>
            el.child(
              h_flex()
                .id("toggle-all-pages")
                .h(22)
                .px(7)
                .gap(5)
                .items_center()
                .rounded(4)
                .bg(this.sendAllPages ? t.selected : t.chrome)
                .border(1)
                .border_color(this.sendAllPages ? t.accent : t.border)
                .text_size(11)
                .text_color(this.sendAllPages ? t.foreground : t.muted)
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => {
                  this.sendAllPages = !this.sendAllPages;
                  cx.notify();
                })
                .child(
                  this.sendAllPages
                    ? `✓ All ${visibleBatches.length} Pages`
                    : "Current Page Only",
                ),
            ),
          )
          .when(Boolean(activeBatch?.screenshotAbsPath), el =>
            el.child(
              h_flex()
                .id("toggle-shot-attach")
                .h(22)
                .px(7)
                .gap(5)
                .items_center()
                .rounded(4)
                .bg(this.includeScreenshot ? t.selected : t.chrome)
                .border(1)
                .border_color(this.includeScreenshot ? t.accent : t.border)
                .text_size(11)
                .text_color(this.includeScreenshot ? t.foreground : t.muted)
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => {
                  this.includeScreenshot = !this.includeScreenshot;
                  cx.notify();
                })
                .child(this.includeScreenshot ? "✓ Attach Shot" : "No Shot"),
            ),
          )
          .child(
            h_flex()
              .id("btn-clear-batches")
              .h(22)
              .px(7)
              .gap(4)
              .items_center()
              .rounded(4)
              .text_size(11)
              .text_color(t.muted)
              .hover(s => s.bg(t.hover).text_color(t.blocked))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => this.clearAllBatches(cx))
              .child(svg(ICON_TRASH).size(11))
              .child("Clear All"),
          ),
      )
      // Global note input row
      .child(
        h_flex()
          .h(28)
          .px(8)
          .gap(6)
          .items_center()
          .rounded(5)
          .bg(t.input)
          .border(1)
          .border_color(t.border)
          .on_mouse_down("left", stop)
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .flex_none()
              .child("Global Note:"),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .child(
                Input.new(this.globalNoteInput)
                  .text_size(12)
                  .text_color(t.foreground),
              ),
          ),
      );
  }

  renderScreenshotSection(t, batch) {
    if (!batch?.screenshotRelPath) return null;
    const stop = (_e, cx) => cx.stop_propagation();

    return v_flex()
      .w_full()
      .rounded(8)
      .border(1)
      .border_color(t.border)
      .bg(t.surface)
      .overflow_hidden()
      .child(
        h_flex()
          .h(28)
          .px(10)
          .gap(8)
          .items_center()
          .bg(t.chrome)
          .border_b(this.showScreenshotPreview ? 1 : 0)
          .border_color(t.border)
          .child(
            div()
              .id("toggle-shot-preview")
              .text_size(11.5)
              .font_semibold()
              .text_color(t.foreground)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                this.showScreenshotPreview = !this.showScreenshotPreview;
                cx.notify();
              })
              .child(
                `${this.showScreenshotPreview ? "▾" : "▸"} Annotated Page Screenshot`,
              ),
          )
          .child(
            div()
              .text_size(11)
              .text_color(t.dim)
              .truncate()
              .flex_1()
              .child(batch.url || ""),
          )
          .child(
            div()
              .id("btn-chat-shot")
              .px(7)
              .py(2)
              .rounded(4)
              .bg(t.surface)
              .border(1)
              .border_color(t.border)
              .text_size(11)
              .text_color(t.muted)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                if (batch.screenshotAbsPath) {
                  pastePromptIntoAgent(
                    `@${batch.screenshotAbsPath}`,
                    cx,
                    this.targetSpec(),
                  );
                }
              })
              .child("+Chat @Screenshot"),
          ),
      )
      .when(this.showScreenshotPreview, el =>
        el.child(
          div()
            .w_full()
            .p(8)
            .flex()
            .justify_center()
            .bg(t.canvas)
            .child(
              image(batch.screenshotRelPath)
                .w_full()
                .max_h(260)
                .rounded(6),
            ),
        ),
      );
  }

  renderAnnotationCard(t, item, idx, workspaceCwd) {
    const stop = (_e, cx) => cx.stop_propagation();
    const num = item.index || idx + 1;
    const enabled = item.enabled !== false;
    const isEditing = this.editingItemId === item.id;
    const sourceRef = normalizeSourceRef(
      item.source?.fileName,
      item.source?.lineNumber,
      item.source?.endLineNumber,
      workspaceCwd,
    );

    const styleEntries = Object.entries(item.styles || {}).filter(
      ([, v]) => v !== undefined && v !== null && v !== "",
    );
    const monoFont = settings().font_family ?? "JetBrains Mono";

    return v_flex()
      .id(`annot-card-${item.id}`)
      .w_full()
      .p(10)
      .gap(7)
      .rounded(8)
      .border(1)
      .border_color(enabled ? t.border : t.chrome)
      .bg(enabled ? t.surface : t.chrome)
      .opacity(enabled ? 1 : 0.6)
      // Header row: [Checkbox] [#1 Badge] [Selector / Tag] [Source Ref] ... [Edit] [Paste #1] [Trash]
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .child(
            div()
              .id(`chk-${item.id}`)
              .size(16)
              .rounded(4)
              .flex()
              .items_center()
              .justify_center()
              .border(1)
              .border_color(enabled ? t.accent : t.border)
              .bg(enabled ? t.accent : t.input)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => this.toggleItemEnabled(item, cx))
              .when(enabled, el =>
                el.child(
                  svg(ICON_CHECK).size(11).text_color(t.accent_foreground),
                ),
              ),
          )
          .child(
            div()
              .px(6)
              .py(1)
              .rounded(10)
              .bg(t.accent)
              .text_size(11)
              .font_bold()
              .text_color(t.accent_foreground)
              .child(`#${num}`),
          )
          .when(Boolean(item.kind && item.kind !== "element"), el =>
            el.child(
              div()
                .px(5)
                .py(1)
                .rounded(4)
                .bg(t.selected)
                .text_size(10.5)
                .text_color(t.accent)
                .child(item.kind === "area" ? "Area" : "Selection"),
            ),
          )
          .child(
            div()
              .max_w(220)
              .truncate()
              .text_size(11.5)
              .font_family(monoFont)
              .text_color(t.foreground)
              .child(item.selector || (item.tagName ? `<${item.tagName}>` : "element")),
          )
          .when(Boolean(sourceRef), el =>
            el.child(
              div()
                .id(`src-${item.id}`)
                .px(6)
                .py(1)
                .rounded(4)
                .bg(t.selected)
                .border(1)
                .border_color(t.border)
                .text_size(11)
                .font_family(monoFont)
                .text_color(t.accent)
                .hover(s => s.bg(t.hover))
                .on_mouse_down("left", stop)
                .on_click((_e, cx) =>
                  pastePromptIntoAgent(sourceRef, cx, this.targetSpec()),
                )
                .child(sourceRef),
            ),
          )
          .child(div().flex_1())
          .child(
            div()
              .id(`edit-btn-${item.id}`)
              .px(6)
              .py(2)
              .rounded(4)
              .text_size(11)
              .text_color(t.muted)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                if (isEditing) this.commitItemEdit(cx);
                else this.startItemEdit(item, cx);
              })
              .child(isEditing ? "Save" : "Edit"),
          )
          .child(
            div()
              .id(`paste-one-${item.id}`)
              .px(7)
              .py(2)
              .rounded(4)
              .bg(t.chrome)
              .border(1)
              .border_color(t.border)
              .text_size(11)
              .text_color(t.foreground)
              .hover(s => s.bg(t.hover))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => this.pasteSingleItem(item, cx))
              .child(`+Chat #${num}`),
          )
          .child(
            div()
              .id(`del-item-${item.id}`)
              .p(3)
              .rounded(4)
              .text_color(t.dim)
              .hover(s => s.bg(t.hover).text_color(t.blocked))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => this.deleteItem(item.id, cx))
              .child(svg(ICON_TRASH).size(12)),
          ),
      )
      // Note row (either editable input or text)
      .child(
        isEditing
          ? h_flex()
              .h(28)
              .px(8)
              .items_center()
              .rounded(5)
              .bg(t.input)
              .border(1)
              .border_color(t.accent)
              .on_mouse_down("left", stop)
              .child(
                div()
                  .flex_1()
                  .min_w(0)
                  .child(
                    Input.new(this.itemEditInput)
                      .text_size(12.2)
                      .text_color(t.foreground),
                  ),
              )
          : div()
              .id(`note-text-${item.id}`)
              .px(8)
              .py(5)
              .rounded(5)
              .bg(t.background)
              .border_l(2)
              .border_color(t.accent)
              .text_size(12.3)
              .text_color(t.foreground)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => this.startItemEdit(item, cx))
              .child(item.note || "Click to add modification instructions…"),
      )
      // Component stack + text + bbox + styles metadata row
      .child(
        v_flex()
          .gap(3)
          .text_size(11)
          .text_color(t.muted)
          .when(Boolean(item.source?.componentPath), el =>
            el.child(
              h_flex()
                .gap(5)
                .items_center()
                .child(div().text_color(t.dim).child("Component:"))
                .child(
                  div()
                    .font_family(monoFont)
                    .text_color(t.muted)
                    .truncate()
                    .child(item.source.componentPath),
                ),
            ),
          )
          .when(Boolean(item.selectedText || item.text), el =>
            el.child(
              h_flex()
                .gap(5)
                .items_center()
                .child(
                  div()
                    .text_color(t.dim)
                    .child(item.selectedText ? "Selected:" : "Text:"),
                )
                .child(
                  div()
                    .text_color(t.foreground)
                    .truncate()
                    .child(`"${(item.selectedText || item.text).slice(0, 120)}"`),
                ),
            ),
          )
          .when(Boolean(item.rect || styleEntries.length > 0), el =>
            el.child(
              h_flex()
                .gap(6)
                .flex_wrap()
                .items_center()
                .when(Boolean(item.rect), row =>
                  row.child(
                    div()
                      .px(5)
                      .py(1)
                      .rounded(3)
                      .bg(t.chrome)
                      .font_family(monoFont)
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(
                        `${Math.round(item.rect.width)}×${Math.round(item.rect.height)}px @ (${Math.round(item.rect.x)}, ${Math.round(item.rect.y)})`,
                      ),
                  ),
                )
                .children(
                  styleEntries.slice(0, 5).map(([k, v]) =>
                    div()
                      .px(5)
                      .py(1)
                      .rounded(3)
                      .bg(t.chrome)
                      .font_family(monoFont)
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child(`${k}: ${v}`),
                  ),
                ),
            ),
          ),
      );
  }

  renderEmptyState(t) {
    const stop = (_e, cx) => cx.stop_propagation();
    const extPath = bundledExtensionDir();
    const isInstalled = Boolean(this.extStatus?.installed);
    const needsUpdate = Boolean(this.extStatus?.needsUpdate);
    const curVer = this.extStatus?.installedVersion || this.extStatus?.version || "1.0.0";
    const bundledVer = this.extStatus?.bundledVersion || "1.1.0";

    return v_flex()
      .flex_1()
      .w_full()
      .p(24)
      .gap(14)
      .items_center()
      .justify_center()
      .child(
        div()
          .size(44)
          .rounded(12)
          .flex()
          .items_center()
          .justify_center()
          .bg(t.selected)
          .border(1)
          .border_color(t.accent)
          .child(svg(ICON_REVIEW).size(22).text_color(t.accent)),
      )
      .child(
        div()
          .text_size(14.5)
          .font_semibold()
          .text_color(t.foreground)
          .child("UI Review — Inspect & Send to Herdr Agent"),
      )
      // Extension Installation & Update Card
      .child(
        v_flex()
          .max_w(470)
          .w_full()
          .p(14)
          .gap(10)
          .rounded(8)
          .bg(t.surface)
          .border(1)
          .border_color(
            !isInstalled ? t.accent : needsUpdate ? t.working : t.border,
          )
          .text_size(12)
          .text_color(t.muted)
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .child(
                div()
                  .size(8)
                  .rounded(4)
                  .bg(isInstalled && !needsUpdate ? t.done : t.working),
              )
              .child(
                div()
                  .font_semibold()
                  .text_size(12.5)
                  .text_color(t.foreground)
                  .child(
                    !isInstalled
                      ? "检测到尚未安装 Herdr Chrome 标注插件"
                      : needsUpdate
                        ? `发现新版本 Chrome 插件 (已安装 v${curVer} → 内置 v${bundledVer})`
                        : `Chrome 插件已是最新 (v${curVer})`,
                  ),
              )
              .child(div().flex_1())
              .when(isInstalled && !needsUpdate, el =>
                el.child(
                  div()
                    .id("btn-reinstall-ext")
                    .px(7)
                    .py(2)
                    .rounded(4)
                    .bg(t.chrome)
                    .border(1)
                    .border_color(t.border)
                    .text_size(11)
                    .text_color(t.muted)
                    .hover(s => s.bg(t.hover).text_color(t.foreground))
                    .on_mouse_down("left", stop)
                    .on_click((_e, cx) => this.installChromeExt(cx))
                    .child("重新加载插件"),
                ),
              ),
          )
          .when(!isInstalled || needsUpdate, el =>
            el
              .child(
                div()
                  .text_size(11.8)
                  .text_color(t.muted)
                  .child(
                    needsUpdate
                      ? `内置插件已升级至 v${bundledVer}，点击下方按钮即可一键热更新到 Chrome：`
                      : "点击下方按钮即可自动打开 Chrome 扩展中心并加载内置的标注插件（无需手动寻找目录）：",
                  ),
              )
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .child(
                    h_flex()
                      .id("btn-oneclick-install-ext")
                      .h(30)
                      .px(14)
                      .gap(6)
                      .items_center()
                      .rounded(6)
                      .bg(t.accent)
                      .text_size(12)
                      .font_semibold()
                      .text_color(t.accent_foreground)
                      .hover(s => s.opacity(0.92))
                      .on_mouse_down("left", stop)
                      .on_click((_e, cx) => this.installChromeExt(cx))
                      .child(
                        this.installingExt
                          ? needsUpdate
                            ? "正在自动更新到 Chrome…"
                            : "正在自动安装到 Chrome…"
                          : needsUpdate
                            ? `一键更新 Chrome 插件 (v${bundledVer})`
                            : "一键安装 Chrome 插件",
                      ),
                  )
                  .child(
                    h_flex()
                      .id("btn-reveal-ext-finder")
                      .h(30)
                      .px(10)
                      .items_center()
                      .rounded(6)
                      .bg(t.chrome)
                      .border(1)
                      .border_color(t.border)
                      .text_size(11.5)
                      .text_color(t.muted)
                      .hover(s => s.bg(t.hover).text_color(t.foreground))
                      .on_mouse_down("left", stop)
                      .on_click(() => this.revealExtInFinder())
                      .child("在 Finder 中显示"),
                  )
                  .child(
                    h_flex()
                      .id("btn-copy-ext-path")
                      .h(30)
                      .px(10)
                      .items_center()
                      .rounded(6)
                      .bg(t.chrome)
                      .border(1)
                      .border_color(t.border)
                      .text_size(11.5)
                      .text_color(t.muted)
                      .hover(s => s.bg(t.hover).text_color(t.foreground))
                      .on_mouse_down("left", stop)
                      .on_click((_e, cx) => {
                        cx.write_to_clipboard(extPath);
                        notify({
                          title: "Copied Extension Path",
                          body: extPath,
                          level: "info",
                          timeout: 2200,
                        });
                      })
                      .child("复制路径"),
                  ),
              ),
          )
          .child(
            v_flex()
              .gap(5)
              .pt(4)
              .border_t(1)
              .border_color(t.border)
              .text_size(11.5)
              .text_color(t.muted)
              .child(
                "• 在任意本地开发网页按 Alt+Shift+A（或点击插件图标）进入标注模式",
              )
              .child(
                "• 点选元素或拖拽框选区域添加 #1, #2, #3 批注（自动抓取 React/Vue 源码行号）",
              )
              .child(
                "• 按 ⌘Enter 一键连同带标号截图填入当前 Herdr Agent，或按 ⇧⌘Enter 直接发送执行",
              ),
          ),
      );
  }

  render(cx) {
    const t = theme();
    const batch = this.activeBatch();
    const workspaceCwd = currentWorkspaceContext().cwd;

    return v_flex()
      .id("ide-review-root")
      .track_focus(this.handle)
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(t.background)
      .border(1)
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .child(this.renderTopBar(t, batch, cx))
      .when(Boolean(batch), el =>
        el
          .child(this.renderBatchStrip(t, batch))
          .child(
            v_flex()
              .id("annotate-scroll-body")
              .flex_1()
              .min_h(0)
              .w_full()
              .p(10)
              .gap(10)
              .overflow_y_scrollbar()
              .track_scroll(this.scroll)
              .when(Boolean(batch.screenshotRelPath), body =>
                body.child(this.renderScreenshotSection(t, batch)),
              )
              .children(
                (batch.items || []).map((item, idx) =>
                  this.renderAnnotationCard(t, item, idx, workspaceCwd),
                ),
              ),
          ),
      )
      .when(!batch, el => el.child(this.renderEmptyState(t)));
  }
}
