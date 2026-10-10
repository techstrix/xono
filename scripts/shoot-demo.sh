#!/usr/bin/env bash
# Photograph the pill during dictation, which is the only time the border sweep shows.
# --demo cycles the real states on a timer, so the listening frame can be caught
# without needing a microphone.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 2

setsid "$ROOT/node_modules/.bin/electron" "$ROOT" --no-sandbox \
  --ozone-platform=x11 --demo </dev/null >/tmp/xono-demo.log 2>&1 &

# The demo runs idle -> listening -> working -> ... so sample across a full pass.
sleep 4
for n in 1 2 3 4 5 6; do
  spectacle -b -n -f -o "/tmp/xono-demo-$n.png" >/dev/null 2>&1
  sleep 2
done
echo "  frames: /tmp/xono-demo-{1..6}.png"
for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
exit 0