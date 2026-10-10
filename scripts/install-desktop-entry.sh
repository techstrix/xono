#!/usr/bin/env bash
# Install the desktop entry that gives xono a real desktop identity.
#
# This matters more than it looks. On Wayland, global shortcuts are bound through the
# xdg-desktop-portal GlobalShortcuts portal, and the portal identifies the caller from
# its systemd application scope. A process launched straight from a shell has no scope,
# so the portal refuses the bind with "An app id is required" — and Electron surfaces
# nothing, so `register()` returns true and the hotkey silently never fires.
#
# Installing this entry (and launching through it) is what makes the hotkey work in
# development. Packaged builds get the entry from the installer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$HOME/.local/share/applications"
TARGET="$APPS/dev.xono.app.desktop"

mkdir -p "$APPS"

# Development build: point at the repo's Electron binary so `npm run launch` works.
# For a packaged install the Exec line is rewritten to the real binary by the packager.
if [[ -x "$ROOT/node_modules/.bin/electron" ]]; then
  EXEC="$ROOT/node_modules/.bin/electron $ROOT --no-sandbox --ozone-platform=x11 %U"
  sed "s|^Exec=.*|Exec=$EXEC|" "$ROOT/resources/xono.desktop" >"$TARGET"
  echo "installed $TARGET (development: runs the repo build)"
else
  cp "$ROOT/resources/xono.desktop" "$TARGET"
  echo "installed $TARGET (Exec points at 'xono'; edit it or install the app)"
fi

if command -v update-desktop-database >/dev/null; then
  update-desktop-database "$APPS" 2>/dev/null || true
fi

cat <<'EOF'

Done. Launch xono through the desktop entry so the portal can identify it:

    npm run launch

or from the KDE application menu.

If you launched it from a bare terminal instead, the GlobalShortcuts portal cannot
derive an app id and refuses the binding silently — the hotkey will appear registered
in settings and do nothing.
EOF
