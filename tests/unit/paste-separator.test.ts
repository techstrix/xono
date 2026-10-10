import { beforeEach, describe, expect, it } from 'vitest'
import {
  ClipboardPasteInjector,
  clearPasteNote,
  leadingSeparator,
  notePaste
} from '../../src/main/core/inject/clipboardPaste'
import { DEFAULT_CONFIG } from '../../src/shared/schema'

/**
 * Regression coverage for two consecutive dictations being pasted end to end.
 *
 * Injection lands at the caret. If the user dictates, then dictates again without moving
 * the caret, the second text is pasted immediately after the first with nothing between
 * them, so two instructions read as one run-on sentence.
 */
const injectOptions = {
  ...DEFAULT_CONFIG.inject,
  // ydotool is exercised by the live suite; here we only care about the payload, so
  // point the injector at the clipboard-only path by giving it a stub sender.
  restoreClipboard: false
}

function stubInjector(): { injector: ClipboardPasteInjector; written: () => string } {
  let written = ''
  const injector = new ClipboardPasteInjector(
    'test',
    'clipboard-only',
    { read: async () => '', write: async (t: string) => void (written = t) },
    'ydotool'
  )
  // The clipboard path is what is under test, so bypass the key chord entirely.
  injector.preflight = async () => []
  return { injector, written: () => written }
}

beforeEach(() => {
  clearPasteNote()
})

describe('leadingSeparator', () => {
  it('adds nothing on the very first paste', () => {
    expect(leadingSeparator('hello', injectOptions)).toBe('')
  })

  it('separates a second dictation from the first', () => {
    notePaste('first dictation')
    expect(leadingSeparator('second dictation', injectOptions)).toBe(' ')
  })

  it('supports a newline separator', () => {
    notePaste('first')
    expect(
      leadingSeparator('second', { ...injectOptions, appendSeparator: 'newline' })
    ).toBe('\n')
  })

  it('adds nothing when the separator is disabled', () => {
    notePaste('first')
    expect(leadingSeparator('second', { ...injectOptions, appendSeparator: 'none' })).toBe('')
  })

  it('adds nothing once the window has passed', async () => {
    notePaste('first')
    await new Promise((r) => setTimeout(r, 5))
    expect(
      leadingSeparator('second', { ...injectOptions, appendWindowMs: 1 }),
      'a stale paste means the user has moved on'
    ).toBe('')
  })

  it('adds nothing when the new text already begins with whitespace', () => {
    notePaste('first')
    expect(leadingSeparator(' second', injectOptions)).toBe('')
    expect(leadingSeparator('\nsecond', injectOptions)).toBe('')
  })

  it('adds nothing when the previous paste already ended with whitespace', () => {
    notePaste('first\n')
    expect(leadingSeparator('second', injectOptions)).toBe('')
  })

  it('adds nothing when the previous paste already ended with a newline', () => {
    // `notePaste` records the payload that was actually sent, which includes the
    // trailing newline when trailingNewline is on.
    notePaste('first\n')
    expect(leadingSeparator('second', injectOptions)).toBe('')
  })
})

describe('clipboard-only injector', () => {
  it('separates back-to-back dictations', async () => {
    const { injector, written } = stubInjector()

    await injector.inject('first dictation', injectOptions)
    expect(written()).toBe('first dictation')

    await injector.inject('second dictation', injectOptions)
    expect(written()).toBe(' second dictation')
  })

  it('does not separate a first dictation in a fresh field', async () => {
    const { injector, written } = stubInjector()
    await injector.inject('only one', injectOptions)
    expect(written()).toBe('only one')
  })

  it('keeps three in a row all separated', async () => {
    const { injector, written } = stubInjector()
    await injector.inject('one', injectOptions)
    await injector.inject('two', injectOptions)
    await injector.inject('three', injectOptions)
    expect(written()).toBe(' three')
  })

  it('combines the separator with a trailing newline without doubling it', async () => {
    const { injector, written } = stubInjector()
    const withNewline = { ...injectOptions, trailingNewline: true }

    await injector.inject('one', withNewline)
    // The first paste ends with a newline, so the second needs no extra separator.
    await injector.inject('two', withNewline)
    expect(written()).toBe('two\n')
  })

  it('honours a newline separator end to end', async () => {
    const { injector, written } = stubInjector()
    const opts = { ...injectOptions, appendSeparator: 'newline' as const }

    await injector.inject('first', opts)
    await injector.inject('second', opts)
    expect(written()).toBe('\nsecond')
  })

  it('does not note a paste that was never attempted', async () => {
    const { injector } = stubInjector()
    const result = await injector.inject('   ', injectOptions)
    expect(result.ok).toBe(false)
    expect(leadingSeparator('next', injectOptions)).toBe('')
  })

  it('stops separating after the note is cleared', async () => {
    const { injector, written } = stubInjector()
    await injector.inject('first', injectOptions)
    clearPasteNote()
    await injector.inject('second', injectOptions)
    expect(written()).toBe('second')
  })
})
