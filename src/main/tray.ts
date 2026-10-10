import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { loggerScope } from './core/logger'

const log = loggerScope('tray')

export interface TrayCallbacks {
  onToggle: () => void
  onCancel: () => void
  onOpenSettings: () => void
  onQuit: () => void
  isBusy: () => boolean
  isListening: () => boolean
}

function loadIcon(): NativeImage {
  // electron-vite emits main into out/main, so the repo's resources/ is two levels up
  // in development and lives under resourcesPath in a packaged build.
  const candidates = [
    resolve(__dirname, '../../resources/tray.png'),
    resolve(__dirname, '../resources/tray.png'),
    resolve(process.cwd(), 'resources/tray.png'),
    process.resourcesPath ? join(process.resourcesPath, 'resources/tray.png') : ''
  ].filter((p): p is string => Boolean(p) && existsSync(p))

  for (const path of candidates) {
    const img = nativeImage.createFromPath(path)
    if (!img.isEmpty()) {
      // Template images follow the desktop theme; setTemplateImage keeps it legible
      // on both light and dark panels.
      img.setTemplateImage(true)
      return img
    }
  }

  log.warn('tray icon not found at resources/tray.png, using an empty image')
  return nativeImage.createEmpty()
}

/**
 * Owns the tray icon, which is the app's only always-present surface. Electron's
 * `globalShortcut` needs a live process, so closing the settings window leaves the
 * tray running rather than quitting.
 */
export class TrayController {
  private tray: Tray | null = null

  constructor(private callbacks: TrayCallbacks) {}

  create(): void {
    if (this.tray) return
    this.tray = new Tray(loadIcon())
    this.rebuild()
    this.tray.on('click', () => this.rebuild())
    this.tray.on('right-click', () => this.rebuild())
  }

  /** Re-derive the menu from current state. Cheap enough to call on every change. */
  rebuild(): void {
    if (!this.tray) return
    const busy = this.callbacks.isBusy()
    const listening = this.callbacks.isListening()

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: listening ? 'Stop and paste' : busy ? 'Finishing…' : 'Start dictating',
          enabled: !busy || listening,
          click: this.callbacks.onToggle
        },
        {
          label: 'Cancel current utterance',
          enabled: busy,
          click: this.callbacks.onCancel
        },
        { type: 'separator' },
        { label: 'Settings…', click: this.callbacks.onOpenSettings },
        { type: 'separator' },
        { label: 'Quit Xono', click: this.callbacks.onQuit }
      ])
    )

    this.tray.setToolTip(listening ? 'Xono — listening' : busy ? 'Xono — working' : 'Xono — idle')
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}