import type { InjectionMethod } from '@shared/schema'
import type { InjectResult } from '@shared/types'
import type { PreflightCheck } from '@shared/types'

export interface InjectOptions {
  method: InjectionMethod
  restoreClipboard: boolean
  restoreClipboardDelayMs: number
  typeDelayMs: number
  trailingNewline: boolean
  /** Separator to place before text that follows an earlier dictation. */
  appendSeparator: 'space' | 'newline' | 'none'
  /** How long that earlier dictation still counts as adjacent. */
  appendWindowMs: number
}

export interface Injector {
  readonly id: string
  readonly method: InjectionMethod
  /** Report whether this injector can work here, plus how to fix it if not. */
  preflight(): Promise<PreflightCheck[]>
  inject(text: string, options: InjectOptions): Promise<InjectResult>
}

/**
 * Clipboard access, kept behind an interface so tests can substitute it.
 *
 * Async because Electron 44 made `clipboard.readText()`/`writeText()` promise-based on
 * every platform, following the W3C `navigator.clipboard` shape. An earlier version was
 * synchronous.
 */
export interface TextSource {
  read(): Promise<string>
  write(text: string): Promise<void>
}

export interface InjectorDeps {
}