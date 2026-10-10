import type { XonoConfig } from '../../shared/schema'

export type ConfigSection = keyof XonoConfig

/**
 * A single write path for every settings control. Patches are shallow-merged per
 * section by the main process, so a component never has to send the whole config.
 */
export type PatchFn = <K extends ConfigSection>(section: K, patch: Partial<XonoConfig[K]>) => void

export type TabId =
  | 'providers'
  | 'transcription'
  | 'dictation'
  | 'vocabulary'
  | 'injection'
  | 'appearance'
  | 'diagnostics'
  | 'history'

export interface TabDef {
  id: TabId
  label: string
  group: 'Core' | 'Refine' | 'System'
}

export const TABS: TabDef[] = [
  { id: 'providers', label: 'Providers', group: 'Core' },
  { id: 'transcription', label: 'Speech to text', group: 'Core' },
  { id: 'injection', label: 'Hotkey & pasting', group: 'Core' },
  { id: 'dictation', label: 'Output style', group: 'Refine' },
  { id: 'vocabulary', label: 'Vocabulary', group: 'Refine' },
  { id: 'appearance', label: 'Appearance', group: 'Refine' },
  { id: 'diagnostics', label: 'Diagnostics', group: 'System' },
  { id: 'history', label: 'History', group: 'System' }
]