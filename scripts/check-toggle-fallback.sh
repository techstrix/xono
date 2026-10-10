#!/usr/bin/env bash
# Verify the `xono --toggle` fallback: a second launch must toggle the running instance.
#
# This is the escape hatch for any desktop where the GlobalShortcuts portal refuses the
# binding. It only works if the single-instance lock forwards the flag rather than the
# second process quitting silently, which it used to do.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/.config/xono/logs/main.log"

fired() { grep -c "hotkey fired" "$LOG" 2>/dev/null || true; }

for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 1
rm -f "$LOG"

# Start the app through the desktop entry, then wait for it to settle.
gio launch "$HOME/.local/share/applications/dev.xono.app.desktop" >/dev/null 2>&1 </dev/null &
for _ in $(seq 1 60); do
  [[ -f "$LOG" ]] && grep -q "xono ready" "$LOG" && break
  sleep 0.5
done

if ! grep -q "xono ready" "$LOG" 2>/dev/null; then
  echo "  the app did not start"
  exit 1
fi
echo "  primary instance running"

before=$(fired); before=${before:-0}

# Now the real test: a second launch carrying --toggle.
"$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox --toggle \
  </dev/null >/tmp/xono-toggle-second.log 2>&1
sleep 3

after=$(fired); after=${after:-0}

if [[ "$after" -gt "$before" ]]; then
  echo "  RESULT: --toggle reached the running instance"
else
  echo "  RESULT: --toggle did NOT reach the running instance"
  echo "  (second-instance forwarding is broken)"
  exit 1
fi

# The pipeline should now be listening, which is the point of the flag.
if grep -q "listening\|Listening" "$LOG" 2>/dev/null; then
  echo "  pipeline entered the listening state"
fi
