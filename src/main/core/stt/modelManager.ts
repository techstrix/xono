import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline as streamPipeline } from 'node:stream/promises'
import { MODEL_CATALOGUE, modelUrl, type WhisperModelId } from '@shared/schema'
import type { ModelStatus, Progress } from '@shared/types'
import { ensureModelDir, paths } from '../paths'
import { loggerScope } from '../logger'

const log = loggerScope('models')

export interface ModelDownloadProgress extends Progress {
  receivedBytes: number
  totalBytes: number
}

type DownloadListener = (progress: ModelDownloadProgress) => void

/**
 * Owns the on-disk GGML models. Downloads are streamed straight to a temp file and
 * renamed on success so an interrupted download never leaves a truncated model that
 * whisper.cpp would happily try (and fail) to load.
 */
export class ModelManager {
  private downloads = new Map<WhisperModelId, { abort: AbortController; received: number }>()
  private listeners = new Map<WhisperModelId, Set<DownloadListener>>()

  pathFor(id: WhisperModelId): string {
    return `${paths.modelDir}/${MODEL_CATALOGUE[id].file}`
  }

  status(id: WhisperModelId): ModelStatus {
    const path = this.pathFor(id)
    const present = existsSync(path)
    const dl = this.downloads.get(id)
    let actualBytes: number | undefined
    if (present) {
      try {
        actualBytes = statSync(path).size
      } catch {
        /* ignore */
      }
    }
    return {
      id,
      bytes: MODEL_CATALOGUE[id].bytes,
      path,
      present,
      actualBytes,
      downloading: Boolean(dl),
      progress: dl && MODEL_CATALOGUE[id].bytes ? dl.received / MODEL_CATALOGUE[id].bytes : undefined
    }
  }

  list(): ModelStatus[] {
    return (Object.keys(MODEL_CATALOGUE) as WhisperModelId[]).map((id) => this.status(id))
  }

  isReady(id: WhisperModelId): boolean {
    const status = this.status(id)
    if (!status.present || !status.actualBytes) return false
    // Guard against a half-written file: require at least 90% of the published size.
    return status.actualBytes > MODEL_CATALOGUE[id].bytes * 0.9
  }

  onDownload(id: WhisperModelId, fn: DownloadListener): () => void {
    const set = this.listeners.get(id) ?? new Set()
    set.add(fn)
    this.listeners.set(id, set)
    return () => set.delete(fn)
  }

  private emit(id: WhisperModelId, progress: ModelDownloadProgress): void {
    for (const fn of this.listeners.get(id) ?? []) {
      try {
        fn(progress)
      } catch (err) {
        log.error('download listener threw', err)
      }
    }
  }

  async download(id: WhisperModelId): Promise<string> {
    if (this.downloads.has(id)) throw new Error(`${id} is already downloading`)
    if (this.isReady(id)) return this.pathFor(id)

    ensureModelDir()
    const target = this.pathFor(id)
    const tmp = `${target}.download`
    const abort = new AbortController()
    this.downloads.set(id, { abort, received: 0 })

    const url = modelUrl(id)
    log.info(`downloading ${id} from ${url}`)

    try {
      const res = await fetch(url, {
        signal: abort.signal,
        redirect: 'follow',
        headers: { 'user-agent': 'xono/0.1' }
      })

      if (!res.ok) {
        throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`)
      }

      const declared = Number(res.headers.get('content-length') ?? 0)
      const expected = declared || MODEL_CATALOGUE[id].bytes

      let received = 0
      const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      source.on('data', (chunk: Buffer) => {
        received += chunk.length
        const entry = this.downloads.get(id)
        if (entry) entry.received = received
        this.emit(id, {
          label: `Downloading ${MODEL_CATALOGUE[id].label}`,
          value: expected ? Math.min(1, received / expected) : undefined,
          receivedBytes: received,
          totalBytes: expected
        })
      })

      await streamPipeline(source, createWriteStream(tmp))

      const size = statSync(tmp).size
      if (expected && size < expected * 0.9) {
        throw new Error(`download incomplete: got ${size} bytes, expected about ${expected}`)
      }

      renameSync(tmp, target)
      log.info(`${id} ready at ${target} (${size} bytes)`)
      return target
    } catch (err) {
      rmSync(tmp, { force: true })
      throw err
    } finally {
      this.downloads.delete(id)
    }
  }

  delete(id: WhisperModelId): void {
    if (this.downloads.has(id)) {
      this.downloads.get(id)?.abort.abort()
      this.downloads.delete(id)
    }
    rmSync(this.pathFor(id), { force: true })
    rmSync(`${this.pathFor(id)}.download`, { force: true })
    log.info(`deleted ${id}`)
  }

  cancel(id: WhisperModelId): void {
    this.downloads.get(id)?.abort.abort()
    this.downloads.delete(id)
  }
}