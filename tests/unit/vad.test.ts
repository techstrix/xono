import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, DEFAULT_OPENROUTER_REFERER, parseConfig, providerDefaults } from '../../src/shared/schema'
import { EnergyEngine, UtteranceTracker, slicePcm } from '../../src/main/core/vad'
import { SAMPLE_RATE } from '../../src/shared/types'

const baseVad = DEFAULT_CONFIG.vad

function pcmWithSpeech({ leadMs, speechMs, tailMs }: { leadMs: number; speechMs: number; tailMs: number }): Int16Array {
  const n = Math.round(((leadMs + speechMs + tailMs) / 1000) * SAMPLE_RATE)
  const out = new Int16Array(n)
  const speechStart = Math.round((leadMs / 1000) * SAMPLE_RATE)
  const speechEnd = speechStart + Math.round((speechMs / 1000) * SAMPLE_RATE)
  for (let i = speechStart; i < speechEnd && i < n; i++) {
    out[i] = Math.round(Math.sin(i * 0.05) * 8000)
  }
  return out
}

describe('config parsing', () => {
  it('fills in defaults for an empty object', () => {
    expect(parseConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it('survives a completely malformed config', () => {
    expect(parseConfig('nonsense')).toEqual(DEFAULT_CONFIG)
    expect(parseConfig({ stt: { model: 12345 } })).toEqual(DEFAULT_CONFIG)
  })

  it('ships the OpenRouter attribution defaults', () => {
    const cfg = parseConfig({})
    // The attribution headers go out by default; they are what OpenRouter uses for app
    // attribution, and a blank default would silently opt us out of that.
    expect(cfg.llm.providers.openrouter.referer).toBe(DEFAULT_OPENROUTER_REFERER)
    expect(cfg.llm.providers.openrouter.title).toBe('Xono')
  })

  it('keeps a custom attribution header rather than overwriting it', () => {
    const cfg = parseConfig({ llm: { providers: { openrouter: { title: 'My Fork' } } } })
    expect(cfg.llm.providers.openrouter.title).toBe('My Fork')
    expect(cfg.llm.providers.openrouter.referer).toBe(DEFAULT_OPENROUTER_REFERER)
  })

  it('keeps user values while filling blanks', () => {
    const cfg = parseConfig({ stt: { model: 'small.en' } })
    expect(cfg.stt.model).toBe('small.en')
    expect(cfg.stt.beamSize).toBe(DEFAULT_CONFIG.stt.beamSize)
  })

  it('backfills provider base URLs but never clobbers a custom one', () => {
    const cfg = parseConfig({ llm: { providers: { mistral: { apiKey: 'k' } } } })
    expect(cfg.llm.providers.mistral.apiKey).toBe('k')
    expect(cfg.llm.providers.mistral.baseUrl).toBe(providerDefaults('mistral').baseUrl)

    const custom = parseConfig({
      llm: { providers: { groq: { baseUrl: 'https://proxy.internal/v1' } } }
    })
    expect(custom.llm.providers.groq.baseUrl).toBe('https://proxy.internal/v1')
  })

  it('always has every provider present', () => {
    const cfg = parseConfig({ llm: { providers: { ollama: {} } } })
    expect(Object.keys(cfg.llm.providers).sort()).toEqual([
      'anthropic',
      'groq',
      'mistral',
      'nvidia',
      'ollama',
      'openrouter'
    ])
  })
})

describe('EnergyEngine', () => {
  it('debounces: two loud frames open the gate, three quiet frames close it', async () => {
    const engine = new EnergyEngine(baseVad)
    const loud = new Float32Array(512).fill(0.4)
    const quiet = new Float32Array(512)

    // One loud frame is not enough to declare speech.
    expect(await engine.push(loud)).toBe(0.5)
    expect(await engine.push(loud)).toBe(1)

    // The gate needs three consecutive quiet frames to close, so the first two still
    // read as speech. That is ~64ms of hangover at 16kHz, which is intentional.
    expect(await engine.push(quiet)).toBe(1)
    expect(await engine.push(quiet)).toBe(1)
    expect(await engine.push(quiet)).toBe(0)
    expect(await engine.push(loud)).toBe(0.5)
  })

  it('reopens after silence, so end-of-speech detection still works', async () => {
    const engine = new EnergyEngine(baseVad)
    const loud = new Float32Array(512).fill(0.4)
    const quiet = new Float32Array(512)

    for (let i = 0; i < 40; i++) await engine.push(loud)
    expect(await engine.push(loud)).toBe(1)

    // A long trailing silence must eventually be reported as silence; if the gate
    // latched open, auto-stop-on-silence would never fire again.
    for (let i = 0; i < 30; i++) await engine.push(quiet)
    expect(await engine.push(quiet)).toBe(0)

    for (let i = 0; i < 2; i++) await engine.push(loud)
    expect(await engine.push(loud)).toBe(1)
  })
})

describe('UtteranceTracker', () => {
  it('detects speech, silence, and the resulting end of utterance', async () => {
    const tracker = new UtteranceTracker({ ...baseVad, silenceMsToStop: 500 }, new EnergyEngine(baseVad))
    const pcm = pcmWithSpeech({ leadMs: 300, speechMs: 900, tailMs: 900 })

    await tracker.push(pcm)
    await tracker.flush()

    const status = tracker.status()
    expect(status.speechDetected).toBe(true)
    expect(status.durationMs).toBeCloseTo(2100, -1)
    expect(status.endOfSpeech).toBe(true)
  })

  it('does not report end-of-speech before any speech', async () => {
    const tracker = new UtteranceTracker({ ...baseVad, silenceMsToStop: 300 }, new EnergyEngine(baseVad))
    await tracker.push(new Int16Array(SAMPLE_RATE))
    await tracker.flush()
    expect(tracker.status().speechDetected).toBe(false)
    expect(tracker.status().endOfSpeech).toBe(false)
  })

  it('trims leading and trailing silence with a small pad', async () => {
    const tracker = new UtteranceTracker(baseVad, new EnergyEngine(baseVad))
    const pcm = pcmWithSpeech({ leadMs: 1000, speechMs: 1000, tailMs: 1000 })
    await tracker.push(pcm)
    await tracker.flush()

    const { start, end } = tracker.trimRange()
    expect(start).toBeGreaterThan(0)
    expect(end).toBeLessThan(pcm.length)
    // Roughly 1000ms of speech plus ~120ms of pad on each side.
    expect((end - start) / SAMPLE_RATE).toBeGreaterThan(1.0)
    expect((end - start) / SAMPLE_RATE).toBeLessThan(1.4)
  })

  it('keeps the whole buffer when trimming is off', async () => {
    const tracker = new UtteranceTracker({ ...baseVad, trimSilence: false }, new EnergyEngine(baseVad))
    await tracker.push(pcmWithSpeech({ leadMs: 500, speechMs: 500, tailMs: 500 }))
    await tracker.flush()
    expect(tracker.trimRange()).toEqual({ start: 0, end: 1500 * SAMPLE_RATE / 1000 })
  })

  it('handles chunk boundaries that do not align to the analysis frame', async () => {
    const tracker = new UtteranceTracker(baseVad, new EnergyEngine(baseVad))
    const pcm = pcmWithSpeech({ leadMs: 200, speechMs: 800, tailMs: 200 })

    // Push in deliberately awkward slices, including one smaller than a frame.
    let offset = 0
    for (const size of [100, 700, 333, 4096, 2049, 10000]) {
      if (offset >= pcm.length) break
      await tracker.push(pcm.subarray(offset, Math.min(pcm.length, offset + size)))
      offset += size
    }
    await tracker.flush()

    expect(tracker.status().speechDetected).toBe(true)
    const { start, end } = tracker.trimRange()
    expect(end).toBeGreaterThan(start)
  })

  it('resets cleanly between utterances', async () => {
    const tracker = new UtteranceTracker(baseVad, new EnergyEngine(baseVad))
    await tracker.push(pcmWithSpeech({ leadMs: 100, speechMs: 500, tailMs: 100 }))
    await tracker.flush()
    expect(tracker.status().speechDetected).toBe(true)

    tracker.reset()
    await tracker.flush()
    expect(tracker.status().speechDetected).toBe(false)
    expect(tracker.trimRange().end).toBe(0)
  })

  it('respects maxUtteranceMs via the reported duration', async () => {
    const tracker = new UtteranceTracker({ ...baseVad, maxUtteranceMs: 2000 }, new EnergyEngine(baseVad))
    await tracker.push(new Int16Array(SAMPLE_RATE * 3))
    await tracker.flush()
    expect(tracker.status().durationMs).toBeGreaterThan(2000)
  })
})

describe('slicePcm', () => {
  it('clamps to the buffer and never returns a reversed range', () => {
    const pcm = new Int16Array(100)
    expect(slicePcm(pcm, -10, 50).length).toBe(50)
    expect(slicePcm(pcm, 20, 500).length).toBe(80)
    expect(slicePcm(pcm, 80, 20).length).toBe(0)
  })
})