#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
export REPO_DIR APP_HOME
# Same-name personal mods are updated only with explicit --sync consent.
if [[ "${1:-}" != "--sync" ]]; then
  for mod in ide-files ide-changes ide-spaces ide-agents ide-review ide-tabs; do
    if [[ -e "$APP_HOME/mods/$mod" || -L "$APP_HOME/mods/$mod" ]]; then
      echo "Existing personal mod: $mod. Use --sync to back up and update." >&2
      exit 1
    fi
  done
  if [[ -e "$APP_HOME/layouts/ide-main.json" ]]; then
    echo "Existing ide-main layout; use --sync to update personal mods only." >&2
    exit 1
  fi
fi
if command -v herdr-app >/dev/null 2>&1; then
  for mod in ide-files ide-changes ide-spaces ide-agents ide-review ide-tabs; do
    herdr-app check "$REPO_DIR/mods/$mod"
  done
fi
python3 - <<'PY'
import json, os, shutil, pathlib, datetime
src = pathlib.Path(os.environ['REPO_DIR'])
dst = pathlib.Path(os.environ['APP_HOME']).expanduser()
backup = dst.parent / 'herdr-app-backups' / ('review-sync-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
backup.mkdir(parents=True, mode=0o700)
os.chmod(backup, 0o700)
keys_path = dst / 'keys.json'
keys = json.loads(keys_path.read_text()) if keys_path.exists() else {}
provided = json.loads((src / 'keys.json').read_text())
for section, bindings in provided.items():
    existing = keys.setdefault(section, {})
    for key, value in bindings.items():
        if key in existing and existing[key] != value:
            print(f'Preserved existing binding: {section} {key}')
        else:
            existing.setdefault(key, value)
# No credential/runtime state copies: those must not end up in public artifacts.
if keys_path.exists(): shutil.copy2(keys_path, backup / 'keys.json')
for mod in (src / 'mods').iterdir():
    target = dst / 'mods' / mod.name
    if target.is_symlink(): raise SystemExit(f'Refusing symlink: {target}')
    if target.exists():
        shutil.copytree(target, backup / 'mods' / mod.name)
        shutil.rmtree(target)
    shutil.copytree(mod, target, ignore=shutil.ignore_patterns('RECIPE.md', 'preview.png', '*.error', '*.d.ts', 'jsconfig.json'))
layout = dst / 'layouts' / 'ide-main.json'
layout.parent.mkdir(parents=True, exist_ok=True)
if not layout.exists(): shutil.copy2(src / 'layouts' / 'ide-main.json', layout)
keys_path.write_text(json.dumps(keys, ensure_ascii=False, indent=2) + '\n')
print('Backup:', backup)
PY
if command -v herdr-app >/dev/null 2>&1; then
  for mod in ide-files ide-changes ide-spaces ide-agents ide-review ide-tabs; do
    herdr-app check "$APP_HOME/mods/$mod"
  done
  herdr-app do layout.switch '{"name":"ide-main"}'
fi
echo 'Personal mods installed. Stop an older unauthenticated bridge locally before starting version 2.'
echo 'Chrome extension is not loaded automatically. Load mods/ide-review/chrome-extension and pair from Review.'
