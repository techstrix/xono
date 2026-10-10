import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DictationMode } from '@shared/schema'
import type { HistoryEntry } from '@shared/types'
import { paths } from './paths'
import { loggerScope } from './logger'

const log = loggerScope('history')

/**
 * A rolling, capped log of dictations so a bad injection can be recovered.
 * Bounded in memory and on disk; never treated as durable storage.
 */
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private limit: number
  private readonly file: string

  /** `file` exists so tests can isolate history instead of reading the user's. */
  constructor(limit: number, file: string = paths.historyFile) {
    this.limit = limit
    this.file = file
    if (limit <= 0) return
    if (file === paths.historyFile) paths.ensureDirs()
    else mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(this.file)) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(isEntry).slice(-limit)
      }
    } catch (err) {
      log.warn('could not read history', err)
    }
  }

  setLimit(limit: number): void {
    this.limit = limit
    this.entries = this.entries.slice(-Math.max(0, limit))
    this.persist()
  }

  add(entry: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry {
    const full: HistoryEntry = { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now() }
    this.entries.push(full)
    if (this.limit <= 0) {
      this.entries = []
    } else {
      this.entries = this.entries.slice(-this.limit)
    }
    this.persist()
    return full
  }

  list(): HistoryEntry[] {
    return [...this.entries].reverse()
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((e) => e.id === id)
  }

  markInjected(id: string): void {
    const entry = this.entries.find((e) => e.id === id)
    if (entry) {
      entry.injected = true
      this.persist()
    }
  }

  /**
   * Update an entry that was recorded before the outcome was known.
   *
   * An utterance is added to history as soon as there is a transcript, then amended as
   * cleanup and injection resolve. That ordering is what guarantees the words someone
   * actually spoke are never lost — a failed paste still leaves the raw text behind.
   */
  update(id: string, patch: Partial<Omit<HistoryEntry, 'id' | 'at'>>): HistoryEntry | null {
    const entry = this.entries.find((e) => e.id === id)
    if (!entry) return null
    Object.assign(entry, patch)
    this.persist()
    return entry
  }

  clear(): void {
    this.entries = []
    this.persist()
  }

  private persist(): void {
    if (this.limit <= 0) return
    mkdirSync(dirname(this.file), { recursive: true })
    const target = this.file
    const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(this.entries, null, 2), { mode: 0o600 })
      renameSync(tmp, target)
    } catch (err) {
      log.warn('could not persist history', err)
    }
  }

  static emptyEntryMode(): DictationMode {
    return 'cleaned'
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as Partial<HistoryEntry>
  return typeof e.id === 'string' && typeof e.raw === 'string' && typeof e.cleaned === 'string'
}