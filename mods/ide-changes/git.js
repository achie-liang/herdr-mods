import { spaces, panes, focused, exec, window } from "herdr";

export function location() {
  const space = spaces().find(s => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on =
    f?.pane === null
      ? f.terminal?.includes("/")
        ? f.terminal.split("/")[0]
        : null
      : (space?.machine ?? null);
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
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
      return { kind: "@", text: line };
    }
    const kind = line[0];
    if (kind === "-") return { kind, number: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, number: next++, text: line.slice(1) || " " };
    if (kind === " ") {
      old++;
      return { kind, number: next++, text: line.slice(1) || " " };
    }
    return { kind: "", text: line };
  });
}

export async function findSubRepos(cwd, on) {
  const windowsSubRepos = async () => {
    const cmd =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) $out = @(); Get-ChildItem -LiteralPath $p -Directory -Force -ErrorAction SilentlyContinue | Where-Object Name -ne '.git' | ForEach-Object { if (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) { $out += $_.Name } elseif ($_.Name -eq '.worktree') { Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $wt = $_.Name; Get-ChildItem -LiteralPath $_.FullName -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { if (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) { $out += ('.worktree/' + $wt + '/' + $_.Name) } } } } }; $out | ConvertTo-Json -Compress } '" +
      cwd.replace(/['‘’‚‛]/g, "$&$&") +
      "'";
    const r = await exec("powershell", ["-NoProfile", "-Command", cmd], { on }).catch(() => null);
    if (!r || r.code !== 0) return [];
    const parsed = JSON.parse(r.stdout || "[]");
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  };
  if (!on && window()?.platform === "windows") return windowsSubRepos();
  const script =
    'for p in "$1"/* "$1"/.[!.]* "$1"/.worktree/*/*; do [ -d "$p" ] && [ -e "$p/.git" ] || continue; rel=${p#"$1"/}; [ "$rel" = ".git" ] && continue; printf "%s\\0" "$rel"; done';
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
