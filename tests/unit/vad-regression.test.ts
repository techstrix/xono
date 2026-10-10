import { describe, expect, it, beforeEach } from 'vitest'
import { EnergyEngine, UtteranceTracker } from '../../src/main/core/vad'
import { DEFAULT_CONFIG } from '../../src/shared/schema'
import { SAMPLE_RATE } from '../../src/shared/types'

/**
 * Regression coverage for utterances being cut off on a filler word.
 *
 * The failure was: a quiet "uhm" fell below the adaptive noise threshold, was classified
 * as silence, and the end-of-utterance timer ran down through it — so the recording
 * stopped mid-thought. Filler removal is the cleanup model's job; this layer only has to
 * avoid truncating the speaker.
 */
const vad = DEFAULT_CONFIG.vad

/** RMS of a plausible quiet filler such as "uhm". */
const FILLER_RMS = 0.012
/** RMS of steady room noise with a fan or a humming laptop. */
const NOISE_RMS = 0.02

function frame(rms: number, n = 512): Float32Array {
  const out = new Float32Array(n)
  // Deterministic pseudo-noise so results do not depend on Math.random.
  for (let i = 0; i < n; i++) out[i] = (i % 2 === 0 ? 1 : -1) * rms
  return out
}

async function pushFrames(engine: EnergyEngine, frames: number, rms: number): Promise<number[]> {
  const out: number[] = []
  for (let i = 0; i < frames; i++) out.push(await engine.push(frame(rms)))
  return out
}

describe('energy threshold is capped against background noise', () => {
  it('defaults to a threshold low enough to catch quiet fillers', () => {
    expect(vad.energyThreshold).toBeLessThanOrEqual(0.008)
  })

  it('waits at least two seconds of silence before cutting off', () => {
    expect(vad.silenceMsToStop).toBeGreaterThanOrEqual(2000)
  })

  it('still hears a filler in a loud room', async () => {
    const engine = new EnergyEngine(vad)

    // Teach the detector a noisy room, then speak a quiet filler.
    await pushFrames(engine, 80, NOISE_RMS)
    const duringFiller = await pushFrames(engine, 4, FILLER_RMS)

    // Without the cap the adaptive term would be NOISE_RMS * 3 = 0.06, far above the
    // filler, and every frame here would read as silence.
    expect(Math.max(...duringFiller)).toBeGreaterThan(0)
  })

  it('keeps adapting upward within the cap', async () => {
    const engine = new EnergyEngine(vad)
    const quiet = await pushFrames(engine, 60, 0.002)
    // Sustained genuine silence still reads as silence.
    expect(Math.max(...quiet.slice(10))).toBe(0)
  })
})

describe('filler before a pause does not end the utterance', () => {
  it('treats "so I need to [pause] uhm do this" as one utterance', async () => {
    const tracker = new UtteranceTracker(vad, new EnergyEngine(vad))

    // Speak for ~1.2s.
    const speech = new Int16Array(Math.round(1.2 * SAMPLE_RATE))
    for (let i = 0; i < speech.length; i++) {
      speech[i] = Math.round(Math.sin(i * 0.04) * (FILLER_RMS * 32767))
    }
    await tracker.push(speech)
    await tracker.flush()

    // Pause for 1.5s — longer than the old 1.2s cutoff, but well inside the new window.
    await tracker.push(new Int16Array(Math.round(1.5 * SAMPLE_RATE)))
    await tracker.flush()

    const afterPause = tracker.status()
    expect(afterPause.endOfSpeech).toBe(false)

    // Then a quiet filler, which must be heard as speech, not silence.
    const fillerStart = tracker.status().speechDetected
    const filler = new Int16Array(Math.round(0.4 * SAMPLE_RATE))
    for (let i = 0; i < filler.length; i++) {
      filler[i] = Math.round(Math.sin(i * 0.04) * (FILLER_RMS * 32767))
    }
    await tracker.push(filler)
    await tracker.flush()

    expect(fillerStart).toBe(true)
    expect(tracker.status().silenceMs).toBeLessThan(vad.silenceMsToStop)
  })

  it('does cut off after a genuinely long silence', async () => {
    const tracker = new UtteranceTracker(vad, new EnergyEngine(vad))
    const speech = new Int16Array(Math.round(1.0 * SAMPLE_RATE))
    for (let i = 0; i < speech.length; i++) {
      speech[i] = Math.round(Math.sin(i * 0.04) * (FILLER_RMS * 32767))
    }
    await tracker.push(speech)

    await tracker.push(new Int16Array(Math.round((vad.silenceMsToStop / 1000 + 0.4) * SAMPLE_RATE)))
    await tracker.flush()

    expect(tracker.status().endOfSpeech).toBe(true)
  })

  it('does not cut off a quiet utterance in a room that starts noisy', async () => {
    const tracker = new UtteranceTracker(vad, new EnergyEngine(vad))

    // Noise first, long enough for the floor to adapt upward.
    await tracker.push(new Int16Array(Math.round(2.5 * SAMPLE_RATE)))
    await tracker.flush()

    // Then the whole utterance, quietly, with a trailing pause.
    const pcm = new Int16Array(Math.round(3.5 * SAMPLE_RATE))
    const from = Math.round(1.0 * SAMPLE_RATE)
    const to = Math.round(2.6 * SAMPLE_RATE)
    for (let i = from; i < to; i++) pcm[i] = Math.round(Math.sin(i * 0.04) * (FILLER_RMS * 32767))
    await tracker.push(pcm)
    await tracker.flush()

    const status = tracker.status()
    expect(status.speechDetected, 'the quiet utterance should still register').toBe(true)
    expect(status.endOfSpeech, 'should not have cut off after ~0.9s of trailing silence').toBe(false)
  })

  it('stops when dictation was triggered but nothing was ever said', async () => {
    // A hotkey misfire in a quiet room used to record forever: the trailing-silence
    // rule can only fire once something has been heard, so the utterance never ended
    // and the widget sat there showing a waveform.
    const tracker = new UtteranceTracker(vad, new EnergyEngine(vad))

    await tracker.push(new Int16Array(Math.round(1.0 * SAMPLE_RATE)))
    await tracker.flush()
    expect(tracker.status().endOfSpeech, 'should not stop the moment it opens').toBe(false)

    await tracker.push(new Int16Array(Math.round(7.0 * SAMPLE_RATE)))
    await tracker.flush()

    const status = tracker.status()
    expect(status.speechDetected).toBe(false)
    expect(status.endOfSpeech, 'should give up rather than record forever').toBe(true)
  })

  it('keeps the filler inside the trimmed audio', async () => {
    const tracker = new UtteranceTracker(vad, new EnergyEngine(vad))
    const pcm = new Int16Array(Math.round(2.6 * SAMPLE_RATE))
    // Speech, a short gap, then the filler.
    for (let i = Math.round(0.2 * SAMPLE_RATE); i < Math.round(1.0 * SAMPLE_RATE); i++) {
      pcm[i] = Math.round(Math.sin(i * 0.04) * (FILLER_RMS * 32767))
    }
    for (let i = Math.round(1.6 * SAMPLE_RATE); i < Math.round(2.2 * SAMPLE_RATE); i++) {
      pcm[i] = Math.round(Math.sin(i * 0.04) * (FILLER_RMS * 32767))
    }

    await tracker.push(pcm)
    await tracker.flush()

    // The trim must not stop at the end of the first phrase and drop the filler.
    const { end } = tracker.trimRange()
    expect(end / SAMPLE_RATE).toBeGreaterThan(2.0)
  })
})
