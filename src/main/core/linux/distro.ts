import { existsSync, readFileSync } from 'node:fs'

/**
 * Cross-distro identity and install-fix mapping.
 *
 * Everything here is plain Node with no Electron imports, so it can be used from
 * the main process, diagnostics, and unit tests alike.
 *
 * Design constraint: Arch output must stay byte-identical to the old hardcoded
 * strings. Every `installFix()` case for `pacman` returns exactly what the code
 * used to say, and that is pinned by tests.
 */

export type PackageManager =
  | 'pacman'
  | 'apt'
  | 'dnf'
  | 'zypper'
  | 'apk'
  | 'xbps'
  | 'emerge'
  | 'nix'
  | 'unknown'

/** Logical thing we need installed, independent of what any one distro calls it. */
export type LogicalPackage =
  | 'audio-capture'
  | 'ydotool'
  | 'xdotool'
  | 'wtype'
  | 'cmake'
  | 'cxx'
  | 'wireplumber'

export interface DistroInfo {
  /** Raw ID from /etc/os-release, e.g. `arch`, `ubuntu`, `fedora`. */
  id: string
  /** Display name for messages, e.g. `Arch Linux`, `Ubuntu`. */
  displayName: string
  /** Raw ID_LIKE entries, e.g. `['debian']` for Ubuntu. */
  idLike: string[]
  pm: PackageManager
}

/** Parse the KEY=VALUE (optionally quoted) format of /etc/os-release. */
export function parseOsRelease(text: string): { id: string; name: string; idLike: string[] } {
  const get = (key: string): string => {
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      if (trimmed.slice(0, eq).trim() !== key) continue
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      return value
    }
    return ''
  }
  const id = get('ID').toLowerCase()
  const name = get('NAME') || id
  const idLike = get('ID_LIKE').toLowerCase().split(/\s+/).filter(Boolean)
  return { id, name, idLike }
}

export interface DetectOptions {
  /** Override path for tests. Defaults to /etc/os-release. */
  osReleasePath?: string
  /** Override file contents for tests (skips fs read). */
  osReleaseText?: string
  /** Override PATH lookup for tests. */
  hasBinary?: (name: string) => boolean
  /** Force a distro id for tests without touching the fs. */
  distroId?: string
  /** Force ID_LIKE for tests. */
  idLike?: string[]
  /** Force display name for tests. */
  displayName?: string
}

function defaultHasBinary(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    try {
      existsSync(`${dir}/${name}`)
      // existsSync alone can false-positive on non-executable files, but for
      // package-manager probing (pacman, apt-get, …) presence is enough: we only
      // need to know which family to suggest, not to execute it.
      return true
    } catch {
      /* keep looking */
    }
  }
  // Fall back to checking well-known absolute locations.
  for (const full of [`/usr/bin/${name}`, `/bin/${name}`]) {
    if (existsSync(full)) return true
  }
  return false
}

const PM_BINARIES: { pm: PackageManager; bins: string[] }[] = [
  { pm: 'pacman', bins: ['pacman'] },
  { pm: 'apt', bins: ['apt-get', 'apt'] },
  { pm: 'dnf', bins: ['dnf'] },
  { pm: 'zypper', bins: ['zypper'] },
  { pm: 'apk', bins: ['apk'] },
  { pm: 'xbps', bins: ['xbps-install'] },
  { pm: 'emerge', bins: ['emerge'] },
  { pm: 'nix', bins: ['nix-env'] }
]

/** Probe for package-manager binaries, in a fixed priority order. */
export function detectPackageManager(hasBinary: (name: string) => boolean = defaultHasBinary): PackageManager {
  for (const { pm, bins } of PM_BINARIES) {
    if (bins.some((b) => hasBinary(b))) return pm
  }
  return 'unknown'
}

/** Map a distro id (or ID_LIKE entry) to a package manager without probing PATH. */
export function pmForDistroId(id: string): PackageManager | null {
  const v = id.toLowerCase()
  if (['arch', 'manjaro', 'endeavouros', 'cachyos', 'garuda', 'artix'].includes(v)) return 'pacman'
  if (['debian', 'ubuntu', 'linuxmint', 'pop', 'pop_os', 'elementary', 'zorin', 'kali', 'raspbian'].includes(v))
    return 'apt'
  if (['fedora', 'rhel', 'centos', 'rocky', 'almalinux', 'nobara'].includes(v)) return 'dnf'
  if (['opensuse', 'opensuse-leap', 'opensuse-tumbleweed', 'sles'].includes(v)) return 'zypper'
  if (['alpine', 'postmarketos'].includes(v)) return 'apk'
  if (['void'].includes(v)) return 'xbps'
  if (['gentoo'].includes(v)) return 'emerge'
  if (['nixos'].includes(v)) return 'nix'
  return null
}

export function detectDistro(opts: DetectOptions = {}): DistroInfo {
  let id = opts.distroId ?? ''
  let displayName = opts.displayName ?? ''
  let idLike = opts.idLike ?? []

  if (!id || !displayName || opts.osReleaseText !== undefined || !opts.distroId) {
    let text = opts.osReleaseText
    if (text === undefined) {
      const path = opts.osReleasePath ?? '/etc/os-release'
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        text = ''
      }
    }
    if (text) {
      const parsed = parseOsRelease(text)
      if (!id) id = parsed.id
      if (!displayName) displayName = parsed.name
      if (opts.idLike === undefined) idLike = parsed.idLike
    }
  }

  if (!id) id = 'unknown'
  if (!displayName) displayName = id

  const fromId = pmForDistroId(id) ?? pmForDistroId(idLike[0] ?? '') ?? pmForDistroId(idLike[1] ?? '')
  const pm = fromId ?? detectPackageManager(opts.hasBinary ?? defaultHasBinary)
  return { id, displayName, idLike, pm }
}

/** Install verb per package manager: `sudo <pm> <verb> <pkgs>`. */
function installVerb(pm: PackageManager): string {
  switch (pm) {
    case 'pacman':
      return '-S'
    case 'apt':
      return 'install'
    case 'dnf':
      return 'install'
    case 'zypper':
      return 'install'
    case 'apk':
      return 'add'
    case 'xbps':
      return '-S'
    case 'emerge':
      return '--ask'
    case 'nix':
      return '-iA'
    case 'unknown':
      return 'install'
  }
}

function sudoPrefix(pm: PackageManager): string {
  return 'sudo '
}

function pmInstall(pm: PackageManager, pkgs: string): string {
  if (pm === 'pacman') return `sudo pacman -S ${pkgs}`
  if (pm === 'xbps') return `sudo xbps-install -S ${pkgs}`
  if (pm === 'emerge') return `sudo emerge --ask ${pkgs}`
  if (pm === 'nix') return `nix-env -iA ${pkgs}`
  if (pm === 'apk') return `sudo apk add ${pkgs}`
  if (pm === 'zypper') return `sudo zypper install ${pkgs}`
  if (pm === 'dnf') return `sudo dnf install ${pkgs}`
  // apt and unknown share the apt-style spelling; unknown is only a hint.
  void installVerb
  void sudoPrefix
  return `sudo apt install ${pkgs}`
}

/**
 * Package names per distro family for each logical dependency.
 *
 * `parec` (audio capture) is the awkward one: Arch ships it in `pipewire-utils`,
 * while Debian/Ubuntu/Fedora ship the PulseAudio-compat client in
 * `pulseaudio-utils`. Listing both the compat package and the PipeWire side keeps
 * the one-liner copy-pasteable on a fresh install.
 */
const PACKAGE_NAMES: Record<LogicalPackage, Partial<Record<PackageManager, string>>> = {
  'audio-capture': {
    pacman: 'pipewire-utils',
    apt: 'pulseaudio-utils pipewire-pulse wireplumber',
    dnf: 'pipewire-utils pulseaudio-utils wireplumber',
    zypper: 'pipewire-pulseaudio pulseaudio-utils wireplumber',
    apk: 'pipewire pulseaudio-utils wireplumber',
    xbps: 'pipewire pulseaudio wireplumber',
    emerge: 'media-video/pipewire media-sound/pulseaudio',
    nix: 'nixos.pipewire nixos.pulseaudio nixos.wireplumber'
  },
  ydotool: {
    pacman: 'ydotool',
    apt: 'ydotool',
    dnf: 'ydotool',
    zypper: 'ydotool',
    apk: 'ydotool',
    xbps: 'ydotool',
    emerge: 'x11-misc/ydotool',
    nix: 'nixos.ydotool'
  },
  xdotool: {
    pacman: 'xdotool',
    apt: 'xdotool',
    dnf: 'xdotool',
    zypper: 'xdotool',
    apk: 'xdotool',
    xbps: 'xdotool',
    emerge: 'x11-misc/xdotool',
    nix: 'nixos.xdotool'
  },
  wtype: {
    pacman: 'wtype',
    apt: 'wtype',
    dnf: 'wtype',
    zypper: 'wtype',
    apk: 'wtype',
    xbps: 'wtype',
    emerge: 'gui-apps/wtype',
    nix: 'nixos.wtype'
  },
  cmake: {
    pacman: 'cmake',
    apt: 'cmake',
    dnf: 'cmake',
    zypper: 'cmake',
    apk: 'cmake',
    xbps: 'cmake',
    emerge: 'dev-build/cmake',
    nix: 'nixos.cmake'
  },
  cxx: {
    pacman: 'base-devel',
    apt: 'build-essential',
    dnf: 'gcc-c++ make',
    zypper: 'gcc-c++ make',
    apk: 'build-base',
    xbps: 'base-devel',
    emerge: 'sys-devel/gcc sys-devel/make',
    nix: 'nixos.gcc'
  },
  wireplumber: {
    pacman: 'wireplumber',
    apt: 'wireplumber',
    dnf: 'wireplumber',
    zypper: 'wireplumber',
    apk: 'wireplumber',
    xbps: 'wireplumber',
    emerge: 'media-video/wireplumber',
    nix: 'nixos.wireplumber'
  }
}

/**
 * The exact shell line to suggest for a missing dependency.
 *
 * Arch strings are pinned: `installFix('audio-capture', 'pacman')` must stay
 * `sudo pacman -S pipewire-utils` — see tests/unit/distro.test.ts.
 */
export function installFix(pkg: LogicalPackage, pm: PackageManager): string {
  const names = PACKAGE_NAMES[pkg]?.[pm]
  if (names) return pmInstall(pm, names)
  // Unknown PM: fall back to a generic hint naming the upstream package.
  const generic = PACKAGE_NAMES[pkg]?.['pacman'] ?? pkg
  return `Install ${generic} with your distro's package manager`
}

/** Convenience: detect once and format the fix for the current machine. */
let cached: DistroInfo | null = null

export function currentDistro(): DistroInfo {
  if (!cached) cached = detectDistro()
  return cached
}

/** Test hook: clear the cached detection. */
export function resetDistroCache(): void {
  cached = null
}

/** Fix line for the current machine, e.g. `sudo apt install ydotool`. */
export function installFixForCurrent(pkg: LogicalPackage): string {
  return installFix(pkg, currentDistro().pm)
}
