import { BrowserWindow, screen, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { widgetBounds, WIDGET_HEIGHT } from '../core/widgetLayout'
import { loggerScope } from '../core/logger'

const log = loggerScope('windows')

export interface WidgetOptions {
  /** Maximum expanded width; the idle pill is much narrower. */
  width: number
  /** Distance from the bottom edge of the work area to the bottom of the pill. */
  offsetBottom: number
}

/**
 * The area of the display that is not covered by panels.
 *
 * Electron reports the whole screen as the work area on Wayland, because a Wayland
 * client is not told where the panels are. That is not good enough here: the window is
 * sized to span this area and then centred by the compositor, so a wrong answer means
 * the pill is not where it was asked to be.
 *
 * XWayland's root window does know — `_NET_WORKAREA` carries the compositor's own idea
 * of the available area, in physical pixels. It is only a hint, so anything unexpected
 * falls back to what Electron said.
 */
function workAreaFor(display: Electron.Display): Electron.Rectangle {
  try {
    const out = execFileSync('xprop', ['-root', '_NET_WORKAREA'], {
      timeout: 1000,
      encoding: 'utf8',
      env: process.env.DISPLAY ? process.env : { ...process.env, DISPLAY: ':0' }
    })
    const m = /=\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/.exec(out)
    if (m) {
      const scale = display.scaleFactor || 1
      // Round the edges rather than the size, so a fractional panel height cannot make
      // the rect a pixel short of the screen and drop the pill out of alignment.
      const x = Math.round(Number(m[1]) / scale)
      const y = Math.round(Number(m[2]) / scale)
      const right = Math.round((Number(m[1]) + Number(m[3])) / scale)
      const bottom = Math.round((Number(m[2]) + Number(m[4])) / scale)
      return { x, y, width: right - x, height: bottom - y }
    }
  } catch {
    // No XWayland, or no xprop. Electron's answer is the best available one.
  }
  return display.workArea
}

const HTML = join(__dirname, '../renderer/widget/index.html')
const SETTINGS_HTML = join(__dirname, '../renderer/settings/index.html')
const PRELOAD = join(__dirname, '../preload/index.cjs')

/**
 * The floating dictation pill.
 *
 * Two properties are load-bearing:
 *
 *  - `focusable: false`. Under Wayland, a window that can take focus would win the
 *    keyboard ring and the synthetic Ctrl+V would land here instead of in the user's
 *    text field.
 *  - `setIgnoreMouseEvents(true, { forward: true })`. The window covers a wide strip
 *    above the bottom edge, and it is permanently on top; without this it would swallow
 *    clicks meant for whatever is underneath. Forwarding keeps mousemove available so
 *    the renderer can still detect hover during the one state that needs clicks.
 */
export class WidgetWindow {
  private window: BrowserWindow | null = null
  private interactive = false
  private rendererReady = false

  constructor(private options: WidgetOptions) {
    // A panel moving or a resolution changing moves the work area under the window.
    screen.on('display-metrics-changed', this.onMetricsChanged)
  }

  private create(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window

    // The position has to be requested at construction. On Wayland the compositor owns
    // placement, and a position asked for after the window is mapped is ignored outright:
    // KWin just runs its own placement policy and centres the window. Asking up front is
    // the only chance to land bottom-centre.
    const at = this.bounds()

    const win = new BrowserWindow({
      width: at.width,
      height: at.height,
      x: at.x,
      y: at.y,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      acceptFirstMouse: false,
      alwaysOnTop: true,
      // 'screen-saver' is the only level that stays above the desktop's own furniture.
      // At the default 'floating' level the pill draws over ordinary application windows
      // but is itself covered by a KDE dock or panel, which is exactly where it needs to
      // be visible.
      // 'toolbar' makes this a dock-type window, and KWin lowers docks when an ordinary
      // window is raised — so the pill vanished every time another app was maximised.
      // An ordinary window with keep-above holds its place instead.
      type: 'normal',
      roundedCorners: false,
      webPreferences: {
        preload: PRELOAD,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })

    // Belt and braces: even if the platform lets us, never accept focus.
    win.on('focus', () => win.blur())

    // Click-through from the moment the window exists, not from the first state change.
    // This window is permanently on top and sits over whatever the user is working in,
    // so it must never take a click that was not aimed at it.
    win.setIgnoreMouseEvents(true, { forward: true })

    // 'screen-saver' is the level that stays above the desktop's own furniture. At the
    // default 'floating' level the pill draws over ordinary application windows but is
    // itself covered by a KDE dock or panel — which is exactly where it has to be seen.
    win.setAlwaysOnTop(true, 'screen-saver', 1)

    void win.loadFile(HTML)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    this.window = win
    this.reposition()
    return win
  }

  /**
   * Change the expanded width. Only ever applied while collapsed; the window is resized
   * once at creation and the renderer handles the in-between animation.
   */
  resize(width: number): void {
    if (width === this.options.width) return
    this.options.width = width
    if (this.window && !this.window.isDestroyed() && !this.window.isVisible()) {
      this.window.setBounds({ ...this.bounds(width) })
    }
  }

  private bounds(width = this.options.width): Electron.Rectangle {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    return widgetBounds(workAreaFor(display), this.options.offsetBottom, width)
  }

  private onMetricsChanged = (): void => {
    this.reposition()
  }

  /** Re-anchor to the bottom centre, following the display the pointer is on. */
  reposition(): void {
    if (!this.window || this.window.isDestroyed()) return
    const target = this.bounds()
    this.window.setBounds(target)

    // setBounds is asynchronous on some Electron/Wayland combinations, so the result is
    // not necessarily visible immediately. Logged at debug because a window that never
    // lands where it was asked to is otherwise invisible from the outside.
    const actual = this.window.getBounds()
    // A pixel of rounding is not worth a warning; a window in the wrong half of the
    // screen is.
    if (Math.abs(actual.x - target.x) > 1 || Math.abs(actual.y - target.y) > 1) {
      log.warn(
        `widget setBounds did not take effect: asked for x=${target.x} y=${target.y}, got x=${actual.x} y=${actual.y}`
      )
    }
  }

  /**
   * Bring the pill up.
   *
   * Safe to call at any time: the window is created immediately so `send()` has
   * somewhere to write, but it is only made visible once the renderer has reported in.
   * Showing a window whose renderer has not loaded would present an empty pill, and —
   * worse — `webContents.send` is silently dropped before load, so a dictation started
   * in that window would never reach the widget and it would sit at `idle` while
   * recording.
   */
  show(): void {
    const win = this.create()
    this.reposition()
    this.setInteractive(false)
    if (!this.rendererReady) return
    // `showInactive` never steals the keyboard focus.
    win.showInactive()
  }

  /**
   * Called once the renderer has mounted and its IPC listeners are attached. Only now is
   * it safe to reveal the window and start sending it state.
   */
  setRendererReady(): void {
    this.rendererReady = true
    this.reposition()
    this.show()
  }

  hide(): void {
    this.window?.hide()
  }

  isVisible(): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isVisible())
  }

  /**
   * Let clicks through, except in the review state where the user has real buttons to
   * press. Reversible, so returning to idle restores click-through immediately.
   */
  setInteractive(interactive: boolean): void {
    if (!this.window || this.window.isDestroyed()) return
    this.interactive = interactive
    // Applied on every call rather than only on change. The previous guard returned
    // early whenever the requested state matched the cached one, and because
    // `interactive` starts out as `false`, the very first `setInteractive(false)` — the
    // one `show()` relies on to make the window click-through — was a no-op. The window
    // then swallowed every click across its whole rect.
    this.window.setIgnoreMouseEvents(!interactive, { forward: true })
  }

  send(channel: string, payload: unknown): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send(channel, payload)
  }

  destroy(): void {
    this.window?.destroy()
    this.window = null
    this.interactive = false
    this.rendererReady = false
  }
}

/**
 * Settings window. Created lazily and destroyed on close so the tray-resident
 * baseline stays as small as possible.
 */
export class SettingsWindow {
  private window: BrowserWindow | null = null

  isOpen(): boolean {
    return Boolean(this.window && !this.window.isDestroyed())
  }

  show(): void {
    if (this.isOpen()) {
      this.window!.show()
      this.window!.focus()
      return
    }

    const win = new BrowserWindow({
      width: 1040,
      height: 760,
      minWidth: 840,
      minHeight: 600,
      show: false,
      title: 'Xono Settings',
      backgroundColor: '#14161a',
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false
      }
    })

    win.on('close', (event) => {
      // Destroy rather than hide: an idle Electron app should not hold a renderer
      // and a web contents alive for a window nobody is looking at.
      if (!win.webContents.isDevToolsOpened()) {
        event.preventDefault()
        win.destroy()
        this.window = null
      }
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url)
      return { action: 'deny' }
    })

    win.once('ready-to-show', () => win.show())
    void win.loadFile(SETTINGS_HTML)

    this.window = win
    log.info('settings window opened')
  }

  hide(): void {
    this.window?.hide()
  }

  send(channel: string, payload: unknown): void {
    if (!this.isOpen()) return
    this.window!.webContents.send(channel, payload)
  }

  destroy(): void {
    this.window?.destroy()
    this.window = null
  }
}