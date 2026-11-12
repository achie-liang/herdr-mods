import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, exec, window, shared, setShared, run } from "herdr";

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

export function location() {
  const space = spaces().find(s => s.active);
  const f = focused();
  if (f?.pane) {
    lastFocusedPaneId = f.pane;
  }
  const activeTab = space?.tabs?.find(t => t.active);
  const allPanes = panes();
  const pane =
    (f?.pane && allPanes.find(p => p.pane === f.pane)) ||
    (lastFocusedPaneId &&
      allPanes.find(
        p => p.pane === lastFocusedPaneId && (!activeTab || p.tab === activeTab.id),
      )) ||
    (activeTab && allPanes.find(p => p.tab === activeTab.id)) ||
    null;
  const on =
    f?.pane === null && f?.terminal
      ? f.terminal.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
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

export function writeSharedWtState(contextKey, selectedFeature, userPinnedRoot) {
  if (!contextKey) return;
  try {
    const prev = shared(SHARED_WT_KEY);
    const all = prev && typeof prev === "object" ? { ...prev } : {};
    const cur = all[contextKey];
    if (
      cur &&
      (cur.selectedFeature || null) === (selectedFeature || null) &&
      Boolean(cur.userPinnedRoot) === Boolean(userPinnedRoot)
    ) {
      return;
    }
    all[contextKey] = {
      selectedFeature: selectedFeature || null,
      userPinnedRoot: Boolean(userPinnedRoot),
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
