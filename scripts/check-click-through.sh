#!/usr/bin/env bash
# Does the widget swallow clicks meant for the app underneath it?
#
# The widget's window is deliberately far taller than the pill, so anything it fails to
# pass through becomes a large dead zone rather than a sliver. This puts a real input
# field inside that zone and clicks it.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RESULT=/tmp/xono-click-result.txt
rm -f "$RESULT"

for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 2

# A page that records every click and keystroke it actually receives.
cat > /tmp/click-target.html <<'EOF'
<!doctype html><html><head><meta charset="utf-8" />
<style>
 body{margin:0;font:16px sans-serif;background:#22334d;color:#fff;padding:16px}
 input{font:16px sans-serif;padding:8px;width:90%}
 #log{margin-top:12px;font-family:monospace;background:#0006;padding:8px;height:40px}
</style></head><body>
<input id="field" placeholder="type here" />
<div id="log">none</div>
<script>
  const log = document.getElementById('log')
  const field = document.getElementById('field')
  window.__clicks = 0
  document.addEventListener('click', () => {
    window.__clicks++
    log.textContent = 'clicks=' + window.__clicks + ' typed=' + field.value
  })
  field.addEventListener('input', () => { log.textContent = 'typed=' + field.value })
</script></body></html>
EOF

cat > /tmp/click-target.mjs <<'EOF'
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 420, height: 220, x: 600, y: 420, show: true, frame: true,
    title: 'ClickTarget', backgroundColor: '#22334d'
  })
  await w.loadFile('/tmp/click-target.html')
  await new Promise((r) => setTimeout(r, 20000))
  const n = await w.webContents.executeJavaScript('window.__clicks')
  writeFileSync('/tmp/xono-click-result.txt', String(n))
  app.quit()
})
EOF

setsid "$ROOT/node_modules/.bin/electron" --no-sandbox /tmp/click-target.mjs \
  </dev/null >/dev/null 2>&1 &
sleep 6

# Start xono, then click the input's field — inside the widget's window rect.
setsid gio launch "$HOME/.local/share/applications/dev.xono.app.desktop" >/dev/null 2>&1 </dev/null &
for _ in $(seq 1 60); do
  grep -q "xono ready" "$HOME/.config/xono/logs/main.log" 2>/dev/null && break
  sleep 0.5
done
sleep 3

echo "  clicking the field behind the widget..."
DISPLAY=:0 xdotool mousemove 810 460 click 1
sleep 1
DISPLAY=:0 xdotool type "hello"
sleep 1

# The target writes its tally as it exits, so wait for that rather than guessing.
for _ in $(seq 1 40); do
  [[ -f "$RESULT" ]] && break
  sleep 1
done
CLICKS=$(cat "$RESULT" 2>/dev/null || echo "none")
echo "  clicks received by the app underneath: $CLICKS"
if [[ "$CLICKS" == "0" || "$CLICKS" == "none" || -z "$CLICKS" ]]; then
  echo "  RESULT: the widget swallowed the click — the area behind it is dead"
  exit 1
fi
echo "  RESULT: the click reached the app underneath"
exit 0

for pid in $(pgrep -f "click-target.mjs" 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
exit 0