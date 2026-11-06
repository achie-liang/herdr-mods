import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, window } from "herdr";
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
