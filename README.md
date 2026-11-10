# Herdr IDE Mods (`ide-files`, `ide-changes`, `ide-spaces`, `ide-agents`)

An IDE-grade file explorer, ripgrep workspace search & replace, multi-repo Git changes suite, and enhanced Spaces/Agents sidebars for [Herdr](https://herdr.dev).

## Included Mods & Layout

- **`mods/ide-files/`** — IDE File Explorer & Workspace Search:
  - **Seti File Icons & Git Status:** 160+ file icons, `git:(branch)` subtitles on repo roots and sub-repos, file status letters (`M`, `U`, `A`, `D`, `C`), parent folder status dots, and `.gitignore` dimming.
  - **Workspace Search & Replace (`⌘⇧F`):** Ripgrep-powered live search (`Aa`, `[ ]`, `.*`), include/exclude glob filters, preserve-case (`AB`), per-file replace, and Replace All.
  - **Always-On Syntax Highlighting & Read-Only / Edit Toggle:** Character-by-character selection, double-click word selection, right-click `Add to Chat (@file#L...)`, in-file Find (`⌘F`), and one-click Read-Only / Edit mode toggle with auto-save.
- **`mods/ide-changes/`** — Multi-Repo & Worktree Git Changes:
  - Automatically detects both single-repo workspaces and multi-repo / `.worktree/<id>/<repo>` parent workspaces.
  - Groups uncommitted changes by repository with collapsible headers, `git:(branch)` labels, and targeted commits per repository.
- **`mods/ide-spaces/`** — Enhanced Spaces Sidebar:
  - Displays colored space avatar icons in narrow sidebar mode with full space title & git branch tooltips on hover.
- **`mods/ide-agents/`** — Enhanced Agents Sidebar:
  - Displays agent program icons and status indicators in narrow sidebar mode, with session-aware tooltips (`Session: <name>`) in both wide and narrow views.
- **`layouts/ide-main.json`** — Cloned from Herdr's default `main` layout, wired to `ide-spaces`, `ide-agents`, `ide-files`, and `ide-changes`.

## Installation & Sync Workflow

Install or sync this repository into `~/.config/herdr-app` using `./install.sh`:

```bash
# Copy mods & layout into ~/.config/herdr-app and run herdr-app check
./install.sh
```

> **Note:** Herdr's `cap_primitives` asset loader sandboxes `~/.config/herdr-app` and blocks symlinks that point outside `~/.config/herdr-app` when loading SVG icons. Always use `./install.sh` (which copies files directly into `~/.config/herdr-app`) after making changes in this repo.
