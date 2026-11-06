import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input } from "gpui-base";
import { readTextFile, theme, settings } from "herdr";
import { getFileIcon, ICON_PREFIX } from "./icons.js";
import {
  LANG,
  LINE_H,
  buildSearchRegExp,
  formatRef,
  pasteIntoTerminal,
} from "./utils.js";

export const previewMethods = {
  openFileFind(cx, initialQuery) {
    if (!this.file) return;
    this.findOpen = true;
    this.rawEditor = false;
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
      this.scrollToLine(active.lineNo);
    }
    cx.notify();
  },

  show(path, cx, jumpOpts = null) {
    const hadFile = Boolean(this.file);
    this.code?.release();
    this.code = null;
    this.file = path;
    this.fileError = null;
    this.lines = [];
    this.lineScroll = 0;
    this.selStart = null;
    this.selEnd = null;
    this.selectingLines = false;
    this.drag = null;
    this.contextMenu = null;
    this.findMatches = [];
    this.findMatchesByLine = new Map();
    if (!path) {
      this.findOpen = false;
      if (hadFile && this.searchMode) {
        this.syncPanelWidth();
      }
      return;
    }
    if (this.searchMode) {
      this.syncPanelWidth();
    }
    if (!cx) return;

    this.handle.focus();
    if (jumpOpts?.query) {
      this.rawEditor = false;
      this.findQuery = jumpOpts.query;
      this.findInput.set_value(jumpOpts.query);
      if (typeof jumpOpts.caseSensitive === "boolean") this.findCase = jumpOpts.caseSensitive;
      if (typeof jumpOpts.wholeWord === "boolean") this.findWord = jumpOpts.wholeWord;
      if (typeof jumpOpts.regex === "boolean") this.findRegex = jumpOpts.regex;
    }

    const context = this.context;
    const root = this.root;
    const on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) {
          this.fileError = "This file is no longer available";
          return;
        }
        if (text.includes("\0")) {
          this.fileError = "Binary file · no text preview";
          return;
        }
        const clipped =
          text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        this.lines = clipped.replace(/\r\n/g, "\n").split("\n");
        const t = theme();
        const ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({
          language: LANG[ext] ?? ext,
          readonly: true,
          value: clipped,
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
        if ((this.findOpen || jumpOpts?.query) && this.findQuery) {
          const prevOpen = this.findOpen;
          this.findOpen = true;
          this.recomputeFileMatches(false, jumpOpts?.lineNo ?? null);
          this.findOpen = prevOpen;
        }
        if (jumpOpts?.lineNo != null) {
          this.selStart = jumpOpts.lineNo;
          this.selEnd = jumpOpts.lineNo;
          this.scrollToLine(jumpOpts.lineNo);
        }
      } catch {
        if (this.file === path && this.current(context)) {
          this.fileError = "Cannot preview this file (binary, too large, or unreadable)";
        }
      } finally {
        cx.notify();
      }
    });
  },

  selectedRange() {
    if (this.selStart == null) return null;
    const a = Math.min(this.selStart, this.selEnd ?? this.selStart);
    const b = Math.max(this.selStart, this.selEnd ?? this.selStart);
    return [a, b];
  },

  buildLineMenuItems(lineNo) {
    const range = this.selectedRange();
    const [a, b] =
      range && lineNo >= range[0] && lineNo <= range[1] ? range : [lineNo, lineNo];
    this.selStart = a;
    this.selEnd = b;
    const lineRef = formatRef(this.file, false, a, b);
    const fileRef = formatRef(this.file, false);
    const snippet = this.lines.slice(a - 1, b).join("\n");
    return [
      { label: "Find in File (⌘F)", action: "find", value: "" },
      { label: `Add to Chat (${lineRef})`, action: "chat", value: lineRef, divider: true },
      { label: `Add Whole File (${fileRef})`, action: "chat", value: fileRef },
      { label: `Copy ${lineRef}`, action: "copy", value: lineRef, divider: true },
      { label: "Copy Selected Lines", action: "copy", value: snippet },
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

  renderLineContentWithMatches(lineText, lineMatches, t) {
    if (!lineMatches || !lineMatches.length) {
      return div().flex_1().min_w(0).truncate().text_color(t.foreground).child(lineText || " ");
    }

    const activeOnLine =
      lineMatches.find(m => m.globalIdx === this.findActiveIdx) || lineMatches[0];
    let offset = 0;
    const segments = [];
    if (activeOnLine && activeOnLine.start > 36) {
      const firstStart = lineMatches[0].start;
      offset = Math.max(0, Math.min(firstStart, activeOnLine.start - 18));
      if (offset > 0) {
        segments.push(div().flex_none().text_color(t.dim).child("…"));
      }
    }

    let cursor = offset;
    for (const m of lineMatches) {
      if (m.end <= offset) continue;
      const s = Math.max(offset, m.start);
      if (s > cursor) {
        segments.push(div().flex_none().text_color(t.foreground).child(lineText.slice(cursor, s)));
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
      segments.push(
        div().flex_1().min_w(0).truncate().text_color(t.foreground).child(lineText.slice(cursor)),
      );
    }

    return h_flex().flex_1().min_w(0).overflow_hidden().items_center().children(segments);
  },

  renderLinesView(t) {
    const range = this.selectedRange();
    const totalLines = this.lines.length;
    const font = settings().font_family ?? "JetBrains Mono";
    const viewH = Math.max(120, this.linesViewHeight || 500);
    const totalH = Math.max(viewH, totalLines * LINE_H + 8);
    const maxScroll = Math.max(0, totalLines * LINE_H - viewH + 8);
    this.lineScroll = Math.max(0, Math.min(this.lineScroll, maxScroll));

    const startIdx = Math.max(0, Math.floor(this.lineScroll / LINE_H) - 3);
    const endIdx = Math.min(
      totalLines,
      Math.ceil((this.lineScroll + viewH) / LINE_H) + 3,
    );

    const visibleRows = [];
    for (let idx = startIdx; idx < endIdx; idx++) {
      const lineNo = idx + 1;
      const lineText = this.lines[idx];
      const selected = Boolean(range && lineNo >= range[0] && lineNo <= range[1]);
      const lineMatches = this.findMatchesByLine.get(lineNo);
      const hasActiveMatch = Boolean(lineMatches?.some(m => m.globalIdx === this.findActiveIdx));

      visibleRows.push(
        h_flex()
          .id(`line-${lineNo}`)
          .absolute()
          .left(0)
          .right(10)
          .top(idx * LINE_H - this.lineScroll + 4)
          .h(LINE_H)
          .px(8)
          .gap(10)
          .items_center()
          .cursor_pointer()
          .when(hasActiveMatch, el => el.bg("#e2b06122"))
          .when(!hasActiveMatch && selected, el => el.bg(t.selected))
          .when(!hasActiveMatch && !selected, el => el.hover(s => s.bg(t.hover)))
          .on_mouse_down("left", (e, cx) => {
            cx.stop_propagation();
            this.contextMenu = null;
            this.handle.focus();
            const target = this.rememberTarget();
            if (e.modifiers?.shift && this.selStart != null) {
              this.selEnd = lineNo;
              this.selectingLines = true;
            } else if (selected && range) {
              const ref = formatRef(this.file, false, range[0], range[1]);
              this.drag = {
                kind: "lines",
                lineNo,
                ref,
                startX: e.position.x,
                startY: e.position.y,
                moved: false,
                sent: false,
                target,
              };
            } else {
              this.selStart = lineNo;
              this.selEnd = lineNo;
              this.selectingLines = true;
            }
            cx.notify();
          })
          .on_mouse_move((e, cx) => {
            if (this.selectingLines && this.selEnd !== lineNo) {
              this.selEnd = lineNo;
              cx.notify();
            } else if (this.drag?.kind === "lines" && !this.drag.sent) {
              const dx = e.position.x - this.drag.startX;
              const dy = e.position.y - this.drag.startY;
              if (Math.abs(dy) > 10 && Math.abs(dx) < 16) {
                this.selStart = this.drag.lineNo;
                this.selEnd = lineNo;
                this.selectingLines = true;
                this.drag = null;
                cx.notify();
              } else if (Math.hypot(dx, dy) > 8 && !this.drag.moved) {
                this.drag.moved = true;
                cx.notify();
              }
            }
          })
          .on_mouse_up("left", (e, cx) => {
            cx.stop_propagation();
            const d = this.drag;
            this.selectingLines = false;
            this.drag = null;
            if (d?.kind === "lines" && !d.sent) {
              const dist = Math.hypot(e.position.x - d.startX, e.position.y - d.startY);
              if (d.moved && dist > 16) {
                pasteIntoTerminal(d.ref, cx, d.target);
              } else {
                this.selStart = lineNo;
                this.selEnd = lineNo;
              }
            }
            cx.notify();
          })
          .on_mouse_down("right", () => {
            this.pendingMenu = this.buildLineMenuItems(lineNo);
          })
          .child(
            div()
              .w(36)
              .flex_none()
              .text_right()
              .text_color(hasActiveMatch ? "#e2b061" : selected ? t.accent : t.dim)
              .child(String(lineNo)),
          )
          .child(this.renderLineContentWithMatches(lineText, lineMatches, t)),
      );
    }

    const thumbH =
      totalLines * LINE_H > viewH ? Math.max(24, Math.round((viewH / totalH) * viewH)) : 0;
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
          cx.notify();
        }
      })
      .on_scroll_wheel((e, cx) => {
        if (maxScroll <= 0) return;
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

  renderFilePreviewPane(t, range, activeRef) {
    return v_flex()
      .id("files-preview-pane")
      .flex_1()
      .min_w(0)
      .h_full()
      .min_h(0)
      .child(
        h_flex()
          .h(34)
          .flex_none()
          .px(10)
          .gap(6)
          .items_center()
          .border_b(1)
          .border_color(t.border)
          .child(
            div()
              .id("files-back")
              .w(22)
              .h(22)
              .flex()
              .items_center()
              .justify_center()
              .rounded(4)
              .cursor_pointer()
              .text_color(t.muted)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.show(null);
                cx.notify();
              })
              .child("←"),
          )
          .child(
            svg(getFileIcon(this.file.split("/").pop() || "").svg)
              .size(15)
              .flex_none()
              .text_color(getFileIcon(this.file.split("/").pop() || "").color),
          )
          .child(
            div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(this.file),
          )
          .child(
            div()
              .id("files-find-btn")
              .px(6)
              .h(22)
              .flex_none()
              .flex()
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .border_1()
              .border_color(this.findOpen ? t.accent : t.border)
              .when(this.findOpen, el => el.bg(t.selected))
              .text_color(this.findOpen ? t.accent : t.muted)
              .text_size(11)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .tooltip("Find in File (⌘F)")
              .on_click((_e, cx) => {
                if (this.findOpen) this.closeFileFind(cx);
                else this.openFileFind(cx);
              })
              .child("Find"),
          )
          .child(
            div()
              .id("files-add-chat")
              .px(7)
              .h(22)
              .flex_none()
              .flex()
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .bg(range ? t.solid : t.raised)
              .text_color(range ? t.solid_foreground : t.foreground)
              .text_size(11)
              .hover(s => s.opacity(0.9))
              .on_click((_e, cx) => pasteIntoTerminal(activeRef, cx, this.rememberTarget()))
              .child(
                range
                  ? range[0] === range[1]
                    ? `+ L${range[0]}`
                    : `+ L${range[0]}-${range[1]}`
                  : "+ Chat",
              ),
          )
          .child(
            div()
              .id("files-mode-toggle")
              .px(6)
              .h(22)
              .flex_none()
              .flex()
              .items_center()
              .rounded(5)
              .cursor_pointer()
              .border_1()
              .border_color(t.border)
              .text_color(t.muted)
              .text_size(11)
              .hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => {
                this.rawEditor = !this.rawEditor;
                if (this.rawEditor) this.findOpen = false;
                cx.notify();
              })
              .child(this.rawEditor ? "Lines" : "Syntax"),
          )
          .when(!this.searchMode, hdr =>
            hdr.child(
              this.headerIconButton(
                t,
                "files-preview-search-ws",
                "search",
                "Search Files (⌘⇧F)",
                (_e, cx) => this.openWorkspaceSearch(cx),
                false,
              ),
            ),
          ),
      )
      .when(this.findOpen, sub => sub.child(this.renderFileFindBar(t)))
      .child(
        this.lines.length
          ? this.rawEditor && this.code && !this.findOpen
            ? Editor.new(this.code).flex_1().min_h(0)
            : this.renderLinesView(t)
          : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…"),
      );
  },
};
