import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CHANNELS, SAMPLE_RATE, type WaveFrame } from '@shared/types'
import { loggerScope } from './logger'

const log = loggerScope('recorder')
const execFileAsync = promisify(execFile)

export interface AudioDevice {
  id: string
  name: string
  isDefault: boolean
}

export type RecorderSink = (frame: WaveFrame, totalSamples: number) => void

/** Raw PCM as it arrives from the capture process, for the VAD to consume. */
export type ChunkSink = (pcm: Int16Array) => void

/**
 * RMS at which the waveform display reaches full height.
 *
 * A fixed scale rather than an auto-ranged one: a running maximum always equals the
 * loudest recent sample, so steady speech would sit pinned at 100% and the widget
 * would stop conveying anything. 0.25 was chosen so conversational speech lands
 * around a third to two thirds of the display on a normally-configured microphone.
 */
const DISPLAY_RMS_CEILING = 0.25

/** RMS below which audio counts as silence for the frame's `speech` flag. */
const SPEECH_RMS_FLOOR = 0.03

/**
 * Ring of recent levels so the widget can draw a scrolling waveform.
 *
 * The scale is fixed (see `DISPLAY_RMS_CEILING`) and the mapping is a gamma curve:
 * linear RMS spends most of its range near zero and makes quiet speech look like
 * silence, whereas the gamma lifts the bottom end into the visible range.
 */
export class LevelMeter {
  private readonly values: number[] = []

  constructor(
    private readonly capacity = 64,
    private readonly ceiling = DISPLAY_RMS_CEILING
  ) {}

  /** Feed a raw RMS reading (0..1); returns the normalised level to display. */
  pushRms(rms: number): number {
    const ratio = Math.min(1, Math.max(0, rms) / this.ceiling)
    const level = Math.pow(ratio, 0.7)
    this.push(level)
    return level
  }

  /** RMS at or above this counts as the `speech` flag on a frame. */
  static get speechFloor(): number {
    return SPEECH_RMS_FLOOR
  }

  push(level: number): void {
    this.values.push(level)
    if (this.values.length > this.capacity) this.values.shift()
  }

  recent(): number[] {
    return this.values
  }

  latest(): number {
    return this.values[this.values.length - 1] ?? 0
  }

  clear(): void {
    this.values.length = 0
  }
}

export interface RecorderOptions {
  deviceId?: string
  /** Called roughly every 32 ms with the current waveform frame. */
  onFrame?: RecorderSink
  /** Called with each block of raw PCM, as it arrives. This is what feeds the VAD. */
  onChunk?: ChunkSink
  /** Called when the audio process dies unexpectedly. */
  onError?: (err: Error) => void
}

/**
 * Captures 16 kHz mono s16le PCM by shelling out to PipeWire's `parec`.
 *
 * Why a subprocess rather than an npm native module: `parec` ships with
 * pipewire-utils (already present on any modern desktop), negotiates the format for
 * us, and — unlike portaudio/GStreamer bindings — carries no ABI that breaks when
 * Electron updates. The trade-off is one process per utterance.
 */
type Capture = ChildProcessByStdio<null, Readable, Readable>

export class AudioRecorder {
  private child: Capture | null = null
  private chunks: Buffer[] = []
  private carry: Buffer = Buffer.alloc(0)
  private totalSamples = 0
  private startedAt = 0
  private stopping = false

  readonly meter = new LevelMeter()

  get isRunning(): boolean {
    return this.child !== null && !this.stopping
  }

  get sampleCount(): number {
    return this.totalSamples
  }

  async start(opts: RecorderOptions = {}): Promise<void> {
    if (this.child) throw new Error('recorder already running')
    this.reset()

    const args = [
      `--format=s16le`,
      `--rate=${SAMPLE_RATE}`,
      `--channels=${CHANNELS}`,
      `--latency-msec=20`
    ]
    if (opts.deviceId) args.push(`--device=${opts.deviceId}`)

    log.debug('spawning parec', args.join(' '))
    let child: Capture
    try {
      child = spawn('parec', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      throw new Error(
        `Could not start audio capture: ${(err as Error).message}. Install pipewire-utils with \`sudo pacman -S pipewire-utils\`.`
      )
    }

    this.child = child
    this.startedAt = Date.now()

    let spawnFailure: Error | null = null
    child.on('error', (err) => {
      spawnFailure = new Error(
        `Audio capture failed to start: ${err.message}. Install pipewire-utils with \`sudo pacman -S pipewire-utils\`.`
      )
      log.error('parec error', err)
    })

    child.stdout.on('data', (data: Buffer) => this.ingest(data, opts))

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) log.warn('parec:', text)
    })

    child.on('close', (code, signal) => {
      if (!this.stopping) {
        const err = new Error(
          `Audio capture stopped unexpectedly (code=${code} signal=${signal}). Check that a microphone is connected and not exclusively owned by another app.`
        )
        log.error('parec exited', { code, signal })
        opts.onError?.(spawnFailure ?? err)
      }
      this.child = null
    })

    // Give parec a moment to fail fast if the device or daemon is unavailable,
    // rather than letting the user talk into nothing.
    await Promise.race([once(child, 'spawn'), delay(600)])
    if (spawnFailure) {
      this.child = null
      throw spawnFailure
    }
  }

  private ingest(data: Buffer, opts: RecorderOptions): void {
    const buf: Buffer = this.carry.length ? Buffer.concat([this.carry, data]) : data
    const usable = buf.length - (buf.length % 2)
    this.carry = buf.subarray(usable)

    if (usable <= 0) return
    const slice = buf.subarray(0, usable)
    this.chunks.push(slice)
    this.totalSamples += usable / 2

    const pcm = toInt16(slice)
    opts.onChunk?.(pcm)

    if (opts.onFrame) {
      // 512 samples is the natural analysis frame; it is ~32 ms at 16 kHz which
      // matches the widget's refresh rate closely enough.
      let sum = 0
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i]! / 32768
        sum += v * v
      }
      const rms = Math.sqrt(sum / Math.max(1, pcm.length))
      const level = this.meter.pushRms(rms)
      opts.onFrame(
        { level, speech: rms >= LevelMeter.speechFloor ? 1 : 0, t: Date.now() - this.startedAt },
        this.totalSamples
      )
    }
  }

  /** Stop capture and return everything captured so far. */
  async stop(): Promise<Int16Array> {
    if (!this.child) return this.collect()
    this.stopping = true
    const child = this.child
    this.child = null

    try {
      child.kill('SIGTERM')
    } catch {
      /* already gone */
    }

    const timeout = delay(500).then(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    })
    await Promise.race([once(child, 'close').catch(() => undefined), timeout])
    return this.collect()
  }

  cancel(): void {
    this.stopping = true
    try {
      this.child?.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    this.child = null
    this.reset()
  }

  private collect(): Int16Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const merged = Buffer.concat(this.chunks, total)
    const out = new Int16Array(merged.length >> 1)
    for (let i = 0; i < out.length; i++) out[i] = merged.readInt16LE(i * 2)
    return out
  }

  private reset(): void {
    this.chunks = []
    this.carry = Buffer.alloc(0)
    this.totalSamples = 0
    this.stopping = false
    this.meter.clear()
  }
}

function toInt16(buf: Buffer): Int16Array {
  const out = new Int16Array(buf.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2)
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Enumerate PipeWire input devices via `pactl`, best-effort. */
export async function listInputDevices(): Promise<AudioDevice[]> {
  try {
    const { stdout } = await execFileAsync('pactl', ['list', 'sources', 'short'], {
      timeout: 3000
    })
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, rest = ''] = line.split(/\s+/)
        return { id: id ?? '', name: rest.trim(), isDefault: rest.includes('default') }
      })
      .filter((d) => d.id !== '' && !d.name.includes('monitor'))
  } catch (err) {
    log.warn('could not enumerate audio devices', err)
    return []
  }
}