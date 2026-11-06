#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_HOME="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"

echo "==> Linking mods and layout from $REPO_DIR to $APP_HOME"

mkdir -p "$APP_HOME/mods" "$APP_HOME/layouts"

for mod in ide-files ide-changes; do
  target="$APP_HOME/mods/$mod"
  if [ -L "$target" ] || [ -d "$target" ]; then
    rm -rf "$target"
  fi
  ln -s "$REPO_DIR/mods/$mod" "$target"
  echo "  Linked mod: $target -> $REPO_DIR/mods/$mod"
done

layout_target="$APP_HOME/layouts/ide-main.json"
if [ -L "$layout_target" ] || [ -f "$layout_target" ]; then
  rm -f "$layout_target"
fi
ln -s "$REPO_DIR/layouts/ide-main.json" "$layout_target"
echo "  Linked layout: $layout_target -> $REPO_DIR/layouts/ide-main.json"

cp "$REPO_DIR/keys.json" "$APP_HOME/keys.json"
echo "  Updated keys: $APP_HOME/keys.json"

if command -v herdr-app >/dev/null 2>&1; then
  echo "==> Checking mods with herdr-app check"
  herdr-app check "$APP_HOME/mods/ide-files"
  herdr-app check "$APP_HOME/mods/ide-changes"
  echo "==> Switching active layout to ide-main"
  herdr-app do layout.switch '{"name":"ide-main"}' || true
fi

echo "==> Done!"
