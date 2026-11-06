import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, settings } from "herdr";
import {
  location,
  locationKey,
  READ,
  countLines,
  diffRows,
  findSubRepos,
  inspectRepoChanges,
} from "./git.js";

export default class IdeChanges extends View {
  init(_props, cx) {
    this.files = [];
    this.groups = [];
    this.foldedGroups = new Set();
    this.multiRepo = false;
    this.activeRepoRoot = null;
    this.activeRepoRel = "";
    this.rows = [];
    this.diffWidth = 0;
    this.message = "";
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => {
      this.typing = true;
      cx.notify();
    });
    this.input.on("blur", (_e, cx) => {
      this.typing = false;
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async cx => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch {
        this.watched = null;
      }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    const { cwd, on } = location();
    const context = locationKey();
    if (context !== this.context) {
      this.context = context;
      this.root = null;
      this.files = [];
      this.groups = [];
      this.multiRepo = false;
      this.activeRepoRoot = null;
      this.activeRepoRel = "";
      this.open = null;
      this.setLines([]);
      this.message = "";
      this.input.set_value("");
      this.error = null;
      this.note = null;
      this.watched = null;
      this.closed = false;
      this.limited = false;
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (locationKey() !== context) return;

        let repoResults = [];
        let multiRepo = false;

        if (top.code === 0 && top.stdout.trim()) {
          const singleRoot = top.stdout.trim();
          const res = await inspectRepoChanges(singleRoot, "", on);
          repoResults = [res];
        } else {
          const subRepos = await findSubRepos(cwd, on);
          if (locationKey() !== context) return;
          if (!subRepos.length) {
            this.root = null;
            this.files = [];
            this.groups = [];
            this.multiRepo = false;
            this.setLines([]);
            this.open = null;
            this.error = "Not a git repository";
            return;
          }
          multiRepo = true;
          repoResults = await Promise.all(
            subRepos.map(rel => inspectRepoChanges(`${cwd}/${rel}`, rel, on).catch(() => null)),
          );
          repoResults = repoResults.filter(Boolean);
        }

        if (locationKey() !== context) return;

        const activeGroups = multiRepo ? repoResults.filter(g => g.files.length > 0) : repoResults;
        const files = activeGroups.flatMap(g => g.files);
        const limited = activeGroups.some(g => g.limited);

        this.root = cwd;
        this.on = on;
        this.multiRepo = multiRepo;
        this.groups = activeGroups;
        this.files = files;
        this.limited = limited;
        this.error = null;
        this.watch(cwd, cx);

        if (this.open && !files.some(f => f.id === this.open)) {
          this.open = null;
          this.setLines([]);
        }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) {
          this.open = files[0].id;
        }
        const openFile = files.find(f => f.id === this.open) || files[0] || activeGroups[0];
        if (openFile && files.length > 0) {
          this.activeRepoRoot = openFile.repoRoot;
          this.activeRepoRel = openFile.repoRel || "";
        } else if (!multiRepo && repoResults[0]) {
          this.activeRepoRoot = repoResults[0].repoRoot;
          this.activeRepoRel = "";
        } else {
          this.activeRepoRoot = null;
          this.activeRepoRel = "";
        }

        if (this.open) {
          try {
            await this.load(this.open, context);
          } catch {
            if (locationKey() === context)
              this.setLines(["Cannot preview this diff (too large or unreadable)"]);
          }
        }
      } catch (e) {
        if (locationKey() === context) this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  async load(fileId, context) {
    const file = this.files.find(f => f.id === fileId);
    const on = this.on;
    if (!file) return;
    const root = file.repoRoot;
    const path = file.path;
    let lines;
    if (file.fresh || (!file.hasHead && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [
          `@@ -0,0 +1,${file.add} @@`,
          ...text
            .slice(0, 400000)
            .replace(/\n$/, "")
            .split("\n")
            .slice(0, 1500)
            .map(l => `+${l}`),
        ];
      }
    } else {
      const r = await exec(
        "git",
        [
          ...READ,
          "diff",
          ...(file.hasHead ? ["HEAD"] : []),
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--",
          path,
        ],
        { cwd: root, on },
      );
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n");
      const first = all.findIndex(l => l.startsWith("@@"));
      lines =
        first < 0
          ? [file.binary ? "Binary file changed" : "No text diff available"]
          : all.slice(first);
    }
    if (locationKey() === context && this.open === fileId) {
      this.setLines(
        lines
          .slice(0, 1500)
          .map(line => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line)),
      );
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(fileId, cx) {
    const file = this.files.find(f => f.id === fileId);
    if (file) {
      this.activeRepoRoot = file.repoRoot;
      this.activeRepoRel = file.repoRel || "";
    }
    this.open = this.open === fileId ? null : fileId;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open)
      cx.spawn(async cx => {
        try {
          await this.load(fileId, context);
        } catch (e) {
          if (locationKey() === context && this.open === fileId)
            this.note = `Cannot preview this diff (too large or unreadable): ${e}`;
        }
        cx.notify();
      });
    cx.notify();
  }

  toggleGroup(repoRel, repoRoot, cx) {
    this.activeRepoRoot = repoRoot;
    this.activeRepoRel = repoRel;
    if (this.foldedGroups.has(repoRel)) this.foldedGroups.delete(repoRel);
    else this.foldedGroups.add(repoRel);
    cx.notify();
  }

  commit(cx) {
    const targetRoot = this.activeRepoRoot || (!this.multiRepo ? this.root : null);
    if (
      !this.message.trim() ||
      !targetRoot ||
      this.busy ||
      this.loading ||
      this.context !== locationKey()
    )
      return;
    const on = this.on;
    const context = this.context;
    const message = this.message.trim();
    this.busy = true;
    this.note = null;
    cx.spawn(async cx => {
      try {
        for (const args of [
          ["add", "-A"],
          ["commit", "-m", message],
        ]) {
          const r = await exec("git", args, { cwd: targetRoot, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (locationKey() === context) {
          this.message = "";
          this.input.set_value("");
        }
      } catch (e) {
        if (locationKey() === context) this.note = `Commit failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx);
        cx.notify();
      }
    });
    cx.notify();
  }

  diffRow({ kind, number, text }, t) {
    if (kind === "@")
      return div()
        .w_full()
        .px(12)
        .h(20)
        .flex_none()
        .truncate()
        .bg(t.raised)
        .text_color(t.dim)
        .child(text);
    return h_flex()
      .w_full()
      .h(20)
      .flex_none()
      .gap(10)
      .when(kind === "+", e => e.bg(t.ansi2 + "18"))
      .when(kind === "-", e => e.bg(t.ansi1 + "18"))
      .child(
        div()
          .w(30)
          .flex_none()
          .text_right()
          .text_color(t.dim)
          .child(number === undefined ? "" : String(number)),
      )
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderFileRow(f, t, indented) {
    const parts = f.path.split("/");
    const name = parts.pop();
    return h_flex()
      .id(`change-${f.id}`)
      .h(28)
      .flex_none()
      .pl(indented ? 18 : 8)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(this.open === f.id, e => e.bg(t.selected))
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => this.pick(f.id, cx))
      .child(
        div()
          .w(14)
          .text_size(11)
          .text_color(
            f.status === "A"
              ? t.ansi2
              : f.status === "D"
                ? t.ansi1
                : f.status === "U"
                  ? t.ansi1
                  : t.blocked,
          )
          .child(f.status),
      )
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .child(
            div()
              .text_color(t.dim)
              .truncate()
              .child(parts.length ? parts.join("/") + "/" : ""),
          )
          .child(div().max_w(260).min_w(0).truncate().child(name)),
      )
      .when(f.add > 0, e => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, e => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
  }

  renderListItems(t) {
    if (!this.multiRepo) {
      return this.files.map(f => this.renderFileRow(f, t, false));
    }
    const items = [];
    for (const g of this.groups) {
      const folded = this.foldedGroups.has(g.repoRel);
      const gAdd = g.files.reduce((n, f) => n + f.add, 0);
      const gDel = g.files.reduce((n, f) => n + f.del, 0);
      const isTarget = this.activeRepoRoot === g.repoRoot;
      const displayBranch =
        g.branch && g.branch.length > 24 ? `${g.branch.slice(0, 23)}…` : g.branch;

      items.push(
        h_flex()
          .id(`change-group-${g.repoRel}`)
          .h(28)
          .flex_none()
          .px(8)
          .gap(6)
          .items_center()
          .rounded(7)
          .cursor_pointer()
          .bg(isTarget ? t.raised : t.background)
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.toggleGroup(g.repoRel, g.repoRoot, cx))
          .child(
            svg(`mods/ide-changes/chevron-${folded ? "right" : "down"}.svg`)
              .size(12)
              .flex_none()
              .text_color(t.dim),
          )
          .child(
            div().flex_none().font_semibold().text_size(12.5).text_color(t.foreground).child(g.repoRel),
          )
          .when(Boolean(displayBranch), el =>
            el.child(
              h_flex()
                .flex_none()
                .items_center()
                .text_size(11)
                .opacity(0.68)
                .child(div().text_color("#5b9bd5").child("git:("))
                .child(div().text_color("#e06c75").child(displayBranch))
                .child(div().text_color("#5b9bd5").child(")")),
            ),
          )
          .child(
            div()
              .px(5)
              .py(0.5)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .text_color(t.muted)
              .child(`${g.files.length}`),
          )
          .child(div().flex_1())
          .when(gAdd > 0, e => e.child(div().text_size(11).text_color(t.ansi2).child(`+${gAdd}`)))
          .when(gDel > 0, e => e.child(div().text_size(11).text_color(t.ansi1).child(`−${gDel}`))),
      );

      if (!folded) {
        for (const f of g.files) {
          items.push(this.renderFileRow(f, t, true));
        }
      }
    }
    return items;
  }

  render(cx) {
    if (locationKey() !== this.context) this.refresh(cx);
    const t = theme();
    const add = this.files.reduce((n, f) => n + f.add, 0);
    const del = this.files.reduce((n, f) => n + f.del, 0);
    const targetRoot = this.activeRepoRoot || (!this.multiRepo ? this.root : null);
    const enabled = Boolean(this.message.trim() && targetRoot && !this.busy && !this.loading);
    const listItems = this.renderListItems(t);
    const maxListHeight = this.multiRepo ? 240 : 200;

    return v_flex()
      .id("changes")
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) {
          this.typing = false;
          this.handle.focus();
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .h(42)
          .flex_none()
          .px(14)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(div().font_semibold().child("Changes"))
          .child(
            div()
              .px(5)
              .py(1)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .text_color(t.muted)
              .child(`${this.files.length} files`),
          )
          .when(this.multiRepo && this.groups.length > 0, el =>
            el.child(
              div()
                .px(5)
                .py(1)
                .rounded(4)
                .border_1()
                .border_color(t.border)
                .text_size(10)
                .text_color(t.dim)
                .child(`${this.groups.length} repos`),
            ),
          )
          .child(div().flex_1())
          .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`))
          .child(div().text_size(11).text_color(t.ansi1).child(`−${del}`)),
      )
      .child(
        v_flex()
          .id("changes-list")
          .flex_none()
          .h(Math.min(maxListHeight, Math.max(44, listItems.length * 28 + 12)))
          .overflow_y_scrollbar()
          .p(6)
          .border_b(1)
          .border_color(t.border)
          .children(listItems)
          .when(!this.files.length, e =>
            e.child(
              div()
                .p(8)
                .text_color(t.dim)
                .child(
                  this.error ||
                    (this.loading
                      ? "Loading changes…"
                      : this.root
                        ? "No uncommitted changes"
                        : "No folder"),
                ),
            ),
          ),
      )
      .when(this.limited, el =>
        el.child(
          div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files"),
        ),
      )
      .child(
        div()
          .flex_1()
          .min_h(0)
          .relative()
          .font_family(settings().font_family ?? "JetBrains Mono")
          .text_size(11)
          .child(
            div()
              .id("changes-diff-x")
              .size_full()
              .overflow_x_scrollbar()
              .child(
                div()
                  .w_full()
                  .min_w(this.diffWidth)
                  .h_full()
                  .child(
                    v_virtual_list(
                      "changes-diff",
                      this.rows.length,
                      20,
                      i => String(i),
                      range =>
                        this.rows
                          .slice(range.start, range.end)
                          .map(row => this.diffRow(row, t)),
                    ).size_full(),
                  ),
              ),
          )
          .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
          .when(!this.open && this.files.length > 0, e =>
            e.child(
              div()
                .absolute()
                .top(6)
                .px(12)
                .text_color(t.dim)
                .child("Select a file to view its changes"),
            ),
          ),
      )
      .when(Boolean(this.note), e =>
        e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)),
      )
      .child(
        h_flex()
          .flex_none()
          .p(10)
          .gap(8)
          .border_t(1)
          .border_color(t.border)
          .when(Boolean(this.multiRepo && this.activeRepoRel), el =>
            el.child(
              div()
                .flex_none()
                .h(32)
                .px(8)
                .flex()
                .items_center()
                .rounded(8)
                .bg(t.raised)
                .border_1()
                .border_color(t.border)
                .text_size(11)
                .text_color(t.muted)
                .child(this.activeRepoRel),
            ),
          )
          .child(
            div()
              .id("commit-message")
              .flex_1()
              .min_w(0)
              .h(32)
              .px(10)
              .flex()
              .items_center()
              .rounded(8)
              .border_1()
              .border_color(this.typing ? t.accent : t.border)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)),
          )
          .child(
            div()
              .id("commit")
              .h(32)
              .px(14)
              .flex()
              .items_center()
              .rounded(8)
              .bg(enabled ? t.solid : t.raised)
              .text_color(enabled ? t.solid_foreground : t.dim)
              .text_size(12)
              .when(enabled, e => e.cursor_pointer())
              .on_click((_e, cx) => this.commit(cx))
              .child(this.busy ? "Committing…" : "Commit"),
          ),
      );
  }
}
