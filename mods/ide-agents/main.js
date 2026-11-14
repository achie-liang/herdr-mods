// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, exec, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return (tab.name === prog || !tab.named) && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by space", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

const SESSION_RESOLVER_PY = `
import sys, os, glob, json
from datetime import datetime

def resolve_pi(cwd, created_ms, title):
    if title and title.startswith("π - "):
        parts = title[4:].split(" - ")
        if len(parts) >= 2:
            return " - ".join(parts[:-1]).strip()
    if not cwd:
        return None
    safe = "--" + cwd.lstrip("/\\\\").replace("/", "-").replace("\\\\", "-").replace(":", "-") + "--"
    sdir = os.path.expanduser(f"~/.pi/agent/sessions/{safe}")
    if not os.path.isdir(sdir):
        return None
    files = sorted(glob.glob(os.path.join(sdir, "*.jsonl")), key=os.path.getmtime, reverse=True)
    if not files:
        return None
    target = files[0]
    if created_ms and len(files) > 1:
        best = None
        best_mtime = None
        for fp in files[:15]:
            try:
                with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                    hdr = json.loads(f.readline())
                ts = hdr.get("timestamp")
                if ts:
                    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                    ms = int(dt.timestamp() * 1000)
                    mtime = os.path.getmtime(fp)
                    if ms >= created_ms - 60000 and (best_mtime is None or mtime > best_mtime):
                        best = fp
                        best_mtime = mtime
            except Exception:
                pass
        if best:
            target = best
    name = None
    first_msg = None
    try:
        with open(target, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if '"session_info"' in line:
                    try:
                        obj = json.loads(line)
                        if obj.get("type") == "session_info":
                            n = (obj.get("name") or "").strip()
                            name = n if n else None
                    except Exception:
                        pass
                elif first_msg is None and '"role":"user"' in line:
                    try:
                        obj = json.loads(line)
                        if obj.get("type") == "message" and obj.get("message", {}).get("role") == "user":
                            c = obj["message"].get("content", "")
                            if isinstance(c, str):
                                txt = c
                            elif isinstance(c, list):
                                txt = " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
                            else:
                                txt = ""
                            txt = " ".join(txt.split()).strip()
                            if txt:
                                first_msg = txt
                    except Exception:
                        pass
    except Exception:
        pass
    res = name or first_msg
    if res and len(res) > 64:
        res = res[:64].rstrip() + "…"
    return res

def resolve_claude(cwd):
    if not cwd:
        return None
    safe = "-" + cwd.lstrip("/\\\\").replace("/", "-").replace("\\\\", "-").replace(".", "-")
    sdir = os.path.expanduser(f"~/.claude/projects/{safe}")
    if not os.path.isdir(sdir):
        return None
    files = sorted(glob.glob(os.path.join(sdir, "*.jsonl")), key=os.path.getmtime, reverse=True)
    if not files:
        return None
    target = files[0]
    title = None
    first_msg = None
    try:
        with open(target, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if '"custom-title"' in line or '"summary"' in line:
                    try:
                        obj = json.loads(line)
                        t = (obj.get("customTitle") or obj.get("summary") or "").strip()
                        if t:
                            title = t
                    except Exception:
                        pass
                elif first_msg is None and '"user"' in line:
                    try:
                        obj = json.loads(line)
                        if obj.get("type") == "user":
                            c = obj.get("message", {}).get("content", "")
                            txt = c if isinstance(c, str) else " ".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text")
                            txt = " ".join(txt.split()).strip()
                            if txt and not txt.startswith("<"):
                                first_msg = txt
                    except Exception:
                        pass
    except Exception:
        pass
    res = title or first_msg
    if res and len(res) > 64:
        res = res[:64].rstrip() + "…"
    return res

items = json.loads(sys.argv[1])
out = {}
for it in items:
    addr = it.get("address")
    app = (it.get("app") or "").lower()
    cwd = it.get("cwd")
    created_ms = it.get("created_ms")
    title = it.get("title") or ""
    sname = None
    if "pi" in app or title.startswith("π"):
        sname = resolve_pi(cwd, created_ms, title)
    elif "claude" in app:
        sname = resolve_claude(cwd)
    if sname:
        out[addr] = sname
print(json.dumps(out))
`;

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    this.sessions = {};
    this.sessionSig = "";
    this.refreshingSessions = false;
    this.refreshSessions(cx);
    cx.timer.every(5000, (cx) => this.refreshSessions(cx));
    cx.timer.every(30000, (cx) => cx.notify());
  }

  refreshSessions(cx) {
    if (this.refreshingSessions) return;
    const list = agents();
    if (!list.length) return;
    const all = new Map(terminals().map((t) => [t.address, t]));
    const ps = new Map(panes().map((p) => [p.pane, p]));
    const items = list
      .filter((a) => !a.address.includes("/"))
      .map((a) => {
        const term = all.get(a.address);
        const pane = ps.get(a.pane);
        return {
          address: a.address,
          app: a.app || a.program?.key || "",
          cwd: term?.foreground?.cwd || pane?.cwd || term?.cwd || "",
          created_ms: term?.created_ms || null,
          title: a.title || "",
        };
      });
    if (!items.length) return;
    this.refreshingSessions = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("python3", ["-c", SESSION_RESOLVER_PY, JSON.stringify(items)]);
        if (r.code === 0 && r.stdout.trim()) {
          const parsed = JSON.parse(r.stdout.trim());
          const prev = JSON.stringify(this.sessions);
          this.sessions = { ...this.sessions, ...parsed };
          try {
            setShared("ide.agent_sessions", this.sessions);
          } catch {}
          if (JSON.stringify(this.sessions) !== prev) cx.notify();
        }
      } catch {}
      this.refreshingSessions = false;
    });
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    const subTitle = k.name || k.template || k.program?.name || k.address;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(39)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12.5)
      .tooltip(subTitle)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.peek(k.address))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(subTitle))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  // Resolve the current session name for an agent, combining terminal labels,
  // parsed Pi/Claude session metadata, and terminal/tab title fallback.
  sessionNameOf(a, termMap, labelText) {
    const term = termMap.get(a.address);
    const fromLabel = term?.labels?.["herdr.session"];
    if (fromLabel) return fromLabel;
    const fromResolved = this.sessions?.[a.address];
    if (fromResolved) return fromResolved;
    if (a.title && a.title.startsWith("π - ")) {
      const parts = a.title.slice(4).split(" - ");
      if (parts.length >= 2) return parts.slice(0, -1).join(" - ").trim();
    }
    return a.title || labelText || a.tab_name || a.program?.name || "";
  }

  // Build hover tooltip:
  // - In narrow/collapsed mode (or when the row title is truncated), show the wide-area
  //   title on line 1 and the session name on line 2.
  // - In wide mode when the title is fully visible, only show the session line.
  agentTooltip(a, more, labelText, when, now, termMap, collapsed) {
    const detailText = more ?? (/^\d+$/.test(labelText) ? a.program?.name || a.title || labelText : labelText);
    const spacePart = a.space_name || "";
    const wideTitle =
      spacePart && detailText && spacePart.toLowerCase() !== detailText.toLowerCase()
        ? `${spacePart} \u00b7 ${detailText}`
        : spacePart || detailText || a.program?.name || a.address;
    const age = when ? duration(now - when) : "";
    const header = age ? `${wideTitle}  ${age}` : wideTitle;
    const sessionName = this.sessionNameOf(a, termMap, labelText) || detailText || wideTitle;
    const sessionLine = `Session: ${sessionName}`;

    if (collapsed) {
      return `${header}\n${sessionLine}`;
    }
    const sidebarPx = find(layout(), "sidebar")?.size?.px ?? 268;
    const availTextPx = Math.max(0, sidebarPx - 110);
    const titleTruncated = wideTitle.length * 7.2 > availTextPx;
    return titleTruncated ? `${header}\n${sessionLine}` : sessionLine;
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    const termMap = new Map(all.map((term) => [term.address, term]));
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);

    const nextSig = list.map((a) => `${a.address}:${a.seq}:${a.title}`).join("|");
    if (nextSig !== this.sessionSig) {
      this.sessionSig = nextSig;
      this.refreshSessions(cx);
    }

    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const pinned = list.filter((a) => a.pinned);
    const rest = list.filter((a) => !a.pinned);
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          open ? this.folded.add(a.address) : this.folded.delete(a.address);
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabLabels = new Map(spaces().flatMap(s => s.tabs).map(tab => [tab.id, title(tab, leads.get(tab.id))]));
    const labels = new Map(list.map(a => [a.address, tabLabels.get(a.tab) ?? (a.title || a.program?.name || "")]));
    const label = (a) => labels.get(a.address);
    const detail = new Map(list.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of list) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of list) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    const row = (a, i, subs = []) => {
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const pic = icon(a.program, 16, idle ? t.muted : t.foreground);
      const more = detail.get(a.address);
      const labelText = label(a) ?? "";
      const tip = this.agentTooltip(a, more, labelText, when, now, termMap, collapsed);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(28)
          .px(6)
          .flex_none()
          .rounded(8)
          .items_center()
          .justify_center()
          .gap(5)
          .cursor_pointer()
          .tooltip(tip)
          .when(a.focused, (el) => el.bg(t.selected))
          .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .when(Boolean(pic), (el) => el.child(pic))
          .when(!pic, (el) => el.child(div().text_color(t.muted).child(String(i + 1))))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      // Under a space header the space goes without saying; an automatic tab number says nothing.
      // Without a space header above (priority, pinned) the row names its space.
      const full = byPriority || isPinned;
      const name = full ? a.space_name || labelText : more ?? (/^\d+$/.test(labelText) ? a.program?.name || labelText : labelText);
      return h_flex()
        .id(`ag-${a.address}`)
        .px(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .tooltip(tip)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.folded.has(a.address) ? this.folded.delete(a.address) : this.folded.add(a.address);
            cx.notify();
          })).child(pic)))
        .child(h_flex().flex_1().min_w(0).gap(5).items_center()
          .child(div().min_w(0).max_w(full && more ? 120 : 200).truncate().text_color(idle ? t.muted : t.foreground).child(name))
          .when(full && Boolean(more), el => el.child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(`\u00b7 ${more}`))))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))))
        .child(this.status(t, a, byPriority && !isPinned));
    };

    // Groups in list order: spaces (grouped) or priority sections. Agents of a
    // space are next to each other in agents(), so neighbours make a group.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const id = byPriority ? `sec-${r}` : `sp-${a.space}`;
      if (groups.at(-1)?.id === id) groups.at(-1).members.push(a);
      else groups.push({ id, label: byPriority ? SECTION[r] : a.space_name || "", status: byPriority ? SECTION_STATUS[r] : null, members: [a] });
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      return h_flex()
        .id(g.id)
        .px(8)
        .pt(8)
        .h(30)
        .flex_none()
        .gap(6)
        .items_center()
        .text_size(11)
        .font_medium()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .child(div().truncate().text_color(t[g.status] ?? t.dim).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open, (el) => el
          .when(!byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
          .child(svg("mods/workspace-chrome/chevron-right.svg").size(11).flex_none().text_color(t.dim)));
    };
    const rows = collapsed
      ? list.flatMap(withKids)
      : groups.flatMap((g) => [header(g), ...(this.folded.has(g.id) ? [] : g.members.flatMap(withKids))]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Agents"))
            .child(
              div()
                .id("ag-sort")
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(() => openOverlay({ mod: "ide-agents", kind: "popup", width: 200, height: 140, props: { sortMenu: true } }))
                .tooltip(`Sort agents: ${sort.label}`)
                .child(svg(`mods/workspace-chrome/${sort.icon}.svg`).size(14)),
            ),
        ),
      )
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(12).text_size(12).text_color(t.dim).child("No agent status yet. Agents show up here when they report their status. Older versions and agents inside tmux may not.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 6 : 8).pt(collapsed ? 6 : 0).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
