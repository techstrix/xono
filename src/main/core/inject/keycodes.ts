/**
 * Linux evdev key codes (input-event-codes.h). ydotool speaks these directly.
 *
 * We hardcode only the two we need. For correctness on unusual layouts the
 * preferred path is the clipboard payload plus the Ctrl+V chord, because the chord
 * is layout-independent: the receiving application resolves V itself.
 */
export const EVDEV = {
  KEY_LEFTCTRL: 29,
  KEY_LEFTMETA: 125,
  KEY_V: 47,
  KEY_ENTER: 28,
  KEY_ESC: 1
} as const

export const CHORD_CTRL_V = [
  `${EVDEV.KEY_LEFTCTRL}:1`,
  `${EVDEV.KEY_V}:1`,
  `${EVDEV.KEY_V}:0`,
  `${EVDEV.KEY_LEFTCTRL}:0`
] as const

export const CHORD_ENTER = [`${EVDEV.KEY_ENTER}:1`, `${EVDEV.KEY_ENTER}:0`] as const

export const CHORD_ESCAPE = [`${EVDEV.KEY_ESC}:1`, `${EVDEV.KEY_ESC}:0`] as const

/** ydotool key-state syntax: `<code>:<state>` where 1 is pressed and 0 is released. */
export function keyDown(code: number): string {
  return `${code}:1`
}

export function keyUp(code: number): string {
  return `${code}:0`
}

export function chord(...codes: number[]): string[] {
  const down = codes.map(keyDown)
  const up = [...codes].reverse().map(keyUp)
  return [...down, ...up]
}