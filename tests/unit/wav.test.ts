import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav, float32ToInt16, int16ToFloat32, peak, pcmDurationMs, rms } from '../../src/main/core/wav'
import { SAMPLE_RATE } from '../../src/shared/types'

function silence(samples: number): Int16Array {
  return new Int16Array(samples)
}

function tone(samples: number, amplitude: number, freqHz = 220): Int16Array {
  const out = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    out[i] = Math.round(Math.sin((2 * Math.PI * freqHz * i) / SAMPLE_RATE) * amplitude * 32767)
  }
  return out
}

describe('sample conversion', () => {
  it('round-trips within int16 precision', () => {
    const original = tone(1000, 0.5)
    const f32 = int16ToFloat32(original)
    expect(float32ToInt16(f32)).toEqual(original)
  })

  it('clamps out-of-range input rather than wrapping', () => {
    const out = float32ToInt16(new Float32Array([2, -2, 0]))
    expect(out[0]).toBe(32767)
    expect(out[1]).toBe(-32767)
    expect(out[2]).toBe(0)
  })
})

describe('wav codec', () => {
  it('writes a 16 kHz mono RIFF header', () => {
    const buf = encodeWav(tone(16000, 0.3))
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF')
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE')
    expect(buf.readUInt32LE(24)).toBe(SAMPLE_RATE)
    expect(buf.readUInt16LE(22)).toBe(1) // channels
    expect(buf.readUInt16LE(34)).toBe(16) // bits per sample
    expect(buf.readUInt32LE(40)).toBe(16000 * 2) // data bytes
    expect(buf.length).toBe(44 + 32000)
  })

  it('decodes what it encodes', () => {
    const pcm = tone(8000, 0.7, 330)
    const decoded = decodeWav(encodeWav(pcm))
    expect(decoded.sampleRate).toBe(SAMPLE_RATE)
    expect(decoded.channels).toBe(1)
    expect(decoded.pcm).toEqual(pcm)
  })

  it('downmixes stereo to mono', () => {
    // Hand-build a stereo file: the same frame left and right, one offset by +1000.
    const frames = 100
    const buf = Buffer.alloc(44 + frames * 2 * 2)
    buf.write('RIFF', 0, 'ascii')
    buf.writeUInt32LE(buf.length - 8, 4)
    buf.write('WAVE', 8, 'ascii')
    buf.write('fmt ', 12, 'ascii')
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(2, 22)
    buf.writeUInt32LE(SAMPLE_RATE, 24)
    buf.writeUInt32LE(SAMPLE_RATE * 4, 28)
    buf.writeUInt16LE(4, 32)
    buf.writeUInt16LE(16, 34)
    buf.write('data', 36, 'ascii')
    buf.writeUInt32LE(frames * 4, 40)
    for (let i = 0; i < frames; i++) {
      buf.writeInt16LE(1000, 44 + i * 4)
      buf.writeInt16LE(3000, 44 + i * 4 + 2)
    }

    const decoded = decodeWav(buf)
    expect(decoded.channels).toBe(1)
    expect(decoded.pcm.length).toBe(frames)
    expect(decoded.pcm[0]).toBe(2000)
  })

  it('rejects a non-WAVE buffer', () => {
    expect(() => decodeWav(Buffer.from('not a wav file at all, really'))).toThrow(/RIFF/)
  })

  it('rejects an unsupported bit depth', () => {
    const buf = Buffer.alloc(64)
    buf.write('RIFF', 0, 'ascii')
    buf.write('WAVE', 8, 'ascii')
    buf.write('fmt ', 12, 'ascii')
    buf.writeUInt32LE(16, 16)
    buf.writeUInt16LE(1, 20)
    buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(SAMPLE_RATE, 24)
    buf.writeUInt32LE(SAMPLE_RATE * 3, 28)
    buf.writeUInt16LE(3, 32)
    buf.writeUInt16LE(24, 34)
    buf.write('data', 36, 'ascii')
    expect(() => decodeWav(buf)).toThrow(/bit depth/)
  })
})

describe('level measurement', () => {
  it('reports zero for silence', () => {
    expect(rms(silence(1024))).toBe(0)
    expect(peak(silence(1024))).toBe(0)
  })

  it('reports half amplitude for a half-scale tone', () => {
    // A sine's RMS is amplitude / sqrt(2), so allow a small tolerance.
    expect(rms(tone(8192, 0.5))).toBeGreaterThan(0.34)
    expect(rms(tone(8192, 0.5))).toBeLessThan(0.36)
  })

  it('measures only the requested range', () => {
    const mixed = new Int16Array(2048)
    mixed.fill(0)
    for (let i = 1024; i < 2048; i++) mixed[i] = 30000
    expect(rms(mixed, 0, 1024)).toBe(0)
    expect(rms(mixed, 1024, 2048)).toBeGreaterThan(0.9)
  })

  it('computes duration', () => {
    expect(pcmDurationMs(new Int16Array(SAMPLE_RATE))).toBeCloseTo(1000, 6)
  })
})