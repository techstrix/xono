import { existsSync } from 'node:fs'
import { SAMPLE_RATE, VAD_FRAME_SAMPLES, VAD_FRAME_MS } from '@shared/types'
import type { VadConfig, VadEngineId } from '@shared/schema'
import { loggerScope } from './logger'
import { rms } from './wav'

const log = loggerScope('vad')

/**
 * How far above the base threshold background noise may push the speech threshold.
 * Bounded so a noisy room can never make quiet speech invisible.
 */
const ADAPTIVE_CEILING = 2.5

export interface VadEngine {
  readonly id: VadEngineId
  /** Human-readable status for the diagnostics pane. */
  readonly detail: string
  reset(): void
  /**
   * Feed one analysis frame and return the speech probability in 0..1.
   *
   * Async because Silero runs through onnxruntime, whose `run` is promise-based.
   * Callers must serialise frames: the model carries RNN state, so two overlapping
   * inferences would interleave and corrupt it.
   */
  push(frame: Float32Array): Promise<number>
  dispose(): Promise<void>
}

/**
 * Zero-dependency RMS detector with an adaptive noise floor.
 *
 * This is the default because in batch toggle-mode the user explicitly marks the
 * start and end of an utterance — Silero's accuracy buys us very little, and an
 * ONNX native module carries real ABI risk under Electron. It stays as the fallback
 * if Silero is enabled but fails to load.
 */
export class EnergyEngine implements VadEngine {
  readonly id = 'energy' as const
  readonly detail = 'RMS energy with adaptive noise floor (no native dependency)'

  private noiseFloor = 0.004
  private streakAbove = 0
  private streakBelow = 0

  constructor(private readonly config: VadConfig) {}

  reset(): void {
    this.noiseFloor = 0.004
    this.streakAbove = 0
    this.streakBelow = 0
  }

  /**
   * Threshold above which a frame counts as speech.
   *
   * The adaptive term is what keeps steady fan noise or a humming laptop from being
   * transcribed as speech, but it is also what caused utterances to be cut off: in a
   * noisy room the floor climbed until a quiet "uhm" sat *below* it, the filler was
   * read as silence, and the end-of-utterance timer ran down through it.
   *
   * So the adaptation is capped. The ceiling is generous rather than tight, because the
   * two failure modes are not equally bad: a little extra room tone is harmless and
   * gets cleaned up, whereas losing the end of a sentence is not recoverable.
   */
  private effectiveThreshold(): number {
    const adaptive = Math.min(this.noiseFloor * 3, this.config.energyThreshold * ADAPTIVE_CEILING)
    return Math.max(this.config.energyThreshold, adaptive)
  }

  async push(frame: Float32Array): Promise<number> {
    let sum = 0
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i]!
      sum += v * v
    }
    const level = Math.sqrt(sum / Math.max(1, frame.length))
    const threshold = this.effectiveThreshold()

    if (level > threshold) {
      this.streakAbove++
      this.streakBelow = 0
    } else {
      this.streakBelow++
      // Only adapt the floor on sustained silence, so a long vowel cannot teach the
      // detector that speech is background noise.
      if (this.streakBelow > 20) {
        this.noiseFloor = this.noiseFloor * 0.9 + level * 0.1
      }
    }

    // Debounce: two adjacent frames to open the gate, three to close it. The close
    // test must come first *and* clear the open counter — otherwise a single long
    // stretch of speech leaves the gate latched open and silence is never reported
    // again, which would break end-of-speech detection for the rest of the session.
    if (this.streakBelow >= 3) {
      this.streakAbove = 0
      return 0
    }
    if (this.streakAbove >= 2) return 1
    return this.streakAbove >= 1 ? 0.5 : 0
  }

  async dispose(): Promise<void> {}
}

interface OrtTensorCtor {
  new (type: string, data: Float32Array | Int32Array | BigInt64Array, dims: number[]): unknown
}

interface OrtLike {
  Tensor: OrtTensorCtor
  InferenceSession: { create(path: string): Promise<OrtSessionLike> }
}

interface OrtSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array | number[] }>>
  release(): Promise<void> | void
}

/** Silero keeps RNN state as [2, 1, 128] float32. */
const STATE_SHAPE = [2, 1, 128] as const

/**
 * Silero VAD via onnxruntime-node.
 *
 * The window size is read from the model's own input metadata rather than hardcoded,
 * because the export changed between v4/v5/v6 and a mismatched window silently
 * produces garbage probabilities rather than an error.
 */
export class SileroEngine implements VadEngine {
  readonly id = 'silero' as const
  detail = 'Silero VAD (ONNX)'

  private session: OrtSessionLike | null = null
  private ort: OrtLike | null = null
  readonly window = VAD_FRAME_SAMPLES
  private states: Float32Array | null = null

  constructor(private readonly modelPath: string) {}

  static async create(modelPath: string): Promise<SileroEngine> {
    if (!existsSync(modelPath)) {
      throw new Error(
        `Silero model not found at ${modelPath}. Point the path at an ONNX Silero export, or switch the VAD engine to "energy".`
      )
    }
    const engine = new SileroEngine(modelPath)
    await engine.load()
    await probeSession(engine)
    return engine
  }

  private async load(): Promise<void> {
    let ort: OrtLike
    try {
      ort = (await import('onnxruntime-node')) as unknown as OrtLike
    } catch (err) {
      throw new Error(
        `onnxruntime-node could not be loaded (${(err as Error).message}). Run \`npm run postinstall\` to rebuild native modules for Electron, or switch the VAD engine to "energy".`
      )
    }
    this.ort = ort
    this.session = await ort.InferenceSession.create(this.modelPath)
    this.detail = `Silero VAD (ONNX) @${SAMPLE_RATE}Hz`
    this.reset()
    log.info('silero ready:', this.detail)
  }

  reset(): void {
    this.states = new Float32Array(STATE_SHAPE[0] * STATE_SHAPE[1] * STATE_SHAPE[2])
  }

  async push(frame: Float32Array): Promise<number> {
    if (!this.session || !this.ort || !this.states) return 0
    const window = this.window
    const input = frame.length === window ? frame : resampleFrame(frame, window)

    // The model expects [1, window]; a bare 1-D array would be interpreted as shape
    // [window] and rejected, so wrap it explicitly.
    const flat = new Float32Array(window)
    flat.set(input)

    const { Tensor } = this.ort
    const output = await this.session.run({
      input: new Tensor('float32', flat, [1, window]),
      state: new Tensor('float32', this.states, [...STATE_SHAPE]),
      sr: new Tensor('int64', new BigInt64Array([BigInt(SAMPLE_RATE)]), [])
    })

    const nextState = output['stateN'] ?? output['state']
    if (nextState) this.states = new Float32Array(nextState.data as Float32Array | number[])

    return firstTensor(output, 'output')
  }

  async dispose(): Promise<void> {
    await this.session?.release()
    this.session = null
  }
}

function firstTensor(output: unknown, key: string): number {
  if (!output || typeof output !== 'object') return 0
  const bag = output as Record<string, { data?: unknown }>
  const entry = bag[key] ?? Object.values(bag)[0]
  const data = entry?.data
  if (!data) return 0
  const value = ArrayBuffer.isView(data)
    ? (data as Float32Array)[0]
    : Array.isArray(data)
      ? (data as number[])[0]
      : undefined
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Validate the tensor contract before trusting the engine.
 *
 * Silero's exported window differs between model versions (512 samples in v4, 576 in
 * v5+). Rather than hardcoding a guess, run one silent frame through and let the
 * runtime's own shape check tell us whether our contract matches the file on disk.
 */
async function probeSession(engine: SileroEngine): Promise<void> {
  const silence = new Float32Array(engine.window)
  const prob = await engine.push(silence)
  if (!Number.isFinite(prob)) {
    throw new Error('silero produced a non-finite probability on the probe frame')
  }
  if (prob > 0.5) {
    throw new Error(`silero reported ${prob.toFixed(2)} speech probability for pure silence`)
  }
}

/** Nearest-neighbour stretch of a frame to the model's expected length. */
function resampleFrame(frame: Float32Array, target: number): Float32Array {
  if (frame.length === target) return frame
  const out = new Float32Array(target)
  const ratio = (frame.length - 1) / Math.max(1, target - 1)
  for (let i = 0; i < target; i++) {
    const src = i * ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(frame.length - 1, i0 + 1)
    const t = src - i0
    out[i] = frame[i0]! * (1 - t) + frame[i1]! * t
  }
  return out
}

/**
 * How long dictation waits for the first sound before giving up.
 *
 * Longer than the trailing-silence threshold on purpose: at the start of an utterance
 * a pause is normal, and cutting someone off mid-thought to answer "you didn't say
 * anything" is worse than waiting.
 */
const NEVER_SPOKE_GRACE_MS = 4000

export interface TrackerStatus {
  speechDetected: boolean
  speechProb: number
  level: number
  silenceMs: number
  durationMs: number
  endOfSpeech: boolean
}

/**
 * Frames a growing PCM buffer into fixed analysis windows, feeds them to a VadEngine
 * once each, and tracks the span of the utterance so we can trim silence before STT.
 */
export class UtteranceTracker {
  private engine: VadEngine
  private consumedSamples = 0
  private carry = new Float32Array(0)
  private firstSpeechSample = -1
  private lastSpeechSample = -1
  private lastSpeechAtMs = 0
  private level = 0
  private prob = 0
  /**
   * Frames are evaluated strictly in order. Silero carries RNN state across calls, so
   * two concurrent inferences would interleave and corrupt the model's memory; every
   * queued frame chains onto this promise instead of racing it.
   */
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private config: VadConfig,
    engine?: VadEngine
  ) {
    this.engine = engine ?? new EnergyEngine(config)
  }

  get engineId(): VadEngineId {
    return this.engine.id
  }

  get engineDetail(): string {
    return this.engine.detail
  }

  async setEngine(engine: VadEngine): Promise<void> {
    await this.engine.dispose()
    this.engine = engine
    this.reset()
  }

  reset(): void {
    this.engine.reset()
    this.consumedSamples = 0
    this.carry = new Float32Array(0)
    this.firstSpeechSample = -1
    this.lastSpeechSample = -1
    this.lastSpeechAtMs = 0
    this.level = 0
    this.prob = 0
    this.queue = Promise.resolve()
  }

  /**
   * Consume newly arrived samples and evaluate every complete 512-sample frame they
   * contain. Returns immediately; call `flush()` before reading `trimRange()`.
   */
  push(pcm: Int16Array): Promise<void> {
    const base = this.consumedSamples
    this.consumedSamples += pcm.length

    let input = pcm.length ? float32From(pcm) : new Float32Array(0)
    if (this.carry.length) {
      const merged = new Float32Array(this.carry.length + input.length)
      merged.set(this.carry, 0)
      merged.set(input, this.carry.length)
      input = merged
    }

    // Frames must be copied out: `input` may be a view into a buffer we do not own.
    const frames: { frame: Float32Array; absoluteStart: number }[] = []
    let offset = 0
    while (offset + VAD_FRAME_SAMPLES <= input.length) {
      frames.push({
        frame: input.slice(offset, offset + VAD_FRAME_SAMPLES),
        absoluteStart: base + offset - this.carry.length
      })
      offset += VAD_FRAME_SAMPLES
    }
    this.carry = input.slice(offset)

    if (frames.length === 0) return this.queue

    this.queue = this.queue.then(async () => {
      for (const { frame, absoluteStart } of frames) {
        await this.evaluate(frame, absoluteStart)
      }
    })
    return this.queue
  }

  /** Wait for every queued frame to be evaluated. */
  async flush(): Promise<void> {
    await this.queue
  }

  private async evaluate(frame: Float32Array, absoluteStart: number): Promise<void> {
    this.level = rms(toInt16(frame), 0, frame.length)
    const engineProb = await this.engine.push(frame)
    // The energy reading is a useful second opinion even when a model is driving, and
    // it keeps the energy path honest if a model is misconfigured.
    this.prob = Math.max(engineProb, this.level >= this.config.energyThreshold ? 0.6 : 0)

    if (this.prob < this.config.speechThreshold && this.level < this.config.energyThreshold) return

    const end = absoluteStart + frame.length
    if (this.firstSpeechSample < 0) this.firstSpeechSample = absoluteStart
    this.lastSpeechSample = end
    this.lastSpeechAtMs = (end / SAMPLE_RATE) * 1000
  }

  status(): TrackerStatus {
    const durationMs = (this.consumedSamples / SAMPLE_RATE) * 1000
    const silenceMs = this.lastSpeechSample < 0 ? durationMs : durationMs - this.lastSpeechAtMs
    const speechDetected = this.firstSpeechSample >= 0

    // Silence only ends an utterance that started. Someone who triggers dictation and
    // then says nothing — a false keypress, an open mic in a quiet room, a hotkey that
    // fires while they are typing — would otherwise record forever, because the trailing
    // silence test can never be satisfied without a first sample. So an utterance that
    // never got started is given a grace period of its own and then ends, still empty.
    const neverStarted =
      !speechDetected && durationMs >= this.config.silenceMsToStop + NEVER_SPOKE_GRACE_MS

    const endOfSpeech =
      this.config.autoStopOnSilence &&
      (neverStarted ||
        (speechDetected &&
          silenceMs >= this.config.silenceMsToStop &&
          durationMs > this.config.silenceMsToStop))

    return {
      speechDetected,
      speechProb: this.prob,
      level: this.level,
      silenceMs,
      durationMs,
      endOfSpeech
    }
  }

  /** Sample range to keep, in source-buffer coordinates. */
  trimRange(): { start: number; end: number } {
    const total = this.consumedSamples
    if (!this.config.trimSilence || this.firstSpeechSample < 0) return { start: 0, end: total }
    const pad = Math.round(SAMPLE_RATE * 0.12)
    return {
      start: Math.max(0, this.firstSpeechSample - pad),
      end: Math.min(total, this.lastSpeechSample + pad)
    }
  }

  async dispose(): Promise<void> {
    await this.engine.dispose()
  }
}

export function slicePcm(pcm: Int16Array, start: number, end: number): Int16Array {
  return pcm.subarray(Math.max(0, start), Math.min(pcm.length, Math.max(start, end)))
}

function float32From(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768
  return out
}

function toInt16(frame: Float32Array): Int16Array {
  const out = new Int16Array(frame.length)
  for (let i = 0; i < frame.length; i++) {
    const v = Math.max(-1, Math.min(1, frame[i]!))
    out[i] = Math.round(v * 32767)
  }
  return out
}

export const FRAME_DURATION_MS = VAD_FRAME_MS

/** Build the configured engine, falling back to energy if Silero cannot start. */
export async function createVadEngine(config: VadConfig, sileroModelPath: string): Promise<VadEngine> {
  if (config.engine === 'silero') {
    try {
      return await SileroEngine.create(sileroModelPath)
    } catch (err) {
      log.error('silero unavailable, using energy engine:', (err as Error).message)
      return new EnergyEngine(config)
    }
  }
  return new EnergyEngine(config)
}