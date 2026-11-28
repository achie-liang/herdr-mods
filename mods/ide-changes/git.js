import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, focused, exec, window, shared, setShared, run } from "herdr";

export function formatRef(path, dir, startLine, endLine) {
  const clean = dir && !path.endsWith("/") ? `${path}/` : path;
  const quoted = /\s/.test(clean) ? `"${clean}"` : clean;
  if (!dir && startLine != null) {
    const a = Math.min(startLine, endLine ?? startLine);
    const b = Math.max(startLine, endLine ?? startLine);
    return a === b ? `@${quoted}#L${a}` : `@${quoted}#L${a}-L${b}`;
  }
  return `@${quoted}`;
}

export function pasteIntoTerminal(text, cx, target) {
  const f = target || focused();
  cx.write_to_clipboard(`${text} `);
  if (f?.pane) run("pane.focus", { pane: f.pane });
  else if (f?.terminal) run("pane.focus", { terminal: f.terminal });
  run("terminal.paste");
}

let lastFocusedPaneId = null;
let lastFocusedTerminal = null;

export function location() {
  const space = spaces().find(s => s.active);
  const f = focused();
  if (f?.pane) {
    lastFocusedPaneId = f.pane;
    lastFocusedTerminal = null;
    try {
      if (shared("ide.last_focused_pane") !== f.pane) {
        setShared("ide.last_focused_pane", f.pane);
      }
    } catch {}
  } else if (f?.terminal) {
    lastFocusedTerminal = f.terminal;
  }

  let effectiveLastPaneId = lastFocusedPaneId;
  if (!effectiveLastPaneId) {
    try {
      effectiveLastPaneId = shared("ide.last_focused_pane") || null;
    } catch {}
  }

  const activeTab = space?.tabs?.find(t => t.active);
  const allPanes = panes();
  const pane =
    (f?.pane && allPanes.find(p => p.pane === f.pane)) ||
    (effectiveLastPaneId &&
      allPanes.find(
        p => p.pane === effectiveLastPaneId && (!activeTab || p.tab === activeTab.id),
      )) ||
    (activeTab && allPanes.find(p => p.tab === activeTab.id && p.program?.agent)) ||
    (activeTab && allPanes.find(p => p.tab === activeTab.id)) ||
    null;

  const allAgents = agents();
  const allTerminals = terminals();
  const termMap = new Map(allTerminals.map(t => [t.address, t]));

  const rawTermAddr =
    (f?.pane === null && f?.terminal ? f.terminal : null) ||
    pane?.terminal ||
    f?.agent ||
    f?.terminal ||
    (!pane && lastFocusedTerminal ? lastFocusedTerminal : null) ||
    null;

  let rootTermAddr = rawTermAddr;
  const visited = new Set();
  while (rootTermAddr && !visited.has(rootTermAddr)) {
    visited.add(rootTermAddr);
    const tObj = termMap.get(rootTermAddr);
    if (tObj?.parent && termMap.has(tObj.parent)) {
      rootTermAddr = tObj.parent;
    } else {
      break;
    }
  }

  const agent =
    (rootTermAddr && allAgents.find(a => a.address === rootTermAddr)) ||
    (rawTermAddr && allAgents.find(a => a.address === rawTermAddr)) ||
    (pane?.pane && allAgents.find(a => a.pane === pane.pane)) ||
    (activeTab && allAgents.find(a => a.tab === activeTab.id)) ||
    null;

  const term =
    (agent?.address && termMap.get(agent.address)) ||
    (rootTermAddr && termMap.get(rootTermAddr)) ||
    (rawTermAddr && termMap.get(rawTermAddr)) ||
    null;

  const agentKey =
    agent?.address ||
    rootTermAddr ||
    (pane?.pane ? `pane:${pane.pane}` : null) ||
    (activeTab?.id ? `tab:${activeTab.id}` : null) ||
    "default";

  const agentCandidates = [];
  const pushCandidate = val => {
    if (!val || typeof val !== "string") return;
    const trimmed = val.trim();
    if (trimmed && !agentCandidates.includes(trimmed)) {
      agentCandidates.push(trimmed);
    }
  };

  const cwdList = [
    term?.foreground?.cwd,
    pane?.cwd,
    f?.cwd,
    term?.cwd,
    space?.folder,
  ].filter(Boolean);
  for (const c of cwdList) {
    const wtMatch = /^(.*)\/(\.worktrees?|worktrees?)\/([^/]+)(?:\/.*)?$/.exec(c);
    if (wtMatch && wtMatch[2] && wtMatch[3]) {
      pushCandidate(`${wtMatch[2]}/${wtMatch[3]}`);
      pushCandidate(wtMatch[3]);
    }
  }

  pushCandidate(term?.labels?.["herdr.session"]);

  try {
    const sharedSessions = shared("ide.agent_sessions");
    if (sharedSessions && agent?.address) {
      pushCandidate(sharedSessions[agent.address]);
    }
    if (sharedSessions && rootTermAddr) {
      pushCandidate(sharedSessions[rootTermAddr]);
    }
  } catch {}

  const progName = agent?.program?.name || pane?.program?.name || term?.program?.name || "";
  for (const rawTitle of [agent?.title, term?.title, pane?.title]) {
    if (!rawTitle || typeof rawTitle !== "string") continue;
    const t = rawTitle.trim();
    if (t.startsWith("π - ")) {
      const parts = t.slice(4).split(" - ");
      if (parts.length >= 2) {
        pushCandidate(parts.slice(0, -1).join(" - ").trim());
      }
      continue;
    }
    if (
      t &&
      t !== progName &&
      !/^[~/]|^[A-Za-z]:\\/.test(t) &&
      !t.includes("@")
    ) {
      pushCandidate(t);
    }
  }

  const tabName = activeTab?.name || agent?.tab_name || "";
  if (
    tabName &&
    !/^tb?\d+$|^\d+$/.test(tabName) &&
    tabName !== progName &&
    (activeTab?.named || tabName !== progName)
  ) {
    pushCandidate(tabName);
  }

  const on =
    f?.pane === null && f?.terminal
      ? f.terminal.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);

  return {
    cwd: pane?.cwd || term?.foreground?.cwd || term?.cwd || f?.cwd || space?.folder,
    on,
    space: space?.id,
    agentKey,
    agentCandidates,
  };
}

export function matchAgentWorktreeFeature(wtFeatures, agentCandidates) {
  if (!Array.isArray(wtFeatures) || wtFeatures.length === 0) return null;
  if (!Array.isArray(agentCandidates) || agentCandidates.length === 0) return null;

  for (const raw of agentCandidates) {
    const cand = String(raw || "").trim();
    if (!cand) continue;

    const byRel = wtFeatures.find(f => f.relPath === cand);
    if (byRel) return byRel.relPath;

    const byName = wtFeatures.find(f => f.name === cand);
    if (byName) return byName.relPath;

    if (cand.includes("/")) {
      const tail = cand.split("/").pop()?.trim();
      if (tail) {
        const byTail = wtFeatures.find(f => f.name === tail);
        if (byTail) return byTail.relPath;
      }
    }

    const lower = cand.toLowerCase();
    const byLower = wtFeatures.find(f => f.name.toLowerCase() === lower);
    if (byLower) return byLower.relPath;
  }

  return null;
}

export const locationKey = () => JSON.stringify(location());

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
export const READ = [
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.autoRefreshIndex=false",
];

export const countLines = text =>
  text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// Numbers each diff line once, so a frame only draws the rows on screen.
export function diffRows(lines) {
  let old = 0;
  let next = 0;
  return lines.map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) {
      old = +match[1];
      next = +match[2];
      return { kind: "@", text: line, targetLine: Math.max(1, next) };
    }
    const kind = line[0];
    if (kind === "-") {
      return {
        kind,
        number: old++,
        targetLine: Math.max(1, next),
        text: line.slice(1) || " ",
      };
    }
    if (kind === "+") {
      const ln = next++;
      return { kind, number: ln, targetLine: ln, text: line.slice(1) || " " };
    }
    if (kind === " ") {
      old++;
      const ln = next++;
      return { kind, number: ln, targetLine: ln, text: line.slice(1) || " " };
    }
    return { kind: "", text: line, targetLine: next > 0 ? next : null };
  });
}

export async function findSubRepos(cwd, on) {
  const windowsSubRepos = async () => {
    const cmd =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) $out = @(); Get-ChildItem -LiteralPath $p -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '.git' -and $_.Name -ne '.worktree' -and $_.Name -ne 'worktree' -and $_.Name -ne '.worktrees' -and $_.Name -ne 'worktrees' } | ForEach-Object { if (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) { $out += $_.Name } }; $out | ConvertTo-Json -Compress } '" +
      cwd.replace(/['‘’‚‛]/g, "$&$&") +
      "'";
    const r = await exec("powershell", ["-NoProfile", "-Command", cmd], { on }).catch(() => null);
    if (!r || r.code !== 0) return [];
    const parsed = JSON.parse(r.stdout || "[]");
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  };
  if (!on && window()?.platform === "windows") return windowsSubRepos();
  const script =
    'for p in "$1"/* "$1"/.[!.]*; do [ -d "$p" ] && [ -e "$p/.git" ] || continue; rel=${p#"$1"/}; case "$rel" in .git|.worktree|worktree|.worktrees|worktrees) continue ;; esac; printf "%s\\0" "$rel"; done';
  let r;
  try {
    r = await exec("sh", ["-c", script, "changes-repos", cwd], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsSubRepos();
    return [];
  }
  if (!r || r.code !== 0) return [];
  return r.stdout
    .split("\0")
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export async function discoverWorktreeFeatures(baseRoot, customDirs, on) {
  if (!baseRoot) return { hasWorktreeDir: false, wtDirs: [], features: [] };
  const candidates = [
    ...(Array.isArray(customDirs) ? customDirs : []),
    ".worktree",
    "worktree",
    ".worktrees",
    "worktrees",
  ].filter((v, i, a) => v && typeof v === "string" && a.indexOf(v) === i);

  const quotedCandidates = candidates.map(c => `"${c.replace(/"/g, '\\"')}"`).join(" ");
  const script = `
cd "$1" 2>/dev/null || exit 0
found_dirs=""
# 1. Check .herdr.json if present for custom worktreeDirs
if [ -f ".herdr.json" ] && command -v python3 >/dev/null 2>&1; then
  extra=$(python3 -c '
import json
try:
  d = json.load(open(".herdr.json"))
  dirs = d.get("worktreeDirs") or d.get("worktree_dirs") or []
  if isinstance(dirs, str): dirs = [dirs]
  for x in dirs:
    if isinstance(x, str) and x.strip(): print(x.strip())
except Exception:
  pass
' 2>/dev/null)
else
  extra=""
fi

# 2. Auto-detect worktree container dirs from git worktree list of child repos
auto_dirs=""
for repo in ./*/; do
  [ -e "\${repo}.git" ] || continue
  while IFS= read -r line; do
    case "$line" in
      "worktree $1/"*)
        rel="\${line#worktree $1/}"
        first="\${rel%%/*}"
        rest="\${rel#*/}"
        if [ -n "$first" ] && [ "$first" != "\${repo%/}" ] && [ "\${rest#*/}" != "$rest" ]; then
          auto_dirs="$auto_dirs $first"
        fi
        ;;
    esac
  done <<EOF
$(git -C "$repo" --no-optional-locks worktree list --porcelain 2>/dev/null)
EOF
  break
done

seen_dirs="|"
for d in $extra ${quotedCandidates} $auto_dirs; do
  [ -n "$d" ] || continue
  case "$seen_dirs" in *"|$d|"*) continue ;; esac
  seen_dirs="\${seen_dirs}\${d}|"
  if [ -d "$d" ]; then
    printf "D\\t%s\\0" "$d"
    for f in "$d"/*; do
      [ -d "$f" ] || continue
      fname="\${f##*/}"
      printf "F\\t%s\\t%s\\0" "$d" "$fname"
    done
  fi
done
`;
  const r = await exec("sh", ["-c", script, "wt-discover", baseRoot], { on }).catch(() => null);
  if (!r || r.code !== 0 || !r.stdout) {
    return { hasWorktreeDir: false, wtDirs: [], features: [] };
  }
  const wtDirs = [];
  const features = [];
  for (const rec of r.stdout.split("\0")) {
    if (!rec) continue;
    const parts = rec.split("\t");
    if (parts[0] === "D" && parts[1]) {
      wtDirs.push(parts[1]);
    } else if (parts[0] === "F" && parts[1] && parts[2]) {
      features.push({
        wtDir: parts[1],
        name: parts[2],
        relPath: `${parts[1]}/${parts[2]}`,
      });
    }
  }
  features.sort((a, b) => a.name.localeCompare(b.name));
  return {
    hasWorktreeDir: wtDirs.length > 0,
    wtDirs,
    features,
  };
}

export function renderGitBranchSubtitle(branch, t) {
  const display = branch.length > 30 ? `${branch.slice(0, 29)}…` : branch;
  return h_flex()
    .flex_none()
    .min_w(0)
    .overflow_hidden()
    .items_center()
    .text_size(11.5)
    .text_color(t.dim)
    .child(div().flex_none().child(`git:(${display})`));
}

const SHARED_WT_KEY = "ide.worktree_state";

export function readSharedWtState(contextKey) {
  if (!contextKey) return null;
  try {
    const all = shared(SHARED_WT_KEY);
    if (all && typeof all === "object") {
      return all[contextKey] || null;
    }
  } catch {}
  return null;
}

export function writeSharedWtState(contextKey, selectedFeature, userSpecified) {
  if (!contextKey) return;
  try {
    const prev = shared(SHARED_WT_KEY);
    const all = prev && typeof prev === "object" ? { ...prev } : {};
    const cur = all[contextKey];
    if (
      cur &&
      (cur.selectedFeature || null) === (selectedFeature || null) &&
      Boolean(cur.userSpecified) === Boolean(userSpecified)
    ) {
      return;
    }
    all[contextKey] = {
      selectedFeature: selectedFeature || null,
      userSpecified: Boolean(userSpecified),
      updatedAt: Date.now(),
    };
    setShared(SHARED_WT_KEY, all);
  } catch {}
}

export async function inspectRepoChanges(repoRoot, relName, on) {
  const git = args => exec("git", [...READ, ...args], { cwd: repoRoot, on });
  const [status, head, branchRes] = await Promise.all([
    git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
    git(["rev-parse", "--verify", "HEAD"]),
    git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null),
  ]);
  if (status.code !== 0) throw new Error(status.stderr);
  let branch = branchRes?.code === 0 ? branchRes.stdout.trim() : "";
  if (!branch && head.code === 0) {
    const rev = await git(["rev-parse", "--short", "HEAD"]).catch(() => null);
    if (rev?.code === 0) branch = rev.stdout.trim();
  }
  const hasHead = head.code === 0;
  const stats = {};
  const results = hasHead
    ? [await git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])]
    : [
        await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
        await git(["diff", "--numstat", "-z", "--no-renames"]),
      ];
  for (const result of results) {
    if (result.code !== 0) throw new Error(result.stderr);
    for (const entry of result.stdout.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t");
      const old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = {
        add: old.add + (Number(a) || 0),
        del: old.del + (Number(d) || 0),
        binary: a === "-",
      };
    }
  }
  const files = [];
  const entries = status.stdout.split("\0").filter(Boolean);
  for (const entry of entries.slice(0, 1000)) {
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const fresh = xy === "??";
    const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
    const s = conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M";
    const stat = stats[path] ?? { add: 0, del: 0 };
    const id = relName ? `${relName}::${path}` : path;
    files.push({
      id,
      repoRoot,
      repoRel: relName,
      hasHead,
      path,
      status: s,
      fresh,
      ...stat,
    });
  }
  return {
    repoRoot,
    repoRel: relName,
    branch,
    hasHead,
    files,
    limited: entries.length > 1000,
  };
}

export function compactRelTime(unixSeconds) {
  if (!unixSeconds || !Number.isFinite(unixSeconds)) return "";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}

function normalizeGitStatus(raw) {
  const ch = (raw || "M").trim()[0] || "M";
  if (ch === "A") return "A";
  if (ch === "D") return "D";
  if (ch === "U") return "C";
  return "M";
}

function parseNameStatusZ(stdout) {
  const out = [];
  const parts = (stdout || "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    if (!code) continue;
    const status = normalizeGitStatus(code);
    if (code.startsWith("R") || code.startsWith("C")) {
      const nextPath = parts[i + 2];
      i += 2;
      if (nextPath) out.push({ path: nextPath, status });
    } else {
      const path = parts[i + 1];
      i += 1;
      if (path) out.push({ path, status });
    }
  }
  return out;
}

function parseNumstatZ(stdout) {
  const stats = {};
  const parts = (stdout || "").split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const [a, d, ...rest] = entry.split("\t");
    if (!rest.length) continue;
    const path = rest.join("\t");
    stats[path] = {
      add: a === "-" ? 0 : Number(a) || 0,
      del: d === "-" ? 0 : Number(d) || 0,
      binary: a === "-",
    };
  }
  return stats;
}

export async function detectDefaultBranch(repoRoot, on) {
  const git = args => exec("git", [...READ, ...args], { cwd: repoRoot, on }).catch(() => null);
  const sym = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (sym?.code === 0 && sym.stdout.trim()) {
    const ref = sym.stdout.trim();
    const label = ref.replace(/^origin\//, "");
    return { ref, label };
  }
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (r?.code === 0 && r.stdout.trim()) {
      return { ref, label: ref.replace(/^origin\//, "") };
    }
  }
  return null;
}

export async function inspectRepoBranchCommits(repoRoot, relName, branch, hasHead, on) {
  if (!hasHead) {
    return { baseRef: null, baseLabel: null, mergeBase: null, commits: [] };
  }
  const base = await detectDefaultBranch(repoRoot, on);
  if (!base) {
    return { baseRef: null, baseLabel: null, mergeBase: null, commits: [] };
  }
  if (branch && branch === base.label) {
    return { baseRef: base.ref, baseLabel: base.label, mergeBase: null, commits: [] };
  }
  const git = args => exec("git", [...READ, ...args], { cwd: repoRoot, on }).catch(() => null);
  const mbRes = await git(["merge-base", base.ref, "HEAD"]);
  if (!mbRes || mbRes.code !== 0 || !mbRes.stdout.trim()) {
    return { baseRef: base.ref, baseLabel: base.label, mergeBase: null, commits: [] };
  }
  const mergeBase = mbRes.stdout.trim();
  const logRes = await git([
    "log",
    `${mergeBase}..HEAD`,
    "--max-count=100",
    "--format=%x1e%H%x1f%h%x1f%s%x1f%an%x1f%at%x1f%cr",
    "--shortstat",
  ]);
  if (!logRes || logRes.code !== 0 || !logRes.stdout.trim()) {
    return { baseRef: base.ref, baseLabel: base.label, mergeBase: null, commits: [] };
  }

  const commits = [];
  const records = logRes.stdout.split("\x1e").filter(Boolean);
  for (const rec of records) {
    const lines = rec.split("\n");
    const header = lines[0] || "";
    const [hash, shortHash, subject, author, tsRaw, relTime] = header.split("\x1f");
    if (!hash) continue;
    let filesChanged = 0;
    for (let i = 1; i < lines.length; i++) {
      const m = /(\d+)\s+files?\s+changed/.exec(lines[i]);
      if (m) {
        filesChanged = Number(m[1]) || 0;
        break;
      }
    }
    commits.push({
      id: relName ? `${relName}::${hash}` : hash,
      hash,
      shortHash: shortHash || hash.slice(0, 7),
      subject: (subject || "").trim(),
      author: (author || "").trim(),
      timestamp: Number(tsRaw) || 0,
      relTime: (relTime || "").trim(),
      filesChanged,
      repoRoot,
      repoRel: relName,
      baseLabel: base.label,
    });
  }

  return {
    baseRef: base.ref,
    baseLabel: base.label,
    mergeBase: commits.length > 0 ? mergeBase : null,
    commits,
  };
}

export async function inspectRepoAllVsBase(
  repoRoot,
  relName,
  mergeBase,
  workingFiles,
  hasHead,
  on,
) {
  const git = args => exec("git", [...READ, ...args], { cwd: repoRoot, on });
  const [nameStatusRes, numstatRes] = await Promise.all([
    git(["diff", mergeBase, "--name-status", "-z", "--no-renames"]),
    git(["diff", mergeBase, "--numstat", "-z", "--no-renames"]),
  ]);
  if (nameStatusRes.code !== 0) throw new Error(nameStatusRes.stderr);
  if (numstatRes.code !== 0) throw new Error(numstatRes.stderr);

  const workingMap = new Map((workingFiles || []).map(f => [f.path, f]));
  const stats = parseNumstatZ(numstatRes.stdout);
  const parsed = parseNameStatusZ(nameStatusRes.stdout);

  const seen = new Set();
  const files = [];

  for (const item of parsed.slice(0, 1000)) {
    seen.add(item.path);
    const work = workingMap.get(item.path);
    const stat = stats[item.path] ?? { add: 0, del: 0, binary: false };
    const id = relName ? `${relName}::${item.path}` : item.path;
    files.push({
      id,
      repoRoot,
      repoRel: relName,
      hasHead,
      path: item.path,
      status: work?.status === "U" ? "U" : item.status,
      fresh: false,
      uncommitted: Boolean(work),
      diffBase: mergeBase,
      source: "branch",
      ...stat,
    });
  }

  for (const work of workingFiles || []) {
    if (seen.has(work.path)) continue;
    if (files.length >= 1000) break;
    files.push({
      ...work,
      uncommitted: true,
      diffBase: work.fresh ? mergeBase : "HEAD",
      source: "branch",
    });
  }

  return {
    files,
    limited: parsed.length > 1000,
  };
}

export async function inspectCommitFiles(repoRoot, relName, commitHash, on) {
  const git = args => exec("git", [...READ, ...args], { cwd: repoRoot, on });
  const [nameStatusRes, numstatRes] = await Promise.all([
    git(["show", "--format=", "--name-status", "-z", "--no-renames", "--root", commitHash]),
    git(["show", "--format=", "--numstat", "-z", "--no-renames", "--root", commitHash]),
  ]);
  if (nameStatusRes.code !== 0) throw new Error(nameStatusRes.stderr);
  if (numstatRes.code !== 0) throw new Error(numstatRes.stderr);

  const stats = parseNumstatZ(numstatRes.stdout);
  const parsed = parseNameStatusZ(nameStatusRes.stdout);
  const files = parsed.slice(0, 1000).map(item => {
    const stat = stats[item.path] ?? { add: 0, del: 0, binary: false };
    const id = relName
      ? `${relName}::${commitHash}::${item.path}`
      : `${commitHash}::${item.path}`;
    return {
      id,
      repoRoot,
      repoRel: relName,
      hasHead: true,
      path: item.path,
      status: item.status,
      fresh: false,
      uncommitted: false,
      commitHash,
      source: "commit",
      ...stat,
    };
  });

  return {
    files,
    limited: parsed.length > 1000,
  };
}
