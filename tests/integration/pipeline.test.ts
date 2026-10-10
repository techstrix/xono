import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pipeline, type PipelineDeps } from '../../src/main/core/pipeline'
import { ConfigStore } from '../../src/main/core/config'
import { HistoryStore } from '../../src/main/core/history'
import type { AudioRecorder } from '../../src/main/core/recorder'
import type { ModelManager, SttProvider } from '../../src/main/core/stt'
import type { ProviderRegistry } from '../../src/main/core/llm'
import { EnergyEngine } from '../../src/main/core/vad'
import type { Injector } from '../../src/main/core/inject'
import { DEFAULT_CONFIG, type XonoConfig } from '../../src/shared/schema'
import { SAMPLE_RATE, type PipelineState, type TranscriptResult, type WaveFrame } from '../../src/shared/types'

/**
 * The pipeline is the one component where a mistake costs the user their words, so it
 * is exercised with fake capture / STT / LLM / injection seams.
 *
 * What is deliberately *not* faked: config parsing and persistence, VAD framing and
 * trimming, WAV encoding, the state machine, history recording, and the fail-open
 * policy that keeps a dictation from being lost when a provider is down.
 */

const RAW = 'um so deploy the thing on friday you know'
const CLEANED = 'Deploy the thing on Friday.'

function speechPcm(ms: number): Int16Array {
  const out = new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE))
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin(i * 0.04) * 9000)
  return out
}

interface Harness {
  pipeline: Pipeline
  injections: string[]
  history: HistoryStore
  states: PipelineState[]
  failures: string[]
  degraded: string[]
  setConfig: (patch: Partial<XonoConfig>) => void
  setStt: (impl: Partial<SttProvider>) => void
  setCleanup: (impl: () => Promise<{ text: string; fallback?: boolean }>) => void
}

let tempDirs: string[] = []

function makeHarness(overrides: Partial<XonoConfig> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'xono-test-'))
  tempDirs.push(dir)

  let config: XonoConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
    ui: { ...DEFAULT_CONFIG.ui, ...overrides.ui },
    vad: { ...DEFAULT_CONFIG.vad, ...overrides.vad }
  }

  // An explicit path keeps the test suite out of the real ~/.config/xono.
  const store = new ConfigStore(join(dir, 'config.json'))
  store.replace(config)

  const injections: string[] = []
  const states: PipelineState[] = []
  const failures: string[] = []
  const degraded: string[] = []

  const recorder = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => speechPcm(600)),
    cancel: vi.fn()
  } as unknown as AudioRecorder

  const stt: SttProvider = {
    id: 'fake-stt',
    label: 'fake',
    isReady: () => true,
    ensureReady: async () => undefined,
    dispose: async () => undefined,
    transcribe: async (): Promise<TranscriptResult> => ({
      text: RAW,
      providerId: 'fake-stt',
      model: 'fake',
      latencyMs: 1
    })
  }

  const models = {
    isReady: () => true,
    download: async () => join(dir, 'model.bin'),
    onDownload: () => () => undefined,
    pathFor: () => join(dir, 'model.bin'),
    list: () => []
  } as unknown as ModelManager

  let cleanup: () => Promise<{ text: string; fallback?: boolean }> = async () => ({ text: CLEANED })

  const makeProvider = (id: string) => ({
    id,
    label: `Fake ${id}`,
    requiresApiKey: true,
    defaultModel: 'fake',
    defaultBaseUrl: '',
    validateConfig: () => ({ ok: true }),
    healthCheck: async () => ({ ok: true, detail: '' }),
    cleanup: async () => {
      const result = await cleanup()
      return {
        text: result.text,
        fallback: result.fallback ?? false,
        removedFillers: 2,
        latencyMs: 1,
        providerId: 'mistral',
        model: 'fake'
      }
    }
  })

  const providers = {
    mistral: makeProvider('mistral'),
    groq: makeProvider('groq'),
    ollama: makeProvider('ollama'),
    anthropic: makeProvider('anthropic')
  } as unknown as ProviderRegistry

  const injector: Injector = {
    id: 'fake',
    method: 'clipboard-only',
    preflight: async () => [],
    inject: async (text) => {
      injections.push(text)
      return { ok: true, method: 'clipboard-only', clipboardRestored: false }
    }
  }

  const history = new HistoryStore(10, join(dir, 'history.json'))
  const deps: PipelineDeps = {
    config: store,
    recorder,
    stt,
    models,
    providers,
    history,
    createVadEngine: async (cfg) => new EnergyEngine(cfg.vad),
    resolveInjector: async () => ({ injector, degraded: false })
  }

  const pipeline = new Pipeline(deps)
  pipeline.on('state', (s: PipelineState) => states.push(s))
  // The reserved EventEmitter 'error' name would throw when unlistened, so the
  // pipeline signals failures on 'failed'.
  pipeline.on('failed', (m: string) => failures.push(m))
  pipeline.on('degraded', (m: string) => degraded.push(m))

  return {
    pipeline,
    injections,
    history,
    states,
    failures,
    degraded,
    setConfig: (patch) => {
      config = { ...config, ...patch }
      store.replace(config)
    },
    setStt: (impl) => Object.assign(stt, impl),
    setCleanup: (impl) => {
      cleanup = impl
    }
  }
}

describe('Pipeline', () => {
  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
    tempDirs = []
  })

  it('walks idle → listening → transcribing → cleaning → injecting → done', async () => {
    const h = makeHarness()
    await h.pipeline.start()
    expect(h.pipeline.getState()).toBe('listening')

    await h.pipeline.stop()

    expect(h.injections).toEqual([CLEANED])
    expect(h.states).toEqual(
      expect.arrayContaining(['starting', 'listening', 'transcribing', 'cleaning', 'injecting', 'done'])
    )
  })

  it('strips fillers: what is pasted differs from what was transcribed', async () => {
    const h = makeHarness()
    await h.pipeline.start()
    await h.pipeline.stop()

    expect(h.injections[0]).toBe(CLEANED)
    expect(h.injections[0]).not.toContain('um')
    // The un-cleaned audio is still recoverable from history.
    expect(h.history.list()[0]?.raw).toBe(RAW)
  })

  it('records a history entry per dictation', async () => {
    const h = makeHarness()
    await h.pipeline.start()
    await h.pipeline.stop()

    const entries = h.history.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.injected).toBe(true)
    expect(entries[0]?.cleaned).toBe(CLEANED)
    expect(typeof entries[0]?.id).toBe('string')
  })

  it('accumulates history across several dictations', async () => {
    const h = makeHarness()
    for (let i = 0; i < 3; i++) {
      await h.pipeline.start()
      await h.pipeline.stop()
    }
    expect(h.history.list()).toHaveLength(3)
  })

  it('falls back to the raw transcript when cleanup throws', async () => {
    const h = makeHarness()
    await h.pipeline.start()
    h.setCleanup(async () => {
      throw new Error('provider is down')
    })
    await h.pipeline.stop()

    expect(h.injections).toHaveLength(1)
    expect(h.injections[0]).toBe(RAW)
    expect(h.degraded.join(' ')).toContain('provider is down')
    expect(h.failures).toHaveLength(0)
  })

  it('reports an error instead of pasting when failOpenToRaw is off', async () => {
    const h = makeHarness()
    h.setConfig({ llm: { ...DEFAULT_CONFIG.llm, failOpenToRaw: false } })

    await h.pipeline.start()
    h.setCleanup(async () => {
      throw new Error('provider is down')
    })
    await h.pipeline.stop()

    expect(h.injections).toHaveLength(0)
    expect(h.failures.join(' ')).toContain('provider is down')
  })

  it('falls back when the model returns only whitespace', async () => {
    const h = makeHarness()
    await h.pipeline.start()
    h.setCleanup(async () => ({ text: '   ' }))
    await h.pipeline.stop()

    expect(h.injections).toEqual([RAW])
  })

  it('errors when the transcript is empty rather than pasting whitespace', async () => {
    const h = makeHarness()
    h.setStt({
      transcribe: async () => ({ text: '  ', providerId: 'x', model: 'y', latencyMs: 0 })
    })

    await h.pipeline.start()
    await h.pipeline.stop()

    expect(h.injections).toHaveLength(0)
    expect(h.failures.join(' ')).toMatch(/no speech/i)
  })

  it('errors when nothing was captured', async () => {
    const h = makeHarness()
    const recorder = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => new Int16Array(0)),
      cancel: vi.fn()
    } as unknown as AudioRecorder

    // Swap in an empty-capture recorder without duplicating the whole harness.
    ;(h.pipeline as unknown as { deps: PipelineDeps }).deps.recorder = recorder

    await h.pipeline.start()
    await h.pipeline.stop()

    expect(h.injections).toHaveLength(0)
    expect(h.failures.join(' ')).toMatch(/nothing was captured/i)
  })

  it('appends a newline only when configured to', async () => {
    const withNewline = makeHarness({ inject: { ...DEFAULT_CONFIG.inject, trailingNewline: true } })
    await withNewline.pipeline.start()
    await withNewline.pipeline.stop()
    expect(withNewline.injections[0]).toBe(`${CLEANED}\n`)

    const without = makeHarness()
    await without.pipeline.start()
    await without.pipeline.stop()
    expect(without.injections[0]).toBe(CLEANED)
  })

  it('does not double up a newline if the model already emitted one', async () => {
    const h = makeHarness({ inject: { ...DEFAULT_CONFIG.inject, trailingNewline: true } })
    await h.pipeline.start()
    h.setCleanup(async () => ({ text: `${CLEANED}\n` }))
    await h.pipeline.stop()

    expect(h.injections[0]).toBe(`${CLEANED}\n`)
  })

  it('tells the user when injection degraded to clipboard-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xono-test-'))
    tempDirs.push(dir)
    const store = new ConfigStore(join(dir, 'config.json'))
    store.replace(structuredClone(DEFAULT_CONFIG))

    const injector: Injector = {
      id: 'fake',
      method: 'clipboard-only',
      preflight: async () => [],
      inject: async () => ({ ok: true, method: 'clipboard-only', clipboardRestored: false })
    }

    const pipeline = new Pipeline({
      config: store,
      recorder: { start: async () => undefined, stop: async () => speechPcm(400), cancel: () => undefined } as unknown as AudioRecorder,
      stt: {
        isReady: () => true,
        ensureReady: async () => undefined,
        dispose: async () => undefined,
        transcribe: async () => ({ text: RAW, providerId: 'a', model: 'b', latencyMs: 0 })
      } as unknown as SttProvider,
      models: { isReady: () => true, download: async () => '', onDownload: () => () => undefined } as unknown as ModelManager,
      providers: {
        mistral: {
          validateConfig: () => ({ ok: true }),
          cleanup: async () => ({ text: CLEANED, fallback: false, removedFillers: 0, latencyMs: 0, providerId: 'mistral', model: 'f' }),
          label: 'Fake'
        }
      } as unknown as ProviderRegistry,
      history: new HistoryStore(5, join(dir, 'history.json')),
      createVadEngine: async (cfg) => new EnergyEngine(cfg.vad),
      resolveInjector: async () => ({
        injector,
        degraded: true,
        reason: 'ydotool: /dev/uinput is not accessible'
      })
    })

    const degraded: string[] = []
    pipeline.on('degraded', (m: string) => degraded.push(m))

    await pipeline.start()
    await pipeline.stop()

    expect(degraded.join(' ')).toContain('ydotool')
    expect(degraded.join(' ')).toContain('Ctrl+V')
  })

  it('cancel stops recording and pastes nothing', async () => {
    const h = makeHarness()
    await h.pipeline.start()
    h.pipeline.cancel()

    expect(h.injections).toHaveLength(0)
    expect(h.states).toContain('cancelled')
    expect(h.history.list()).toHaveLength(0)
  })

  it('is a no-op to start twice or to stop while idle', async () => {
    const h = makeHarness()
    await expect(h.pipeline.stop()).resolves.toBeNull()

    await h.pipeline.start()
    await h.pipeline.start()
    expect(h.pipeline.getState()).toBe('listening')
    expect(h.states.filter((s) => s === 'listening')).toHaveLength(1)

    h.pipeline.cancel()
  })

  it('offers a review and can fall back to the raw transcript', async () => {
    const h = makeHarness({ ui: { ...DEFAULT_CONFIG.ui, reviewBeforeInject: true } })

    await h.pipeline.start()
    const stopped = h.pipeline.stop()
    await vi.waitFor(() => expect(h.pipeline.getState()).toBe('reviewing'))

    h.pipeline.resolveReview('raw')
    await stopped

    expect(h.injections).toEqual([RAW])
  })

  it('accepts the cleaned text from review', async () => {
    const h = makeHarness({ ui: { ...DEFAULT_CONFIG.ui, reviewBeforeInject: true } })

    await h.pipeline.start()
    const stopped = h.pipeline.stop()
    await vi.waitFor(() => expect(h.pipeline.getState()).toBe('reviewing'))

    h.pipeline.resolveReview('accept')
    await stopped

    expect(h.injections).toEqual([CLEANED])
  })

  it('discards the utterance when review is rejected', async () => {
    const h = makeHarness({ ui: { ...DEFAULT_CONFIG.ui, reviewBeforeInject: true } })

    await h.pipeline.start()
    const stopped = h.pipeline.stop()
    await vi.waitFor(() => expect(h.pipeline.getState()).toBe('reviewing'))

    h.pipeline.resolveReview('reject')
    await stopped

    expect(h.injections).toHaveLength(0)
    expect(h.history.list()).toHaveLength(0)
  })

  it('re-injects text from history without re-transcribing', async () => {
    const h = makeHarness()
    await h.pipeline.start()
    await h.pipeline.stop()
    const entry = h.history.list()[0]!

    await expect(h.pipeline.injectText(entry.cleaned)).resolves.toBe(true)
    expect(h.injections).toHaveLength(2)
  })

  it('refuses to inject empty text', async () => {
    const h = makeHarness()
    await expect(h.pipeline.injectText('   ')).resolves.toBe(false)
    expect(h.injections).toHaveLength(0)
  })

  it('remembers the previous utterance and passes it as context', async () => {
    const seen: (string | undefined)[] = []
    const h = makeHarness()
    const pipelineDeps = (h.pipeline as unknown as { deps: PipelineDeps }).deps
    const original = pipelineDeps.providers.mistral!.cleanup
    pipelineDeps.providers.mistral!.cleanup = async (req: { previousContext?: string }) => {
      seen.push(req.previousContext)
      return original.call(pipelineDeps.providers.mistral!, req as never, {} as never, 0)
    }

    await h.pipeline.start()
    await h.pipeline.stop()
    await h.pipeline.start()
    await h.pipeline.stop()

    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBe(CLEANED)
  })

  it('does not pass context when the feature is off', async () => {
    const seen: (string | undefined)[] = []
    const h = makeHarness({
      llm: { ...DEFAULT_CONFIG.llm, useConversationContext: false }
    })
    const deps = (h.pipeline as unknown as { deps: PipelineDeps }).deps
    const original = deps.providers.mistral!.cleanup
    deps.providers.mistral!.cleanup = async (req: { previousContext?: string }) => {
      seen.push(req.previousContext)
      return original.call(deps.providers.mistral!, req as never, {} as never, 0)
    }

    await h.pipeline.start()
    await h.pipeline.stop()
    await h.pipeline.start()
    await h.pipeline.stop()

    expect(seen).toEqual([undefined, undefined])
  })

  it('emits waveform frames from the recorder to listeners', async () => {
    const frames: WaveFrame[] = []
    const dir = mkdtempSync(join(tmpdir(), 'xono-test-'))
    tempDirs.push(dir)
    const store = new ConfigStore(join(dir, 'config.json'))
    store.replace(structuredClone(DEFAULT_CONFIG))

    let onFrame: ((f: WaveFrame) => void) | undefined
    const pipeline = new Pipeline({
      config: store,
      recorder: {
        start: async (opts: { onFrame?: (f: WaveFrame) => void }) => {
          onFrame = opts.onFrame
        },
        stop: async () => speechPcm(200),
        cancel: () => undefined
      } as unknown as AudioRecorder,
      stt: {
        isReady: () => true,
        ensureReady: async () => undefined,
        dispose: async () => undefined,
        transcribe: async () => ({ text: RAW, providerId: 'a', model: 'b', latencyMs: 0 })
      } as unknown as SttProvider,
      models: { isReady: () => true, download: async () => '', onDownload: () => () => undefined } as unknown as ModelManager,
      providers: {
        mistral: {
          validateConfig: () => ({ ok: true }),
          label: 'Fake',
          cleanup: async () => ({ text: CLEANED, fallback: false, removedFillers: 0, latencyMs: 0, providerId: 'mistral', model: 'f' })
        }
      } as unknown as ProviderRegistry,
      history: new HistoryStore(5, join(dir, 'history.json')),
      createVadEngine: async (cfg) => new EnergyEngine(cfg.vad),
      resolveInjector: async () => ({
        injector: { id: 'f', method: 'clipboard-only', preflight: async () => [], inject: async () => ({ ok: true, method: 'clipboard-only', clipboardRestored: false }) },
        degraded: false
      })
    })

    pipeline.on('wave', (f: WaveFrame) => frames.push(f))
    await pipeline.start()
    onFrame?.({ level: 0.5, speech: 1, t: 32 })

    expect(frames).toHaveLength(1)
    expect(frames[0]?.level).toBe(0.5)

    await pipeline.stop()
  })

  it('writes the config to an explicit path and reloads it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xono-test-'))
    tempDirs.push(dir)
    const file = join(dir, 'config.json')

    const first = new ConfigStore(file)
    first.patch('llm', { timeoutMs: 4321 })
    first.patch('general', { vocabulary: ['ydotool', 'parec'] })

    const second = new ConfigStore(file)
    expect(second.get().llm.timeoutMs).toBe(4321)
    expect(second.get().general.vocabulary).toEqual(['ydotool', 'parec'])
  })

  it('notifies subscribers on every patch and stops after unsubscribe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xono-test-'))
    tempDirs.push(dir)
    const store = new ConfigStore(join(dir, 'config.json'))
    const seen: number[] = []
    const off = store.subscribe((cfg) => seen.push(cfg.ui.widgetWidth))

    store.patch('ui', { widgetWidth: 500 })
    store.patch('ui', { widgetWidth: 640 })
    off()
    store.patch('ui', { widgetWidth: 800 })

    expect(seen).toEqual([500, 640])
  })
})