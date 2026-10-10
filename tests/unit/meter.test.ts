import { describe, expect, it } from 'vitest'
import { LevelMeter } from '../../src/main/core/recorder'

/**
 * The widget's waveform is the only feedback the user gets while speaking, so the
 * mapping from real RMS to display height has to stay useful across the range of
 * microphone gains people actually have.
 */
describe('LevelMeter', () => {
  it('reports silence at zero', () => {
    expect(new LevelMeter().pushRms(0)).toBe(0)
  })

  it('never exceeds full scale, even on a clipping input', () => {
    const meter = new LevelMeter()
    for (const rms of [1, 5, 100]) {
      expect(meter.pushRms(rms)).toBe(1)
    }
  })

  it('leaves steady speech well short of full scale', () => {
    // A running-maximum design would report 1.0 here, which is why the scale is fixed:
    // a pinned waveform tells the user nothing.
    const meter = new LevelMeter()
    for (let i = 0; i < 100; i++) meter.pushRms(0.08)
    const level = meter.latest()
    expect(level).toBeGreaterThan(0.3)
    expect(level).toBeLessThan(0.9)
  })

  it('keeps quiet speech visible rather than flat against zero', () => {
    const meter = new LevelMeter()
    expect(meter.pushRms(0.03)).toBeGreaterThan(0.2)
  })

  it('is monotonic in input level', () => {
    const meter = new LevelMeter()
    const levels = [0.005, 0.01, 0.03, 0.08, 0.2, 0.4].map((r) => meter.pushRms(r))
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]!).toBeGreaterThan(levels[i - 1]!)
    }
  })

  it('keeps a bounded ring of recent values', () => {
    const meter = new LevelMeter(4)
    for (let i = 0; i < 10; i++) meter.pushRms(0.05)
    expect(meter.recent()).toHaveLength(4)
    expect(meter.latest()).toBeGreaterThan(0)
  })

  it('clears between utterances', () => {
    const meter = new LevelMeter()
    for (let i = 0; i < 50; i++) meter.pushRms(0.5)
    meter.clear()
    expect(meter.recent()).toHaveLength(0)
    expect(meter.pushRms(0)).toBe(0)
  })

  it('honours a custom ceiling', () => {
    const meter = new LevelMeter(64, 0.1)
    expect(meter.pushRms(0.1)).toBe(1)
    expect(meter.pushRms(0.05)).toBeLessThan(0.8)
  })

  it('exposes the speech threshold used for the frame flag', () => {
    expect(LevelMeter.speechFloor).toBeGreaterThan(0)
    expect(LevelMeter.speechFloor).toBeLessThan(0.1)
  })
})