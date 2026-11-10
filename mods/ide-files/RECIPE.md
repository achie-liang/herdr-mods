# IDE Files

An IDE-grade file explorer, code viewer, and workspace search & replace panel for Herdr. It upgrades the default `files` panel with 160+ Seti file icons, Git status colors and branch subtitles, ripgrep-powered workspace search and replace, in-file regex find, and drag-to-chat `@file#L10-L20` references for coding agents.

![IDE Files](preview.png)

## What you see

- **Explorer Header (30px):**
  - In standard workspaces, shows the current folder name and a `git:(branch)` subtitle when at a Git root.
  - When a parallel worktree directory exists (`.worktree`, `worktree`, `.worktrees`, `worktrees`, or auto-detected via `git worktree list`), the header left area becomes an interactive **Feature Worktree Dropdown (`22px` height)** showing the active feature name (or workspace root with a feature count badge) and a floating menu (`max_h: 320px`) listing `Workspace Root (main)` and all parallel feature directories.
  - Right-side icon buttons (`22×22px`) for Refresh and Collapse All.
- **File Tree (24px rows):** Indented guide lines (`1px`), Seti colored file icons, folder chevrons, `git:(branch)` subtitles on nested sub-repositories, and Git status coloring (`#e2b061` amber for Modified `M`, `#63c29f` teal for Untracked/Added `U`/`A`, `#e06c75` coral for Deleted/Conflict `D`/`C`, `#b88746`/`#4fa384`/`#c25a62` status dots on parent folders, and dimmed text for `.gitignore`d items).
- **Workspace Search Sidebar (260px width alongside file preview):**
  - Search input with `Aa` (case), `[ ]` (whole word), and `.*` (regex) toggles.
  - Collapsible Replace input with `AB` (preserve case) toggle and Replace All button, plus `Files to include` and `Files to exclude` glob inputs.
  - Grouped file match list with match count badges, inline diff preview of replacements, and per-file Replace / Dismiss hover buttons.
- **Unified Top Bar & Code Preview / Editor:**
  - Top bar (`36px`) with Back/Forward navigation buttons, clickable path breadcrumbs, Markdown `Preview` / `Source` switch, an icon-only **Read-Only / Edit mode toggle** (`codicon-eye.svg` for Read-Only, `codicon-edit.svg` highlighted in accent for Edit mode), Search in Files (`⌘⇧F`), and Right Sidebar toggle.
  - **Read-Only Mode:** Virtualized line viewer (`20px` row height) with line numbers, **always-on token syntax highlighting**, character-by-character selection (`#3568a899`), scrollbar with amber match ticks, and an optional top Find bar (`34px`, triggered via `⌘F`) with `x of y` match navigation.
  - **Edit Mode:** Interactive `EditorState` syntax editor with debounced auto-save (`300ms`) back to disk via `writeTextFile`.

## How it behaves

- **Navigation & Worktree Feature Switching:**
  - Clicking a folder expands/collapses it and persists expanded folders per workspace in `localStorage` (`ide-files.saved`).
  - Selecting a feature from the **Feature Worktree Dropdown** switches `this.root` to `<baseRoot>/<wtDir>/<feature>`, scoping the file tree, Git status/branches, Quick Open, and Workspace Search (`⌘⇧F`) to that feature's worktree directory.
  - Worktree container directories are discovered via a 3-tier strategy: (1) default conventions (`.worktree`, `worktree`, `.worktrees`, `worktrees`), (2) zero-config auto-detection from `git worktree list --porcelain` on child repositories, and (3) optional explicit overrides in `.herdr.json` (`worktreeDirs`) or `shared("ide.worktree_dirs")`.
- **Character-Level Selection & Copy (Read-Only Mode):**
  - Dragging across code text selects character-by-character across one or multiple lines; double-clicking selects a word; triple-clicking or clicking/dragging the line-number gutter selects whole lines; `Shift`+click extends the selection.
  - Pressing `⌘C` copies the exact selected text to the clipboard.
- **In-File Find (`⌘F`):** Highlights all matches in `#e2b06140` and the active match in `#e2b06199` while preserving syntax colors on surrounding tokens, scrolling the active line to center. `⌘G` / `⇧⌘G` (or Enter / Shift+Enter) steps through matches.
- **Workspace Search (`⌘⇧F`):** Runs `rg --json` (falling back to `grep`) with 180ms debounce. Clicking a match opens the file alongside the search sidebar and jumps to the matched line.
- **Drag-to-Chat & Context Menu:**
  - Dragging any file, folder, or search match to the left (or >16px) pastes `@path/to/file` or `@path/to/file#L10-L20` directly into the focused terminal/agent pane.
  - Right-clicking opens a context menu with `Find in File (⌘F)`, `Add to Chat (@...)`, `Add Whole File`, `Copy @...`, `Copy Selected Text`, `Copy Relative Path`, or `Copy Full Path`.

## Built from

- **Mod folder (`mods/ide-files/`):**
  - `mod.json`: `{"place": "none", "focusable": true}`.
  - `main.js`: `IdeFiles` view class, explorer tree, context menu, drag-to-chat, and keyboard routing.
  - `icons.js` + `icons/*.svg`: Self-contained Seti file icon table and Codicon UI icons.
  - `git.js`: Cross-platform directory listing (`sh` / `powershell`) and non-locking `git status --porcelain=v1 -z --ignored=matching` inspection.
  - `search.js`: Workspace search (`rg` / `grep`), glob compiler, preserve-case replacement, and search sidebar UI.
  - `preview.js`: Virtualized code viewer, `EditorState` syntax view, and in-file Find bar.
  - `utils.js`: Location resolution, regex/glob helpers, and terminal paste helper.
- **Herdr APIs used:** `spaces`, `panes`, `focused`, `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `theme`, `settings`, `window`, `run`, `notify`, `nextCommand`.
- **External programs:** `git` (for status/branch), `rg` (ripgrep, with `grep` fallback), `sh` (or `powershell` on Windows).

## Watch out

- **Panel resizing:** Workspace search calls `run("layout.resize", { id: "panel", px: 720 })` when previewing a file alongside search results. Ensure the layout's `panel` column has `"max": 1100` (or at least `720`).
- **Keyboard shortcuts:** Merge the `mod:ide-files` section from `keys.json` (`cmd-f`, `cmd-shift-f`, `cmd-g`, `cmd-shift-g`) so shortcuts route to `ide-files.<command>` when the panel has focus.
- **Self-contained assets:** All icons live under `mods/ide-files/`. If renaming the mod folder, update `ICON_PREFIX` in `icons.js` and the two SVG paths in `main.js`.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/ide-files` exits 0.
- Opening the Files panel shows Seti icons, `git:(branch)` subtitles, and colored Git status markers (`M`, `U`, `A`, `D`).
- Pressing `⌘⇧F` opens the Search sidebar, finds matches across files, and clicking a match opens the file at that line.
- Selecting lines in a file preview and dragging left pastes `@file#Lstart-Lend` into the active terminal.
