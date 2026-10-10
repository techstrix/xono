#!/usr/bin/env bash
# The bug that started all this: `npm run dev` behaved differently from the installed
# app, and the widget disappeared behind other windows. This runs dev mode with a
# maximised window on top and photographs the result.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHOT=/tmp/xono-dev-ontop.png

for pid in $(pgrep -f "node_modules/electron/dist/electron" 2>/dev/null); do
  kill -9 "$pid" 2>/dev/null
done
sleep 2
rm -f "$SHOT"

cat > /tmp/other-app.mjs <<'EOF'
import { app, BrowserWindow } from 'electron'
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    width: 1200, height: 700, show: false, frame: true,
    title: 'OtherApp', backgroundColor: '#1b2a4a'
  })
  await w.loadURL('data:text/html,<body style="margin:0;background:%231b2a4a;color:%23fff;' +
    'font:40px sans-serif;display:flex;align-items:center;justify-content:center">' +
    'OTHER APP maximized</body>')
  w.maximize()
  await new Promise((r) => setTimeout(r, 9000))
  w.moveTop()
  await new Promise((r) => setTimeout(r, 7000))
  app.quit()
})
EOF

cd "$ROOT"
setsid npm run dev </dev/null >/tmp/xono-dev-run.log 2>&1 &
sleep 18
echo "  backend: $(pgrep -af 'dist/electron' | grep -o 'ozone-platform=x11' | head -1 || echo NONE)"

setsid "$ROOT/node_modules/.bin/electron" --no-sandbox /tmp/other-app.mjs \
  </dev/null >/dev/null 2>&1 &
sleep 10

spectacle -b -n -f -o "$SHOT" >/dev/null 2>&1
echo "  screenshot: $SHOT"
for pid in $(pgrep -f "other-app.mjs" 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
exit 0