/**
 * Modifier keys, shown as labels rather than symbols.
 *
 * `⌃` was the symbol for Control, and rendered as a bare caret it reads as "up arrow" or
 * a stray punctuation mark rather than a key. Spelling the modifier out on a keycap is
 * unambiguous at a glance, which matters because the hotkey is otherwise undiscoverable.
 */
const MODIFIER_LABELS: Record<string, string> = {
  Super: 'super',
  Meta: 'super',
  Command: 'cmd',
  Control: 'ctrl',
  Ctrl: 'ctrl',
  Alt: 'alt',
  Option: 'alt',
  Shift: 'shift'
}

export interface AcceleratorKey {
  /** What is drawn on the keycap. */
  label: string
  /** Modifiers get a quieter keycap; named keys are the ones being memorised. */
  modifier: boolean
}

/**
 * Split an accelerator into keycaps, so each part is drawn rather than concatenated.
 *
 * `Control+Space` used to collapse to `⌃Space`: two glyphs in a run of text. As keycaps
 * the pairing is obvious at a glance and it reads as the chord it is.
 */
export function acceleratorKeys(accelerator: string): AcceleratorKey[] {
  if (!accelerator) return []
  return accelerator.split('+').filter(Boolean).map((part) => {
    const modifier = MODIFIER_LABELS[part]
    if (modifier) return { label: modifier, modifier: true }
    // Single letters read better lowercase in a keycap; named keys read better as words.
    const label = part.length === 1 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1)
    return { label, modifier: false }
  })
}

/** The accelerator as one string, for anywhere a single run of text is needed. */
export function prettyAccelerator(accelerator: string): string {
  return acceleratorKeys(accelerator).map((k) => k.label).join('+')
}
