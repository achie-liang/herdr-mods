// IDE-style file explorer with Cursor-like split layout:
// - Persistent left pane: File Viewer (with Markdown Preview/Source, Lines/Syntax, In-File Find)
//   or Quick Open ("Files, Folders..." search + Recents) when no file is open.
// - Collapsible right sidebar: switches between File Tree (Explorer) and Workspace Search & Replace.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState } from "gpui-base";
import {
  focused,
  exec,
  watchFolder,
  theme,
  notify,
  nextCommand,
} from "herdr";
import { getFileIcon, ICON_PREFIX } from "./icons.js";
import {
  PER_FOLDER,
  TOTAL,
  RIGHT_SIDEBAR_WIDTH,
  GIT_COLOR,
  GIT_DOT_COLOR,
  STATUS_PRIORITY,
  location,
  locationKey,
  formatRef,
  pasteIntoTerminal,
} from "./utils.js";
import { listDirectory, inspectGitRepo, renderGitBranchSubtitle } from "./git.js";
import { searchMethods } from "./search.js";
import { previewMethods } from "./preview.js";

const STORAGE_KEY = "ide-files.saved";

export default class IdeFiles extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.saved = new Map();
    try {
      const raw = JSON.parse(
        localStorage.getItem(STORAGE_KEY) ||
          localStorage.getItem("my-files.saved") ||
          "{}",
      );
      for (const [k, v] of Object.entries(raw)) {
        this.saved.set(k, {
          folders: new Set(v.folders || []),
          recents: Array.isArray(v.recents) ? v.recents : [],
          file: null,
        });
      }
    } catch {}
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.folderMarks = {};
    this.ignored = new Set();
    this.branches = {};
    this.repos = new Set();
    this.lines = [];
    this.rawText = "";
    this.mdPreview = true;
    this.lineScroll = 0;
    this.linesViewHeight = 520;
    this.scrollbarDrag = false;
    this.selStart = null;
    this.selEnd = null;
    this.selectingLines = false;
    this.rawEditor = false;
    this.drag = null;
    this.lastTarget = null;
    this.pendingMenu = null;
    this.contextMenu = null;
    this.panelSize = { width: 680, height: 600 };

    // Navigation history & Recents & Quick Open state
    this.history = [null];
    this.historyIdx = 0;
    this.recents = [];
    this.wsIndex = [];
    this.wsIndexRoot = null;
    this.wsIndexLoading = false;
    this.quickQuery = "";
    this.quickFocused = false;
    this.quickInput = InputState.new({ placeholder: "Files, Folders..." });
    this.quickInput.on("change", (_e, cx) => {
      this.quickQuery = this.quickInput.value();
      cx.notify();
    });
    this.quickInput.on("submit", (_e, cx) => {
      const matches = this.filteredQuickEntries();
      if (matches.length > 0) {
        const first = matches[0];
        if (first.isDir) {
          this.rightSidebarCollapsed = false;
          this.searchMode = false;
          this.revealFileInTree(`${first.path}/_`, cx);
        } else {
          this.show(first.path, cx);
        }
        cx.notify();
      }
    });
    this.quickInput.on("focus", (_e, cx) => {
      this.quickFocused = true;
      cx.notify();
    });
    this.quickInput.on("blur", (_e, cx) => {
      this.quickFocused = false;
      cx.notify();
    });

    // Right sidebar state (Explorer vs Search, collapsible)
    this.rightSidebarCollapsed = false;
    this.searchMode = false;

    // In-file Find state
    this.findOpen = false;
    this.findFocused = false;
    this.findQuery = "";
    this.findCase = false;
    this.findWord = false;
    this.findRegex = false;
    this.findRegexError = null;
    this.findMatches = [];
    this.findMatchesByLine = new Map();
    this.findActiveIdx = 0;
    this.findInput = InputState.new({ placeholder: "Find" });
    this.findInput.on("change", (_e, cx) => {
      this.findQuery = this.findInput.value();
      if (this.rawEditor && this.findQuery) this.rawEditor = false;
      this.recomputeFileMatches(true);
      cx.notify();
    });
    this.findInput.on("submit", (e, cx) => {
      this.stepFileMatch(e?.shift ? -1 : 1, cx);
    });
    this.findInput.on("focus", (_e, cx) => {
      this.findFocused = true;
      cx.notify();
    });
    this.findInput.on("blur", (_e, cx) => {
      this.findFocused = false;
      cx.notify();
    });

    // Workspace Search Files state
    this.wsShowDetails = true;
    this.wsQuery = "";
    this.wsReplace = "";
    this.wsInclude = "";
    this.wsExclude = "";
    this.wsCase = false;
    this.wsWord = false;
    this.wsRegex = false;
    this.wsPreserveCase = false;
    this.wsRegexError = null;
    this.wsSearching = false;
    this.wsReplacing = false;
    this.wsGroups = [];
    this.wsTotalMatches = 0;
    this.wsFoldedFiles = new Set();
    this.wsHoveredFile = null;
    this.wsSearchSeq = 0;
    this.wsSearchFocused = false;
    this.wsReplaceFocused = false;
    this.wsIncludeFocused = false;
    this.wsExcludeFocused = false;

    this.wsSearchInput = InputState.new({ placeholder: "Search" });
    this.wsSearchInput.on("change", (_e, cx) => {
      this.wsQuery = this.wsSearchInput.value();
      this.scheduleWorkspaceSearch(cx);
      cx.notify();
    });
    this.wsSearchInput.on("submit", (_e, cx) => {
      this.executeWorkspaceSearch(cx);
    });
    this.wsSearchInput.on("focus", (_e, cx) => {
      this.wsSearchFocused = true;
      cx.notify();
    });
    this.wsSearchInput.on("blur", (_e, cx) => {
      this.wsSearchFocused = false;
      cx.notify();
    });

    this.wsReplaceInput = InputState.new({ placeholder: "Replace" });
    this.wsReplaceInput.on("change", (_e, cx) => {
      this.wsReplace = this.wsReplaceInput.value();
      cx.notify();
    });
    this.wsReplaceInput.on("submit", (_e, cx) => {
      this.replaceAllInWorkspace(cx);
    });
    this.wsReplaceInput.on("focus", (_e, cx) => {
      this.wsReplaceFocused = true;
      cx.notify();
    });
    this.wsReplaceInput.on("blur", (_e, cx) => {
      this.wsReplaceFocused = false;
      cx.notify();
    });

    this.wsIncludeInput = InputState.new({
      placeholder: "Files to include (e.g. *.ts, src/**/*.py)",
    });
    this.wsIncludeInput.on("change", (_e, cx) => {
      this.wsInclude = this.wsIncludeInput.value();
      this.scheduleWorkspaceSearch(cx);
      cx.notify();
    });
    this.wsIncludeInput.on("submit", (_e, cx) => {
      this.executeWorkspaceSearch(cx);
    });
    this.wsIncludeInput.on("focus", (_e, cx) => {
      this.wsIncludeFocused = true;
      cx.notify();
    });
    this.wsIncludeInput.on("blur", (_e, cx) => {
      this.wsIncludeFocused = false;
      cx.notify();
    });

    this.wsExcludeInput = InputState.new({ placeholder: "Files to exclude" });
    this.wsExcludeInput.on("change", (_e, cx) => {
      this.wsExclude = this.wsExcludeInput.value();
      this.scheduleWorkspaceSearch(cx);
      cx.notify();
    });
    this.wsExcludeInput.on("submit", (_e, cx) => {
      this.executeWorkspaceSearch(cx);
    });
    this.wsExcludeInput.on("focus", (_e, cx) => {
      this.wsExcludeFocused = true;
      cx.notify();
    });
    this.wsExcludeInput.on("blur", (_e, cx) => {
      this.wsExcludeFocused = false;
      cx.notify();
    });

    // Listen for mod key commands (cmd-f, cmd-shift-f, cmd-g, cmd-shift-g, focus)
    cx.spawn(async cx => {
      for (;;) {
        const cmd = await nextCommand();
        if (!cmd) continue;
        if (cmd === "focus") {
          this.handle.focus();
        } else if (cmd === "find") {
          if (this.file) this.openFileFind(cx);
          else this.quickInput.focus();
        } else if (cmd === "search_files") {
          this.openWorkspaceSearch(cx);
        } else if (cmd === "find_next") {
          if (this.file && this.findOpen) this.stepFileMatch(1, cx);
        } else if (cmd === "find_prev") {
          if (this.file && this.findOpen) this.stepFileMatch(-1, cx);
        }
        cx.notify();
      }
    });

    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  persistFolders() {
    if (!this.context?.key) return;
    this.saved.set(this.context.key, {
      folders: new Set(this.folders),
      recents: [...(this.recents || [])],
      file: this.file,
      history: [...(this.history || [null])],
      historyIdx: this.historyIdx || 0,
    });
    try {
      const obj = {};
      for (const [k, v] of this.saved.entries()) {
        obj[k] = {
          folders: [...(v.folders || [])],
          recents: [...(v.recents || [])],
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {}
  }

  rememberTarget() {
    const f = focused();
    if (f?.pane || f?.terminal) {
      this.lastTarget = { pane: f.pane ?? null, terminal: f.terminal ?? null };
    }
    return this.lastTarget || f;
  }

  chooseMenuItem(it, cx) {
    const target = this.contextMenu?.target || this.rememberTarget();
    this.contextMenu = null;
    if (!it) {
      cx.notify();
      return;
    }
    if (it.action === "chat") {
      pasteIntoTerminal(it.value, cx, target);
    } else if (it.action === "copy") {
      cx.write_to_clipboard(it.value);
      notify({ title: "Copied", body: it.label, timeout: 1500 });
    } else if (it.action === "find") {
      this.openFileFind(cx);
    }
    cx.notify();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.current(context)) this.refresh(cx);
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
    });
  }

  current(context) {
    return this.context === context && locationKey() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const fullDir = path ? `${root}/${path}` : root;
    let entries;
    try {
      entries = await listDirectory(fullDir, on);
    } catch (e) {
      if (path) {
        this.folders.delete(path);
        this.entries.delete(path);
        this.persistFolders();
        return [];
      }
      throw e;
    }
    if (!this.current(context) || (path && !this.folders.has(path))) return [];
    const used = [...this.entries.entries()]
      .filter(([p]) => p !== path)
      .reduce((n, [, e]) => n + e.length, 0);
    const sorted = entries
      .slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used)))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    this.entries.set(path, sorted);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
    const newGitDirs = [];
    for (const e of sorted) {
      if (e.git) {
        const sub = path ? `${path}/${e.name}` : e.name;
        const abs = `${root}/${sub}`;
        this.repos.add(abs);
        newGitDirs.push(abs);
      }
    }
    return newGitDirs;
  }

  applyRepoResults(results) {
    const marks = { ...this.marks };
    const folderMarks = { ...this.folderMarks };
    const ignored = new Set(this.ignored);
    const branches = { ...this.branches };

    for (const r of results) {
      if (!r) continue;
      const prefix = `${r.repoDir}/`;
      for (const k of Object.keys(marks)) if (k.startsWith(prefix)) delete marks[k];
      for (const k of Object.keys(folderMarks))
        if (k === r.repoDir || k.startsWith(prefix)) delete folderMarks[k];
      for (const k of [...ignored]) if (k === r.repoDir || k.startsWith(prefix)) ignored.delete(k);

      if (r.branch) branches[r.repoDir] = r.branch;
      Object.assign(marks, r.fileMarks);
      for (const [dir, m] of Object.entries(r.folderMarks)) {
        const prev = folderMarks[dir];
        if (!prev || (STATUS_PRIORITY[m] ?? 0) > (STATUS_PRIORITY[prev] ?? 0)) {
          folderMarks[dir] = m;
        }
      }
      const repoMark = folderMarks[r.repoDir];
      if (repoMark && this.root && r.repoDir.startsWith(this.root + "/")) {
        let cur = r.repoDir;
        while (cur.length > this.root.length) {
          const slash = cur.lastIndexOf("/");
          if (slash <= this.root.length) break;
          cur = cur.slice(0, slash);
          const prev = folderMarks[cur];
          if (!prev || (STATUS_PRIORITY[repoMark] ?? 0) > (STATUS_PRIORITY[prev] ?? 0)) {
            folderMarks[cur] = repoMark;
          }
        }
      }
      for (const ig of r.ignored) ignored.add(ig);
    }

    this.marks = marks;
    this.folderMarks = folderMarks;
    this.ignored = ignored;
    this.branches = branches;
  }

  isIgnored(absPath) {
    if (this.ignored.has(absPath)) return true;
    let cur = absPath;
    const minLen = this.root ? this.root.length : 0;
    while (cur.length > minLen) {
      const slash = cur.lastIndexOf("/");
      if (slash <= minLen) break;
      cur = cur.slice(0, slash);
      if (this.ignored.has(cur)) return true;
    }
    return false;
  }

  refresh(cx) {
    this.rememberTarget();
    const { cwd, on } = location();
    const next = locationKey();
    if (next !== this.context?.key) {
      if (this.context) {
        this.saved.set(this.context.key, {
          folders: this.folders,
          recents: this.recents || [],
          file: this.file,
          history: this.history || [null],
          historyIdx: this.historyIdx || 0,
        });
      }
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on };
      this.root = cwd;
      this.on = on;
      this.entries = new Map();
      this.folders = new Set(saved?.folders);
      this.recents = [...(saved?.recents || [])];
      this.history = saved?.history?.length ? [...saved.history] : [null];
      this.historyIdx = typeof saved?.historyIdx === "number" ? saved.historyIdx : 0;
      this.pending = new Set();
      this.marks = {};
      this.folderMarks = {};
      this.ignored = new Set();
      this.branches = {};
      this.repos = new Set();
      this.wsIndex = [];
      this.wsIndexRoot = null;
      this.wsIndexLoading = false;
      this.quickQuery = "";
      this.quickInput.set_value("");
      this.show(null, null, { fromHistory: true });
      this.watched = null;
      this.error = null;
      this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx, { fromHistory: true });
      if (this.searchMode && this.wsQuery) this.executeWorkspaceSearch(cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        this.repos = new Set();
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(
          () => null,
        );
        if (top?.code === 0 && top.stdout.trim()) {
          this.repos.add(top.stdout.trim());
        }
        const repoList = [...this.repos];
        const results = await Promise.all(repoList.map(r => inspectGitRepo(r, on)));
        if (!this.current(context)) return;
        this.marks = {};
        this.folderMarks = {};
        this.ignored = new Set();
        this.branches = {};
        this.applyRepoResults(results);
        this.error = null;
        this.watch(cwd, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.context === context) this.loading = false;
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders])
        if (folder === path || folder.startsWith(path + "/")) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try {
            const newGitDirs = await this.loadFolder(path, context);
            if (this.current(context)) {
              const absDir = `${context.cwd}/${path}`;
              const toInspect = [...newGitDirs];
              if (this.repos.has(absDir)) toInspect.push(absDir);
              if (toInspect.length) {
                const res = await Promise.all(
                  toInspect.map(r => inspectGitRepo(r, context.on)),
                );
                if (this.current(context)) this.applyRepoResults(res);
              }
            }
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.context === context) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
    this.persistFolders();
  }

  collapseAll(cx) {
    if (this.searchMode) {
      if (this.wsFoldedFiles.size < this.wsGroups.length) {
        this.wsFoldedFiles = new Set(this.wsGroups.map(g => g.path));
      } else {
        this.wsFoldedFiles.clear();
      }
      cx.notify();
      return;
    }
    this.folders.clear();
    for (const k of [...this.entries.keys()]) {
      if (k !== "") this.entries.delete(k);
    }
    this.persistFolders();
    cx.notify();
  }

  buildEntryMenuItems(path, dir, lineNo = null) {
    const ref = formatRef(path, dir, lineNo, lineNo);
    const full = this.root ? `${this.root}/${path}` : path;
    return [
      { label: `Add to Chat (${ref})`, action: "chat", value: ref },
      { label: `Copy ${ref}`, action: "copy", value: ref, divider: true },
      { label: "Copy Relative Path", action: "copy", value: dir ? `${path}/` : path },
      { label: "Copy Full Path", action: "copy", value: full },
    ];
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absPath = `${this.root}/${path}`;
      const open = this.folders.has(path);
      const fileMark = !entry.dir ? this.marks[absPath] : null;
      const folderMark = entry.dir ? this.folderMarks[absPath] : null;
      const ignored = !fileMark && !folderMark && this.isIgnored(absPath);
      const branch = entry.dir ? this.branches[absPath] : null;
      const ref = formatRef(path, entry.dir);
      const isDragged = this.drag?.path === path && this.drag?.moved;
      const isActiveFile = !entry.dir && this.file === path;
      const fileIcon = !entry.dir ? getFileIcon(entry.name) : null;

      const labelColor = fileMark
        ? (GIT_COLOR[fileMark] ?? t.foreground)
        : folderMark
          ? (GIT_COLOR[folderMark] ?? t.foreground)
          : ignored
            ? t.dim
            : t.foreground;

      const guides = [];
      for (let d = 0; d < depth; d++) {
        guides.push(
          div()
            .w(16)
            .h_full()
            .flex_none()
            .pl(7)
            .child(div().w(1).h_full().bg(t.border).opacity(0.6)),
        );
      }

      out.push(
        h_flex()
          .id(`file-${path}`)
          .h(24)
          .flex_none()
          .mx(4)
          .pl(6)
          .pr(8)
          .rounded(5)
          .items_center()
          .cursor_pointer()
          .when(isActiveFile, el => el.bg(t.selected))
          .when(isDragged, el => el.bg(t.selected).opacity(0.75))
          .when(!isActiveFile, el => el.hover(s => s.bg(t.hover)))
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.contextMenu = null;
            this.handle.focus();
            const target = this.rememberTarget();
            this.drag = {
              kind: "entry",
              path,
              dir: entry.dir,
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
            } else if (d.path === path) {
              if (entry.dir) this.toggle(path, cx);
              else this.show(path, cx);
            }
            cx.notify();
          })
          .on_mouse_down("right", () => {
            this.pendingMenu = this.buildEntryMenuItems(path, entry.dir);
          })
          .children(guides)
          .child(
            div()
              .w(16)
              .h_full()
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .mr(5)
              .child(
                entry.dir
                  ? svg(`${ICON_PREFIX}/codicon-chevron-${open ? "down" : "right"}.svg`)
                      .size(13)
                      .flex_none()
                      .text_color(ignored ? t.dim : t.muted)
                  : svg(fileIcon.svg)
                      .size(15)
                      .flex_none()
                      .text_color(fileIcon.color)
                      .when(ignored, s => s.opacity(0.55)),
              ),
          )
          .when(Boolean(branch), el =>
            el
              .child(div().flex_none().mr(6).text_color(labelColor).child(entry.name))
              .child(renderGitBranchSubtitle(branch, t)),
          )
          .when(!branch, el =>
            el.child(div().flex_1().min_w(0).truncate().text_color(labelColor).child(entry.name)),
          )
          .when(Boolean(fileMark), el =>
            el.child(
              div()
                .flex_none()
                .ml(6)
                .text_size(11)
                .font_semibold()
                .text_color(GIT_COLOR[fileMark] ?? t.muted)
                .child(fileMark),
            ),
          )
          .when(Boolean(folderMark), el =>
            el.child(
              div()
                .flex_none()
                .ml(6)
                .size(6)
                .rounded(3)
                .bg(GIT_DOT_COLOR[folderMark] ?? t.dim),
            ),
          ),
      );
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  renderExplorerSidebar(t) {
    const rootName = this.root?.split(/[\\/]/).pop() || "files";
    const rootBranch = this.root ? this.branches[this.root] : null;

    return v_flex()
      .id("files-explorer-sidebar")
      .w(RIGHT_SIDEBAR_WIDTH)
      .flex_none()
      .h_full()
      .min_h(0)
      .border_l(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("files-header")
          .h(30)
          .flex_none()
          .pl(10)
          .pr(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(Boolean(rootBranch), hdr =>
            hdr
              .child(
                div()
                  .flex_none()
                  .mr(6)
                  .text_size(12)
                  .text_color(t.muted)
                  .child(rootName),
              )
              .child(renderGitBranchSubtitle(rootBranch, t)),
          )
          .when(!rootBranch, hdr =>
            hdr.child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .text_color(t.muted)
                .child(rootName),
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
                  "files-refresh",
                  "refresh",
                  "Refresh Explorer",
                  (_e, cx) => {
                    this.wsIndexRoot = null;
                    this.refresh(cx);
                  },
                ),
              )
              .child(
                this.headerIconButton(
                  t,
                  "files-collapse",
                  "collapse-all",
                  "Collapse Folders in Explorer",
                  (_e, cx) => {
                    this.collapseAll(cx);
                  },
                ),
              ),
          ),
      )
      .child(
        v_flex()
          .id("files-tree")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .py(4)
          .children(this.rows("", 0, [], t))
          .when(Boolean(this.error) || !this.entries.get("")?.length, tree =>
            tree.child(
              div()
                .p(8)
                .text_size(12)
                .text_color(t.dim)
                .child(
                  this.error ||
                    (this.loading
                      ? "Loading files…"
                      : this.root
                        ? "No files"
                        : "No folder"),
                ),
            ),
          )
          .when(this.limited, tree =>
            tree.child(
              div()
                .p(8)
                .text_size(11)
                .text_color(t.dim)
                .child("File list limited to 500 entries per folder and 5,000 total"),
            ),
          ),
      );
  }

  renderOptionToggle(t, id, label, active, tooltip, onClick) {
    return div()
      .id(id)
      .h(18)
      .px(4)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(3)
      .cursor_pointer()
      .text_size(10.5)
      .font_semibold()
      .when(active, el => el.border_1().border_color(t.accent).bg(t.selected))
      .text_color(active ? t.accent : t.muted)
      .hover(s => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
      .tooltip(tooltip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => {
        cx.stop_propagation();
        onClick(e, cx);
      })
      .child(label);
  }

  renderContextMenuOverlay(t) {
    const m = this.contextMenu;
    if (!m) return null;
    const menuW = 248;
    const menuH = m.items.length * 32 + 16;
    const maxW = this.panelSize?.width || 680;
    const maxH = this.panelSize?.height || 600;
    const left = Math.max(8, Math.min(m.x, maxW - menuW - 8));
    const top = Math.max(8, Math.min(m.y, maxH - menuH - 8));

    return div()
      .id("files-menu-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.contextMenu = null;
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.contextMenu = null;
        cx.notify();
      })
      .child(
        v_flex()
          .id("files-menu-popup")
          .absolute()
          .left(left)
          .top(top)
          .w(menuW)
          .p(5)
          .rounded(8)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_md()
          .text_size(12.5)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_mouse_down("right", (_e, cx) => cx.stop_propagation())
          .children(
            m.items.map((it, i) =>
              v_flex()
                .when(Boolean(it.divider), el => el.child(div().mx(6).my(4).h(1).bg(t.border)))
                .child(
                  h_flex()
                    .id(`fmi-${i}`)
                    .h(30)
                    .px(8)
                    .gap(8)
                    .rounded(6)
                    .items_center()
                    .cursor_pointer()
                    .text_color(t.foreground)
                    .hover(s => s.bg(t.hover))
                    .on_click((_e, cx) => this.chooseMenuItem(it, cx))
                    .child(
                      svg(
                        it.action === "chat"
                          ? "mods/ide-files/plus.svg"
                          : it.action === "find"
                            ? `${ICON_PREFIX}/codicon-search.svg`
                            : "mods/ide-files/file.svg",
                      )
                        .size(13)
                        .flex_none()
                        .text_color(it.action === "chat" ? t.accent : t.muted),
                    )
                    .child(div().flex_1().min_w(0).truncate().child(it.label)),
                ),
            ),
          ),
      );
  }

  headerIconButton(t, id, iconName, tooltip, onClick, active = false) {
    return div()
      .id(id)
      .size(22)
      .flex_none()
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .cursor_pointer()
      .when(active, el => el.bg(t.selected))
      .text_color(active ? t.accent : t.muted)
      .hover(s => s.bg(active ? t.selected : t.hover).text_color(active ? t.accent : t.foreground))
      .tooltip(tooltip)
      .on_click((e, cx) => {
        cx.stop_propagation();
        onClick(e, cx);
      })
      .child(svg(`${ICON_PREFIX}/codicon-${iconName}.svg`).size(13.5));
  }

  render(cx) {
    if (locationKey() !== this.context?.key) this.refresh(cx);
    this.rememberTarget();
    const t = theme();
    const range = this.selectedRange();
    const activeRef = this.file
      ? formatRef(this.file, false, range ? range[0] : null, range ? range[1] : null)
      : null;

    return v_flex()
      .id("files")
      .track_focus(this.handle)
      .relative()
      .size_full()
      .min_h(0)
      .rounded(10)
      .overflow_hidden()
      .bg(t.background)
      .border_1()
      .border_color(this.drag?.moved ? t.accent : t.border)
      .text_color(t.foreground)
      .text_size(13)
      .on_size_change(size => {
        this.panelSize = size;
      })
      .on_key_down((e, cx) => {
        const k = (e.key || "").toLowerCase();
        const cmdOrCtrl = Boolean(e.modifiers?.platform || e.modifiers?.control);
        if (cmdOrCtrl && k === "c" && this.file && !this.rawEditor) {
          const selText = this.getSelectedText?.();
          if (selText) {
            cx.stop_propagation();
            cx.write_to_clipboard(selText);
            return;
          }
        }
        if (cmdOrCtrl && k === "f" && e.modifiers?.shift) {
          cx.stop_propagation();
          this.openWorkspaceSearch(cx);
          return;
        }
        if (cmdOrCtrl && k === "f") {
          cx.stop_propagation();
          if (this.file) this.openFileFind(cx);
          else this.quickInput.focus();
          return;
        }
        if ((cmdOrCtrl && k === "g") || k === "f3") {
          if (this.file && this.findOpen) {
            cx.stop_propagation();
            this.stepFileMatch(e.modifiers?.shift ? -1 : 1, cx);
          }
          return;
        }
        if (k === "escape") {
          if (this.contextMenu) {
            cx.stop_propagation();
            this.contextMenu = null;
            cx.notify();
            return;
          }
          if (this.file && this.findOpen) {
            cx.stop_propagation();
            this.closeFileFind(cx);
            return;
          }
          if (!this.file && this.quickFocused) {
            cx.stop_propagation();
            if (this.quickQuery) {
              this.quickQuery = "";
              this.quickInput.set_value("");
            } else {
              this.quickFocused = false;
              this.handle.focus();
            }
            cx.notify();
            return;
          }
          if (this.searchMode) {
            cx.stop_propagation();
            this.closeWorkspaceSearch(cx);
            return;
          }
        }
      })
      .on_mouse_down("right", (e, cx) => {
        if (!this.pendingMenu) return;
        const items = this.pendingMenu;
        this.pendingMenu = null;
        const x = e.local_position?.x ?? 40;
        const y = e.local_position?.y ?? 60;
        this.contextMenu = {
          x,
          y,
          items,
          target: this.rememberTarget(),
        };
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag || this.drag.sent) return;
        const dx = e.position.x - this.drag.startX;
        const dy = e.position.y - this.drag.startY;
        if (Math.hypot(dx, dy) > 8 && !this.drag.moved) {
          this.drag.moved = true;
          cx.notify();
        }
        if (dx < -22 && (e.local_position?.x ?? 999) <= 22) {
          const d = this.drag;
          d.sent = true;
          this.drag = null;
          pasteIntoTerminal(d.ref, cx, d.target);
          cx.notify();
        }
      })
      .on_mouse_up("left", (e, cx) => {
        this.selectingLines = false;
        this.scrollbarDrag = false;
        if (!this.drag) return;
        const d = this.drag;
        this.drag = null;
        if (
          !d.sent &&
          d.moved &&
          Math.hypot(e.position.x - d.startX, e.position.y - d.startY) > 16
        ) {
          pasteIntoTerminal(d.ref, cx, d.target);
        }
        cx.notify();
      })
      .when(Boolean(this.drag?.moved), el =>
        el.child(
          h_flex()
            .h(26)
            .flex_none()
            .px(12)
            .items_center()
            .bg(t.selected)
            .border_b(1)
            .border_color(t.accent)
            .text_size(11.5)
            .text_color(t.accent)
            .child(`Drag left or release to Add to Chat: ${this.drag?.ref ?? ""}`),
        ),
      )
      // Unified Top Bar (← → Breadcrumbs | Preview/Source/Find/+Chat | 🔍 [>|])
      .child(this.renderUnifiedTopBar(t, range, activeRef))
      // Main Split Body: Left persistent File Viewer / Quick Open Home + Right collapsible Tree / Search sidebar
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .w_full()
          .child(this.renderFilePreviewPane(t, cx))
          .when(!this.rightSidebarCollapsed && !this.searchMode, row =>
            row.child(this.renderExplorerSidebar(t)),
          )
          .when(!this.rightSidebarCollapsed && this.searchMode, row =>
            row.child(this.renderWorkspaceSearchSidebar(t)),
          ),
      )
      .when(Boolean(this.contextMenu), el => el.child(this.renderContextMenuOverlay(t)));
  }
}

Object.assign(IdeFiles.prototype, searchMethods, previewMethods);
