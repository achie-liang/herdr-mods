import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, window, shared, setShared } from "herdr";
import { TOTAL, STATUS_PRIORITY } from "./utils.js";

export async function listDirectory(path, on) {
  const windowsDirectory = async () => {
    const r = await exec(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { $isDir = ($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))); @{ name=$_.Name; dir=$isDir; git=($isDir -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git'))) } }) | ConvertTo-Json -Compress } '" +
          path.replace(/['‘’‚‛]/g, "$&$&") +
          "'",
      ],
      { on },
    );
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script =
    'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then if [ -e "$p/.git" ]; then kind=g; else kind=d; fi; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "files", path], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const kind = fields[i];
    out.push({ name: fields[i + 1], dir: kind === "d" || kind === "g", git: kind === "g" });
  }
  return out;
}

export async function inspectGitRepo(repoDir, on) {
  const branchRes = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: repoDir,
    on,
  }).catch(() => null);
  let branch = branchRes?.code === 0 ? branchRes.stdout.trim() : "";
  if (!branch) {
    const revRes = await exec("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoDir,
      on,
    }).catch(() => null);
    if (revRes?.code === 0) branch = revRes.stdout.trim();
  }
  const status = await exec(
    "git",
    [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--no-renames",
      "--untracked-files=all",
      "--ignored=matching",
    ],
    { cwd: repoDir, on },
  ).catch(() => null);

  const fileMarks = {};
  const folderMarks = {};
  const ignored = [];

  if (status?.code === 0) {
    for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
      const xy = entry.slice(0, 2);
      const rel = entry.slice(3).replace(/\/+$/, "");
      if (!rel) continue;
      const abs = `${repoDir}/${rel}`;
      if (xy === "!!") {
        ignored.push(abs);
        continue;
      }
      const mark =
        xy === "??"
          ? "U"
          : xy.includes("U") || xy === "AA" || xy === "DD"
            ? "C"
            : xy.includes("D")
              ? "D"
              : xy.includes("A")
                ? "A"
                : "M";
      fileMarks[abs] = mark;

      let cur = abs;
      while (cur.length > repoDir.length) {
        const slash = cur.lastIndexOf("/");
        if (slash < repoDir.length) break;
        cur = cur.slice(0, slash);
        const prev = folderMarks[cur];
        if (!prev || (STATUS_PRIORITY[mark] ?? 0) > (STATUS_PRIORITY[prev] ?? 0)) {
          folderMarks[cur] = mark;
        }
      }
    }
  }
  return { repoDir, branch, fileMarks, folderMarks, ignored };
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
    .flex_1()
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

