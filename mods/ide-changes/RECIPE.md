# IDE Changes

A multi-repo and Git worktree-aware source control & diff viewer mod for Herdr. It extends the default `changes` panel so workspaces containing multiple Git repositories or `.worktree/<feature>/<repo>` checkouts automatically group changes by repository, display each repo's branch, and commit to the selected repository.

![IDE Changes](preview.png)

## What you see

- **Header (42px):** Shows `Changes`, a badge with total changed files (`N files`), a badge with active repository count (`M repos`) when in a multi-repo workspace, and total `+add` / `−del` line counts.
- **Changed Files / Repo Groups List (up to 240px height):**
  - **Single-repo mode:** Flat list of changed files (28px rows) with status letter (`A`, `M`, `D`, `U`), dimmed directory prefix, filename, and `+add` / `−del` counts.
  - **Multi-repo mode:** Collapsible repository group headers (28px rows) with chevron icon, bold repo relative path (e.g. `pace-mono` or `.worktree/feat-x/pace-mono`), colored `git:(branch)` subtitle, file count badge, and repo-level `+add` / `−del` totals. Indented file rows appear underneath each expanded repo.
- **Virtualized Unified Diff View:** Monospace diff viewer (`v_virtual_list`) with old/new line numbers, green/red line highlights (`t.ansi2` / `t.ansi1`), and horizontal + vertical scrollbars.
- **Commit Bar (52px):** Shows a target repository badge (in multi-repo mode), a `Commit message` input (`32px` height), and a `Commit` button.

## How it behaves

- **Single vs. Multi-Repo Detection:**
  - First checks `git rev-parse --show-toplevel` in the active pane's `cwd`.
  - If `cwd` is not itself a Git repository, scans immediate subdirectories (`*`, `.[!.]*`) and nested worktrees (`.worktree/*/*`) for `.git` directories/files.
- **Non-Locking Live Refresh:** Uses `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false` so `watchFolder` never loops on `.git/index.lock`.
- **Targeted Commits:** Clicking any repo header or file row sets that repository as the active commit target (`activeRepoRoot`). Entering a commit message and pressing Enter (or clicking `Commit`) runs `git add -A` and `git commit -m <message>` inside that specific repository.

## Built from

- **Mod folder (`mods/ide-changes/`):**
  - `mod.json`: `{"place": "none"}`.
  - `main.js`: `IdeChanges` view class, collapsible repo groups, virtualized diff list, and commit bar.
  - `git.js`: `findSubRepos`, `inspectRepoChanges`, and `diffRows` parser.
  - `chevron-down.svg`, `chevron-right.svg`, `changes.svg`: Self-contained vector icons.
- **Herdr APIs used:** `spaces`, `panes`, `focused`, `exec`, `readTextFile`, `watchFolder`, `theme`, `settings`, `window`.
- **External programs:** `git`, `sh` (or `powershell` on Windows).

## Watch out

- **Self-contained assets:** Chevron icons are loaded from `mods/ide-changes/chevron-down.svg` and `mods/ide-changes/chevron-right.svg`. If renaming the mod folder, update the `svg(...)` path in `main.js`.
- **Multi-repo filtering:** In multi-repo mode, only sub-repositories with uncommitted changes are shown in the list to keep large workspaces clean.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/ide-changes` exits 0.
- In a single Git repo, changed files and their diffs display and commit as expected.
- In a parent folder containing multiple Git repos or `.worktree/<id>/<repo>` directories, changed files are grouped under collapsible repo headers with `git:(branch)` labels, and committing targets the selected repo.
