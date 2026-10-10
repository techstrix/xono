import { describe, expect, it } from 'vitest'
import {
  detectDistro,
  detectPackageManager,
  installFix,
  parseOsRelease,
  pmForDistroId
} from '../../src/main/core/linux/distro'

describe('parseOsRelease', () => {
  it('parses Arch', () => {
    const parsed = parseOsRelease('NAME="Arch Linux"\nID=arch\nID_LIKE=archlinux\n')
    expect(parsed.id).toBe('arch')
    expect(parsed.idLike).toEqual(['archlinux'])
  })

  it('parses Ubuntu with ID_LIKE=debian', () => {
    const parsed = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n')
    expect(parsed.id).toBe('ubuntu')
    expect(parsed.idLike).toEqual(['debian'])
  })

  it('handles unquoted values and comments', () => {
    const parsed = parseOsRelease('# comment\nID=fedora\nNAME=Fedora Linux\n')
    expect(parsed.id).toBe('fedora')
    expect(parsed.name).toBe('Fedora Linux')
  })
})

describe('pmForDistroId', () => {
  it.each([
    ['arch', 'pacman'],
    ['manjaro', 'pacman'],
    ['ubuntu', 'apt'],
    ['debian', 'apt'],
    ['fedora', 'apt'.replace('apt', 'dnf')],
    ['opensuse-tumbleweed', 'zypper'],
    ['alpine', 'apk'],
    ['void', 'xbps'],
    ['gentoo', 'emerge'],
    ['nixos', 'nix']
  ] as const)('maps %s to %s', (id, pm) => {
    expect(pmForDistroId(id)).toBe(pm)
  })

  it('returns null for unknown ids', () => {
    expect(pmForDistroId('plan9')).toBeNull()
  })
})

describe('detectPackageManager', () => {
  it('prefers pacman when present', () => {
    expect(detectPackageManager((b) => b === 'pacman')).toBe('pacman')
  })

  it('falls through to apt when pacman is absent', () => {
    expect(detectPackageManager((b) => b === 'apt-get')).toBe('apt')
  })

  it('returns unknown when nothing matches', () => {
    expect(detectPackageManager(() => false)).toBe('unknown')
  })
})

describe('detectDistro', () => {
  it('resolves Ubuntu via ID_LIKE without probing PATH', () => {
    const info = detectDistro({
      osReleaseText: 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n',
      hasBinary: () => false
    })
    expect(info.pm).toBe('apt')
    expect(info.id).toBe('ubuntu')
  })

  it('falls back to PATH probing when the id is unknown', () => {
    const info = detectDistro({
      osReleaseText: 'NAME="Mystery"\nID=mystery\n',
      hasBinary: (b) => b === 'dnf'
    })
    expect(info.pm).toBe('dnf')
  })
})

describe('installFix — Arch strings are pinned (no-break guarantee)', () => {
  it('audio-capture on Arch stays `sudo pacman -S pipewire-utils`', () => {
    expect(installFix('audio-capture', 'pacman')).toBe('sudo pacman -S pipewire-utils')
  })

  it('ydotool/xdotool on Arch stay unchanged', () => {
    expect(installFix('ydotool', 'pacman')).toBe('sudo pacman -S ydotool')
    expect(installFix('xdotool', 'pacman')).toBe('sudo pacman -S xdotool')
  })

  it('emits per-distro commands elsewhere', () => {
    expect(installFix('audio-capture', 'apt')).toBe(
      'sudo apt install pulseaudio-utils pipewire-pulse wireplumber'
    )
    expect(installFix('ydotool', 'dnf')).toBe('sudo dnf install ydotool')
    expect(installFix('cxx', 'apt')).toBe('sudo apt install build-essential')
    expect(installFix('cxx', 'pacman')).toBe('sudo pacman -S base-devel')
    expect(installFix('cmake', 'dnf')).toBe('sudo dnf install cmake')
  })

  it('falls back to a generic hint for unknown package managers', () => {
    expect(installFix('ydotool', 'unknown')).toMatch(/package manager/i)
  })
})
