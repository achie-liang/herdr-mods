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
  - **Bundled Chrome Extension (`mods/ide-review/chrome-extension/`):** Use Herdr's user-triggered Install / Update button on macOS (guided manual fallback when Chrome automation is unavailable), then pair using a five-minute, one-use code shown in a native Herdr dialog. The worker stores a scoped credential in trusted extension storage. No all-sites permission or automatic page injection.
  - **Visual Element & Region Picker:** Click elements, drag-select regions, or select text on any web page to pin numbered annotations (`#1`, `#2`, `#3`). Automatically extracts React (16–19 Fiber), Vue (2/3), Svelte, and Vite Inspector source file paths & line numbers (`@src/pages/Login.tsx#L84`), component hierarchy, DOM selectors, and key computed styles.
  - **Annotated Screenshot + Staging:** Explicitly stages a screenshot and annotations over an authenticated loopback bridge (`127.0.0.1:17501`). Browser requests cannot paste or execute. Confirm the final prompt and local Agent in Herdr before sending.
  - **Herdr UI Review Panel:** Preview screenshots, edit notes, pick a local Agent, and confirm delivery. Copy-for-paste leaves annotations queued and requires manual pasting; Send & Run targets an idle local Agent explicitly and consumes batches only after an acknowledged send.
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
# First installation: refuses same-name mods/layout; merges keys without overwriting
./install.sh

# Update existing personal mods: backup first, preserve layout and existing keys
./install.sh --sync
```

## Secure Review pairing

1. If upgrading from Review 1.x, stop the old bridge **by verifying its local process/PID**. Version 2 refuses to reuse an unauthenticated or foreign listener. It never calls the old public shutdown endpoint.
2. Start Herdr's `ide-main` layout. In Review, click **连接** (or the empty-state **连接浏览器** button). The native dialog shows a grouped one-use code, remaining time and copy feedback. Expired codes can be regenerated; cancel invalidates only that pending code. Successful pairing shows a brief success state and closes automatically.
3. Click **安装 / 更新插件** to explicitly start local Chrome automation on macOS. Updating targets only the Herdr UI Review card, not other extensions. Automation may require macOS Automation / Accessibility permission; if registration cannot be verified, the UI gives manual steps and copies the directory. Alternatively, open `chrome://extensions`, enable developer mode and load `~/.config/herdr-app/mods/ide-review/chrome-extension`. Use the extension's styled **Options** page to enter the code. The code alone completes pairing; there is no second approval popup in this version. Only pair while you intentionally initiated the connection.
4. Click the extension action on a non-sensitive development page. `⌘Enter` stages annotations and an explicit screenshot. Normal note edits stage text only. All page/DOM/source metadata remains untrusted.
5. Review the final prompt and target in Herdr. Confirm **复制待粘贴** for manual paste or **Send & Run** for explicitly targeted execution. Busy, blocked, missing, remote, or changed targets fail closed.
6. The toolbar status pill distinguishes connected, paired/offline, unpaired and bridge-unavailable states. Use its **⋯** menu → **撤销浏览器配对…**, then confirm; this immediately invalidates the browser token. Pairing a new browser profile replaces the previous pairing (one client at a time). Browser or Herdr restarts preserve pairing, but a worker restart requires clicking the action again to reactivate a page.

Credentials are persisted under `data/annotations/security/` (0700 directory, 0600 file). Never publish this directory. Local administration uses a separate credential; browser clients cannot shutdown, install extensions, edit the Review queue, or read other staged batches. Public ping contains health/version only. Revocation and rotation are also available using `node mods/ide-review/bridge.mjs --revoke|--rotate --app-home ~/.config/herdr-app`.

The bridge rejects legacy `send`/`paste`, unexpected Host/Origin, unpaired clients, unbounded annotations and invalid PNG headers. Screenshot storage is bounded and aged out. These checks do not make page content trusted and do not protect against malware with the current user's filesystem access. CORS/extension ID are auxiliary checks, not secrets. Pair-code expiry uses server time; never share the code.

## Verification

Six suites, one per boundary; they assert behaviour, not markup:

```sh
node --test tests/*.test.mjs   # bridge, worker, runtime, delivery, installer, ui
herdr-app check ~/.config/herdr-app/mods/ide-review
herdr-app check ~/.config/herdr-app/mods/ide-tabs
```

- `bridge.test.mjs` — pairing, scoping, staging limits, queue revisions
- `worker.test.mjs` — activation gate, credential containment, capture safety
- `runtime.test.mjs` — stale page script disposal after a reload
- `delivery.test.mjs` — explicit targets, confirmation, queue retention
- `installer.test.mjs` — local-only install, registration proof, permission hints
- `ui.test.mjs` — connection state, Agent labels, in-menu pairing, panel entries

Installation/update is local CLI only (`--install-ext` / `--update-ext`), never available through HTTP and never triggered during startup or checks. It reads only Chrome extension registration when you explicitly click the button. It does not change Review pairing credentials. Unsupported platforms use manual installation.

Tests use temporary directories and simulated browser/Agent APIs. Real Chrome pairing, activeTab permissions and page capture require manual end-to-end testing; a passing Herdr check only verifies the initial render.

> **Note:** Herdr's `cap_primitives` asset loader sandboxes `~/.config/herdr-app` and blocks symlinks that point outside `~/.config/herdr-app` when loading SVG icons. Always use `./install.sh` (which copies files directly into `~/.config/herdr-app`) after making changes in this repo.
