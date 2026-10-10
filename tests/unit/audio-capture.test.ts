import { describe, expect, it } from 'vitest'
import { buildCaptureArgs, pickCaptureTool } from '../../src/main/core/linux/audio'

describe('buildCaptureArgs', () => {
  it('keeps the tuned parec flags (no-break: identical to the old hardcoded argv)', () => {
    expect(buildCaptureArgs('parec')).toEqual([
      '--format=s16le',
      '--rate=16000',
      '--channels=1',
      '--latency-msec=20'
    ])
  })

  it('passes --device through for parec', () => {
    expect(buildCaptureArgs('parec', 'bluez')).toContain('--device=bluez')
  })

  it('builds pw-record argv as s16 stdout capture', () => {
    const args = buildCaptureArgs('pw-record')
    expect(args).toContain('--format=s16')
    expect(args).toContain('--rate=16000')
    expect(args[args.length - 1]).toBe('-')
  })

  it('builds arecord argv as raw S16_LE', () => {
    const args = buildCaptureArgs('arecord')
    expect(args).toContain('S16_LE')
    expect(args).toContain('-t')
    expect(args).toContain('raw')
  })
})

describe('pickCaptureTool', () => {
  it('prefers parec when available', async () => {
    await expect(pickCaptureTool(() => true)).resolves.toBe('parec')
  })

  it('falls back to pw-record when parec is missing', async () => {
    await expect(pickCaptureTool((t) => t === 'pw-record')).resolves.toBe('pw-record')
  })

  it('falls back to arecord as a last resort', async () => {
    await expect(pickCaptureTool((t) => t === 'arecord')).resolves.toBe('arecord')
  })

  it('returns null when nothing is available', async () => {
    await expect(pickCaptureTool(() => false)).resolves.toBeNull()
  })
})
