import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import {
  focused,
  exec,
  readTextFile,
  watchFolder,
  theme,
  settings,
  notify,
  nextCommand,
  shared,
  setShared,
  run,
} from "herdr";
import { getFileIcon, ICON_PREFIX } from "./icons.js";
import {
  location,
  formatRef,
  pasteIntoTerminal,
  READ,
  countLines,
  diffRows,
  findSubRepos,
  discoverWorktreeFeatures,
  renderGitBranchSubtitle,
  readSharedWtState,
  writeSharedWtState,
  inspectRepoChanges,
} from "./git.js";

const STORAGE_KEY = "ide-changes.saved";
const RIGHT_SIDEBAR_WIDTH = 260;
const DIFF_LINE_H = 20;

const GIT_COLOR = {
  M: "#e2b061", // Modified: warm amber-gold
  U: "#63c29f", // Untracked / Conflict: teal-green
  A: "#63c29f", // Added: teal-green
  D: "#e06c75", // Deleted: coral red
  C: "#e06c75", // Conflict: coral red
};

const GIT_DOT_COLOR = {
  M: "#b88746",
  U: "#4fa384",
  A: "#4fa384",
  D: "#c25a62",
  C: "#c25a62",
};

const STATUS_PRIORITY = { C: 5, D: 4, M: 3, A: 2, U: 1 };

function buildRepoChangeTree(files, repoPrefix = "") {
  const root = { folders: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    const fileName = parts.pop() || f.path;
    let cur = root;
    let curPath = repoPrefix;
    for (const seg of parts) {
      curPath = curPath ? `${curPath}/${seg}` : seg;
      let sub = cur.folders.get(seg);
      if (!sub) {
        sub = {
          name: seg,
          key: curPath,
          mark: f.status,
          folders: new Map(),
          files: [],
        };
        cur.folders.set(seg, sub);
      } else if ((STATUS_PRIORITY[f.status] ?? 0) > (STATUS_PRIORITY[sub.mark] ?? 0)) {
        sub.mark = f.status;
      }
      cur = sub;
    }
    cur.files.push({ ...f, name: fileName });
  }
  return root;
}

function collectTreeFolderKeys(node, out = []) {
  for (const sub of node.folders.values()) {
    out.push(sub.key);
    collectTreeFolderKeys(sub, out);
  }
  return out;
}

function collectTreeOrderedFiles(node, out = []) {
  const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const sub of folders) {
    collectTreeOrderedFiles(sub, out);
  }
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  for (const f of files) {
    out.push(f);
  }
  return out;
}

export default class IdeChanges extends View {
  init(_props, cx) {
    this.saved = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      for (const [k, v] of Object.entries(raw)) {
        this.saved.set(k, {
          selectedFeature: v.selectedFeature || null,
          userPinnedRoot: Boolean(v.userPinnedRoot),
          foldedGroups: new Set(v.foldedGroups || []),
          collapsedFolders: new Set(v.collapsedFolders || []),
        });
      }
    } catch {}

    this.baseRoot = null;
    this.hasWorktreeDir = false;
    this.wtDirs = [];
    this.wtFeatures = [];
    this.wtLoaded = false;
    this.selectedFeature = null;
    this.userPinnedRoot = false;
    this.wtDropdownOpen = false;
    this.rightSidebarCollapsed = false;
    this.refreshSeq = 0;
    this.pendingRefresh = false;

    this.files = [];
    this.groups = [];
    this.foldedGroups = new Set();
    this.collapsedFolders = new Set();
    this.multiRepo = false;
    this.singleBranch = null;
    this.activeRepoRoot = null;
    this.activeRepoRel = "";
    this.history = [];
    this.historyIdx = -1;
    this.rows = [];
    this.diffWidth = 0;
    this.diffScroll = 0;
    this.diffViewHeight = 480;
    this.diffScrollbarDrag = false;
    this.message = "";
    this.filterQuery = "";
    this.filterFocused = false;
    this.lastFileClick = null;
    this.lastDiffClick = null;
    this.lastTarget = null;
    this.pendingMenu = null;
    this.contextMenu = null;
    this.panelSize = { width: 680, height: 600 };
    this.handle = cx.focus_handle();

    this.filterInput = InputState.new({ placeholder: "Filter files… (⌘F)" });
    this.filterInput.on("change", (_e, cx) => {
      this.filterQuery = this.filterInput.value();
      this.syncFilteredSelection(cx);
      cx.notify();
    });
    this.filterInput.on("submit", (_e, cx) => {
      const matched = this.filteredFiles();
      if (matched.length > 0 && this.open !== matched[0].id) {
        this.pick(matched[0].id, cx);
      }
    });
    this.filterInput.on("focus", (_e, cx) => {
      this.filterFocused = true;
      cx.notify();
    });
    this.filterInput.on("blur", (_e, cx) => {
      this.filterFocused = false;
      cx.notify();
    });

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

    cx.spawn(async cx => {
      for (;;) {
        const cmd = await nextCommand();
        if (!cmd) continue;
        this.syncSharedWorktree(cx);
        if (cmd === "focus") {
          this.handle.focus();
        } else if (cmd === "find") {
          this.rightSidebarCollapsed = false;
          this.filterInput.focus();
        } else if (cmd === "prev_file") {
          this.stepChangedFile(-1, cx);
        } else if (cmd === "next_file") {
          this.stepChangedFile(1, cx);
        }
        cx.notify();
      }
    });

    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  rememberTarget() {
    const f = focused();
    if (f?.pane || f?.terminal) {
      this.lastTarget = { pane: f.pane ?? null, terminal: f.terminal ?? null };
    }
    return this.lastTarget || f;
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
    }
    cx.notify();
  }

  current(context) {
    if (!context) return false;
    const { cwd: rawCwd, on } = location();
    let baseRoot = rawCwd;
    if (rawCwd) {
      const wtMatch = /^(.*)\/(\.worktrees?|worktrees?)\/([^/]+)(?:\/.*)?$/.exec(rawCwd);
      if (wtMatch && wtMatch[1]) baseRoot = wtMatch[1];
    }
    return this.context === context && JSON.stringify({ baseRoot, on }) === context.key;
  }

  persistState() {
    if (!this.context?.key) return;
    this.saved.set(this.context.key, {
      selectedFeature: this.selectedFeature || null,
      userPinnedRoot: Boolean(this.userPinnedRoot),
      foldedGroups: new Set(this.foldedGroups),
      collapsedFolders: new Set(this.collapsedFolders),
    });
    try {
      const obj = {};
      for (const [k, v] of this.saved.entries()) {
        obj[k] = {
          selectedFeature: v.selectedFeature || null,
          userPinnedRoot: Boolean(v.userPinnedRoot),
          foldedGroups: [...(v.foldedGroups || [])],
          collapsedFolders: [...(v.collapsedFolders || [])],
        };
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
    } catch {}
    writeSharedWtState(this.context.key, this.selectedFeature, this.userPinnedRoot);
  }

  selectFeature(relPath, cx) {
    const nextFeature = relPath || null;
    const nextPinned = !nextFeature;
    this.wtDropdownOpen = false;
    if (this.selectedFeature === nextFeature && this.userPinnedRoot === nextPinned) {
      cx.notify();
      return;
    }
    this.selectedFeature = nextFeature;
    this.userPinnedRoot = nextPinned;
    this.root =
      this.selectedFeature && this.baseRoot
        ? `${this.baseRoot}/${this.selectedFeature}`
        : this.baseRoot;
    if (this.context) {
      this.context.cwd = this.root;
    }
    this.files = [];
    this.groups = [];
    this.multiRepo = false;
    this.singleBranch = null;
    this.activeRepoRoot = null;
    this.activeRepoRel = "";
    this.open = null;
    this.history = [];
    this.historyIdx = -1;
    this.diffScroll = 0;
    this.setLines([]);
    this.note = null;
    this.error = null;
    this.closed = false;
    this.limited = false;
    this.persistState();
    this.refresh(cx, true);
    cx.notify();
  }

  syncSharedWorktree(cx) {
    if (!this.context?.key) return;
    const sharedState = readSharedWtState(this.context.key);
    if (!sharedState) return;
    let wantFeature = sharedState.selectedFeature || null;
    let wantPinned = Boolean(sharedState.userPinnedRoot);
    if (
      wantFeature &&
      this.wtLoaded &&
      !this.wtFeatures.some(f => f.relPath === wantFeature)
    ) {
      wantFeature = null;
      wantPinned = this.wtFeatures.length > 0;
      writeSharedWtState(this.context.key, null, wantPinned);
    }
    if (wantFeature !== (this.selectedFeature || null)) {
      this.userPinnedRoot = wantPinned;
      this.selectFeature(wantFeature, cx);
    } else if (wantPinned !== Boolean(this.userPinnedRoot)) {
      this.userPinnedRoot = wantPinned;
    }
  }

  openInFiles(file, lineNo, cx) {
    if (!file) return;
    const fullPath = `${file.repoRoot}/${file.path}`;
    const relPath =
      this.root && fullPath.startsWith(`${this.root}/`)
        ? fullPath.slice(this.root.length + 1)
        : file.repoRel
          ? `${file.repoRel}/${file.path}`
          : file.path;

    this.persistState();
    try {
      setShared("ide.open_file_request", {
        id: `${Date.now()}-${Math.random()}`,
        contextKey: this.context?.key || null,
        baseRoot: this.baseRoot || this.root || null,
        selectedFeature: this.selectedFeature || null,
        path: relPath,
        lineNo: typeof lineNo === "number" && lineNo > 0 ? lineNo : null,
        ts: Date.now(),
      });
    } catch {}

    try {
      run("layout.select", { stack: "panel-body", child: "files" });
      run("layout.show", { id: "panel" });
    } catch {}
    cx.notify();
  }

  orderedFiles() {
    const hasFilter = Boolean(this.filterQuery.trim());
    const out = [];
    if (!this.multiRepo) {
      const tree = buildRepoChangeTree(this.filteredFiles(), "");
      return collectTreeOrderedFiles(tree, out);
    }
    for (const g of this.groups) {
      const groupFiles = hasFilter ? g.files.filter(f => this.matchesFilter(f)) : g.files;
      if (hasFilter && groupFiles.length === 0) continue;
      const tree = buildRepoChangeTree(groupFiles, g.repoRel);
      collectTreeOrderedFiles(tree, out);
    }
    return out;
  }

  stepChangedFile(delta, cx) {
    const list = this.orderedFiles();
    if (!list.length) return;
    const curIdx = list.findIndex(f => f.id === this.open);
    const nextIdx =
      curIdx < 0
        ? delta > 0
          ? 0
          : list.length - 1
        : (curIdx + delta + list.length) % list.length;
    const target = list[nextIdx];
    if (!target) return;
    const parts = target.path.split("/").filter(Boolean);
    parts.pop();
    if (parts.length || target.repoRel) {
      const folderKey = [target.repoRel, ...parts].filter(Boolean).join("/");
      this.revealFolderInChangesTree(folderKey, target.repoRel || "", cx);
    }
    this.pick(target.id, cx);
  }

  revealFolderInChangesTree(folderKey, repoRel, cx) {
    this.rightSidebarCollapsed = false;
    if (repoRel && this.foldedGroups.has(repoRel)) {
      this.foldedGroups.delete(repoRel);
    }
    const segs = folderKey.split("/").filter(Boolean);
    let acc = "";
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s;
      this.collapsedFolders.delete(acc);
    }
    this.persistState();
    cx.notify();
  }

  collapseAll(cx) {
    const allFolderKeys = [];
    if (this.multiRepo) {
      for (const g of this.groups) {
        const tree = buildRepoChangeTree(g.files, g.repoRel);
        collectTreeFolderKeys(tree, allFolderKeys);
      }
    } else {
      const tree = buildRepoChangeTree(this.files, "");
      collectTreeFolderKeys(tree, allFolderKeys);
    }

    const hasExpandedFolder = allFolderKeys.some(k => !this.collapsedFolders.has(k));
    if (hasExpandedFolder) {
      for (const k of allFolderKeys) {
        this.collapsedFolders.add(k);
      }
    } else if (this.multiRepo && this.groups.some(g => !this.foldedGroups.has(g.repoRel))) {
      for (const g of this.groups) {
        this.foldedGroups.add(g.repoRel);
      }
    } else {
      this.collapsedFolders.clear();
      this.foldedGroups.clear();
    }
    this.persistState();
    cx.notify();
  }

  matchesFilter(file) {
    const q = (this.filterQuery || "").trim().toLowerCase();
    if (!q) return true;
    const target = `${file.repoRel ? file.repoRel + "/" : ""}${file.path}`.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    return tokens.every(tok => target.includes(tok));
  }

  filteredFiles() {
    if (!this.filterQuery.trim()) return this.files;
    return this.files.filter(f => this.matchesFilter(f));
  }

  syncFilteredSelection(cx) {
    if (!this.filterQuery.trim()) return;
    const matched = this.filteredFiles();
    if (matched.length > 0 && !matched.some(f => f.id === this.open)) {
      this.pick(matched[0].id, cx);
    }
  }

  clearFilter(cx) {
    this.filterQuery = "";
    try {
      this.filterInput.set_value("");
    } catch {}
    cx.notify();
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

  refresh(cx, force = false) {
    if (this.busy) return;
    const { cwd: rawCwd, on } = location();
    let baseRoot = rawCwd;
    let detectedFeature = null;
    if (rawCwd) {
      const wtMatch = /^(.*)\/(\.worktrees?|worktrees?)\/([^/]+)(?:\/.*)?$/.exec(rawCwd);
      if (wtMatch && wtMatch[1]) {
        baseRoot = wtMatch[1];
        detectedFeature = `${wtMatch[2]}/${wtMatch[3]}`;
      }
    }
    const next = JSON.stringify({ baseRoot, on });
    if (next !== this.context?.key) {
      if (this.context) {
        this.saved.set(this.context.key, {
          selectedFeature: this.selectedFeature || null,
          userPinnedRoot: Boolean(this.userPinnedRoot),
          foldedGroups: new Set(this.foldedGroups),
          collapsedFolders: new Set(this.collapsedFolders),
        });
      }
      const saved = this.saved.get(next);
      const sharedState = readSharedWtState(next);
      this.baseRoot = baseRoot;
      this.selectedFeature =
        sharedState?.selectedFeature ??
        saved?.selectedFeature ??
        detectedFeature ??
        null;
      this.userPinnedRoot =
        sharedState !== null
          ? Boolean(sharedState.userPinnedRoot)
          : Boolean(saved?.userPinnedRoot);
      this.wtDropdownOpen = false;
      this.wtLoaded = false;
      const activeRoot =
        this.selectedFeature && baseRoot ? `${baseRoot}/${this.selectedFeature}` : baseRoot;
      this.context = { key: next, cwd: activeRoot, baseRoot, on };
      this.root = activeRoot;
      this.on = on;
      this.foldedGroups = new Set(saved?.foldedGroups);
      this.collapsedFolders = new Set(saved?.collapsedFolders);
      this.files = [];
      this.groups = [];
      this.multiRepo = false;
      this.singleBranch = null;
      this.activeRepoRoot = null;
      this.activeRepoRel = "";
      this.open = null;
      this.history = [];
      this.historyIdx = -1;
      this.diffScroll = 0;
      this.setLines([]);
      this.message = "";
      this.filterQuery = "";
      this.error = null;
      this.note = null;
      this.watched = null;
      this.closed = false;
      this.limited = false;
      this.loading = false;
    }
    if (!baseRoot) return;
    if (this.loading && !force) {
      this.pendingRefresh = true;
      return;
    }
    const context = this.context;
    const seq = ++this.refreshSeq;
    this.loading = true;
    this.pendingRefresh = false;

    cx.spawn(async cx => {
      try {
        const customWtDirs = shared("ide.worktree_dirs");
        const wtInfo = await discoverWorktreeFeatures(
          baseRoot,
          Array.isArray(customWtDirs)
            ? customWtDirs
            : typeof customWtDirs === "string"
              ? customWtDirs.split(",").map(s => s.trim())
              : [],
          on,
        );
        if (!this.current(context) || this.refreshSeq !== seq) return;
        this.hasWorktreeDir = wtInfo.hasWorktreeDir;
        this.wtDirs = wtInfo.wtDirs;
        this.wtFeatures = wtInfo.features;
        this.wtLoaded = true;
        let wtChanged = false;
        if (
          this.selectedFeature &&
          !this.wtFeatures.some(f => f.relPath === this.selectedFeature)
        ) {
          this.selectedFeature = null;
          this.userPinnedRoot = this.wtFeatures.length > 0;
          this.open = null;
          this.diffScroll = 0;
          this.setLines([]);
          wtChanged = true;
        }
        if (this.wtFeatures.length === 0 && this.userPinnedRoot) {
          this.userPinnedRoot = false;
          wtChanged = true;
        }
        if (!this.selectedFeature && !this.userPinnedRoot && this.wtFeatures.length > 0) {
          this.selectedFeature = this.wtFeatures[0].relPath;
          wtChanged = true;
        }
        if (wtChanged) {
          this.persistState();
        }
        const effectiveRoot =
          this.selectedFeature && this.baseRoot
            ? `${this.baseRoot}/${this.selectedFeature}`
            : this.baseRoot;
        this.root = effectiveRoot;
        context.cwd = effectiveRoot;

        let repoResults = [];
        let multiRepo = false;

        const subRepos = await findSubRepos(effectiveRoot, on);
        if (!this.current(context) || this.refreshSeq !== seq) return;

        if (subRepos.length > 0) {
          multiRepo = true;
          repoResults = await Promise.all(
            subRepos.map(rel =>
              inspectRepoChanges(`${effectiveRoot}/${rel}`, rel, on).catch(() => null),
            ),
          );
          repoResults = repoResults.filter(Boolean);
        } else {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], {
            cwd: effectiveRoot,
            on,
          }).catch(() => null);
          if (!this.current(context) || this.refreshSeq !== seq) return;

          if (top?.code === 0 && top.stdout.trim()) {
            const singleRoot = top.stdout.trim();
            const res = await inspectRepoChanges(singleRoot, "", on);
            repoResults = [res];
          } else {
            this.files = [];
            this.groups = [];
            this.multiRepo = false;
            this.singleBranch = null;
            this.setLines([]);
            this.open = null;
            this.error = "Not a git repository";
            this.watch(baseRoot, cx);
            return;
          }
        }

        if (!this.current(context) || this.refreshSeq !== seq) return;

        const activeGroups = multiRepo ? repoResults.filter(g => g.files.length > 0) : repoResults;
        const files = activeGroups.flatMap(g => g.files);
        const limited = activeGroups.some(g => g.limited);

        this.root = effectiveRoot;
        this.on = on;
        this.multiRepo = multiRepo;
        this.singleBranch = !multiRepo && repoResults[0]?.branch ? repoResults[0].branch : null;
        this.groups = activeGroups;
        this.files = files;
        this.limited = limited;
        this.error = null;
        this.watch(baseRoot, cx);

        if (this.open && !files.some(f => f.id === this.open)) {
          this.open = null;
          this.diffScroll = 0;
          this.setLines([]);
        }
        if (!this.open && !this.closed && files.length) {
          this.open = files[0].id;
          this.diffScroll = 0;
          if (!this.history.length) {
            this.history = [this.open];
            this.historyIdx = 0;
          }
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
            if (this.current(context))
              this.setLines(["Cannot preview this diff (too large or unreadable)"]);
          }
        }
      } catch (e) {
        if (this.current(context) && this.refreshSeq === seq) {
          this.error = String(e);
        }
      } finally {
        if (this.refreshSeq === seq) {
          this.loading = false;
          if (this.pendingRefresh) {
            this.pendingRefresh = false;
            this.refresh(cx);
          }
        }
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
    if (this.current(context) && this.open === fileId) {
      this.setLines(
        lines
          .slice(0, 1500)
          .map(line => (line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line)),
      );
    }
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 64));
  }

  pick(fileId, cx, opts = null) {
    const file = this.files.find(f => f.id === fileId);
    if (file) {
      this.activeRepoRoot = file.repoRoot;
      this.activeRepoRel = file.repoRel || "";
    }
    if (!opts?.fromHistory && fileId) {
      const curHist = this.history[this.historyIdx] ?? null;
      if (curHist !== fileId) {
        this.history = this.history.slice(0, this.historyIdx + 1);
        this.history.push(fileId);
        this.historyIdx = this.history.length - 1;
      }
    }
    if (this.open === fileId && this.rows.length > 0) {
      cx.notify();
      return;
    }
    this.open = fileId;
    this.diffScroll = 0;
    this.setLines([]);
    this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open)
      cx.spawn(async cx => {
        try {
          await this.load(fileId, context);
        } catch (e) {
          if (this.current(context) && this.open === fileId)
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
    this.persistState();
    cx.notify();
  }

  toggleFolder(folderKey, cx) {
    if (this.collapsedFolders.has(folderKey)) {
      this.collapsedFolders.delete(folderKey);
    } else {
      this.collapsedFolders.add(folderKey);
    }
    this.persistState();
    cx.notify();
  }

  commit(cx) {
    const targetRoot = this.activeRepoRoot || (!this.multiRepo ? this.root : null);
    if (
      !this.message.trim() ||
      !targetRoot ||
      this.busy ||
      this.loading ||
      !this.current(this.context)
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
        if (this.current(context)) {
          this.message = "";
          try {
            this.input.set_value("");
          } catch {}
        }
      } catch (e) {
        if (this.current(context)) this.note = `Commit failed: ${e}`;
      } finally {
        this.busy = false;
        this.refresh(cx, true);
        cx.notify();
      }
    });
    cx.notify();
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

  renderBreadcrumbs(t) {
    const openFile = this.files.find(f => f.id === this.open);
    if (!openFile) {
      return h_flex()
        .flex_1()
        .min_w(0)
        .gap(8)
        .items_center()
        .child(div().text_size(12.5).text_color(t.muted).child("Changes"))
        .when(this.files.length > 0, el =>
          el.child(
            div()
              .px(5)
              .py(0.5)
              .rounded(4)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .text_color(t.dim)
              .child(`${this.files.length} files`),
          ),
        );
    }

    const parts = openFile.path.split("/").filter(Boolean);
    const fileName = parts.pop() || openFile.path;
    const fileIcon = getFileIcon(fileName);
    const crumbs = [];

    if (this.multiRepo && openFile.repoRel) {
      const repoRel = openFile.repoRel;
      const repoRoot = openFile.repoRoot;
      crumbs.push(
        div()
          .id(`changes-crumb-repo-${repoRel}`)
          .flex_none()
          .cursor_pointer()
          .text_size(12.5)
          .font_medium()
          .text_color(t.muted)
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.rightSidebarCollapsed = false;
            this.activeRepoRoot = repoRoot;
            this.activeRepoRel = repoRel;
            this.foldedGroups.delete(repoRel);
            this.persistState();
            cx.notify();
          })
          .child(repoRel),
      );
      crumbs.push(
        svg(`${ICON_PREFIX}/codicon-chevron-right.svg`)
          .size(11)
          .flex_none()
          .mx(2)
          .text_color(t.dim),
      );
    }

    let acc = this.multiRepo && openFile.repoRel ? openFile.repoRel : "";
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      acc = acc ? `${acc}/${seg}` : seg;
      const folderKey = acc;
      const repoRel = openFile.repoRel || "";
      crumbs.push(
        div()
          .id(`changes-crumb-${folderKey}`)
          .flex_none()
          .cursor_pointer()
          .text_size(12.5)
          .text_color(t.muted)
          .hover(s => s.text_color(t.foreground))
          .on_click((_e, cx) => {
            this.revealFolderInChangesTree(folderKey, repoRel, cx);
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
        .id(`changes-crumb-file-${openFile.id}`)
        .flex_1()
        .min_w(0)
        .gap(5)
        .items_center()
        .cursor_pointer()
        .on_mouse_down("left", (e, cx) => {
          if (e.click_count >= 2) {
            cx.stop_propagation();
            this.openInFiles(openFile, null, cx);
          }
        })
        .child(svg(fileIcon.svg).size(14.5).flex_none().text_color(fileIcon.color))
        .child(
          div()
            .min_w(0)
            .truncate()
            .text_size(12.5)
            .text_color(t.foreground)
            .child(fileName),
        )
        .child(
          div()
            .flex_none()
            .ml(2)
            .text_size(11)
            .font_semibold()
            .text_color(GIT_COLOR[openFile.status] ?? t.muted)
            .child(openFile.status),
        )
        .when(openFile.add > 0, el =>
          el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${openFile.add}`)),
        )
        .when(openFile.del > 0, el =>
          el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${openFile.del}`)),
        ),
    );

    return h_flex().flex_1().min_w(0).items_center().overflow_hidden().children(crumbs);
  }

  renderUnifiedTopBar(t) {
    const ordered = this.orderedFiles();
    const canStep = ordered.length > 0;

    return h_flex()
      .id("changes-unified-topbar")
      .h(36)
      .flex_none()
      .px(10)
      .gap(6)
      .items_center()
      .border_b(1)
      .border_color(t.border)
      .child(this.renderBreadcrumbs(t))
      .child(
        h_flex()
          .flex_none()
          .gap(2)
          .items_center()
          .child(
            div()
              .id("changes-prev-file")
              .size(22)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(4)
              .when(canStep, el =>
                el
                  .cursor_pointer()
                  .text_color(t.muted)
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.stepChangedFile(-1, cx)),
              )
              .when(!canStep, el => el.text_color(t.dim).opacity(0.45))
              .tooltip("Previous File (⌥[)")
              .child(svg("mods/ide-changes/chevron-left.svg").size(14)),
          )
          .child(
            div()
              .id("changes-next-file")
              .size(22)
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .rounded(4)
              .when(canStep, el =>
                el
                  .cursor_pointer()
                  .text_color(t.muted)
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .on_click((_e, cx) => this.stepChangedFile(1, cx)),
              )
              .when(!canStep, el => el.text_color(t.dim).opacity(0.45))
              .tooltip("Next File (⌥])")
              .child(svg("mods/ide-changes/chevron-right.svg").size(14)),
          )
          .child(
            this.headerIconButton(
              t,
              "changes-sidebar-toggle",
              "panel-right",
              this.rightSidebarCollapsed
                ? "Show Changes File Tree"
                : "Hide Changes File Tree",
              (_e, cx) => {
                this.rightSidebarCollapsed = !this.rightSidebarCollapsed;
                cx.notify();
              },
              !this.rightSidebarCollapsed,
            ),
          ),
      );
  }

  renderDiffRow(row, rowIdx, topPx, t) {
    const { kind, number, targetLine, text } = row;
    const onMouseDown = (e, cx) => {
      cx.stop_propagation();
      this.contextMenu = null;
      const now = Date.now();
      const isDouble =
        e.click_count >= 2 ||
        (this.lastDiffClick?.idx === rowIdx && now - this.lastDiffClick.ts < 350);
      this.lastDiffClick = { idx: rowIdx, ts: isDouble ? 0 : now };
      if (isDouble) {
        const file = this.files.find(f => f.id === this.open);
        if (file) {
          this.openInFiles(file, targetLine ?? number ?? null, cx);
        }
      }
    };
    const onRightMouseDown = () => {
      const file = this.files.find(f => f.id === this.open);
      if (!file) return;
      const relPath = file.repoRel ? `${file.repoRel}/${file.path}` : file.path;
      this.pendingMenu = this.buildEntryMenuItems(
        relPath,
        false,
        targetLine ?? number ?? null,
      );
    };

    if (kind === "@")
      return h_flex()
        .id(`diff-row-${rowIdx}`)
        .absolute()
        .left(0)
        .right(10)
        .top(topPx)
        .h(DIFF_LINE_H)
        .px(12)
        .items_center()
        .cursor_pointer()
        .bg(t.raised)
        .hover(s => s.bg(t.hover))
        .text_color(t.dim)
        .on_mouse_down("left", onMouseDown)
        .on_mouse_down("right", onRightMouseDown)
        .child(div().w_full().truncate().child(text));

    return h_flex()
      .id(`diff-row-${rowIdx}`)
      .absolute()
      .left(0)
      .right(10)
      .top(topPx)
      .h(DIFF_LINE_H)
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
      .on_mouse_down("left", onMouseDown)
      .on_mouse_down("right", onRightMouseDown)
      .child(
        div()
          .w(36)
          .flex_none()
          .text_right()
          .text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim)
          .child(number === undefined ? "" : String(number)),
      )
      .child(
        div()
          .w(12)
          .flex_none()
          .text_center()
          .text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim)
          .child(kind === "+" || kind === "-" ? kind : " "),
      )
      .child(div().flex_1().min_w(0).truncate().child(text));
  }

  renderDiffMainPane(t) {
    const totalRows = this.rows.length;
    const viewH = Math.max(120, this.diffViewHeight || 480);
    const maxScroll = Math.max(0, totalRows * DIFF_LINE_H - viewH + 8);
    this.diffScroll = Math.max(0, Math.min(this.diffScroll || 0, maxScroll));

    const startIdx = Math.max(0, Math.floor(this.diffScroll / DIFF_LINE_H) - 3);
    const endIdx = Math.min(
      totalRows,
      Math.ceil((this.diffScroll + viewH) / DIFF_LINE_H) + 3,
    );

    const visibleRows = [];
    for (let idx = startIdx; idx < endIdx; idx++) {
      const row = this.rows[idx];
      if (!row) continue;
      const topPx = idx * DIFF_LINE_H - this.diffScroll + 4;
      visibleRows.push(this.renderDiffRow(row, idx, topPx, t));
    }

    const thumbH =
      totalRows > 0
        ? Math.max(24, Math.min(viewH, Math.round((viewH / (totalRows * DIFF_LINE_H + 8)) * viewH)))
        : viewH;
    const thumbTop =
      maxScroll > 0
        ? Math.round((this.diffScroll / maxScroll) * Math.max(0, viewH - thumbH))
        : 0;

    return v_flex()
      .id("changes-diff-pane")
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .child(
        div()
          .id("changes-diff-scroll")
          .flex_1()
          .min_h(0)
          .relative()
          .overflow_hidden()
          .font_family(settings().font_family ?? "JetBrains Mono")
          .text_size(11.5)
          .on_size_change((size, cx) => {
            if (size.height > 0 && Math.abs((this.diffViewHeight || 0) - size.height) > 1) {
              this.diffViewHeight = size.height;
              cx.notify();
            }
          })
          .on_scroll_wheel((e, cx) => {
            if (maxScroll <= 0) return;
            this.diffScroll = Math.max(0, Math.min(maxScroll, this.diffScroll - e.delta.y));
            cx.notify();
          })
          .on_mouse_up("left", (_e, cx) => {
            if (this.diffScrollbarDrag) {
              this.diffScrollbarDrag = false;
              cx.notify();
            }
          })
          .children(visibleRows)
          .when(maxScroll > 0, el =>
            el.child(
              div()
                .id("changes-diff-scrollbar")
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(10)
                .cursor_pointer()
                .on_mouse_down("left", (e, cx) => {
                  cx.stop_propagation();
                  this.diffScrollbarDrag = true;
                  const y = Math.max(0, Math.min(viewH, e.local_position?.y ?? 0));
                  const ratio = Math.max(
                    0,
                    Math.min(1, (y - thumbH / 2) / Math.max(1, viewH - thumbH)),
                  );
                  this.diffScroll = Math.round(ratio * maxScroll);
                  cx.notify();
                })
                .on_mouse_move((e, cx) => {
                  if (!this.diffScrollbarDrag) return;
                  const y = Math.max(0, Math.min(viewH, e.local_position?.y ?? 0));
                  const ratio = Math.max(
                    0,
                    Math.min(1, (y - thumbH / 2) / Math.max(1, viewH - thumbH)),
                  );
                  this.diffScroll = Math.round(ratio * maxScroll);
                  cx.notify();
                })
                .on_mouse_up("left", (_e, cx) => {
                  cx.stop_propagation();
                  this.diffScrollbarDrag = false;
                  cx.notify();
                })
                .child(
                  div()
                    .absolute()
                    .right(2)
                    .w(6)
                    .top(thumbTop)
                    .h(thumbH)
                    .rounded(3)
                    .bg(t.border)
                    .opacity(0.75),
                ),
            ),
          )
          .when(!this.rows.length, e =>
            e.child(
              div()
                .p(16)
                .text_size(12.5)
                .text_color(t.dim)
                .child(
                  this.note ||
                    this.error ||
                    (this.loading
                      ? "Loading diff…"
                      : !this.files.length
                        ? "No uncommitted changes"
                        : "Select a changed file on the right to view its diff"),
                ),
            ),
          ),
      )
      .when(Boolean(this.note && this.rows.length > 0), e =>
        e.child(div().px(12).py(6).text_size(11).text_color(t.ansi1).child(this.note)),
      );
  }

  renderIndentGuides(depth, t) {
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
    return guides;
  }

  renderTreeFolderRow(sub, depth, open, t) {
    const labelColor = sub.mark ? (GIT_COLOR[sub.mark] ?? t.foreground) : t.foreground;
    return h_flex()
      .id(`change-dir-${sub.key}`)
      .h(24)
      .flex_none()
      .mx(4)
      .pl(6)
      .pr(8)
      .rounded(5)
      .items_center()
      .cursor_pointer()
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => {
        this.contextMenu = null;
        this.toggleFolder(sub.key, cx);
      })
      .on_mouse_down("right", () => {
        this.pendingMenu = this.buildEntryMenuItems(sub.key, true);
      })
      .children(this.renderIndentGuides(depth, t))
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
            svg(`${ICON_PREFIX}/codicon-chevron-${open ? "down" : "right"}.svg`)
              .size(13)
              .flex_none()
              .text_color(t.muted),
          ),
      )
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(labelColor).child(sub.name))
      .when(Boolean(sub.mark), el =>
        el.child(
          div()
            .flex_none()
            .ml(6)
            .size(6)
            .rounded(3)
            .bg(GIT_DOT_COLOR[sub.mark] ?? t.dim),
        ),
      );
  }

  renderTreeFileRow(f, depth, t) {
    const isSelected = this.open === f.id;
    const fileIcon = getFileIcon(f.name);
    const labelColor = GIT_COLOR[f.status] ?? t.foreground;
    const relPath = f.repoRel ? `${f.repoRel}/${f.path}` : f.path;

    return h_flex()
      .id(`change-${f.id}`)
      .h(24)
      .flex_none()
      .mx(4)
      .pl(6)
      .pr(8)
      .rounded(5)
      .items_center()
      .cursor_pointer()
      .when(isSelected, e => e.bg(t.selected))
      .when(!isSelected, e => e.hover(s => s.bg(t.hover)))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.contextMenu = null;
        const now = Date.now();
        const isDouble =
          e.click_count >= 2 ||
          (this.lastFileClick?.id === f.id && now - this.lastFileClick.ts < 350);
        this.lastFileClick = { id: f.id, ts: isDouble ? 0 : now };
        if (isDouble) {
          this.openInFiles(f, null, cx);
          return;
        }
        this.pick(f.id, cx);
      })
      .on_mouse_down("right", () => {
        this.pendingMenu = this.buildEntryMenuItems(relPath, false);
      })
      .children(this.renderIndentGuides(depth, t))
      .child(
        div()
          .w(16)
          .h_full()
          .flex_none()
          .flex()
          .items_center()
          .justify_center()
          .mr(5)
          .child(svg(fileIcon.svg).size(15).flex_none().text_color(fileIcon.color)),
      )
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_size(12.5)
          .text_color(labelColor)
          .child(f.name),
      )
      .when(f.add > 0, e =>
        e.child(div().flex_none().ml(4).text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)),
      )
      .when(f.del > 0, e =>
        e.child(div().flex_none().ml(3).text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)),
      )
      .child(
        div()
          .flex_none()
          .ml(5)
          .text_size(11)
          .font_semibold()
          .text_color(labelColor)
          .child(f.status),
      );
  }

  renderTreeNodes(node, depth, hasFilter, out, t) {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const sub of folders) {
      const open = hasFilter || !this.collapsedFolders.has(sub.key);
      out.push(this.renderTreeFolderRow(sub, depth, open, t));
      if (open) {
        this.renderTreeNodes(sub, depth + 1, hasFilter, out, t);
      }
    }
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of files) {
      out.push(this.renderTreeFileRow(f, depth, t));
    }
  }

  renderTreeItems(t) {
    const hasFilter = Boolean(this.filterQuery.trim());
    const out = [];

    if (!this.multiRepo) {
      const matched = this.filteredFiles();
      const tree = buildRepoChangeTree(matched, "");
      this.renderTreeNodes(tree, 0, hasFilter, out, t);
      return out;
    }

    for (const g of this.groups) {
      const groupFiles = hasFilter ? g.files.filter(f => this.matchesFilter(f)) : g.files;
      if (hasFilter && groupFiles.length === 0) continue;
      const folded = !hasFilter && this.foldedGroups.has(g.repoRel);
      const isTarget = this.activeRepoRoot === g.repoRoot;

      out.push(
        h_flex()
          .id(`change-group-${g.repoRel}`)
          .h(24)
          .flex_none()
          .mx(4)
          .pl(6)
          .pr(8)
          .rounded(5)
          .items_center()
          .cursor_pointer()
          .when(isTarget, el => el.bg(t.raised))
          .hover(s => s.bg(t.hover))
          .on_click((_e, cx) => {
            this.contextMenu = null;
            this.toggleGroup(g.repoRel, g.repoRoot, cx);
          })
          .on_mouse_down("right", () => {
            this.pendingMenu = this.buildEntryMenuItems(g.repoRel, true);
          })
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
                svg(`${ICON_PREFIX}/codicon-chevron-${folded ? "right" : "down"}.svg`)
                  .size(13)
                  .flex_none()
                  .text_color(t.muted),
              ),
          )
          .child(
            div()
              .flex_none()
              .mr(6)
              .text_size(12.5)
              .font_medium()
              .text_color(t.foreground)
              .child(g.repoRel),
          )
          .when(Boolean(g.branch), el => el.child(renderGitBranchSubtitle(g.branch, t)))
          .when(!g.branch, el => el.child(div().flex_1()))
          .child(
            div()
              .flex_none()
              .ml(4)
              .px(4)
              .rounded(3)
              .bg(t.raised)
              .border_1()
              .border_color(t.border)
              .text_size(10)
              .text_color(t.muted)
              .child(hasFilter ? `${groupFiles.length}/${g.files.length}` : `${g.files.length}`),
          ),
      );

      if (!folded) {
        const tree = buildRepoChangeTree(groupFiles, g.repoRel);
        this.renderTreeNodes(tree, 1, hasFilter, out, t);
      }
    }
    return out;
  }

  renderWorktreeDropdownMenu(t, baseRootName) {
    const features = this.wtFeatures || [];
    const activeRel = this.selectedFeature || null;
    const multipleWtDirs = (this.wtDirs || []).length > 1;

    return div()
      .id("changes-wt-dropdown-backdrop")
      .absolute()
      .inset_0()
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.wtDropdownOpen = false;
        cx.notify();
      })
      .child(
        v_flex()
          .id("changes-wt-dropdown-menu")
          .absolute()
          .top(31)
          .left(6)
          .right(6)
          .max_h(320)
          .py(5)
          .gap(2)
          .rounded(8)
          .bg(t.popover)
          .border_1()
          .border_color(t.border)
          .shadow_md()
          .overflow_y_scrollbar()
          .text_size(12)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            div()
              .mx(5)
              .px(6)
              .py(3)
              .text_size(10.5)
              .text_color(t.dim)
              .child("Workspace Root"),
          )
          .child(
            h_flex()
              .id("changes-wt-opt-root")
              .mx(5)
              .h(26)
              .px(8)
              .gap(6)
              .rounded(5)
              .items_center()
              .cursor_pointer()
              .when(!activeRel, el => el.bg(t.selected).text_color(t.accent))
              .when(Boolean(activeRel), el =>
                el.text_color(t.foreground).hover(s => s.bg(t.hover)),
              )
              .on_click((_e, cx) => this.selectFeature(null, cx))
              .child(
                svg("mods/ide-files/folder.svg")
                  .size(13)
                  .flex_none()
                  .text_color(!activeRel ? t.accent : t.muted),
              )
              .child(div().flex_1().min_w(0).truncate().child(baseRootName))
              .child(div().flex_none().pl(4).text_size(10.5).text_color(t.dim).child("main")),
          )
          .child(div().mx(8).my(3).h(1).bg(t.border))
          .child(
            div()
              .mx(5)
              .px(6)
              .py(3)
              .text_size(10.5)
              .text_color(t.dim)
              .child(`Parallel Features (${features.length})`),
          )
          .when(features.length === 0, menu =>
            menu.child(
              div()
                .mx(5)
                .px(6)
                .py(6)
                .text_size(11.5)
                .text_color(t.dim)
                .child(`No features in ${(this.wtDirs && this.wtDirs[0]) || ".worktree"}/`),
            ),
          )
          .children(
            features.map(feat => {
              const isSelected = activeRel === feat.relPath;
              return h_flex()
                .id(`changes-wt-opt-${feat.relPath}`)
                .mx(5)
                .h(26)
                .px(8)
                .gap(6)
                .rounded(5)
                .items_center()
                .cursor_pointer()
                .when(isSelected, el => el.bg(t.selected).text_color(t.accent))
                .when(!isSelected, el =>
                  el.text_color(t.foreground).hover(s => s.bg(t.hover)),
                )
                .on_click((_e, cx) => this.selectFeature(feat.relPath, cx))
                .child(
                  svg("mods/workspace-chrome/git-branch.svg")
                    .size(12.5)
                    .flex_none()
                    .text_color(isSelected ? t.accent : t.muted),
                )
                .child(div().flex_1().min_w(0).truncate().child(feat.name))
                .when(multipleWtDirs, el =>
                  el.child(div().flex_none().pl(4).text_size(10.5).text_color(t.dim).child(feat.wtDir)),
                );
            }),
          ),
      );
  }

  renderChangesSidebar(t) {
    const baseRootName = (this.baseRoot || this.root)?.split(/[\\/]/).pop() || "changes";
    const rootName = this.root?.split(/[\\/]/).pop() || "changes";
    const activeFeatureObj = this.selectedFeature
      ? (this.wtFeatures || []).find(f => f.relPath === this.selectedFeature)
      : null;
    const hasFilter = Boolean(this.filterQuery.trim());
    const treeItems = this.renderTreeItems(t);
    const targetRoot = this.activeRepoRoot || (!this.multiRepo ? this.root : null);
    const enabled = Boolean(this.message.trim() && targetRoot && !this.busy && !this.loading);

    return v_flex()
      .id("changes-explorer-sidebar")
      .relative()
      .w(RIGHT_SIDEBAR_WIDTH)
      .flex_none()
      .h_full()
      .min_h(0)
      .border_l(1)
      .border_color(t.border)
      // 1. Sidebar Header (30px): Worktree Branch Dropdown + Refresh + Collapse All (aligned with Files)
      .child(
        h_flex()
          .id("changes-header")
          .h(30)
          .flex_none()
          .pl(8)
          .pr(6)
          .gap(4)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(this.hasWorktreeDir, hdr =>
            hdr.child(
              h_flex()
                .id("changes-wt-dropdown-btn")
                .flex_1()
                .min_w(0)
                .h(22)
                .px(6)
                .gap(5)
                .rounded(5)
                .items_center()
                .cursor_pointer()
                .border_1()
                .border_color(
                  this.wtDropdownOpen || activeFeatureObj ? t.accent : t.border,
                )
                .when(Boolean(activeFeatureObj), el => el.bg(t.selected))
                .when(!activeFeatureObj && this.wtDropdownOpen, el => el.bg(t.hover))
                .hover(s => s.bg(activeFeatureObj ? t.selected : t.hover))
                .tooltip(
                  activeFeatureObj
                    ? `Feature Worktree: ${activeFeatureObj.relPath} (点击切换)`
                    : `Workspace: ${baseRootName} · ${this.wtFeatures.length} worktree features (点击切换)`,
                )
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.wtDropdownOpen = !this.wtDropdownOpen;
                  cx.notify();
                })
                .child(
                  svg(
                    activeFeatureObj
                      ? "mods/workspace-chrome/git-branch.svg"
                      : "mods/ide-files/folder.svg",
                  )
                    .size(12.5)
                    .flex_none()
                    .text_color(activeFeatureObj ? t.accent : t.muted),
                )
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(12)
                    .font_medium()
                    .text_color(activeFeatureObj ? t.accent : t.foreground)
                    .child(activeFeatureObj ? activeFeatureObj.name : baseRootName),
                )
                .when(!activeFeatureObj && this.wtFeatures.length > 0, el =>
                  el.child(
                    div()
                      .flex_none()
                      .px(4)
                      .rounded(3)
                      .bg(t.raised)
                      .text_size(10)
                      .text_color(t.muted)
                      .child(String(this.wtFeatures.length)),
                  ),
                )
                .child(
                  svg(
                    `${ICON_PREFIX}/codicon-chevron-${this.wtDropdownOpen ? "down" : "right"}.svg`,
                  )
                    .size(11.5)
                    .flex_none()
                    .text_color(t.dim),
                ),
            ),
          )
          .when(!this.hasWorktreeDir && Boolean(this.singleBranch), hdr =>
            hdr
              .child(
                div()
                  .flex_none()
                  .mr(6)
                  .text_size(12)
                  .text_color(t.muted)
                  .child(rootName),
              )
              .child(renderGitBranchSubtitle(this.singleBranch, t)),
          )
          .when(!this.hasWorktreeDir && !this.singleBranch, hdr =>
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
                  "changes-refresh",
                  "refresh",
                  "Refresh Changes",
                  (_e, cx) => {
                    this.refresh(cx, true);
                  },
                ),
              )
              .child(
                this.headerIconButton(
                  t,
                  "changes-collapse",
                  "collapse-all",
                  "Collapse / Expand Folders",
                  (_e, cx) => {
                    this.collapseAll(cx);
                  },
                ),
              ),
          ),
      )
      // 2. Filter Files Input Bar directly under header
      .child(
        h_flex()
          .flex_none()
          .px(6)
          .py(5)
          .border_b(1)
          .border_color(t.border)
          .child(
            h_flex()
              .id("changes-filter-box")
              .w_full()
              .h(24)
              .px(7)
              .gap(5)
              .items_center()
              .rounded(5)
              .bg(t.raised)
              .border_1()
              .border_color(this.filterFocused ? t.accent : t.border)
              .cursor_text()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(
                svg("mods/ide-changes/search.svg")
                  .size(12)
                  .flex_none()
                  .text_color(this.filterFocused || hasFilter ? t.accent : t.dim),
              )
              .child(
                Input.new(this.filterInput)
                  .flex_1()
                  .h_full()
                  .text_size(11.5)
                  .text_color(t.foreground),
              )
              .when(hasFilter, box =>
                box.child(
                  div()
                    .id("changes-filter-clear")
                    .size(16)
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(4)
                    .cursor_pointer()
                    .text_color(t.muted)
                    .hover(s => s.bg(t.hover).text_color(t.foreground))
                    .tooltip("Clear Filter (Esc)")
                    .on_click((_e, cx) => {
                      cx.stop_propagation();
                      this.clearFilter(cx);
                    })
                    .child(svg("mods/ide-changes/close.svg").size(10.5)),
                ),
              ),
          ),
      )
      // 3. Hierarchical Changes File Tree grouped by Repository
      .child(
        v_flex()
          .id("changes-tree")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .py(4)
          .children(treeItems)
          .when(!this.files.length, e =>
            e.child(
              div()
                .p(8)
                .text_size(12)
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
          )
          .when(this.files.length > 0 && !treeItems.length, e =>
            e.child(
              div()
                .p(8)
                .text_size(12)
                .text_color(t.dim)
                .child(`No changed files matching "${this.filterQuery}"`),
            ),
          )
          .when(this.limited, e =>
            e.child(
              div()
                .p(8)
                .text_size(11)
                .text_color(t.dim)
                .child("Showing first 1,000 changed files"),
            ),
          ),
      )
      // 4. Commit Box at the bottom of the sidebar
      .child(
        v_flex()
          .flex_none()
          .p(6)
          .gap(5)
          .border_t(1)
          .border_color(t.border)
          .when(Boolean(this.multiRepo && this.activeRepoRel), el =>
            el.child(
              h_flex()
                .gap(4)
                .px(2)
                .items_center()
                .text_size(10.5)
                .text_color(t.dim)
                .child(div().child("Target:"))
                .child(div().font_medium().text_color(t.muted).truncate().child(this.activeRepoRel)),
            ),
          )
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(
                div()
                  .id("commit-message")
                  .flex_1()
                  .min_w(0)
                  .h(26)
                  .px(8)
                  .flex()
                  .items_center()
                  .rounded(5)
                  .bg(t.raised)
                  .border_1()
                  .border_color(this.typing ? t.accent : t.border)
                  .cursor_text()
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(Input.new(this.input).h_full().text_size(11.5).text_color(t.foreground)),
              )
              .child(
                div()
                  .id("commit")
                  .h(26)
                  .px(10)
                  .flex_none()
                  .flex()
                  .items_center()
                  .rounded(5)
                  .bg(enabled ? t.solid : t.raised)
                  .text_color(enabled ? t.solid_foreground : t.dim)
                  .text_size(11.5)
                  .when(enabled, e => e.cursor_pointer())
                  .on_click((_e, cx) => this.commit(cx))
                  .child(this.busy ? "…" : "Commit"),
              ),
          ),
      )
      .when(this.hasWorktreeDir && this.wtDropdownOpen, el =>
        el.child(this.renderWorktreeDropdownMenu(t, baseRootName)),
      );
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
      .id("changes-menu-backdrop")
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
          .id("changes-menu-popup")
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
                    .id(`cmi-${i}`)
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

  checkPendingSync(cx) {
    if (this.syncTaskScheduled || !this.context?.key) return;
    const sharedState = readSharedWtState(this.context.key);
    const rawWantFeature = sharedState ? sharedState.selectedFeature || null : null;
    const validWantFeature =
      rawWantFeature && this.wtLoaded && !this.wtFeatures.some(f => f.relPath === rawWantFeature)
        ? null
        : rawWantFeature;
    const hasWtChange =
      sharedState &&
      (validWantFeature !== (this.selectedFeature || null) ||
        rawWantFeature !== validWantFeature ||
        Boolean(sharedState.userPinnedRoot) !== Boolean(this.userPinnedRoot));
    if (!hasWtChange) return;
    this.syncTaskScheduled = true;
    cx.spawn(async cx => {
      try {
        await cx.sleep(1);
        this.syncSharedWorktree(cx);
      } finally {
        this.syncTaskScheduled = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    if (!this.current(this.context)) this.refresh(cx);
    this.checkPendingSync(cx);
    this.rememberTarget();
    const t = theme();

    return v_flex()
      .id("changes")
      .relative()
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
      .on_size_change(size => {
        this.panelSize = size;
      })
      .on_key_down((e, cx) => {
        const k = (e.key || "").toLowerCase();
        const cmdOrCtrl = Boolean(e.modifiers?.platform || e.modifiers?.control);
        if (cmdOrCtrl && k === "f") {
          cx.stop_propagation();
          this.rightSidebarCollapsed = false;
          this.filterInput.focus();
          cx.notify();
          return;
        }
        if (e.modifiers?.alt && (k === "[" || k === "arrowup")) {
          cx.stop_propagation();
          this.stepChangedFile(-1, cx);
          return;
        }
        if (e.modifiers?.alt && (k === "]" || k === "arrowdown")) {
          cx.stop_propagation();
          this.stepChangedFile(1, cx);
          return;
        }
        if (k === "escape") {
          if (this.contextMenu) {
            cx.stop_propagation();
            this.contextMenu = null;
            cx.notify();
            return;
          }
          if (this.wtDropdownOpen) {
            cx.stop_propagation();
            this.wtDropdownOpen = false;
            cx.notify();
            return;
          }
          if (this.filterFocused) {
            cx.stop_propagation();
            if (this.filterQuery) {
              this.clearFilter(cx);
            } else {
              this.filterFocused = false;
              this.handle.focus();
              cx.notify();
            }
            return;
          }
          if (this.typing) {
            this.typing = false;
            this.handle.focus();
            cx.stop_propagation();
            cx.notify();
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
      // Unified Top Bar (File Breadcrumbs + Status/Stats | < > + Sidebar Toggle)
      .child(this.renderUnifiedTopBar(t))
      // Main Split Body: Left persistent Content Diff Viewer + Right collapsible Changes File Tree Sidebar
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .w_full()
          .child(this.renderDiffMainPane(t))
          .when(!this.rightSidebarCollapsed, row =>
            row.child(this.renderChangesSidebar(t)),
          ),
      )
      .when(Boolean(this.contextMenu), el => el.child(this.renderContextMenuOverlay(t)));
  }
}
