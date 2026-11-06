# IDE Files

An IDE-grade file explorer, code viewer, and workspace search & replace panel for Herdr. It upgrades the default `files` panel with 160+ Seti file icons, Git status colors and branch subtitles, ripgrep-powered workspace search and replace, in-file regex find, and drag-to-chat `@file#L10-L20` references for coding agents.

![IDE Files](preview.png)

## What you see

- **Explorer Header (30px):** Shows the current folder name in uppercase, a `git:(branch)` subtitle when at a Git root, and action buttons for Search Files (`⌘⇧F`), Refresh, and Collapse All.
- **File Tree (23px rows):** Indented guide lines (`1px`), Seti colored file icons, folder chevrons, `git:(branch)` subtitles on nested sub-repositories, and Git status coloring (`#e2b061` amber for Modified `M`, `#63c29f` teal for Untracked/Added `U`/`A`, `#e06c75` coral for Deleted/Conflict `D`/`C`, `#b88746`/`#4fa384`/`#c25a62` status dots on parent folders, and dimmed text for `.gitignore`d items).
- **Workspace Search Sidebar (304px fixed width, or 720px split with file preview):**
  - Search input with `Aa` (case), `[ ]` (whole word), and `.*` (regex) toggles.
  - Collapsible Replace input with `AB` (preserve case) toggle and Replace All button, plus `Files to include` and `Files to exclude` glob inputs.
  - Grouped file match list with match count badges, inline diff preview of replacements, and per-file Replace / Dismiss hover buttons.
- **Code Preview & In-File Find:**
  - Header (34px) with Back button, file icon and path, `Find` toggle (`⌘F`), `+ Chat` / `+ Lx-Ly` button, and `Lines` / `Syntax` mode toggle.
  - Virtualized line view (20px row height) with line numbers, scrollbar with amber match ticks, and an optional top Find bar (`34px`) with `x of y` match navigation.

## How it behaves

- **Navigation & Persistence:** Clicking a folder expands/collapses it and persists expanded folders per workspace in `localStorage` (`ide-files.saved`). Clicking a file opens its preview.
- **In-File Find (`⌘F`):** Highlights all matches in `#e2b06140` and the active match in `#e2b06199`, scrolling the active line to center. `⌘G` / `⇧⌘G` (or Enter / Shift+Enter) steps through matches.
- **Workspace Search (`⌘⇧F`):** Runs `rg --json` (falling back to `grep`) with 180ms debounce. Clicking a match opens the file alongside the 304px search sidebar (auto-resizing the `panel` block to `720px` via `layout.resize`) and jumps to the matched line.
- **Drag-to-Chat & Context Menu:**
  - Dragging any file, folder, search match, or selected line range to the left (or >16px) pastes `@path/to/file` or `@path/to/file#L10-L20` directly into the focused terminal/agent pane.
  - Right-clicking opens a context menu with `Add to Chat (@...)`, `Copy @...`, `Copy Relative Path`, `Copy Full Path`, or `Copy Selected Lines`.

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
