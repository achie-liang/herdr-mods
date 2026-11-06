# Herdr IDE Mods (`ide-files` & `ide-changes`)

An IDE-grade file explorer, ripgrep workspace search & replace, and multi-repo Git changes suite for [Herdr](https://herdr.dev).

## Included Mods & Layout

- **`mods/ide-files/`** — IDE File Explorer & Workspace Search:
  - **Seti File Icons & Git Status:** 160+ file icons, `git:(branch)` subtitles on repo roots and sub-repos, file status letters (`M`, `U`, `A`, `D`, `C`), parent folder status dots, and `.gitignore` dimming.
  - **Workspace Search & Replace (`⌘⇧F`):** Ripgrep-powered live search (`Aa`, `[ ]`, `.*`), include/exclude glob filters, preserve-case (`AB`), per-file replace, and Replace All.
  - **Code Preview & In-File Find (`⌘F`):** Virtualized line viewer with scrollbar match ticks, `⌘G` / `⇧⌘G` navigation, and syntax editor toggle.
  - **Drag-to-Chat (`@file#L10-L20`):** Drag files, folders, search matches, or selected line ranges to paste `@path#Lstart-Lend` directly into the active coding agent / terminal.
- **`mods/ide-changes/`** — Multi-Repo & Worktree Git Changes:
  - Automatically detects both single-repo workspaces and multi-repo / `.worktree/<id>/<repo>` parent workspaces.
  - Groups uncommitted changes by repository with collapsible headers, `git:(branch)` labels, and targeted commits per repository.
- **`layouts/ide-main.json`** — Cloned from Herdr's default `main` layout, wired to `ide-files` and `ide-changes` with an expanded `1100px` max right-panel width for split search + preview.

## Development & Live Link Workflow

Link or sync this repository into `~/.config/herdr-app` using `./install.sh`:

```bash
# Symlink mods & layout into ~/.config/herdr-app and run herdr-app check
./install.sh
```

Because `mods/ide-files`, `mods/ide-changes`, and `layouts/ide-main.json` are symlinked into `~/.config/herdr-app`, any edits saved in this Git repository hot-reload in the running Herdr window within a second.
