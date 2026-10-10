#!/usr/bin/env bash
# Launch xono the way the desktop does.
#
# Going through the desktop entry is what makes the global hotkey work in development:
# the xdg-desktop-portal GlobalShortcuts portal identifies an app by its systemd
# application scope, and only this route gives it one. Launched straight from a shell the
# portal refuses the bind with "An app id is required", which Electron does not surface —
# so the shortcut looks registered and does nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$HOME/.local/share/applications/dev.xono.app.desktop"

if [[ ! -f "$DESKTOP" ]]; then
  echo "No desktop entry found. Installing one first." >&2
  bash "$ROOT/scripts/install-desktop-entry.sh" >&2
fi

extra=("$@")

if command -v gio >/dev/null; then
  exec gio launch "$DESKTOP" -- "${extra[@]/#/--}"
fi

if command -v gtk-launch >/dev/null; then
  exec gtk-launch dev.xono.app "${extra[@]}"
fi

echo "Neither gio nor gtk-launch is available; falling back to a direct launch." >&2
echo "The global hotkey may not bind without a desktop identity." >&2
exec "$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox "${extra[@]}"
