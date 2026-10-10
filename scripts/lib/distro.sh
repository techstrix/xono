#!/usr/bin/env bash
# Shared distro detection for xono shell scripts.
# Sourced by check-deps.sh and setup-engine.sh — not executed directly.
#
# Provides:
#   xono_detect_pm      -> prints pacman|apt|dnf|zypper|apk|xbps|emerge|nix|unknown
#   xono_install_fix <key> -> prints the exact install line for this machine
#
# Keys: audio-capture | ydotool | xdotool | wtype | cmake | cxx
#
# On Arch the output is byte-identical to the old hardcoded pacman lines.

_xono_os_id() {
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    printf '%s' "${ID:-unknown}"
  else
    printf 'unknown'
  fi
}

xono_detect_pm() {
  local id
  id="$(_xono_os_id)"
  case "$id" in
    arch|manjaro|endeavouros|cachyos|garuda|artix) echo pacman; return ;;
    debian|ubuntu|linuxmint|pop|pop_os|elementary|zorin|kali|raspbian) echo apt; return ;;
    fedora|rhel|centos|rocky|almalinux|nobara) echo dnf; return ;;
    opensuse*|sles) echo zypper; return ;;
    alpine|postmarketos) echo apk; return ;;
    void) echo xbps; return ;;
    gentoo) echo emerge; return ;;
    nixos) echo nix; return ;;
  esac
  # ID_LIKE fallback (Ubuntu reports ID=ubuntu ID_LIKE=debian).
  if [[ -r /etc/os-release ]]; then
    local like
    like="$(grep -E '^ID_LIKE=' /etc/os-release | cut -d= -f2 | tr -d '"' | tr '[:upper:]' '[:lower:]' || true)"
    case "$like" in
      *debian*|*ubuntu*) echo apt; return ;;
      *arch*) echo pacman; return ;;
      *fedora*|*rhel*|*centos*) echo dnf; return ;;
      *suse*) echo zypper; return ;;
      *alpine*) echo apk; return ;;
    esac
  fi
  # PATH probing as a last resort.
  command -v pacman >/dev/null 2>&1 && { echo pacman; return; }
  command -v apt-get >/dev/null 2>&1 && { echo apt; return; }
  command -v dnf >/dev/null 2>&1 && { echo dnf; return; }
  command -v zypper >/dev/null 2>&1 && { echo zypper; return; }
  command -v apk >/dev/null 2>&1 && { echo apk; return; }
  command -v xbps-install >/dev/null 2>&1 && { echo xbps; return; }
  command -v emerge >/dev/null 2>&1 && { echo emerge; return; }
  command -v nix-env >/dev/null 2>&1 && { echo nix; return; }
  echo unknown
}

xono_install_fix() {
  local key="${1:-}" pm="${XONO_PM:-$(xono_detect_pm)}"
  case "$pm:$key" in
    pacman:audio-capture) echo "sudo pacman -S pipewire-utils" ;;
    apt:audio-capture) echo "sudo apt install pulseaudio-utils pipewire-pulse wireplumber" ;;
    dnf:audio-capture) echo "sudo dnf install pipewire-utils pulseaudio-utils wireplumber" ;;
    zypper:audio-capture) echo "sudo zypper install pipewire-pulseaudio pulseaudio-utils wireplumber" ;;
    apk:audio-capture) echo "sudo apk add pipewire pulseaudio-utils wireplumber" ;;
    xbps:audio-capture) echo "sudo xbps-install -S pipewire pulseaudio wireplumber" ;;
    emerge:audio-capture) echo "sudo emerge --ask media-video/pipewire media-sound/pulseaudio" ;;
    nix:audio-capture) echo "nix-env -iA nixos.pipewire nixos.pulseaudio nixos.wireplumber" ;;
    pacman:ydotool) echo "sudo pacman -S ydotool" ;;
    pacman:xdotool) echo "sudo pacman -S xdotool" ;;
    pacman:wtype) echo "sudo pacman -S wtype" ;;
    pacman:cmake) echo "cmake" ;;
    pacman:cxx) echo "base-devel" ;;
    apt:ydotool) echo "sudo apt install ydotool" ;;
    apt:xdotool) echo "sudo apt install xdotool" ;;
    apt:wtype) echo "sudo apt install wtype" ;;
    apt:cmake) echo "sudo apt install cmake" ;;
    apt:cxx) echo "sudo apt install build-essential" ;;
    dnf:ydotool) echo "sudo dnf install ydotool" ;;
    dnf:xdotool) echo "sudo dnf install xdotool" ;;
    dnf:wtype) echo "sudo dnf install wtype" ;;
    dnf:cmake) echo "sudo dnf install cmake" ;;
    dnf:cxx) echo "sudo dnf install gcc-c++ make" ;;
    zypper:ydotool) echo "sudo zypper install ydotool" ;;
    zypper:xdotool) echo "sudo zypper install xdotool" ;;
    zypper:wtype) echo "sudo zypper install wtype" ;;
    zypper:cmake) echo "sudo zypper install cmake" ;;
    zypper:cxx) echo "sudo zypper install gcc-c++ make" ;;
    apk:ydotool|apk:xdotool|apk:wtype|apk:cmake) echo "sudo apk add ${key}" ;;
    apk:cxx) echo "sudo apk add build-base" ;;
    xbps:ydotool|xbps:xdotool|xbps:wtype|xbps:cmake) echo "sudo xbps-install -S ${key}" ;;
    xbps:cxx) echo "sudo xbps-install -S base-devel" ;;
    emerge:ydotool) echo "sudo emerge --ask x11-misc/ydotool" ;;
    emerge:xdotool) echo "sudo emerge --ask x11-misc/xdotool" ;;
    emerge:wtype) echo "sudo emerge --ask gui-apps/wtype" ;;
    emerge:cmake) echo "sudo emerge --ask dev-build/cmake" ;;
    emerge:cxx) echo "sudo emerge --ask sys-devel/gcc sys-devel/make" ;;
    nix:ydotool) echo "nix-env -iA nixos.ydotool" ;;
    nix:xdotool) echo "nix-env -iA nixos.xdotool" ;;
    nix:wtype) echo "nix-env -iA nixos.wtype" ;;
    nix:cmake) echo "nix-env -iA nixos.cmake" ;;
    nix:cxx) echo "nix-env -iA nixos.gcc" ;;
    *) echo "Install ${key} with your distro's package manager" ;;
  esac
}
