# IDE Changes

A multi-repo and Git worktree-aware source control & diff viewer mod for Herdr. It extends the default `changes` panel so workspaces containing multiple Git repositories or `.worktree/<feature>/<repo>` checkouts automatically group changes by repository, display each repo's branch, and commit to the selected repository.

![IDE Changes](preview.png)

## What you see

- **Unified Top Bar (36px):**
  - Left: Back and Forward navigation buttons (`22×22px`) to step through previously viewed changed files.
  - Center: Clickable **File Path Breadcrumbs** (`repo > folder > subfolder > file`) with Seti file icon, Git status badge (`M`, `A`, `D`, `U`), and `+add` / `−del` line counts.
  - Right: `Open File in Files` button and Right Sidebar Toggle (`panel-right`).
- **Left Content Diff Pane (`flex_1`):**
  - Virtualized monospace unified diff viewer (`20px` row height) with old/new line numbers, green/red line highlights (`t.ansi2` / `t.ansi1`), hover highlight, and vertical scrollbar.
- **Right Changes File Tree Sidebar (260px width, collapsible):**
  - **Sidebar Header (30px):** Aligned with `ide-files` — shows the interactive **Feature Worktree Dropdown (`22px` height)** when parallel worktree directories exist (or repo name + `git:(branch)` subtitle), plus Refresh and Collapse All icon buttons (`22×22px`).
  - **Filter Files Bar:** Compact filter input (`Filter files… (⌘F)`) directly under the sidebar header.
  - **Hierarchical Changes File Tree (24px rows):**
    - In multi-repo workspaces, top-level nodes are collapsible repository headers with `git:(branch)` subtitles and changed file counts.
    - Inside each repository, changed files are organized as an indented folder/file tree with `1px` indent guide lines, folder chevrons, Seti colored file icons, Git status colors, and `+add` / `−del` counts.
  - **Commit Bar:** Target repository indicator, `Commit message` input, and `Commit` button at the bottom of the sidebar.

## How it behaves

- **Worktree Feature Switching & Sync:**
  - Discovers parallel worktree directories (`.worktree`, `worktree`, `.worktrees`, `worktrees`, `.herdr.json`, `shared("ide.worktree_dirs")`, or auto-detected via `git worktree list`) and syncs the selected feature with `ide-files` via `localStorage` (`ide-worktree.state`).
  - Automatically selects the active feature worktree when one exists unless the user explicitly selects `Workspace Root (main)`.
- **Double-Click to Open File & Jump to Diff Line:**
  - Single-clicking a file row in the changed file list previews its diff in `Changes`; **double-clicking** a file row switches to the `Files` (`ide-files`) panel and opens that file.
  - **Double-clicking** any line in the diff view switches to the `Files` (`ide-files`) panel, opens the file, and scrolls/highlights that exact line number.
- **Single vs. Multi-Repo Detection:**
  - Scans immediate child repositories (`*`, `.[!.]*`) inside the active root (workspace root or selected `.worktree/<feature>`), falling back to `git rev-parse --show-toplevel` for single-repository roots.
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
