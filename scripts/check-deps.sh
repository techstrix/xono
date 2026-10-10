#!/usr/bin/env bash
# Checks everything xono needs on this machine and prints the fix for whatever is
# missing. Safe to run repeatedly; exits non-zero if a hard requirement is absent.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0
WARN=0

ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$1"; WARN=$((WARN + 1)); }
bad()   { printf '  \033[1;31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

printf '\033[1;6mXono dependency check\033[0m\n'

head_ "Audio capture"
if command -v parec >/dev/null; then
  ok "parec found ($(command -v parec))"
else
  bad "parec missing — no microphone access"
  printf '      fix: sudo pacman -S pipewire-utils\n'
fi

if command -v wpctl >/dev/null; then
  if wpctl status 2>/dev/null | grep -qi 'Audio'; then
    ok "PipeWire running"
  else
    warn "PipeWire does not look like it is running"
    printf '      try: systemctl --user start pipewire\n'
  fi
else
  warn "wpctl not found, cannot verify PipeWire state"
fi

if pactl list sources short 2>/dev/null | grep -qv '^$'; then
  ok "input devices visible to PulseAudio/PipeWire"
else
  warn "no input sources reported — is a microphone connected and unmuted?"
fi

head_ "Text injection"
SESSION="${XDG_SESSION_TYPE:-$( [ -n "${WAYLAND_DISPLAY:-}" ] && echo wayland || echo x11 )}"
printf '  session: %s (desktop: %s)\n' "$SESSION" "${XDG_CURRENT_DESKTOP:-unknown}"

case "$SESSION" in
  wayland) WANT=ydotool ;;
  *)       WANT=xdotool ;;
esac

if command -v "$WANT" >/dev/null; then
  ok "$WANT found"
else
  bad "$WANT missing — this is what sends Ctrl+V on $SESSION"
  printf '      fix: sudo pacman -S %s\n' "$WANT"
fi

if [ "$WANT" = "ydotool" ]; then
  # Probe rather than trust the socket file: it outlives its process, so a stale one
  # makes every ydotool command fail with "connection refused" while looking present.
  if ydotool key 125:1 125:0 >/dev/null 2>&1; then
    ok "ydotoold running and responding"
  elif [ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket" ]; then
    warn "a stale ydotoold socket exists but nothing is listening"
    printf '      fix: rm -f "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/.ydotool_socket"\n'
    printf '      xono also detects this and restarts the daemon automatically.\n'
  else
    warn "ydotoold not running — ydotool only works as a client of that daemon"
    printf '      xono starts it automatically on the first dictation. To keep it alive across\n'
    printf '      reboots instead, enable the systemd user unit: systemctl --user enable --now ydotoold\n'
  fi
fi

if [ -r /dev/uinput ] && [ -w /dev/uinput ]; then
  ok "/dev/uinput readable and writable"
else
  bad "/dev/uinput not accessible"
  printf '      fix:\n'
  printf '        sudo modprobe uinput\n'
  printf "        echo 'KERNEL==\"uinput\", MODE=\"0660\", GROUP=\"input\", OPTIONS+=\"static_node=uinput\"' | sudo tee /etc/udev/rules.d/99-uinput.rules\n"
  printf '        sudo udevadm control --reload-rules && sudo udevadm trigger\n'
  printf '        then reboot and log back in\n'
fi

if id -nG | tr ' ' '\n' | grep -qx input; then
  ok "you are in the input group"
else
  warn "not in the input group (needed to open /dev/uinput)"
  printf '      fix: sudo usermod -aG input $USER   then log out and back in\n'
fi

if command -v wl-copy >/dev/null; then
  ok "wl-clipboard found"
else
  warn "wl-clipboard not installed (not required — Electron talks to the compositor directly)"
fi

head_ "Transcription engine"
WHISPER="$ROOT/vendor/whisper.cpp/build/bin/whisper-cli"
if [ -x "$WHISPER" ]; then
  ok "whisper-cli built ($WHISPER)"
elif command -v whisper-cli >/dev/null; then
  ok "whisper-cli on PATH ($(command -v whisper-cli))"
else
  bad "whisper.cpp not built — transcription will not work"
  printf '      fix: npm run setup:engine\n'
fi

MODEL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/xono/models"
if [ -d "$MODEL_DIR" ] && ls "$MODEL_DIR"/ggml-*.bin >/dev/null 2>&1; then
  for f in "$MODEL_DIR"/ggml-*.bin; do
    ok "model present: $(basename "$f") ($(du -h "$f" | cut -f1))"
  done
else
  warn "no GGML models downloaded yet"
  printf '      xono downloads one on first dictation, or from Settings -> Speech to text\n'
fi

head_ "Node toolchain"
if command -v node >/dev/null; then ok "node $(node -v)"; else bad "node missing"; fi
if [ -d "$ROOT/node_modules" ]; then ok "dependencies installed"; else warn "node_modules missing — run: npm install"; fi

head_ "Global hotkey"

# register() returning true proves nothing on Wayland: the portal resolves the bind
# asynchronously and can refuse it silently. Ask the desktop instead, which is the only
# party that actually knows whether the shortcut is live.
ACCEL=$(python3 -c "import json;print(json.load(open('$HOME/.config/xono/config.json'))['hotkey']['accelerator'])" 2>/dev/null || echo "")
if [ -n "$ACCEL" ] && command -v gdbus >/dev/null; then
  INFO=$(timeout 8 gdbus call --session --dest org.kde.kglobalaccel \
    --object-path /component/dev_xono_app \
    --method org.kde.kglobalaccel.Component.allShortcutInfos 2>/dev/null || true)
  if echo "$INFO" | grep -q "dev.xono.app"; then
    if echo "$INFO" | grep -qE '\[[1-9][0-9]*\]'; then
      ok "hotkey bound by the desktop: $ACCEL"
    else
      bad "xono is registered with KDE but NO KEY is bound"
      printf '      This is the silent Wayland failure mode: register() returns true even\n'
      printf '      when the portal refuses the bind. The usual cause is launching xono\n'
      printf '      without a desktop identity, so the portal has no app id. Try:\n'
      printf '           npm run launch\n'
    fi
  else
    warn "xono has no global shortcut registered with KDE"
    printf '      launch through the desktop entry so the portal can identify it:\n'
    printf '           npm run launch\n'
  fi
else
  printf '  note: could not query KDE for the registered shortcut (accelerator: %s)\n' "${ACCEL:-unknown}"
fi

printf '  fallback if the portal refuses: bind a KDE system shortcut to  xono --toggle\n'
printf '\n'
if [ "$FAIL" -gt 0 ]; then
  printf '\033[1;31m%s blocking problem(s)\033[0m, %s warning(s)\n' "$FAIL" "$WARN"
  exit 1
fi
printf '\033[1;32mNo blocking problems\033[0m, %s warning(s)\n' "$WARN"