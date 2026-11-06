import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";
import { exec, readTextFile, writeTextFile, notify } from "herdr";
import { getFileIcon, ICON_PREFIX } from "./icons.js";
import {
  SEARCH_SIDEBAR_WIDTH,
  buildSearchRegExp,
  compileFileMatchers,
  applyPreserveCase,
  formatRef,
  pasteIntoTerminal,
} from "./utils.js";

export async function runWorkspaceSearch(root, on, query, opts) {
  const { caseSensitive, wholeWord, regex, hasIncludeFilter } = opts;
  const rgArgs = [
    "--no-config",
    "--json",
    "--hidden",
    "--follow",
    "--no-messages",
    "--max-count=100",
    "--max-columns=500",
    "-g",
    "!.git",
    "-g",
    "!node_modules",
    "-g",
    "!.worktree",
    caseSensitive ? "--case-sensitive" : "--ignore-case",
  ];
  if (hasIncludeFilter) rgArgs.push("--no-ignore");
  if (wholeWord) rgArgs.push("--word-regexp");
  if (!regex) rgArgs.push("--fixed-strings");
  rgArgs.push("--", query, ".");

  // Exit 0 whenever rg is found, even if rg returns exit code 2 due to broken symlinks
  const script = `
export PATH="$PATH:$HOME/.pi/agent/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
if command -v rg >/dev/null 2>&1; then
  rg "$@"
  exit 0
fi
exit 127
`;
  const r = await exec("sh", ["-c", script, "ws-rg", ...rgArgs], { cwd: root, on }).catch(() => null);
  if (r && r.code === 0) {
    return { mode: "rg-json", stdout: r.stdout || "" };
  }

  // Fallback to grep if rg is unavailable
  const grepFlags = ["-rnI", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=.worktree"];
  if (!caseSensitive) grepFlags.push("-i");
  if (wholeWord) grepFlags.push("-w");
  grepFlags.push(regex ? "-E" : "-F");
  grepFlags.push("--", query, ".");
  const gr = await exec("grep", grepFlags, { cwd: root, on }).catch(() => null);
  return { mode: "grep", stdout: gr?.stdout || "" };
}

export const searchMethods = {
  openWorkspaceSearch(cx) {
    if (!this.searchMode) {
      if (this.panelSize?.width && this.panelSize.width <= 520) {
        this.savedExplorerWidth = this.panelSize.width;
      }
      this.searchMode = true;
      this.syncPanelWidth();
    }
    this.wsSearchInput.focus();
    if (this.wsSearchInput.value().trim()) {
      this.executeWorkspaceSearch(cx);
    }
    cx.notify();
  },

  closeWorkspaceSearch(cx) {
    this.searchMode = false;
    this.syncPanelWidth();
    this.handle.focus();
    cx.notify();
  },

  scheduleWorkspaceSearch(cx) {
    const seq = ++this.wsSearchSeq;
    cx.timer.after(180, cx => {
      if (seq !== this.wsSearchSeq) return;
      this.executeWorkspaceSearch(cx);
    });
  },

  async executeWorkspaceSearch(cx) {
    const seq = ++this.wsSearchSeq;
    this.wsQuery = this.wsSearchInput.value();
    this.wsInclude = this.wsIncludeInput.value();
    this.wsExclude = this.wsExcludeInput.value();
    const query = this.wsQuery;
    this.wsRegexError = null;
    if (!query || !this.root) {
      this.wsGroups = [];
      this.wsTotalMatches = 0;
      this.wsSearching = false;
      cx.notify();
      return;
    }

    const { re, error } = buildSearchRegExp(query, {
      caseSensitive: this.wsCase,
      wholeWord: this.wsWord,
      regex: this.wsRegex,
    });
    if (error || !re) {
      this.wsRegexError = error || "Invalid search pattern";
      this.wsGroups = [];
      this.wsTotalMatches = 0;
      this.wsSearching = false;
      cx.notify();
      return;
    }

    const includeMatchers = compileFileMatchers(this.wsInclude);
    const excludeMatchers = compileFileMatchers(this.wsExclude);

    this.wsSearching = true;
    cx.notify();

    const root = this.root;
    const on = this.on;
    try {
      const res = await runWorkspaceSearch(root, on, query, {
        caseSensitive: this.wsCase,
        wholeWord: this.wsWord,
        regex: this.wsRegex,
        hasIncludeFilter: includeMatchers.length > 0,
      });
      if (seq !== this.wsSearchSeq) return;

      const groupMap = new Map();
      let totalMatches = 0;
      const MAX_TOTAL_MATCHES = 1000;

      const addMatchLine = (rawPath, lineNo, rawLineText) => {
        if (totalMatches >= MAX_TOTAL_MATCHES) return;
        const cleanPath = rawPath.replace(/^\.\/+/, "").replace(/^\/+/, "");
        if (!cleanPath) return;
        if (includeMatchers.length > 0 && !includeMatchers.some(mRe => mRe.test(cleanPath))) {
          return;
        }
        if (excludeMatchers.length > 0 && excludeMatchers.some(mRe => mRe.test(cleanPath))) {
          return;
        }

        const lineText = rawLineText.replace(/\r?\n$/, "");
        re.lastIndex = 0;
        const matchesOnLine = [];
        let m;
        let safety = 0;
        while ((m = re.exec(lineText)) !== null && safety++ < 50) {
          if (m[0].length === 0) {
            re.lastIndex++;
            continue;
          }
          matchesOnLine.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
        }
        if (!matchesOnLine.length) {
          matchesOnLine.push({ start: 0, end: 0, text: "" });
        }

        let group = groupMap.get(cleanPath);
        if (!group) {
          const slash = cleanPath.lastIndexOf("/");
          const name = slash >= 0 ? cleanPath.slice(slash + 1) : cleanPath;
          const dir = slash >= 0 ? cleanPath.slice(0, slash) : "";
          group = { path: cleanPath, name, dir, matches: [] };
          groupMap.set(cleanPath, group);
        }

        for (const span of matchesOnLine) {
          if (totalMatches >= MAX_TOTAL_MATCHES) break;
          group.matches.push({
            line: lineNo,
            lineText,
            start: span.start,
            end: span.end,
            matchText: span.text,
          });
          totalMatches++;
        }
      };

      if (res.mode === "rg-json") {
        for (const row of res.stdout.split("\n")) {
          if (!row) continue;
          let parsed;
          try {
            parsed = JSON.parse(row);
          } catch {
            continue;
          }
          if (parsed?.type !== "match") continue;
          const relPath = parsed.data?.path?.text || "";
          const lineNo = parsed.data?.line_number || 1;
          const lineText = parsed.data?.lines?.text || "";
          addMatchLine(relPath, lineNo, lineText);
          if (totalMatches >= MAX_TOTAL_MATCHES) break;
        }
      } else {
        for (const row of res.stdout.split("\n")) {
          if (!row) continue;
          const m = /^([^:]+):(\d+):(.*)$/.exec(row);
          if (!m) continue;
          addMatchLine(m[1], Number(m[2]) || 1, m[3]);
          if (totalMatches >= MAX_TOTAL_MATCHES) break;
        }
      }

      const groups = [...groupMap.values()].sort((a, b) => a.path.localeCompare(b.path));
      this.wsGroups = groups;
      this.wsTotalMatches = totalMatches;
    } catch (e) {
      if (seq === this.wsSearchSeq) {
        this.wsRegexError = String(e?.message || e);
        this.wsGroups = [];
        this.wsTotalMatches = 0;
      }
    } finally {
      if (seq === this.wsSearchSeq) {
        this.wsSearching = false;
        cx.notify();
      }
    }
  },

  dismissSearchFile(filePath, cx) {
    const idx = this.wsGroups.findIndex(g => g.path === filePath);
    if (idx < 0) return;
    const removed = this.wsGroups[idx];
    this.wsGroups.splice(idx, 1);
    this.wsTotalMatches = Math.max(0, this.wsTotalMatches - removed.matches.length);
    cx.notify();
  },

  async replaceInSingleFile(filePath, cx, silent = false) {
    if (!this.wsQuery || !this.root) return 0;
    const { re, error } = buildSearchRegExp(this.wsQuery, {
      caseSensitive: this.wsCase,
      wholeWord: this.wsWord,
      regex: this.wsRegex,
    });
    if (error || !re) return 0;
    const absPath = `${this.root}/${filePath}`;
    const original = await readTextFile(absPath, { on: this.on }).catch(() => null);
    if (original === null) return 0;

    let count = 0;
    const updated = original.replace(re, (...args) => {
      count++;
      const matched = args[0];
      if (this.wsPreserveCase) {
        return applyPreserveCase(matched, this.wsReplace);
      }
      return this.wsReplace;
    });

    if (count > 0 && updated !== original) {
      await writeTextFile(absPath, updated, original);
    }
    if (!silent) {
      if (count > 0) {
        notify({
          title: "Replaced",
          body: `Replaced ${count} occurrence${count > 1 ? "s" : ""} in ${filePath}`,
          timeout: 1800,
        });
      }
      this.dismissSearchFile(filePath, cx);
      this.refresh(cx);
    }
    return count;
  },

  async replaceAllInWorkspace(cx) {
    if (!this.wsQuery || !this.wsGroups.length || this.wsReplacing) return;
    this.wsReplacing = true;
    cx.notify();
    let totalReplaced = 0;
    let filesChanged = 0;
    try {
      const paths = this.wsGroups.map(g => g.path);
      for (const p of paths) {
        const c = await this.replaceInSingleFile(p, cx, true);
        if (c > 0) {
          totalReplaced += c;
          filesChanged++;
        }
      }
      if (totalReplaced > 0) {
        notify({
          title: "Replace All Complete",
          body: `Replaced ${totalReplaced} occurrence${totalReplaced > 1 ? "s" : ""} across ${filesChanged} file${filesChanged > 1 ? "s" : ""}`,
          timeout: 2200,
        });
      }
      await this.executeWorkspaceSearch(cx);
      this.refresh(cx);
    } finally {
      this.wsReplacing = false;
      cx.notify();
    }
  },

  renderSearchMatchSnippet(m, t) {
    const raw = m.lineText || "";
    const leadingSpaces = raw.length - raw.trimStart().length;
    const trimmed = raw.slice(leadingSpaces);
    const adjStart = Math.max(0, m.start - leadingSpaces);
    const adjEnd = Math.max(adjStart, Math.min(trimmed.length, m.end - leadingSpaces));

    if (adjEnd <= adjStart) {
      return div().flex_1().min_w(0).truncate().text_color(t.muted).child(trimmed || " ");
    }

    let prefixStart = 0;
    let prefixEllipsis = "";
    if (adjStart > 18) {
      prefixStart = adjStart - 12;
      prefixEllipsis = "…";
    }
    const before = prefixEllipsis + trimmed.slice(prefixStart, adjStart);
    const matchStr = trimmed.slice(adjStart, adjEnd);
    const after = trimmed.slice(adjEnd, adjEnd + 80);

    return h_flex()
      .flex_1()
      .min_w(0)
      .overflow_hidden()
      .items_center()
      .child(div().flex_none().text_color(t.muted).child(before))
      .child(
        div()
          .flex_none()
          .px(1.5)
          .rounded(2)
          .bg("#264f78")
          .text_color("#ffffff")
          .child(matchStr),
      )
      .when(Boolean(this.wsReplace), el =>
        el.child(
          div()
            .flex_none()
            .ml(3)
            .px(1.5)
            .rounded(2)
            .bg("#2ea04340")
            .text_color("#63c29f")
            .child(
              this.wsPreserveCase ? applyPreserveCase(matchStr, this.wsReplace) : this.wsReplace,
            ),
        ),
      )
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(after));
  },

  renderWorkspaceSearchSidebar(t) {
    const rootName = (this.root?.split(/[\\/]/).pop() || "FILES").toUpperCase();
    const resultRows = [];
    for (const g of this.wsGroups) {
      const folded = this.wsFoldedFiles.has(g.path);
      const icon = getFileIcon(g.name);

      resultRows.push(
        h_flex()
          .id(`ws-file-${g.path}`)
          .h(24)
          .flex_none()
          .pl(6)
          .pr(8)
          .items_center()
          .cursor_pointer()
          .hover(s => s.bg(t.hover))
          .on_hover((hovered, cx) => {
            this.wsHoveredFile = hovered
              ? g.path
              : this.wsHoveredFile === g.path
                ? null
                : this.wsHoveredFile;
            cx.notify();
          })
          .on_click((_e, cx) => {
            if (folded) this.wsFoldedFiles.delete(g.path);
            else this.wsFoldedFiles.add(g.path);
            cx.notify();
          })
          .on_mouse_down("right", () => {
            this.pendingMenu = this.buildEntryMenuItems(g.path, false);
          })
          .child(
            div()
              .w(16)
              .h_full()
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .mr(3)
              .child(
                svg(`${ICON_PREFIX}/codicon-chevron-${folded ? "right" : "down"}.svg`)
                  .size(13)
                  .text_color(t.muted),
              ),
          )
          .child(
            div()
              .w(16)
              .h_full()
              .flex_none()
              .flex()
              .items_center()
              .justify_center()
              .mr(5)
              .child(svg(icon.svg).size(15).text_color(icon.color)),
          )
          .child(div().flex_none().mr(6).text_size(12.5).text_color(t.foreground).child(g.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(g.dir))
          .when(this.wsHoveredFile === g.path, el =>
            el.child(
              h_flex()
                .flex_none()
                .gap(2)
                .ml(4)
                .items_center()
                .child(
                  div()
                    .id(`ws-rep-${g.path}`)
                    .size(18)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(3)
                    .text_color(t.muted)
                    .hover(s => s.bg(t.raised).text_color(t.foreground))
                    .tooltip("Replace in File")
                    .on_click((e, cx) => {
                      cx.stop_propagation();
                      this.replaceInSingleFile(g.path, cx);
                    })
                    .child(svg(`${ICON_PREFIX}/codicon-replace.svg`).size(12)),
                )
                .child(
                  div()
                    .id(`ws-dis-${g.path}`)
                    .size(18)
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(3)
                    .text_color(t.muted)
                    .hover(s => s.bg(t.raised).text_color(t.foreground))
                    .tooltip("Dismiss")
                    .on_click((e, cx) => {
                      cx.stop_propagation();
                      this.dismissSearchFile(g.path, cx);
                    })
                    .child(svg(`${ICON_PREFIX}/codicon-close.svg`).size(12)),
                ),
            ),
          )
          .when(this.wsHoveredFile !== g.path, el =>
            el.child(
              div()
                .flex_none()
                .ml(6)
                .min_w(18)
                .h(16)
                .px(5)
                .rounded(8)
                .bg(t.raised)
                .flex()
                .items_center()
                .justify_center()
                .text_size(10.5)
                .text_color(t.muted)
                .child(String(g.matches.length)),
            ),
          ),
      );

      if (!folded) {
        g.matches.forEach((m, mIdx) => {
          const matchRef = formatRef(g.path, false, m.line, m.line);
          const isCurrentOpenMatch = this.file === g.path && this.selStart === m.line;
          resultRows.push(
            h_flex()
              .id(`ws-match-${g.path}-${mIdx}`)
              .h(22)
              .flex_none()
              .pl(28)
              .pr(10)
              .items_center()
              .cursor_pointer()
              .text_size(12)
              .when(isCurrentOpenMatch, el => el.bg(t.selected))
              .when(!isCurrentOpenMatch, el => el.hover(s => s.bg(t.hover)))
              .on_mouse_down("left", (e, cx) => {
                cx.stop_propagation();
                this.contextMenu = null;
                const target = this.rememberTarget();
                this.drag = {
                  kind: "ws-match",
                  path: g.path,
                  lineNo: m.line,
                  ref: matchRef,
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
                } else {
                  this.show(g.path, cx, {
                    lineNo: m.line,
                    query: this.wsQuery,
                    caseSensitive: this.wsCase,
                    wholeWord: this.wsWord,
                    regex: this.wsRegex,
                  });
                }
                cx.notify();
              })
              .on_mouse_down("right", () => {
                this.pendingMenu = this.buildEntryMenuItems(g.path, false, m.line);
              })
              .child(this.renderSearchMatchSnippet(m, t)),
          );
        });
      }
    }

    return v_flex()
      .id("ws-search-panel")
      .w(SEARCH_SIDEBAR_WIDTH)
      .flex_none()
      .h_full()
      .min_h(0)
      .when(Boolean(this.file), el => el.border_l(1).border_color(t.border))
      .children([
        // Search Sidebar Header Bar
        h_flex()
          .id("ws-search-header")
          .h(30)
          .flex_none()
          .pl(6)
          .pr(8)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .when(!this.file, hdr =>
            hdr.child(
              div()
                .id("ws-back-explorer")
                .w(18)
                .h(20)
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .mr(4)
                .rounded(4)
                .cursor_pointer()
                .text_color(t.muted)
                .hover(s => s.bg(t.hover).text_color(t.foreground))
                .tooltip("Back to Explorer")
                .on_click((_e, cx) => this.closeWorkspaceSearch(cx))
                .child("←"),
            ),
          )
          .child(div().flex_none().mr(6).text_size(11.5).font_bold().text_color(t.muted).child("SEARCH"))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(rootName))
          .child(
            h_flex()
              .flex_none()
              .gap(2)
              .items_center()
              .child(
                this.headerIconButton(t, "ws-hdr-refresh", "refresh", "Refresh Search", (_e, cx) => {
                  this.executeWorkspaceSearch(cx);
                }),
              )
              .child(
                this.headerIconButton(
                  t,
                  "ws-hdr-collapse",
                  "collapse-all",
                  "Collapse / Expand All",
                  (_e, cx) => {
                    this.collapseAll(cx);
                  },
                ),
              )
              .child(
                this.headerIconButton(
                  t,
                  "ws-hdr-close",
                  "search",
                  "Close Search Files",
                  (_e, cx) => this.closeWorkspaceSearch(cx),
                  true,
                ),
              ),
          ),

        // Top Search & Replace Form
        v_flex()
          .flex_none()
          .px(8)
          .pt(8)
          .pb(6)
          .gap(6)
          .border_b(1)
          .border_color(t.border)
          // Row 1: Search Input + Filter toggle
          .child(
            h_flex()
              .gap(5)
              .items_center()
              .child(
                h_flex()
                  .id("ws-search-box")
                  .flex_1()
                  .min_w(0)
                  .h(28)
                  .px(7)
                  .gap(4)
                  .items_center()
                  .rounded(5)
                  .bg(t.raised)
                  .border_1()
                  .border_color(
                    this.wsRegexError ? "#e06c75" : this.wsSearchFocused ? t.accent : t.border,
                  )
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(
                    svg(`${ICON_PREFIX}/codicon-search.svg`)
                      .size(12.5)
                      .flex_none()
                      .text_color(t.dim),
                  )
                  .child(
                    Input.new(this.wsSearchInput)
                      .flex_1()
                      .h_full()
                      .text_size(12.5)
                      .text_color(t.foreground),
                  )
                  .child(
                    this.renderOptionToggle(
                      t,
                      "ws-opt-case",
                      "Aa",
                      this.wsCase,
                      "Match Case",
                      (_e, cx) => {
                        this.wsCase = !this.wsCase;
                        this.executeWorkspaceSearch(cx);
                      },
                    ),
                  )
                  .child(
                    this.renderOptionToggle(
                      t,
                      "ws-opt-word",
                      "[ ]",
                      this.wsWord,
                      "Match Whole Word",
                      (_e, cx) => {
                        this.wsWord = !this.wsWord;
                        this.executeWorkspaceSearch(cx);
                      },
                    ),
                  )
                  .child(
                    this.renderOptionToggle(
                      t,
                      "ws-opt-regex",
                      ".*",
                      this.wsRegex,
                      "Use Regular Expression",
                      (_e, cx) => {
                        this.wsRegex = !this.wsRegex;
                        this.executeWorkspaceSearch(cx);
                      },
                    ),
                  ),
              )
              .child(
                div()
                  .id("ws-toggle-details")
                  .size(24)
                  .flex_none()
                  .flex()
                  .items_center()
                  .justify_center()
                  .rounded(4)
                  .cursor_pointer()
                  .when(this.wsShowDetails, el => el.bg(t.selected))
                  .text_color(this.wsShowDetails ? t.accent : t.muted)
                  .hover(s => s.bg(t.hover).text_color(t.foreground))
                  .tooltip("Toggle Replace & File Filters")
                  .on_click((_e, cx) => {
                    this.wsShowDetails = !this.wsShowDetails;
                    cx.notify();
                  })
                  .child(svg(`${ICON_PREFIX}/codicon-sliders.svg`).size(13.5)),
              ),
          )
          // Row 2..4: Replace + Include + Exclude (when wsShowDetails is true)
          .when(this.wsShowDetails, form =>
            form
              .child(
                h_flex()
                  .gap(5)
                  .items_center()
                  .child(
                    h_flex()
                      .id("ws-replace-box")
                      .flex_1()
                      .min_w(0)
                      .h(28)
                      .px(7)
                      .gap(4)
                      .items_center()
                      .rounded(5)
                      .bg(t.raised)
                      .border_1()
                      .border_color(this.wsReplaceFocused ? t.accent : t.border)
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .child(
                        Input.new(this.wsReplaceInput)
                          .flex_1()
                          .h_full()
                          .text_size(12.5)
                          .text_color(t.foreground),
                      )
                      .child(
                        this.renderOptionToggle(
                          t,
                          "ws-opt-preserve",
                          "AB",
                          this.wsPreserveCase,
                          "Preserve Case",
                          (_e, cx) => {
                            this.wsPreserveCase = !this.wsPreserveCase;
                            cx.notify();
                          },
                        ),
                      ),
                  )
                  .child(
                    div()
                      .id("ws-replace-all")
                      .size(24)
                      .flex_none()
                      .flex()
                      .items_center()
                      .justify_center()
                      .rounded(4)
                      .cursor_pointer()
                      .text_color(this.wsGroups.length ? t.muted : t.dim)
                      .hover(s => s.bg(t.hover).text_color(t.foreground))
                      .tooltip("Replace All")
                      .on_click((_e, cx) => this.replaceAllInWorkspace(cx))
                      .child(svg(`${ICON_PREFIX}/codicon-replace-all.svg`).size(13.5)),
                  ),
              )
              .child(
                h_flex()
                  .id("ws-include-box")
                  .h(26)
                  .px(7)
                  .items_center()
                  .rounded(5)
                  .bg(t.raised)
                  .border_1()
                  .border_color(this.wsIncludeFocused ? t.accent : t.border)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(
                    Input.new(this.wsIncludeInput)
                      .flex_1()
                      .h_full()
                      .text_size(12)
                      .text_color(t.foreground),
                  ),
              )
              .child(
                h_flex()
                  .id("ws-exclude-box")
                  .h(26)
                  .px(7)
                  .items_center()
                  .rounded(5)
                  .bg(t.raised)
                  .border_1()
                  .border_color(this.wsExcludeFocused ? t.accent : t.border)
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .child(
                    Input.new(this.wsExcludeInput)
                      .flex_1()
                      .h_full()
                      .text_size(12)
                      .text_color(t.foreground),
                  ),
              ),
          )
          // Summary count & results actions row
          .when(Boolean(this.wsQuery || this.wsRegexError), form =>
            form.child(
              h_flex()
                .pt(2)
                .items_center()
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(11.5)
                    .text_color(this.wsRegexError ? "#e06c75" : t.dim)
                    .child(
                      this.wsRegexError
                        ? this.wsRegexError
                        : this.wsSearching
                          ? "Searching…"
                          : this.wsTotalMatches > 0
                            ? `${this.wsTotalMatches}${this.wsTotalMatches >= 1000 ? "+" : ""} results in ${this.wsGroups.length} file${this.wsGroups.length === 1 ? "" : "s"}`
                            : "No results found",
                    ),
                )
                .when(this.wsGroups.length > 0, row =>
                  row.child(
                    h_flex()
                      .flex_none()
                      .gap(2)
                      .items_center()
                      .child(
                        this.headerIconButton(
                          t,
                          "ws-clear-btn",
                          "clear-all",
                          "Clear Search Results",
                          (_e, cx) => {
                            this.wsQuery = "";
                            this.wsSearchInput.set_value("");
                            this.wsGroups = [];
                            this.wsTotalMatches = 0;
                            cx.notify();
                          },
                        ),
                      )
                      .child(
                        this.headerIconButton(
                          t,
                          "ws-collapse-btn",
                          "collapse-all",
                          "Collapse / Expand All",
                          (_e, cx) => {
                            this.collapseAll(cx);
                          },
                        ),
                      ),
                  ),
                ),
            ),
          ),

        // Results List
        v_flex()
          .id("ws-results-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .py(4)
          .children(resultRows)
          .when(!this.wsQuery && !this.wsSearching, el =>
            el.child(
              div()
                .p(12)
                .text_size(12)
                .text_color(t.dim)
                .child("Type a search term to find text across files in this workspace."),
            ),
          ),
      ]);
  },
};
