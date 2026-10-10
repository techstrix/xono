import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve a user data directory without importing electron where possible, so the
 * core modules stay runnable under plain Node (tests, and a future daemon host).
 */
function userDataRoot(): string {
  try {
    return app.getPath('userData')
  } catch {
    const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
    return join(xdg, 'xono')
  }
}

function dataRoot(): string {
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
  return join(xdg, 'xono')
}

export const paths = {
  get configDir(): string {
    return userDataRoot()
  },
  get configFile(): string {
    return join(userDataRoot(), 'config.json')
  },
  get dataDir(): string {
    return dataRoot()
  },
  get modelDir(): string {
    return join(dataRoot(), 'models')
  },
  get historyFile(): string {
    return join(userDataRoot(), 'history.json')
  },
  get logDir(): string {
    return join(userDataRoot(), 'logs')
  },
  get whisperBinDir(): string {
    // Packaged builds ship whisper-cli under resources/whisper.
    return join(process.resourcesPath ?? join(dataRoot(), '..'), 'whisper')
  },
  ensureDirs(): void {
    for (const dir of [this.configDir, this.dataDir, this.modelDir, this.logDir]) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }
}

/**
 * whisper.cpp writes its WAV into the OS temp dir. Those files can be orphaned if the
 * app is killed mid-utterance, so sweep anything older than `maxAgeMs` on boot.
 */
export function sweepStaleTemp(prefix: string, maxAgeMs = 60 * 60 * 1000): number {
  const dir = join(tmpBase(), prefix)
  if (!existsSync(dir)) return 0
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    try {
      if (statSync(full).mtimeMs < cutoff) {
        unlinkSync(full)
        removed++
      }
    } catch {
      /* best effort */
    }
  }
  return removed
}

function tmpBase(): string {
  return process.env.TMPDIR ?? '/tmp'
}

export function ensureModelDir(): string {
  if (!existsSync(paths.modelDir)) mkdirSync(paths.modelDir, { recursive: true })
  return paths.modelDir
}