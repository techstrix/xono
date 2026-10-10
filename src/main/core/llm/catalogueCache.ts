import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderId } from '@shared/schema'
import { loggerScope } from '../logger'
import { paths } from '../paths'
import type { RemoteModel } from './types'

const log = loggerScope('catalogue')

/** How long a fetched catalogue is trusted before refetching. */
export const CATALOGUE_TTL_MS = 6 * 60 * 60 * 1000

export interface CachedCatalogue {
  models: RemoteModel[]
  fetchedAt: number
}

type CacheShape = Partial<Record<ProviderId, CachedCatalogue>>

/**
 * Disk cache for provider model catalogues.
 *
 * OpenRouter's `/models` response is ~780 kB of JSON across 400+ entries, so refetching
 * it every time the settings window opens would be slow and would hammer the API. The
 * cache makes the picker usable offline and instant on reopen, while `force` still
 * exists for an explicit refresh.
 *
 * A cached list is never used to *fail* a fetch: if the request fails we fall back to
 * whatever is on disk and say so, rather than emptying the picker.
 */
export class CatalogueCache {
  private cache: CacheShape
  private inflight = new Map<ProviderId, Promise<RemoteModel[]>>()

  constructor(private readonly file: string = cataloguePath()) {
    this.cache = this.read()
  }

  private read(): CacheShape {
    if (!existsSync(this.file)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as CacheShape) : {}
    } catch (err) {
      log.warn('could not read the model catalogue cache', err)
      return {}
    }
  }

  private write(): void {
    try {
      mkdirSync(paths.configDir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(this.cache))
      renameSync(tmp, this.file)
    } catch (err) {
      log.warn('could not persist the model catalogue cache', err)
    }
  }

  get(provider: ProviderId): CachedCatalogue | null {
    const entry = this.cache[provider]
    if (!entry || !Array.isArray(entry.models)) return null
    return entry
  }

  isFresh(provider: ProviderId, now = Date.now()): boolean {
    const entry = this.get(provider)
    return Boolean(entry && now - entry.fetchedAt < CATALOGUE_TTL_MS)
  }

  set(provider: ProviderId, models: RemoteModel[]): void {
    this.cache[provider] = { models, fetchedAt: Date.now() }
    this.write()
    log.info(`cached ${models.length} models for ${provider}`)
  }

  clear(provider?: ProviderId): void {
    if (provider) delete this.cache[provider]
    else this.cache = {}
    this.write()
  }

  /**
   * Fetch through the cache, collapsing concurrent requests for the same provider so a
   * re-render cannot trigger two downloads.
   */
  async fetch(
    provider: ProviderId,
    loader: () => Promise<RemoteModel[]>,
    options: { force?: boolean; now?: number } = {}
  ): Promise<{ models: RemoteModel[]; fromCache: boolean; stale: boolean; fetchedAt?: number }> {
    const cached = this.get(provider)
    const fresh = this.isFresh(provider, options.now)

    if (!options.force && fresh && cached) {
      return { models: cached.models, fromCache: true, stale: false, fetchedAt: cached.fetchedAt }
    }

    const existing = this.inflight.get(provider)
    if (existing) {
      const models = await existing
      const entry = this.get(provider)
      return { models, fromCache: false, stale: false, fetchedAt: entry?.fetchedAt }
    }

    const request = loader()
      .then((models) => {
        this.set(provider, models)
        return models
      })
      .catch((err) => {
        // A stale list is far better than an empty picker when the network is down.
        if (cached) {
          log.warn(`${provider} model list failed, serving the cached copy:`, (err as Error).message)
          throw Object.assign(new Error((err as Error).message), { cached })
        }
        throw err
      })
      .finally(() => {
        this.inflight.delete(provider)
      })

    this.inflight.set(provider, request)

    try {
      const models = await request
      return { models, fromCache: false, stale: false, fetchedAt: Date.now() }
    } catch (err) {
      const fallback = (err as { cached?: CachedCatalogue }).cached
      if (fallback) {
        return { models: fallback.models, fromCache: true, stale: true, fetchedAt: fallback.fetchedAt }
      }
      throw err
    }
  }
}

function cataloguePath(): string {
  return join(paths.configDir, 'model-catalogue.json')
}