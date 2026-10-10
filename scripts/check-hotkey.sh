#!/usr/bin/env bash
# Is the global hotkey actually live?
#
# Two things make this harder than it looks, and both have bitten us:
#
#  1. `globalShortcut.register()` returning true proves nothing on Wayland. The bind goes
#     through the xdg-desktop-portal GlobalShortcuts portal, which resolves
#     asynchronously and can refuse without Electron surfacing anything. The shortcut then
#     looks registered and silently never fires.
#
#  2. Synthesising the key press is not a valid test. A uinput device reaches
#     applications, but KWin's global-shortcut path does not consume injected events, so
#     "the key was sent and nothing happened" says nothing about the app.
#
# So this asks the two parties that actually know: KDE for whether a key is bound, and
# then invokes the bound shortcut directly to confirm delivery reaches xono's callback.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CFG="$HOME/.config/xono/config.json"
LOG="$HOME/.config/xono/logs/main.log"
DESKTOP="$HOME/.local/share/applications/dev.xono.app.desktop"
COMPONENT="/component/dev_xono_app"

fired() { grep -c "hotkey fired" "$LOG" 2>/dev/null || true; }

for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 1

ACCEL="${1:-}"
if [[ -z "$ACCEL" ]]; then
  ACCEL=$(python3 -c "import json;print(json.load(open('$CFG'))['hotkey']['accelerator'])" 2>/dev/null || echo "")
else
  python3 - "$CFG" "$ACCEL" <<'PY'
import json, os, sys
path, accel = sys.argv[1], sys.argv[2]
cfg = json.load(open(path)) if os.path.exists(path) else {}
cfg.setdefault("hotkey", {})["accelerator"] = accel
os.makedirs(os.path.dirname(path), exist_ok=True)
json.dump(cfg, open(path, "w"), indent=2)
PY
fi

echo "  accelerator: ${ACCEL:-<unset>}"

if [[ ! -f "$DESKTOP" ]]; then
  echo "  installing the desktop entry (the portal needs an app id)"
  bash "$ROOT/scripts/install-desktop-entry.sh" >/dev/null 2>&1
fi

rm -f "$LOG"
gio launch "$DESKTOP" >/dev/null 2>&1 </dev/null &
for _ in $(seq 1 60); do
  [[ -f "$LOG" ]] && grep -q "xono ready" "$LOG" && break
  sleep 0.5
done

if ! grep -q "xono ready" "$LOG" 2>/dev/null; then
  echo "  RESULT: the app did not start"
  exit 1
fi

# Which mechanism is even in play depends on the windowing backend.
BACKEND=$(pgrep -af "dist/electron" | grep -o "ozone-platform=x11" | head -1 || true)
if [[ -n "$BACKEND" ]]; then
  # Under XWayland Electron grabs the key with XGrabKey and never touches the portal, so
  # anything KGlobalAccel still lists is a leftover from an earlier run and says nothing
  # about the running app. Inventing a verdict here would be a lie.
  echo "  backend: XWayland (XGrabKey, not the portal)"
  echo "  a KGlobalAccel entry here would be stale, so it is not a valid test"
  echo "  this can only be verified by pressing $ACCEL — synthetic keys never reach a"
  echo "  compositor global grab"
  echo
  echo "  guaranteed alternative: bind a KDE system shortcut to  xono --toggle"
  exit 0
fi

INFO=$(timeout 8 gdbus call --session --dest org.kde.kglobalaccel \
  --object-path "$COMPONENT" \
  --method org.kde.kglobalaccel.Component.allShortcutInfos 2>/dev/null || true)

if ! echo "$INFO" | grep -q "dev.xono.app"; then
  echo "  RESULT: xono has no global shortcut registered with KDE"
  echo "          the portal refused the bind — most often because the app was not"
  echo "          launched through its desktop entry, so it has no app id"
  exit 1
fi

if ! echo "$INFO" | grep -qE '\[[1-9][0-9]*\]'; then
  echo "  RESULT: registered with KDE, but NO KEY is bound"
  echo "          this is the silent Wayland failure: register() returns true anyway"
  exit 1
fi

echo "  KDE has the shortcut bound"

# Confirm delivery reaches the app's callback.
SHORTCUT=$(python3 - "$INFO" <<'PY'
import re, sys
m = re.search(r"'([0-9A-F]{16,}-[^']*)'", sys.argv[1])
print(m.group(1) if m else "")
PY
)

before=$(fired); before=${before:-0}
timeout 8 gdbus call --session --dest org.kde.kglobalaccel --object-path "$COMPONENT" \
  --method org.kde.kglobalaccel.Component.invokeShortcut "$SHORTCUT" "default" >/dev/null 2>&1
sleep 2
after=$(fired); after=${after:-0}

if [[ "$after" -gt "$before" ]]; then
  echo "  RESULT: LIVE — the shortcut reached xono and triggered a toggle"
  exit 0
fi

echo "  RESULT: bound but the callback did not fire"
exit 1
