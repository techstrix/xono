import { describe, expect, it } from 'vitest'
import { acceleratorKeys, prettyAccelerator } from '../../src/shared/accelerator'

/**
 * The hotkey is drawn as keycaps, so the accelerator has to split into parts rather than
 * collapse into one run of text. It used to render as `⌃Space`, where the caret glyph
 * reads as punctuation rather than a key and the pairing is invisible.
 */
describe('acceleratorKeys', () => {
  it('splits a chord into one keycap per key', () => {
    expect(acceleratorKeys('Control+Space')).toEqual([
      { label: 'ctrl', modifier: true },
      { label: 'Space', modifier: false }
    ])
  })

  it('marks modifiers apart from the keys being memorised', () => {
    const keys = acceleratorKeys('Control+Shift+Space')
    expect(keys.filter((k) => k.modifier).map((k) => k.label)).toEqual(['ctrl', 'shift'])
    expect(keys.filter((k) => !k.modifier).map((k) => k.label)).toEqual(['Space'])
  })

  it('handles every modifier spelling', () => {
    const cases: Array<[string, string]> = [
      ['Super+Space', 'super'],
      ['Meta+Space', 'super'],
      ['Command+Space', 'cmd'],
      ['Alt+Space', 'alt'],
      ['Option+Space', 'alt'],
      ['Ctrl+Space', 'ctrl']
    ]
    for (const [input, expected] of cases) {
      expect(acceleratorKeys(input)[0]?.label ?? '', input).toBe(expected)
    }
  })

  it('lowercases a single letter so it reads as a key, not a word fragment', () => {
    expect(acceleratorKeys('Control+A')[1]).toEqual({ label: 'a', modifier: false })
  })

  it('returns nothing for an empty accelerator rather than one blank keycap', () => {
    expect(acceleratorKeys('')).toEqual([])
  })

  it('ignores empty parts from a stray separator', () => {
    expect(acceleratorKeys('Control++Space').map((k) => k.label)).toEqual(['ctrl', 'Space'])
  })
})

describe('prettyAccelerator', () => {
  it('still produces a single readable string', () => {
    expect(prettyAccelerator('Control+Space')).toBe('ctrl+Space')
  })

  it('handles an empty accelerator', () => {
    expect(prettyAccelerator('')).toBe('')
  })
})
