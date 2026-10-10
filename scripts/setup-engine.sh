#!/usr/bin/env bash
# Builds whisper.cpp into ./vendor and reports where the binary landed.
#
# CPU-only by default: there is no NVIDIA GPU on the target machine, and shipping a
# CUDA build would just bloat the binary.
#
# Optimisation modes:
#   default (dev):  -DGGML_NATIVE=ON  — fastest on this machine, not portable.
#   portable:       -DGGML_NATIVE=OFF — runs on any x86-64 distro; use for AppImage.
#                   Enable with  XONO_PORTABLE=1  or  --portable.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/distro.sh"
XONO_PM="$(xono_detect_pm)"
VENDOR="$ROOT/vendor"
SRC="$VENDOR/whisper.cpp"
BIN_DIR="$SRC/build/bin"

MODEL_ID="${XONO_MODEL:-base.en}"
MODEL_FILE="ggml-${MODEL_ID}.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}"

say() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$1"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$1" >&2; exit 1; }

PORTABLE="${XONO_PORTABLE:-0}"
for arg in "$@"; do
  [[ "$arg" == "--portable" ]] && PORTABLE=1
done

command -v git >/dev/null || die "git is required"
command -v cmake >/dev/null || die "cmake is required ($(xono_install_fix cmake))"
if ! command -v c++ >/dev/null && ! command -v g++ >/dev/null; then
  die "a C++ compiler is required ($(xono_install_fix cxx))"
fi

mkdir -p "$VENDOR"

if [[ ! -d "$SRC/.git" ]]; then
  say "cloning whisper.cpp"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$SRC"
else
  say "updating whisper.cpp"
  git -C "$SRC" pull --ff-only
fi

if [[ "$PORTABLE" == "1" ]]; then
  say "configuring (CPU, portable x86-64 — for AppImage)"
  NATIVE_FLAG=OFF
else
  say "configuring (CPU, native optimisations)"
  NATIVE_FLAG=ON
fi
# Examples must stay ON: upstream builds the CLI as examples/cli, so turning them off
# removes the `whisper-cli` target entirely.
cmake -S "$SRC" -B "$SRC/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DGGML_NATIVE="$NATIVE_FLAG" \
  -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_EXAMPLES=ON \
  -DWHISPER_BUILD_SERVER=ON

say "building whisper-cli"
cmake --build "$SRC/build" --config Release -j "$(nproc)" --target whisper-cli

[[ -x "$BIN_DIR/whisper-cli" ]] || die "expected $BIN_DIR/whisper-cli after the build"

say "built $BIN_DIR/whisper-cli"
"$BIN_DIR/whisper-cli" --help 2>&1 | head -n 3 || true

MODEL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/xono/models"
mkdir -p "$MODEL_DIR"

if [[ -f "$MODEL_DIR/$MODEL_FILE" ]]; then
  say "model $MODEL_ID already present"
else
  say "downloading $MODEL_ID ($MODEL_FILE)"
  warn "Xono also downloads models on demand from Settings -> Speech to text."
  curl -fL --progress-bar -o "$MODEL_DIR/$MODEL_FILE.part" "$MODEL_URL"
  mv "$MODEL_DIR/$MODEL_FILE.part" "$MODEL_DIR/$MODEL_FILE"
  say "model saved to $MODEL_DIR/$MODEL_FILE"
fi

cat <<EOF

$(say "done")

Next:
  1. Make sure you can open /dev/uinput:   sudo modprobe uinput
  2. Install the injection tool:            $(xono_install_fix ydotool)
  3. Run the dependency check:              npm run doctor
  4. Start the app:                         npm run dev

You can override the model, e.g.:  XONO_MODEL=small.en bash scripts/setup-engine.sh
Build a portable binary for AppImage:  XONO_PORTABLE=1 bash scripts/setup-engine.sh
EOF