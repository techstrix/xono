import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG, parseConfig, type XonoConfig } from '@shared/schema'
import { paths } from './paths'
import { loggerScope } from './logger'

const log = loggerScope('config')

type Listener = (config: XonoConfig) => void

/**
 * Owns the on-disk config. Writes are atomic (temp + rename) because a crash mid-write
 * would otherwise leave a truncated JSON file that the app refuses to boot on.
 */
export class ConfigStore {
  private config: XonoConfig
  private listeners = new Set<Listener>()
  private readonly file: string

  /** Tests pass an explicit path so they never write into the user's home directory. */
  constructor(file: string = paths.configFile) {
    this.file = file
    this.config = this.readFromDisk()
  }

  private readFromDisk(): XonoConfig {
    if (!existsSync(this.file)) return structuredClone(DEFAULT_CONFIG)
    try {
      const text = readFileSync(this.file, 'utf8')
      const config = parseConfig(JSON.parse(text))
      log.debug('loaded config from', this.file)
      return config
    } catch (err) {
      log.error('config unreadable, falling back to defaults', err)
      this.backupCorrupt()
      return structuredClone(DEFAULT_CONFIG)
    }
  }

  private backupCorrupt(): void {
    try {
      const backup = `${this.file}.corrupt-${Date.now()}`
      renameSync(this.file, backup)
      log.warn('moved corrupt config to', backup)
    } catch {
      /* nothing more we can do */
    }
  }

  get(): XonoConfig {
    return structuredClone(this.config)
  }

  /**
   * Shallow-merge a partial patch into the named section and persist. Unknown sections
   * are ignored so a stale renderer cannot invent new config groups.
   */
  patch<K extends keyof XonoConfig>(section: K, patcher: Partial<XonoConfig[K]> | ((prev: XonoConfig[K]) => XonoConfig[K])): XonoConfig {
    const current = structuredClone(this.config[section]) as Record<string, unknown>
    const next =
      typeof patcher === 'function'
        ? (patcher as (p: unknown) => unknown)(current)
        : { ...current, ...(patcher as Record<string, unknown>) }

    this.config = { ...this.config, [section]: next } as unknown as XonoConfig
    this.persist()
    this.emit()
    return this.get()
  }

  /**
   * Write the current config out if no file exists yet, so there is always something
   * concrete to hand-edit. Keys are not yet present at this point — they are added as
   * the user fills them in — but the shape and every default are discoverable.
   */
  ensurePersisted(): void {
    if (existsSync(this.file)) return
    log.info('writing initial config to', this.file)
    this.persist()
  }

  /** Replace the entire config (used by tests and "restore defaults"). */
  replace(config: XonoConfig): void {
    this.config = structuredClone(config)
    this.persist()
    this.emit()
  }

  private persist(): void {
    if (this.file === paths.configFile) paths.ensureDirs()
    else mkdirSync(dirname(this.file), { recursive: true })
    const target = this.file
    const tmp = join(dirname(target), `.config.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
    const text = `${JSON.stringify(this.config, null, 2)}\n`
    try {
      writeFileSync(tmp, text, { mode: 0o600 })
      renameSync(tmp, target)
      // rename preserves the temp file's mode, but be explicit in case of umask games.
      chmodSync(target, 0o600)
    } catch (err) {
      log.error('failed to persist config', err)
      try {
        if (existsSync(tmp)) renameSync(tmp, target)
      } catch {
        /* give up */
      }
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    const snapshot = this.get()
    for (const fn of this.listeners) {
      try {
        fn(snapshot)
      } catch (err) {
        log.error('config listener threw', err)
      }
    }
  }
}