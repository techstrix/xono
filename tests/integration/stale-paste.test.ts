import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pipeline, type PipelineDeps } from '../../src/main/core/pipeline'
import { ConfigStore } from '../../src/main/core/config'
import { HistoryStore } from '../../src/main/core/history'
import { ClipboardPasteInjector, clearPasteNote } from '../../src/main/core/inject/clipboardPaste'
import type { AudioRecorder } from '../../src/main/core/recorder'
import type { ModelManager, SttProvider } from '../../src/main/core/stt'
import type { ProviderRegistry } from '../../src/main/core/llm'
import { EnergyEngine } from '../../src/main/core/vad'
import { DEFAULT_CONFIG, type XonoConfig } from '../../src/shared/schema'
import { SAMPLE_RATE, type PipelineState } from '../../src/shared/types'

/**
 * Regression coverage for a dictation pasting the *previous* utterance instead of the
 * current one, and for the current speech going missing from history.
 *
 * The mechanism: every dictation sends the previous utterance to the cleanup model as
 * context. When the current transcript is thin — a stray "uh", a clipped recording, a
 * quiet word — a small model has nothing to work with and returns the context verbatim.
 * That text gets pasted, and because the history entry records the model's output, the
 * words actually spoken vanish from history too. Both symptoms, one cause.
 */

function pcm(ms: number): Int16Array {
  const out = new Int16Array(Math.round((ms / 1000) * SAMPLE_RATE))
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin(i * 0.04) * 9000)
  return out
}

interface Harness {
  pipeline: Pipeline
  history: HistoryStore
  clipboard: () => string
  writes: string[]
  states: PipelineState[]
  /** Every payload that was offered for pasting, ignoring clipboard restores. */
  pastes: () => string[]
  /** The most recent payload actually offered for pasting. */
  pasted: () => string | undefined
  seedClipboard: (value: string) => void
  setTranscript: (text: string) => void
  setCleanup: (fn: (req: { raw: string; previousContext?: string }) => Promise<string>) => void
}

function makeHarness(overrides: Partial<XonoConfig> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'xono-stale-'))
  let config: XonoConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    ...overrides,
    ui: { ...DEFAULT_CONFIG.ui, ...overrides.ui },
    // The restore delay is irrelevant to what is under test and would add 1.5s per
    // injection across the suite.
    inject: { ...DEFAULT_CONFIG.inject, restoreClipboardDelayMs: 5, ...overrides.inject }
  }

  const store = new ConfigStore(join(dir, 'config.json'))
  store.replace(config)

  const recorder = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => pcm(600)),
    cancel: vi.fn()
  } as unknown as AudioRecorder

  let transcript = 'first dictation'
  const stt = {
    id: 'fake',
    label: 'fake',
    isReady: () => true,
    ensureReady: async () => undefined,
    dispose: async () => undefined,
    transcribe: async () => ({ text: transcript, providerId: 'fake', model: 'fake', latencyMs: 1 })
  } as SttProvider

  const models = {
    isReady: () => true,
    download: async () => '',
    onDownload: () => () => undefined
  } as unknown as ModelManager

  let cleanup = async (_req: { raw: string; previousContext?: string }): Promise<string> => _req.raw

  const provider = {
    id: 'mistral',
    label: 'Fake',
    requiresApiKey: true,
    defaultModel: 'fake',
    defaultBaseUrl: '',
    validateConfig: () => ({ ok: true }),
    healthCheck: async () => ({ ok: true, detail: '' }),
    cleanup: async (req: { raw: string; previousContext?: string }) => ({
      text: await cleanup(req),
      fallback: false,
      removedFillers: 0,
      latencyMs: 1,
      providerId: 'mistral' as const,
      model: 'fake'
    })
  }
  const providers = {
    mistral: provider,
    groq: provider,
    ollama: provider,
    anthropic: provider,
    openrouter: provider,
    nvidia: provider
  } as unknown as ProviderRegistry

  // Real clipboard payload path, without touching the compositor or the key chord.
  let clipboardValue = ''
  const writes: string[] = []
  const injector = new ClipboardPasteInjector(
    'test',
    'clipboard-ydotool',
    {
      read: async () => clipboardValue,
      write: async (t: string) => {
        clipboardValue = t
        writes.push(t)
      }
    },
    'ydotool'
  )
  // Pretend the chord always lands; only the clipboard payload is under test here.
  injector.preflight = async () => []
  ;(injector as unknown as { sendChord: () => Promise<void> }).sendChord = async () => undefined

  const history = new HistoryStore(20, join(dir, 'history.json'))
  const states: PipelineState[] = []

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

  return {
    pipeline,
    history,
    clipboard: () => clipboardValue,
    writes,
    pastes: () => writes.filter((w) => w !== ''),
    pasted: () => writes.filter((w) => w !== '').at(-1),
    seedClipboard: (value: string) => {
      clipboardValue = value
    },
    states,
    setTranscript: (t) => {
      transcript = t
    },
    setCleanup: (fn) => {
      cleanup = fn
    }
  }
}

afterEach(() => {
  clearPasteNote()
})

describe('the model must not be able to paste a previous utterance', () => {
  it('ignores a cleanup that echoes the previous utterance', async () => {
    const h = makeHarness()

    // First dictation, a normal one.
    h.setCleanup(async (req) => req.raw)
    await h.pipeline.start()
    await h.pipeline.stop()
    expect(h.pasted()?.trim()).toBe('first dictation')

    // Second: the transcript degenerates to a filler, and the model hands back the
    // previous utterance instead of cleaning this one.
    h.pipeline.on('failed', (m: string) => console.log('DEBUG failed:', m))
    h.pipeline.on('degraded', (m: string) => console.log('DEBUG degraded:', m))
    h.setTranscript('uh')
    h.setCleanup(async (req) => { console.log('DEBUG provider got:', JSON.stringify(req)); return req.previousContext ?? req.raw })
    await h.pipeline.start()
    const out = await h.pipeline.stop()
    console.log('DEBUG stop returned:', JSON.stringify(out))
    console.log('DEBUG states:', JSON.stringify(h.states))
    console.log('DEBUG clipboard:', JSON.stringify(h.clipboard()))
    console.log('DEBUG history:', JSON.stringify(h.history.list().map(e=>[e.raw,e.cleaned,e.injected])))
    const second = h.history.list()[0]!
    expect(second.raw).toBe('uh')
    // The pasted text must not be the previous utterance.
    expect(second.cleaned).not.toBe('first dictation')
    expect(h.pasted()?.trim()).not.toBe('first dictation')
  })

  it('leaves nothing of the dictation on the clipboard', () => {
    const h = makeHarness()
    const original = 'something the user copied'

    // Seed the clipboard with a real value, then dictate twice.
    h.seedClipboard(original)
    h.setCleanup(async (req) => req.raw)
    return (async () => {
      await h.pipeline.start()
      await h.pipeline.stop()
      h.setTranscript('second dictation')
      await h.pipeline.start()
      await h.pipeline.stop()

      // The user's own clipboard must come back, not an earlier dictation.
      expect(h.clipboard()).toBe(original)
    })()
  })

  it('restores an empty clipboard to empty rather than to a dictation', async () => {
    const h = makeHarness()
    h.setCleanup(async (req) => req.raw)

    // Clipboard starts empty — the case that used to leak dictation text.
    await h.pipeline.start()
    await h.pipeline.stop()
    h.setTranscript('second dictation')
    await h.pipeline.start()
    await h.pipeline.stop()

    expect(h.clipboard(), 'dictated text must not linger on the clipboard').toBe('')
  })

  it('leaves the clipboard alone if the user copied something meanwhile', async () => {
    const h = makeHarness()
    h.setCleanup(async (req) => req.raw)

    await h.pipeline.start()
    // The user copies something while the restore delay is pending.
    const inFlight = h.pipeline.stop()
    h.seedClipboard('user copied this mid-flight')
    await inFlight

    expect(h.clipboard()).toBe('user copied this mid-flight')
  })

  it('falls back to the raw transcript and says so', async () => {
    const h = makeHarness()
    const degraded: string[] = []

    await h.pipeline.start()
    await h.pipeline.stop()
    h.pipeline.on('degraded', (m: string) => degraded.push(m))

    h.setTranscript('uh')
    h.setCleanup(async (req) => req.previousContext ?? req.raw)
    await h.pipeline.start()
    await h.pipeline.stop()

    expect(h.pasted()?.trim()).toBe('uh')
    expect(degraded.join(' ')).toMatch(/previous/i)
    expect(h.clipboard(), 'the raw transcript was used, not the stale one').not.toContain(
      'first dictation'
    )
  })

  it('still allows a legitimate reuse of context', async () => {
    const h = makeHarness()

    h.setCleanup(async (req) => req.raw)
    await h.pipeline.start()
    await h.pipeline.stop()

    // A genuine second dictation that happens to be phrased the same way is fine,
    // because the raw transcript really is that text.
    h.setTranscript('now do the same for the tests')
    h.setCleanup(async () => 'Now do the same for the tests.')
    await h.pipeline.start()
    await h.pipeline.stop()

    expect(h.history.list()[0]?.cleaned).toBe('Now do the same for the tests.')
  })
})

describe('every completed dictation is recorded', () => {
  it('logs the raw words even when the model returns something else', async () => {
    const h = makeHarness()
    h.setCleanup(async (req) => req.raw)

    await h.pipeline.start()
    await h.pipeline.stop()

    h.setTranscript('deploy the widget on friday')
    h.setCleanup(async () => '')
    await h.pipeline.start()
    await h.pipeline.stop()

    const newest = h.history.list()[0]!
    expect(newest.raw).toBe('deploy the widget on friday')
    expect(newest.injected).toBe(true)
  })

  it('records a dictation whose paste failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xono-stale-fail-'))
    const store = new ConfigStore(join(dir, 'config.json'))
    store.replace(structuredClone(DEFAULT_CONFIG))

    const history = new HistoryStore(20, join(dir, 'history.json'))
    const pipeline = new Pipeline({
      config: store,
      recorder: {
        start: async () => undefined,
        stop: async () => pcm(400),
        cancel: () => undefined
      } as unknown as AudioRecorder,
      stt: {
        isReady: () => true,
        ensureReady: async () => undefined,
        dispose: async () => undefined,
        transcribe: async () => ({
          text: 'words you actually said',
          providerId: 'a',
          model: 'b',
          latencyMs: 0
        })
      } as unknown as SttProvider,
      models: {
        isReady: () => true,
        download: async () => '',
        onDownload: () => () => undefined
      } as unknown as ModelManager,
      providers: {
        mistral: {
          validateConfig: () => ({ ok: true }),
          label: 'Fake',
          cleanup: async () => ({
            text: 'clean words',
            fallback: false,
            removedFillers: 0,
            latencyMs: 0,
            providerId: 'mistral' as const,
            model: 'f'
          })
        }
      } as unknown as ProviderRegistry,
      history,
      createVadEngine: async (cfg) => new EnergyEngine(cfg.vad),
      resolveInjector: async () => ({
        injector: {
          id: 'broken',
          method: 'clipboard-only',
          preflight: async () => [],
          inject: async () => ({ ok: false, method: 'clipboard-only', error: 'no target', clipboardRestored: false })
        },
        degraded: false
      })
    })

    await pipeline.start()
    await pipeline.stop()

    // The paste failed, but the words must not be lost.
    const entries = history.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.raw).toBe('words you actually said')
    expect(entries[0]?.injected).toBe(false)

    rmSync(dir, { recursive: true, force: true })
  })

  it('orders history newest first across several dictations', async () => {
    const h = makeHarness()
    h.setCleanup(async (req) => req.raw)

    for (const text of ['one', 'two', 'three']) {
      h.setTranscript(text)
      await h.pipeline.start()
      await h.pipeline.stop()
    }

    expect(h.history.list().map((e) => e.raw)).toEqual(['three', 'two', 'one'])
  })
})
