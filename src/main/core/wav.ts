import { CHANNELS, SAMPLE_RATE } from '@shared/types'

/**
 * Minimal RIFF/WAVE codec for 16 kHz mono 16-bit PCM, which is exactly what
 * whisper.cpp wants. We only ever write this format, but decoding keeps the
 * recorder testable without spawning anything.
 */

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768
  return out
}

export function float32ToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, f32[i]!))
    out[i] = Math.round(clamped * 32767)
  }
  return out
}

export function encodeWav(pcm: Int16Array, sampleRate = SAMPLE_RATE, channels = CHANNELS): Buffer {
  const bytesPerSample = 2
  const dataBytes = pcm.length * bytesPerSample
  const buffer = Buffer.alloc(44 + dataBytes)

  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20) // audioFormat = PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28) // byteRate
  buffer.writeUInt16LE(channels * bytesPerSample, 32) // blockAlign
  buffer.writeUInt16LE(16, 34) // bitsPerSample
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < pcm.length; i++) buffer.writeInt16LE(pcm[i]!, 44 + i * bytesPerSample)
  return buffer
}

export interface DecodedWav {
  pcm: Int16Array
  sampleRate: number
  channels: number
}

export function decodeWav(bytes: Buffer): DecodedWav {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE buffer')
  }

  let offset = 12
  let channels = 1
  let sampleRate = SAMPLE_RATE
  let bitsPerSample = 16
  let dataStart = -1
  let dataLength = 0

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ' && size >= 16) {
      channels = bytes.readUInt16LE(body + 2)
      sampleRate = bytes.readUInt32LE(body + 4)
      bitsPerSample = bytes.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataStart = body
      dataLength = Math.min(size, bytes.length - body)
      break
    }
    offset = body + size + (size % 2)
  }

  if (dataStart < 0) throw new Error('WAVE buffer has no data chunk')
  if (bitsPerSample !== 16) throw new Error(`unsupported bit depth: ${bitsPerSample}`)

  const total = Math.floor(dataLength / 2)
  const pcm = new Int16Array(total)
  for (let i = 0; i < total; i++) pcm[i] = bytes.readInt16LE(dataStart + i * 2)

  if (channels === 1) return { pcm, sampleRate, channels }

  // Interleaved samples: `total` values hold `total / channels` frames.
  const frames = Math.floor(total / channels)
  return { pcm: downmix(pcm, channels, frames), sampleRate, channels: 1 }
}

function downmix(pcm: Int16Array, channels: number, frames: number): Int16Array {
  const out = new Int16Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let c = 0; c < channels; c++) sum += pcm[f * channels + c]!
    out[f] = Math.round(sum / channels)
  }
  return out
}

export function pcmDurationMs(pcm: Int16Array, sampleRate = SAMPLE_RATE): number {
  return (pcm.length / sampleRate) * 1000
}

/** Root-mean-square of a slice, normalised to roughly 0..1. */
export function rms(pcm: Int16Array, start = 0, end = pcm.length): number {
  const n = end - start
  if (n <= 0) return 0
  let sum = 0
  for (let i = start; i < end; i++) {
    const v = pcm[i]! / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

export function peak(pcm: Int16Array, start = 0, end = pcm.length): number {
  let max = 0
  for (let i = start; i < end; i++) {
    const v = Math.abs(pcm[i]! / 32768)
    if (v > max) max = v
  }
  return max
}