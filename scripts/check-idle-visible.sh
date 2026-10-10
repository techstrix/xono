#!/usr/bin/env bash
# Start xono and check the pill is on screen with NOTHING triggered.
# The requirement is simply "visible whenever the daemon runs", so this must not poke
# the hotkey or send a single state.
set -uo pipefail

SHOT="${1:-/tmp/xono-idle-boot.png}"
for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 2
rm -f "$SHOT" "$HOME/.config/xono/logs/main.log"

gio launch "$HOME/.local/share/applications/dev.xono.app.desktop" >/dev/null 2>&1 </dev/null &
for _ in $(seq 1 60); do
  [[ -f "$HOME/.config/xono/logs/main.log" ]] &&
    grep -q "xono ready" "$HOME/.config/xono/logs/main.log" && break
  sleep 0.5
done
sleep 4

spectacle -b -n -f -o "$SHOT" >/dev/null 2>&1
echo "  screenshot: $SHOT"
echo "  running: $(pgrep -f 'node_modules/electron/dist/electron' | wc -l) process(es)"
echo "  the pill should already be on screen — nothing was triggered"