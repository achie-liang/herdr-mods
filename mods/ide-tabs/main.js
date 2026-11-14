import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import {
  spaces,
  panes,
  run,
  openOverlay,
  theme,
  window,
  shared,
  layout,
  settings,
  exec,
  readTextFile,
  writeTextFile,
  watchFolder,
  notify,
  appHome,
  nextCommand,
} from "herdr";
import {
  annotationsDir,
  queueFilePath,
  commandFilePath,
  contextFilePath,
  currentWorkspaceContext,
  formatMultiBatchPrompt,
  pastePromptIntoAgent,
  sendPromptToAgent,
} from "./format.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class IdeTabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.annotationCount = 0;
    this.lastCommandId = localStorage.getItem("ide-annotate.lastCmdId") || null;
    this.lastContextKey = "";
    this.watchingAnnotations = false;

    cx.spawn(async cx => {
      for (;;) {
        const cmd = await nextCommand();
        if (!cmd) continue;
        if (cmd === "toggle_review" || cmd === "toggle_annotate") {
          this.togglePanel("review");
        }
        cx.notify();
      }
    });

    this.bootstrapAnnotationBridge(cx);
    cx.timer.every(6000, cx => {
      this.syncAnnotationContext();
      this.checkAnnotationQueue(cx);
    });
  }

  async bootstrapAnnotationBridge(cx) {
    try {
      const base = appHome();
      const script = `${base}/mods/ide-review/bridge.mjs`;
      await exec("node", [script, "--daemon", "--app-home", base]);
      await this.syncAnnotationContext();
      await this.checkAnnotationQueue(cx);
      this.startAnnotationWatch(cx);
    } catch {}
  }

  startAnnotationWatch(cx) {
    if (this.watchingAnnotations) return;
    this.watchingAnnotations = true;
    const dir = annotationsDir();
    cx.spawn(async cx => {
      try {
        while (this.watchingAnnotations) {
          await watchFolder(dir);
          await this.checkAnnotationQueue(cx);
        }
      } catch {
        this.watchingAnnotations = false;
      }
    });
  }

  async syncAnnotationContext() {
    try {
      const ctx = currentWorkspaceContext();
      const key = JSON.stringify({
        cwd: ctx.cwd,
        focused: ctx.focused,
        activeSpace: ctx.activeSpace,
        agents: ctx.agents.map(
          a => `${a.address}:${a.status}:${a.focused}:${a.sessionName || ""}:${a.displayLabel || ""}`,
        ),
      });
      if (key === this.lastContextKey) return;
      this.lastContextKey = key;
      const path = contextFilePath();
      const prev = await readTextFile(path);
      await writeTextFile(path, JSON.stringify(ctx, null, 2), prev);
    } catch {}
  }

  async checkAnnotationQueue(cx) {
    try {
      const qRaw = await readTextFile(queueFilePath());
      let batches = [];
      if (qRaw) {
        const parsed = JSON.parse(qRaw);
        batches = Array.isArray(parsed?.batches) ? parsed.batches : [];
      }
      const nextCount = batches.reduce(
        (acc, b) => acc + (Array.isArray(b.items) ? b.items.length : 0),
        0,
      );
      if (nextCount !== this.annotationCount) {
        this.annotationCount = nextCount;
        cx.notify();
      }

      const cmdRaw = await readTextFile(commandFilePath());
      if (!cmdRaw) return;
      const cmd = JSON.parse(cmdRaw);
      if (!cmd?.id || cmd.id === this.lastCommandId) return;
      // Ignore stale commands older than 30s on cold restart
      if (cmd.createdAt && Date.now() - cmd.createdAt > 30000) {
        this.lastCommandId = cmd.id;
        localStorage.setItem("ide-annotate.lastCmdId", cmd.id);
        return;
      }

      this.lastCommandId = cmd.id;
      localStorage.setItem("ide-annotate.lastCmdId", cmd.id);

      const batch = batches.find(b => b.id === cmd.batchId) || batches[0];
      if (!batch) return;

      const targetAddr = cmd.targetTerminal || batch.targetTerminal || null;
      const agentBatches = targetAddr
        ? batches.filter(
            b => !b.targetTerminal || b.targetTerminal === targetAddr,
          )
        : [batch];

      const target = {
        terminal: targetAddr,
        pane: cmd.targetPane || batch.targetPane || null,
      };

      if (cmd.action === "stage") {
        run("layout.select", { stack: "panel-body", child: "review" });
        run("layout.show", { id: "panel" });
        notify({
          title: "UI Review Staged",
          body: `${(batch.items || []).length} items ready in Review panel`,
          level: "info",
          timeout: 3000,
        });
      } else if (cmd.action === "send") {
        const text = formatMultiBatchPrompt(agentBatches, {
          includeScreenshot: true,
        });
        if (text) {
          await sendPromptToAgent(text, cx, target);
          const sentIds = new Set(agentBatches.map(b => b.id));
          const remaining = batches.filter(b => !sentIds.has(b.id));
          await writeTextFile(
            queueFilePath(),
            JSON.stringify({ batches: remaining }, null, 2),
            qRaw,
          );
          this.annotationCount = remaining.reduce(
            (acc, b) => acc + (Array.isArray(b.items) ? b.items.length : 0),
            0,
          );
        }
      } else {
        // Default: "paste"
        const text = formatMultiBatchPrompt(agentBatches, {
          includeScreenshot: true,
        });
        if (text) {
          pastePromptIntoAgent(text, cx, target);
          const sentIds = new Set(agentBatches.map(b => b.id));
          const remaining = batches.filter(b => !sentIds.has(b.id));
          await writeTextFile(
            queueFilePath(),
            JSON.stringify({ batches: remaining }, null, 2),
            qRaw,
          );
          this.annotationCount = remaining.reduce(
            (acc, b) => acc + (Array.isArray(b.items) ? b.items.length : 0),
            0,
          );
        }
      }
      cx.notify();
    } catch {}
  }

  togglePanel(id) {
    const root = layout();
    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const on = panel && !panel.hidden && body?.active === id;
    if (on) {
      run("layout.hide", { id: "panel" });
    } else {
      run("layout.select", { stack: "panel-body", child: id });
      run("layout.show", { id: "panel" });
    }
  }

  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null;
        const want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) {
            run("layout.select", { stack: "panel-body", child: want });
            run("layout.show", { id: "panel" });
          } else {
            run("layout.hide", { id: "panel" });
          }
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    this.syncAnnotationContext();

    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) =>
      div()
        .id(id)
        .size(26)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", stop)
        .on_click(action)
        .child(label);

    const item = (c, i) => {
      const program =
        panes().find(p => p.tab === c.id && p.program?.agent)?.program ??
        panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex()
        .id(`tab-${c.id}`)
        .h(29)
        .px(10)
        .gap(7)
        .rounded(7)
        .items_center()
        .flex_none()
        .text_size(12.8)
        .when(i <= active, el =>
          el.on_size_change((_size, cx) => {
            this.scroll.scroll_to_item(active);
            cx.notify();
          }),
        )
        .border(1)
        .border_color(c.active ? t.border : t.chrome)
        .bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          this.pressed = i;
          if (e.click_count === 2) run("tab.rename", { id: c.id });
        })
        .on_mouse_up("left", () => {
          const from = this.pressed;
          this.pressed = null;
          if (from !== null && from !== i) {
            run("tab.move", {
              id: shown[from].id,
              index: space.tabs.findIndex(x => x.id === c.id) + 1,
            });
          } else {
            run("tab.select", { id: c.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "menu",
            kind: "popup",
            width: 200,
            props: { tab: "tab", target: { id: c.id, space: space.id } },
          });
        })
        .when(Boolean(program?.icon), el =>
          el.child(
            program.tint
              ? svg(program.icon).size(14).text_color(t.muted)
              : image(program.icon).size(14),
          ),
        )
        .child(
          div()
            .max_w(170)
            .truncate()
            .child(c.zoomed ? `${name} Z` : name),
        )
        .when(c.status === "working", el =>
          el.child(
            svg("mods/workspace-chrome/spinner.svg")
              .size(12)
              .flex_none()
              .text_color(t.working)
              .spin(900),
          ),
        )
        .when(c.status === "blocked" || c.status === "done", el =>
          el.child(div().size(6).rounded(3).bg(t[c.status])),
        )
        .when(c.active, el =>
          el.child(
            div()
              .id(`close-${c.id}`)
              .text_color(t.dim)
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                run("tab.close", { id: c.id });
              })
              .child(svg("mods/pane/close.svg").size(12)),
          ),
        );
    };

    const root = layout();
    const sidebar = find(root, "sidebar");
    const w = window();
    const lightsPadding =
      w?.platform === "macos" &&
      w.titlebar === "none" &&
      !w.fullscreen &&
      root?.traffic_lights
        ? Math.max(
            10,
            (root.traffic_lights[0] + 64) / settings().zoom -
              (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0),
          )
        : 10;

    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    const rawEnabled = shared("workspace.panels") ?? [
      "files",
      "changes",
      "review",
    ];
    const enabled = rawEnabled.includes("review")
      ? rawEnabled
      : [...rawEnabled, "review"];
    this.syncPanel(space, panel, body, enabled);

    const panelButton = (id, label, icon, badgeCount = 0) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex()
        .id(`panel-${id}`)
        .h(26)
        .px(8)
        .gap(5)
        .flex_none()
        .items_center()
        .rounded(6)
        .text_size(12)
        .bg(on ? t.selected : t.chrome)
        .text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => this.togglePanel(id))
        .child(svg(icon).size(14))
        .child(label)
        .when(badgeCount > 0, el =>
          el.child(
            div()
              .px(5)
              .py(1)
              .rounded(8)
              .bg(t.accent)
              .text_size(10)
              .font_bold()
              .text_color(t.accent_foreground)
              .child(`${badgeCount}`),
          ),
        );
    };

    return h_flex()
      .size_full()
      .min_w(0)
      .px(10)
      .pl(lightsPadding)
      .gap(3)
      .items_center()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .on_mouse_up("left", () => {
        this.pressed = null;
      })
      .on_scroll_wheel(e => {
        if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next");
      })
      .child(
        h_flex()
          .id("tab-scroll")
          .flex_1()
          .min_w(0)
          .h_full()
          .items_center()
          .gap(3)
          .overflow_x_scrollbar()
          .track_scroll(this.scroll)
          .on_size_change((_size, cx) => {
            if (active >= 0) {
              this.scroll.scroll_to_item(active);
              cx.notify();
            }
          })
          .children(shown.map(item)),
      )
      .child(
        button("tab-new", "+", () =>
          openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }),
        ),
      )
      .when(enabled.includes("files"), el =>
        el.child(panelButton("files", "Files", "mods/files/file.svg")),
      )
      .when(enabled.includes("changes"), el =>
        el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")),
      )
      .when(enabled.includes("review"), el =>
        el.child(
          panelButton(
            "review",
            "Review",
            "mods/ide-review/review.svg",
            this.annotationCount,
          ),
        ),
      )
      .when(w?.buttons, el =>
        el
          .child(
            button(
              "minimize",
              w.platform === "windows"
                ? svg("mods/ide-tabs/win-min.svg").size(16)
                : "−",
              () => run("window.minimize"),
            ),
          )
          .child(
            button(
              "maximize",
              w.platform === "windows"
                ? svg(
                    `mods/ide-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`,
                  ).size(16)
                : "□",
              () => run("window.maximize"),
            ),
          )
          .child(
            button(
              "close-window",
              w.platform === "windows"
                ? svg("mods/ide-tabs/win-close.svg").size(16)
                : svg("mods/pane/close.svg").size(13),
              () => run("window.close"),
            ),
          ),
      );
  }
}
