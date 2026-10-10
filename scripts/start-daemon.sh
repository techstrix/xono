#!/usr/bin/env bash
# Start the daemon detached so it survives the shell that launched it, then report
# whether it came up and whether injection can work.
set -uo pipefail

LOG="$HOME/.config/xono/logs/main.log"
for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 2
rm -f "$LOG"

setsid gio launch "$HOME/.local/share/applications/dev.xono.app.desktop" \
  </dev/null >/dev/null 2>&1 &
for _ in $(seq 1 60); do
  [[ -f "$LOG" ]] && grep -q "xono ready" "$LOG" && break
  sleep 0.5
done
sleep 3

main=$(pgrep -f "node_modules/electron/dist/electron" | wc -l)
echo "  electron processes: $main"
grep -q "xono ready" "$LOG" 2>/dev/null && echo "  booted: yes" || echo "  booted: NO"

echo "  backend: $(pgrep -af 'dist/electron' | grep -o 'ozone-platform=x11' | head -1 || echo 'native wayland')"

if grep -q "ydotoold failed to start" "$LOG" 2>/dev/null; then
  echo "  ydotoold: FAILED (paste would not work)"
  echo "  groups: $(id -nG | tr ' ' ',')"
  ls -l /dev/uinput 2>/dev/null || echo "  /dev/uinput: missing"
else
  echo "  ydotoold: ok"
fi
grep "hotkey registered" "$LOG" 2>/dev/null | tail -1 | sed 's/^.*\[/  /'