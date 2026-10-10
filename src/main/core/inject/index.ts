import { clipboard } from 'electron'
import type { InjectionMethod } from '@shared/schema'
import { loggerScope } from '../logger'
import { ClipboardOnlyInjector, ClipboardPasteInjector, sessionType } from './clipboardPaste'
import type { Injector, TextSource } from './types'

const log = loggerScope('inject')

export {
  ClipboardOnlyInjector,
  ClipboardPasteInjector,
  canReadUinput,
  clearPasteNote,
  isInGroup,
  leadingSeparator,
  notePaste,
  sendEnter,
  sessionType
} from './clipboardPaste'
export { YdotoolDaemon, daemonRunning, existingSocket, socketPaths } from './ydotoold'
export { CHORD_CTRL_V, CHORD_ENTER, EVDEV, chord } from './keycodes'
export type { InjectOptions, Injector, TextSource } from './types'

/**
 * Electron's clipboard module talks to the Wayland compositor on Wayland and X11 on
 * X11, so this single adapter works for both without shelling out to wl-copy.
 */
export const electronClipboard: TextSource = {
  read: () => clipboard.readText(),
  write: async (text: string) => {
    await clipboard.writeText(text)
  }
}

export function createInjector(method: InjectionMethod, source: TextSource = electronClipboard): Injector {
  switch (method) {
    case 'clipboard-ydotool':
      return new ClipboardPasteInjector('ydotool', method, source, 'ydotool')
    case 'clipboard-xdotool':
      return new ClipboardPasteInjector('xdotool', method, source, 'xdotool')
    case 'clipboard-only':
      return new ClipboardOnlyInjector(source)
    default:
      log.warn(`unknown injection method ${method}; falling back to the session default`)
      return defaultInjector(source)
  }
}

function defaultInjector(source: TextSource): Injector {
  return sessionType() === 'wayland'
    ? new ClipboardPasteInjector('ydotool', 'clipboard-ydotool', source, 'ydotool')
    : new ClipboardPasteInjector('xdotool', 'clipboard-xdotool', source, 'xdotool')
}

/**
 * Pick something that actually works on this machine, regardless of what is in the
 * config. Settings can request a specific method, but a broken method should not be
 * allowed to silently swallow a user's dictation.
 */
export async function resolveInjector(
  preferred: InjectionMethod,
  source: TextSource = electronClipboard
): Promise<{ injector: Injector; degraded: boolean; reason?: string }> {
  const candidate = createInjector(preferred, source)
  if (candidate.method === 'clipboard-only') return { injector: candidate, degraded: false }

  const checks = await candidate.preflight()
  const blocking = checks.filter((c) => c.severity === 'error' && !c.ok)
  if (blocking.length === 0) return { injector: candidate, degraded: false }

  const fallback = new ClipboardOnlyInjector(source)
  log.warn(`injection method ${preferred} is unusable, degrading to clipboard-only`)
  return {
    injector: fallback,
    degraded: true,
    reason: blocking.map((c) => `${c.label}: ${c.detail}`).join('; ')
  }
}