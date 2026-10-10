import { accessSync, constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { InjectResult, PreflightCheck } from '@shared/types'
import type { InjectionMethod } from '@shared/schema'
import { loggerScope } from '../logger'
import { commandExists, runCommand } from '../exec'
import { currentDistro, installFix } from '../linux/distro'
import { CHORD_CTRL_V, CHORD_ENTER } from './keycodes'
import { YdotoolDaemon } from './ydotoold'
import type { InjectOptions, Injector, TextSource } from './types'

const log = loggerScope('inject')
const execFileAsync = promisify(execFile)

/** ydotool exits 2 with no stderr when its daemon socket is gone. */
function isDaemonUnreachable(err: unknown): boolean {
  const e = err as { code?: number | null; message?: string; stderr?: string }
  if (e.code !== 2) return false
  return !e.stderr || /socket|ydotoold/i.test(e.stderr)
}

/** Gap between the four key events of the Ctrl+V chord, in milliseconds. */
export const KEY_EVENT_DELAY_MS = 12

/**
 * What we last put into the focused field.
 *
 * Injection lands at the caret, so two dictations in a row paste end-to-end and read as
 * one sentence — "…the service" immediately followed by "…and the tests" with nothing
 * between them. There is no way to ask a text field what it already contains, so this
 * records what *we* pasted and assumes the caret has not moved since.
 *
 * Process-level rather than per-injector state: `resolveInjector` builds a fresh injector
 * on every injection, so an instance field would be empty by the time it mattered.
 */
let lastPaste: { at: number; text: string } | null = null

export function notePaste(text: string): void {
  lastPaste = { at: Date.now(), text }
}

/** Forget the last paste, e.g. when the user moves on to a different task. */
export function clearPasteNote(): void {
  lastPaste = null
}

/**
 * Decide whether this paste needs a separator in front of it.
 *
 * Deliberately conservative: a leading space in a field the user had already cleared is
 * harmless, whereas running two sentences together is exactly the bug this fixes. It is
 * also skipped when the text is already separated — by its own leading whitespace, by the
 * previous paste's trailing newline, or because enough time has passed that the user has
 * almost certainly typed something else in between.
 */
export function leadingSeparator(
  text: string,
  options: Pick<InjectOptions, 'appendSeparator' | 'appendWindowMs' | 'trailingNewline'>
): string {
  if (options.appendSeparator === 'none') return ''
  if (!lastPaste) return ''
  if (Date.now() - lastPaste.at > options.appendWindowMs) return ''

  // Already separated: this text starts with whitespace, or the previous paste already
  // ended with one. `lastPaste.text` is the full payload that was sent, so a previous
  // paste with trailingNewline on already ends in a newline and is caught here.
  if (/^\s/.test(text)) return ''
  if (/\s$/.test(lastPaste.text)) return ''

  return options.appendSeparator === 'newline' ? '\n' : ' '
}

/**
 * Puts text on the clipboard, then asks a virtual keyboard to send Ctrl+V.
 *
 * The clipboard carries the payload and the virtual keyboard carries only the
 * chord. That split matters: typing characters one at a time is far too slow for a
 * paragraph and mangles anything non-ASCII, while the Ctrl+V chord is
 * layout-independent because the receiving application resolves V itself.
 */
export class ClipboardPasteInjector implements Injector {
  /** Shared so the daemon is started at most once across all injectors. */
  static daemon = new YdotoolDaemon()

  constructor(
    readonly id: string,
    readonly method: InjectionMethod,
    private readonly clipboard: TextSource,
    private readonly keySender: 'ydotool' | 'xdotool'
  ) {}

  async preflight(): Promise<PreflightCheck[]> {
    const checks: PreflightCheck[] = []
    const binary = this.keySender

    const installed = await commandExists(binary)
    const pm = currentDistro().pm
    const fixPkg = binary === 'ydotool' ? 'ydotool' : 'xdotool'
    checks.push({
      id: `${binary}-installed`,
      label: `${binary} is installed`,
      ok: installed,
      severity: 'error',
      detail: installed ? 'found on PATH' : `${binary} is not on PATH`,
      fixes: installed ? [] : [installFix(fixPkg, pm)]
    })

    // ydotool is only a client; without the daemon every invocation exits 2 with
    // "failed to connect socket". xdotool needs no daemon.
    if (binary === 'ydotool') {
      const daemon = ClipboardPasteInjector.daemon.peek()
      checks.push({
        id: 'ydotoold',
        label: 'ydotoold is running',
        ok: daemon.ok,
        // Not an error: xono starts the daemon on first use.
        severity: daemon.ok ? 'info' : 'warning',
        detail: daemon.ok
          ? daemon.detail
          : `${daemon.detail} Xono starts it automatically on the first dictation.`,
        fixes: daemon.ok
          ? []
          : [
              'For a daemon that survives app restarts, add a systemd user unit:',
              'sudo systemctl --user enable --now ydotool   (or: systemctl --user start ydotoold)',
              `Daemon-less alternative on Wayland compositors with virtual-keyboard support: ${installFix('wtype', pm)}`
            ]
      })
    }

    const uinputReadable = canReadUinput()
    checks.push({
      id: 'uinput',
      label: '/dev/uinput is readable',
      ok: uinputReadable,
      severity: 'error',
      detail: uinputReadable
        ? 'ok'
        : 'missing, or your user cannot open it. Virtual keyboards need write access to /dev/uinput.',
      fixes: uinputReadable
        ? []
        : [
            'sudo modprobe uinput',
            `echo 'KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"' | sudo tee /etc/udev/rules.d/99-uinput.rules`,
            'sudo udevadm control --reload-rules && sudo udevadm trigger',
            'reboot, then log out and back in'
          ]
    })

    const inInputGroup = await isInGroup('input')
    checks.push({
      id: 'input-group',
      label: 'Your user is in the input group',
      ok: inInputGroup,
      severity: 'warning',
      detail: inInputGroup ? 'ok' : 'required to open /dev/uinput',
      fixes: inInputGroup ? [] : ['sudo usermod -aG input $USER', 'log out and back in for the group to take effect']
    })

    const session = sessionType()
    const expected = this.keySender === 'ydotool' ? 'wayland' : 'x11'
    checks.push({
      id: 'session-type',
      label: `Session matches ${this.keySender} (${expected})`,
      ok: session === expected,
      severity: session === expected ? 'info' : 'error',
      detail: `Detected ${session}`,
      fixes:
        session === expected
          ? []
          : this.keySender === 'ydotool'
            ? ['You are on an X11 session; switch the injection method to xdotool in Settings → Injection.']
            : ['You are on a Wayland session; switch the injection method to ydotool in Settings → Injection.']
    })

    return checks
  }

  async inject(text: string, options: InjectOptions): Promise<InjectResult> {
    if (!text.trim()) {
      return { ok: false, method: this.method, error: 'nothing to inject', clipboardRestored: false }
    }

    const payload = this.buildPayload(text, options)
    // Captured before writing, so the user's own clipboard can be put back afterwards.
    const previous = await this.clipboard.read()

    try {
      await this.clipboard.write(payload)
      // Give the compositor a moment to publish the clipboard selection before the
      // receiving application asks for it.
      await delay(60)
      await this.sendChord()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('injection failed', message)
      if (options.restoreClipboard) await this.clipboard.write(previous)
      return { ok: false, method: this.method, error: message, clipboardRestored: false }
    }

    let restored = false
    if (options.restoreClipboard) {
      await delay(options.restoreClipboardDelayMs)
      // Restore unconditionally, *including to an empty string*.
      //
      // Skipping the restore when the previous value was empty left this dictation's
      // text sitting on the clipboard. The next dictation then captured that as its
      // "previous" value and restored it in turn, so the clipboard ended up permanently
      // holding an earlier dictation — and anything pasting from it later got a stale
      // sentence. Always restoring means dictated text never outlives its own paste.
      //
      // The equality check stops us clobbering something the user copied in the
      // meantime, which is the one case where leaving the clipboard alone is right.
      if ((await this.clipboard.read()) === payload) {
        await this.clipboard.write(previous)
      } else {
        log.debug('clipboard changed while restoring; leaving it alone')
      }
      restored = true
    }

    notePaste(payload)
    return { ok: true, method: this.method, clipboardRestored: restored }
  }

  /** Text plus whatever separation is needed before it, and the trailing newline. */
  private buildPayload(text: string, options: InjectOptions): string {
    const separator = leadingSeparator(text, options)
    const body = `${separator}${text}`
    return options.trailingNewline ? `${body}\n` : body
  }

  /**
   * Send the chord. ydotool needs its daemon up first; xdotool talks to X directly and
   * needs no setup. The delay gives the receiving app a moment to register the
   * modifier before the V press arrives.
   */
  private async sendChord(): Promise<void> {
    if (this.keySender !== 'ydotool') {
      await runCommand('xdotool', ['key', 'ctrl+v'], 5000)
      return
    }

    const daemon = await ClipboardPasteInjector.daemon.ensure()
    if (!daemon.ok) {
      throw new Error(daemon.detail)
    }

    const args = ['key', '-d', String(KEY_EVENT_DELAY_MS), ...CHORD_CTRL_V]
    try {
      await runCommand('ydotool', args, 5000)
    } catch (err) {
      // Exit code 2 with no output is ydotool telling us it could not reach the
      // daemon. That happens when the socket file outlived its process, so clear it
      // and try exactly once more before giving up.
      if (!isDaemonUnreachable(err)) throw err
      log.warn('ydotool could not reach ydotoold, restarting it and retrying once')
      const restarted = await ClipboardPasteInjector.daemon.restart()
      if (!restarted.ok) {
        throw new Error(restarted.detail)
      }
      await runCommand('ydotool', args, 5000)
    }
  }

  /** Kill a daemon this process started. */
  stopOwnedDaemon(): void {
    ClipboardPasteInjector.daemon.stop()
  }
}

/**
 * Last-resort injector: places the text on the clipboard and leaves it there so the
 * user can paste with their own hands. Never fails, but it is not automatic.
 */
export class ClipboardOnlyInjector implements Injector {
  readonly id = 'clipboard'
  readonly method = 'clipboard-only' as const

  constructor(private readonly clipboard: TextSource) {}

  async preflight(): Promise<PreflightCheck[]> {
    return [
      {
        id: 'clipboard-only',
        label: 'Clipboard access',
        ok: true,
        severity: 'info',
        detail: 'Text will be placed on the clipboard; press Ctrl+V to paste it yourself.',
        fixes: []
      }
    ]
  }

  /**
   * There is nothing to press here, so the text has to stay on the clipboard for the
   * user to paste themselves — which is exactly the documented trade-off of this method.
   */
  async inject(text: string, options: InjectOptions): Promise<InjectResult> {
    const separator = leadingSeparator(text, options)
    const body = `${separator}${text}`
    const payload = options.trailingNewline ? `${body}\n` : body
    await this.clipboard.write(payload)
    notePaste(payload)
    return { ok: true, method: this.method, clipboardRestored: false }
  }
}

export function canReadUinput(): boolean {
  try {
    accessSync('/dev/uinput', constants.R_OK | constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function isInGroup(group: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('id', ['-nG'], { timeout: 3000 })
    return stdout.split(/\s+/).includes(group)
  } catch {
    return false
  }
}

export function sessionType(): string {
  return process.env.XDG_SESSION_TYPE ?? (process.env.WAYLAND_DISPLAY ? 'wayland' : 'x11')
}

export async function sendEnter(): Promise<void> {
  if (await commandExists('ydotool')) {
    await runCommand('ydotool', ['key', ...CHORD_ENTER], 5000)
  } else if (await commandExists('xdotool')) {
    await runCommand('xdotool', ['key', 'Return'], 5000)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}