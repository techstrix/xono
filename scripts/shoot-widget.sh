#!/usr/bin/env bash
# Launch xono the way the desktop does, wake the widget, and photograph the result.
# The compositor owns placement on native Wayland, so the only way to know where the
# pill really is (and whether it is really on top) is to look at the screen.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/.config/xono/logs/main.log"
SHOT="${1:-/tmp/xono-widget.png}"

for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 2
rm -f "$LOG" "$SHOT"

gio launch "$HOME/.local/share/applications/dev.xono.app.desktop" >/dev/null 2>&1 </dev/null &
for _ in $(seq 1 60); do
  [[ -f "$LOG" ]] && grep -q "xono ready" "$LOG" && break
  sleep 0.5
done
sleep 2

# Wake the widget through the shortcut that is already bound.
ACCEL=$(python3 -c "import json;print(json.load(open('$HOME/.config/xono/config.json'))['hotkey']['accelerator'])" 2>/dev/null || echo "")
SHORTCUT=$(timeout 8 gdbus call --session --dest org.kde.kglobalaccel \
  --object-path /component/dev_xono_app \
  --method org.kde.kglobalaccel.Component.allShortcutInfos 2>/dev/null \
  | python3 -c "
import re,sys
m = re.search(r\"'([0-9A-F]{16,}-[^']*)'\", sys.stdin.read())
print(m.group(1) if m else '')
")
if [[ -n "$SHORTCUT" ]]; then
  timeout 8 gdbus call --session --dest org.kde.kglobalaccel \
    --object-path /component/dev_xono_app \
    --method org.kde.kglobalaccel.Component.invokeShortcut "$SHORTCUT" "default" >/dev/null 2>&1
fi
sleep 2

spectacle -b -n -f -o "$SHOT" >/dev/null 2>&1
echo "  asked for: ${ACCEL:-<unset>}"
echo "  screenshot: $SHOT"
grep -c "hotkey fired" "$LOG" 2>/dev/null | sed 's/^/  activations: /'
exit 0