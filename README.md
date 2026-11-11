# Herdr IDE Mods (`ide-files`, `ide-changes`, `ide-review`, `ide-tabs`, `ide-spaces`, `ide-agents`)

An IDE-grade file explorer, ripgrep workspace search & replace, multi-repo Git changes suite, browser UI Review tool with Chrome extension, and enhanced Spaces/Agents sidebars for [Herdr](https://herdr.dev).

## Included Mods & Layout

- **`mods/ide-files/`** — IDE File Explorer & Workspace Search:
  - **Seti File Icons & Git Status:** 160+ file icons, `git:(branch)` subtitles on repo roots and sub-repos, file status letters (`M`, `U`, `A`, `D`, `C`), parent folder status dots, and `.gitignore` dimming.
  - **Workspace Search & Replace (`⌘⇧F`):** Ripgrep-powered live search (`Aa`, `[ ]`, `.*`), include/exclude glob filters, preserve-case (`AB`), per-file replace, and Replace All.
  - **Always-On Syntax Highlighting & Read-Only / Edit Toggle:** Character-by-character selection, double-click word selection, right-click `Add to Chat (@file#L...)`, in-file Find (`⌘F`), and one-click Read-Only / Edit mode toggle with auto-save.
- **`mods/ide-changes/`** — Multi-Repo & Worktree Git Changes:
  - Automatically detects both single-repo workspaces and multi-repo / `.worktree/<id>/<repo>` parent workspaces.
  - Groups uncommitted changes by repository with collapsible headers, `git:(branch)` labels, and targeted commits per repository.
- **`mods/ide-review/`** — Self-Contained Browser UI Review (`⌘⇧A` / `Alt+Shift+A`):
  - **Bundled Chrome Extension (`mods/ide-review/chrome-extension/`):** Self-contained inside `ide-review`. Automatically detects whether the `Herdr UI Review` Chrome extension is installed & up-to-date, and provides a **One-Click Install / Update (`一键安装/更新 Chrome 插件`)** button directly inside Herdr.
  - **Visual Element & Region Picker:** Click elements, drag-select regions, or select text on any web page to pin numbered annotations (`#1`, `#2`, `#3`). Automatically extracts React (16–19 Fiber), Vue (2/3), Svelte, and Vite Inspector source file paths & line numbers (`@src/pages/Login.tsx#L84`), component hierarchy, DOM selectors, and key computed styles.
  - **Annotated Screenshot + Direct Agent Delivery:** Captures the page viewport with numbered highlight markers and sends the batch to Herdr over a local HTTP bridge (`127.0.0.1:17501`). Supports **Paste to Agent (`⌘↵`)**, **Send & Run (`⇧⌘↵`)**, or **Stage in Herdr**.
  - **Herdr UI Review Panel:** Preview annotated screenshots, edit individual item notes, toggle items, pick a target Agent pane, or send single/batch annotations (`+Chat #1`, `Paste`, `Send & Run`).
- **`mods/ide-tabs/`** — Enhanced Top Tab Bar:
  - Adds the `Review` panel toggle with a live badge counter alongside `Files` and `Changes`, and auto-starts/watches the local UI Review bridge.
- **`mods/ide-spaces/`** — Enhanced Spaces Sidebar:
  - Displays colored space avatar icons in narrow sidebar mode with full space title & git branch tooltips on hover.
- **`mods/ide-agents/`** — Enhanced Agents Sidebar:
  - Displays agent program icons and status indicators in narrow sidebar mode, with session-aware tooltips (`Session: <name>`) in both wide and narrow views.
- **`layouts/ide-main.json`** — Cloned from Herdr's default `main` layout, wired to `ide-spaces`, `ide-agents`, `ide-tabs`, `ide-files`, `ide-changes`, and `ide-review`.

## Installation & Sync Workflow

Install or sync this repository into `~/.config/herdr-app` using `./install.sh`:

```bash
# Copy mods & layout into ~/.config/herdr-app and run herdr-app check
./install.sh
```

> **Note:** Herdr's `cap_primitives` asset loader sandboxes `~/.config/herdr-app` and blocks symlinks that point outside `~/.config/herdr-app` when loading SVG icons. Always use `./install.sh` (which copies files directly into `~/.config/herdr-app`) after making changes in this repo.
