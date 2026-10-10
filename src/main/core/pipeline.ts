import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DictationMode, InjectionMethod, XonoConfig } from '@shared/schema'
import type { CleanupResult, InjectResult, PipelineState, Progress, WaveFrame } from '@shared/types'
import type { ConfigStore } from './config'
import { encodeWav } from './wav'
import { slicePcm, UtteranceTracker, type VadEngine } from './vad'
import type { AudioRecorder } from './recorder'
import { isSilenceTranscript, type ModelManager, type SttProvider } from './stt'
import type { CleanupRequest, ProviderRegistry } from './llm'
import type { HistoryStore } from './history'
import { resolveInjector as defaultResolveInjector, type Injector } from './inject'
import { loggerScope } from './logger'

const log = loggerScope('pipeline')
const WAV_PREFIX = 'xono-utt-'

export type ReviewDecision = 'accept' | 'raw' | 'reject'

/**
 * True when the model's output is the previous utterance rather than a cleanup of what
 * was just said.
 *
 * Comparing against the raw transcript too matters: when someone genuinely dictates the
 * same words twice, the output legitimately matches the context and must be allowed
 * through. Only an echo that contradicts the current audio is rejected.
 */
export function isEchoOfPrevious(output: string, previousContext?: string, raw?: string): boolean {
  if (!previousContext || !output.trim()) return false
  const produced = canonical(output)
  if (produced !== canonical(previousContext)) return false
  return raw === undefined || produced !== canonical(raw)
}

/** Case- and punctuation-insensitive form, so "Deploy it!" and "deploy it" match. */
function canonical(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

export interface CompletedUtterance {
  raw: string
  cleaned: string
  mode: DictationMode
  fallback: boolean
  durationMs: number
  elapsedMs: number
}

interface Utterance extends Omit<CompletedUtterance, 'elapsedMs'> {
  startedAt: number
  elapsedMs?: number
}

export interface ResolvedInjector {
  injector: Injector
  degraded: boolean
  reason?: string
}

export interface PipelineDeps {
  config: ConfigStore
  recorder: AudioRecorder
  stt: SttProvider
  models: ModelManager
  providers: ProviderRegistry
  history: HistoryStore
  createVadEngine: (cfg: XonoConfig) => Promise<VadEngine>
  /** Called when the config's history limit changes. */
  /**
   * Injection strategy seam. Defaults to the real clipboard/virtual-keyboard
   * resolver; tests substitute a recorder so they never touch the compositor.
   */
  resolveInjector?: (method: InjectionMethod) => Promise<ResolvedInjector>
}

/**
 * Orchestrates one dictation: capture → VAD trim → STT → LLM cleanup → injection.
 *
 * Emits (rather than returns) progress because the UI needs to react at every step,
 * and one deliberate policy runs through the whole thing: the user's words are never
 * dropped. If cleanup or injection degrades, we say so and still land the text.
 */
export class Pipeline extends EventEmitter {
  private state: PipelineState = 'idle'
  private tracker: UtteranceTracker | null = null
  private vadEngine: VadEngine | null = null
  private vadEngineId: string | null = null
  private abort: AbortController | null = null
  private tickTimer: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private pendingReview: { text: string; raw: string; resolve: (d: ReviewDecision) => void } | null = null
  private lastCommitted = ''
  private startPromise: Promise<void> | null = null

  constructor(private readonly deps: PipelineDeps) {
    super()
    this.setMaxListeners(32)
  }

  getState(): PipelineState {
    return this.state
  }

  private cfg(): XonoConfig {
    return this.deps.config.get()
  }

  private setState(state: PipelineState, label?: string): void {
    this.state = state
    this.emit('state', state, label)
  }

  // ---------------------------------------------------------------- lifecycle

  /** Begin an utterance. Re-entrant: a second call while starting awaits the first. */
  async start(): Promise<void> {
    if (this.state === 'listening') return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.runStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private async runStart(): Promise<void> {
    const cfg = this.cfg()
    this.clearSettleTimer()
    this.setState('starting', 'Preparing…')
    this.deps.history.setLimit(cfg.general.historyLimit)

    // Ensure the model is on disk before the user starts talking, otherwise the first
    // dictation of the session stalls on a download.
    if (!this.deps.models.isReady(cfg.stt.model)) {
      if (!cfg.stt.autoDownload) {
        this.fail(`The ${cfg.stt.model} model is not downloaded. Open Settings → Models to fetch it.`)
        return
      }
      const unsubscribe = this.deps.models.onDownload(cfg.stt.model, (p) =>
        this.emit('progress', { label: p.label, value: p.value })
      )
      try {
        this.emit('progress', { label: `Downloading ${cfg.stt.model} model…`, value: 0 })
        await this.deps.models.download(cfg.stt.model)
      } catch (err) {
        this.fail(`Model download failed: ${(err as Error).message}`)
        return
      } finally {
        unsubscribe()
      }
    }

    this.abort = new AbortController()

    try {
      if (!this.vadEngine || this.vadEngineId !== cfg.vad.engine) {
        await this.vadEngine?.dispose()
        this.vadEngine = await this.deps.createVadEngine(cfg)
        this.vadEngineId = cfg.vad.engine
      }
      this.tracker = new UtteranceTracker(cfg.vad, this.vadEngine)
    } catch (err) {
      this.fail(`Voice detection failed to start: ${(err as Error).message}`)
      return
    }

    try {
      await this.deps.recorder.start({
        onChunk: (pcm) => this.tracker?.push(pcm),
        onFrame: (frame) => this.emit('wave', frame),
        onError: (err) => this.fail(err.message)
      })
    } catch (err) {
      this.fail((err as Error).message)
      return
    }

    this.setState('listening', 'Listening…')
    this.tick()
  }

  /** Poll for end-of-speech and for the hard utterance ceiling. */
  private tick(): void {
    this.stopTicking()
    this.tickTimer = setInterval(() => {
      if (this.state !== 'listening' || !this.tracker) return
      const status = this.tracker.status()
      const cfg = this.cfg().vad

      if (status.durationMs > cfg.maxUtteranceMs) {
        log.warn('utterance reached max length, stopping')
        void this.stop()
        return
      }
      if (status.endOfSpeech) void this.stop()
    }, 100)
  }

  private stopTicking(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  // ------------------------------------------------------------------- capture

  /** Finish the current utterance and run it through STT → LLM → inject. */
  async stop(): Promise<CompletedUtterance | null> {
    if (this.state !== 'listening' && this.state !== 'starting') return null
    this.stopTicking()
    this.setState('transcribing', 'Finishing recording…')

    const pcm = await this.deps.recorder.stop()
    const tracker = this.tracker
    this.tracker = null

    if (pcm.length === 0) {
      this.fail('Nothing was captured. Check that a microphone is connected.')
      return null
    }

    // Chunks that arrived while stop() was in flight were never seen by the tracker,
    // so replay the whole buffer once now that it is final, then wait for every
    // queued analysis frame to finish before reading the trim range.
    if (tracker) {
      tracker.reset()
      await tracker.push(pcm)
      await tracker.flush()
    }

    const cfg = this.cfg()
    const range = tracker?.trimRange() ?? { start: 0, end: pcm.length }
    const trimmed = slicePcm(pcm, range.start, range.end)

    if (trimmed.length === 0) {
      this.fail('Nothing but silence was captured.')
      return null
    }

    const workDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', WAV_PREFIX))
    const wavPath = join(workDir, 'utterance.wav')
    const startedAt = Date.now()

    try {
      writeFileSync(wavPath, encodeWav(trimmed))

      const transcript = await this.deps.stt.transcribe({
        wavPath,
        config: cfg.stt,
        vocabulary: cfg.general.vocabulary,
        signal: this.abort?.signal,
        onProgress: (label) => this.emit('progress', { label })
      })

      // normalise() strips whisper's silence markers, so an empty result here means
      // the clip genuinely contained no speech rather than a literal "[BLANK_AUDIO]".
      if (isSilenceTranscript(transcript.text)) {
        this.fail('Whisper heard no speech. Try again, or check your microphone input.')
        return null
      }

      const cleanup = await this.cleanUp(transcript.text)
      let finished: Utterance = {
        raw: transcript.text,
        cleaned: cleanup.text,
        mode: cfg.llm.mode,
        fallback: cleanup.fallback,
        durationMs: (trimmed.length / 16000) * 1000,
        startedAt
      }

      if (cfg.ui.reviewBeforeInject) {
        const decision = await this.askForReview(finished)
        if (decision === 'reject') {
          this.cancelled()
          return null
        }
        if (decision === 'raw') finished = { ...finished, cleaned: finished.raw }
      }

      const completed: CompletedUtterance = { ...finished, elapsedMs: Date.now() - startedAt }
      await this.inject(completed)
      return completed
    } catch (err) {
      if (this.abort?.signal.aborted) {
        this.cancelled()
        return null
      }
      this.fail((err as Error).message)
      return null
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  // ------------------------------------------------------------------ cleanup

  /**
   * Run the LLM. On failure, either fail-open to the raw transcript or surface the
   * error, depending on config — but never silently lose the utterance.
   */
  private async cleanUp(raw: string): Promise<CleanupResult> {
    const cfg = this.cfg()
    const provider = this.deps.providers[cfg.llm.provider]
    const providerCfg = cfg.llm.providers[cfg.llm.provider]

    const passthrough = (reason: string): CleanupResult => {
      this.emit('degraded', reason)
      return { text: raw, fallback: true, removedFillers: 0, latencyMs: 0, providerId: 'none', model: '' }
    }

    const validation = provider.validateConfig(providerCfg)
    if (!validation.ok) {
      if (!cfg.llm.failOpenToRaw) {
        this.fail(`Text cleanup is not configured: ${validation.error}`)
        throw new Error(validation.error ?? 'provider not configured')
      }
      return passthrough(`${validation.error} — injected the raw transcript instead.`)
    }

    this.setState('cleaning', `Cleaning with ${provider.label}…`)
    this.emit('progress', { label: `Cleaning with ${provider.label}…` })

    // Built up front so the echo check below can compare against what was actually sent.
    const req: CleanupRequest = {
      raw,
      mode: cfg.llm.mode,
      vocabulary: cfg.general.vocabulary,
      punctuation: cfg.dictation.autoPunctuation,
      capitalize: cfg.dictation.autoCapitalize,
      previousContext: cfg.llm.useConversationContext ? this.lastCommitted || undefined : undefined
    }

    try {
      const result = await provider.cleanup(
        req,
        providerCfg,
        cfg.llm.timeoutMs,
        this.abort?.signal
      )
      if (!result.text.trim()) return passthrough('The cleanup model returned nothing — used the raw transcript.')

      // The previous utterance is sent as context. When the current transcript is thin —
      // a stray "uh", a clipped recording — the model has little to work with and can
      // hand the context straight back. That text then gets pasted in place of what was
      // just said, which is far worse than a slightly untidy transcript, so it is
      // rejected here.
      if (isEchoOfPrevious(result.text, req.previousContext, req.raw)) {
        log.warn('cleanup echoed the previous utterance; falling back to the raw transcript')
        return passthrough(
          'The model repeated your previous dictation instead of cleaning this one — pasted the raw transcript instead.'
        )
      }

      return result
    } catch (err) {
      if (this.abort?.signal.aborted) throw err
      const message = (err as Error).message
      log.error('cleanup failed', message)
      if (!cfg.llm.failOpenToRaw) {
        this.fail(`Text cleanup failed: ${message}`)
        throw new Error(message)
      }
      return passthrough(`Cleanup unavailable (${message}) — injected the raw transcript instead.`)
    }
  }

  // ------------------------------------------------------------------- review

  private askForReview(utterance: Utterance): Promise<ReviewDecision> {
    this.setState('reviewing', 'Review the text')
    return new Promise((resolvePromise) => {
      this.pendingReview = {
        text: utterance.cleaned,
        raw: utterance.raw,
        resolve: resolvePromise
      }
      this.emit('review', { text: utterance.cleaned, raw: utterance.raw })
    })
  }

  resolveReview(decision: ReviewDecision): void {
    const pending = this.pendingReview
    this.pendingReview = null
    pending?.resolve(decision)
  }

  // ---------------------------------------------------------------- injection

  private async inject(utterance: CompletedUtterance): Promise<void> {
    const cfg = this.cfg()
    this.setState('injecting', 'Pasting…')

    const resolve = this.deps.resolveInjector ?? defaultResolveInjector
    const { injector, degraded, reason } = await resolve(cfg.inject.method)
    if (degraded) {
      this.emit('degraded', `${reason} Text was placed on the clipboard — press Ctrl+V to paste.`)
    }

    const payload = cfg.inject.trailingNewline && !utterance.cleaned.endsWith('\n')
      ? `${utterance.cleaned}\n`
      : utterance.cleaned

    // Record the utterance *before* pasting. If the paste throws, fails, or the app dies
    // mid-flight, the words the user actually spoke are already in history. Adding it
    // afterwards meant a failed paste lost the transcript entirely.
    const entry = this.deps.history.add({
      raw: utterance.raw,
      cleaned: utterance.cleaned,
      mode: utterance.mode,
      providerId: cfg.llm.provider,
      injected: false
    })

    let result: InjectResult
    try {
      result = await injector.inject(payload, cfg.inject)
    } catch (err) {
      // A throw from the injector must not take the transcript down with it.
      result = {
        ok: false,
        method: cfg.inject.method,
        error: (err as Error).message,
        clipboardRestored: false
      }
    }

    this.deps.history.update(entry.id, { injected: result.ok })
    this.lastCommitted = utterance.cleaned

    if (!result.ok) {
      this.fail(
        `Could not paste the text: ${result.error ?? 'unknown error'}. It is saved in History.`
      )
      return
    }

    this.emit('complete', utterance)
    this.setState('done')
    this.settleLater(() => this.setState('idle'), cfg.ui.autoHideMs)
  }

  /** Push arbitrary text through injection only (history restore, manual retry). */
  async injectText(text: string): Promise<boolean> {
    if (!text.trim()) return false
    const cfg = this.cfg()
    const resolve = this.deps.resolveInjector ?? defaultResolveInjector
    const { injector } = await resolve(cfg.inject.method)
    const result = await injector.inject(text, cfg.inject)
    if (result.ok) {
      this.deps.history.add({
        raw: text,
        cleaned: text,
        mode: cfg.llm.mode,
        providerId: cfg.llm.provider,
        injected: true
      })
    }
    return result.ok
  }

  // ---------------------------------------------------------------- terminal states

  cancel(): void {
    if (this.state === 'idle' || this.state === 'done') return
    log.info('cancelled by user')
    this.abort?.abort()
    this.stopTicking()
    this.deps.recorder.cancel()
    this.tracker = null
    this.pendingReview?.resolve('reject')
    this.pendingReview = null
    this.cancelled()
  }

  private cancelled(): void {
    this.clearSettleTimer()
    this.setState('cancelled')
    this.emit('cancelled')
    this.settleLater(() => this.setState('idle'), 150)
  }

  private fail(message: string): void {
    log.error(message)
    this.stopTicking()
    this.deps.recorder.cancel()
    this.tracker = null
    this.clearSettleTimer()
    this.setState('error', message)
    this.emit('failed', message)
    this.settleLater(() => this.setState('idle'), this.cfg().ui.errorAutoHideMs)
  }

  private clearSettleTimer(): void {
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }

  private settleLater(fn: () => void, ms: number): void {
    this.clearSettleTimer()
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      fn()
    }, ms)
  }

  async dispose(): Promise<void> {
    this.stopTicking()
    this.clearSettleTimer()
    this.abort?.abort()
    this.deps.recorder.cancel()
    await this.vadEngine?.dispose()
    this.vadEngine = null
  }
}