import { app, globalShortcut } from 'electron'
import type { XonoConfig } from '@shared/schema'
import type { CompletedUtterance, ReviewDecision } from './core/pipeline'
import { Pipeline } from './core/pipeline'
import { ConfigStore } from './core/config'
import { AudioRecorder } from './core/recorder'
import { createSttRegistry, sweepSttWorkDirs } from './core/stt'
import { createProviderRegistry, type ProviderRegistry } from './core/llm'
import { CatalogueCache } from './core/llm/catalogueCache'
import { createVadEngine, type VadEngine } from './core/vad'
import { HistoryStore } from './core/history'
import { initLogger, loggerScope, setDebug } from './core/logger'
import { paths, sweepStaleTemp } from './core/paths'
import { buildDiagnostics, type DiagnosticsDeps } from './core/diagnostics'
import { SettingsWindow, WidgetWindow } from './windows'
import { ClipboardPasteInjector } from './core/inject'
import { TrayController } from './tray'
import { registerIpc } from './ipc'

const log = loggerScope('app')

/** States where a hotkey press means "commit", not "start". */
const BUSY_STATES = new Set(['starting', 'listening', 'transcribing', 'cleaning', 'reviewing'])

export class XonoApp {
  private config = new ConfigStore()
  private providers: ProviderRegistry = createProviderRegistry()
  private stt = createSttRegistry(() => this.config.get().stt.enginePath)
  private recorder = new AudioRecorder()
  private history = new HistoryStore(this.config.get().general.historyLimit)
  private catalogue = new CatalogueCache()
  private pipeline!: Pipeline
  private widget!: WidgetWindow
  private settings = new SettingsWindow()
  private tray = new TrayController({
    onToggle: () => void this.toggle(),
    onCancel: () => this.cancel(),
    onOpenSettings: () => this.settings.show(),
    onQuit: () => void this.quit(),
    isBusy: () => BUSY_STATES.has(this.pipeline?.getState() ?? 'idle'),
    isListening: () => this.pipeline?.getState() === 'listening'
  })
  private unsubscribeConfig: (() => void) | null = null
  private lastAccelerator: string | null = null
  private widgetRendererReady = false
  private widgetReadyWaiters: (() => void)[] = []
  private quitting = false

  async boot(): Promise<void> {
    paths.ensureDirs()
    initLogger(this.config.get().general.debugLogging)
    sweepStaleTemp('xono-utt-')
    sweepSttWorkDirs()
    this.config.ensurePersisted()

    const ui = this.config.get().ui
    this.widget = new WidgetWindow({ width: ui.widgetWidth, offsetBottom: ui.widgetOffsetBottom })

    this.pipeline = new Pipeline({
      config: this.config,
      recorder: this.recorder,
      stt: this.stt.current,
      models: this.stt.models,
      providers: this.providers,
      history: this.history,
      createVadEngine: (cfg: XonoConfig) => createVadEngine(cfg.vad, cfg.vad.sileroModelPath)
    })

    this.wirePipelineEvents()
    this.wireConfigEvents()
    registerIpc(this)
    this.tray.create()
    this.registerHotkey()

    // The pill is up for as long as the app runs: its presence is the only standing
    // signal that the global hotkey is live, which is otherwise invisible. It is
    // actually shown once the renderer reports in — see `onWidgetReady`.
    this.widget.show()

    log.info('xono ready')
  }

  // ------------------------------------------------------------- public API

  getConfigStore(): ConfigStore {
    return this.config
  }
  getPipeline(): Pipeline {
    return this.pipeline
  }
  getWidget(): WidgetWindow {
    return this.widget
  }
  getSettingsWindow(): SettingsWindow {
    return this.settings
  }
  getModels(): XonoApp['stt']['models'] {
    return this.stt.models
  }
  getProviders(): ProviderRegistry {
    return this.providers
  }
  getHistory(): HistoryStore {
    return this.history
  }
  getCatalogue(): CatalogueCache {
    return this.catalogue
  }

  /** Hotkey / tray action: start listening, or commit if we already are. */
  async toggle(): Promise<void> {
    // Logged at info because "is the shortcut being delivered at all?" is the first
    // question when a hotkey appears dead, and it cannot be answered from the outside.
    log.info(`hotkey fired: ${this.config.get().hotkey.accelerator}`)
    const state = this.pipeline.getState()
    if (state === 'listening') {
      await this.pipeline.stop()
      return
    }
    if (BUSY_STATES.has(state)) return
    await this.pipeline.start()
  }

  /**
   * The widget renderer has mounted and is listening. Reveal the pill and replay the
   * current state, so a dictation already in flight during startup still shows
   * correctly rather than appearing stuck on `idle`.
   */
  /**
   * Run `fn` once the widget renderer is listening — immediately if it already is.
   * Used by the demo so its first state is not emitted into a window that cannot yet
   * receive it.
   */
  whenWidgetReady(fn: () => void): void {
    if (this.widgetRendererReady) {
      fn()
      return
    }
    this.widgetReadyWaiters.push(fn)
  }

  onWidgetReady(): void {
    this.widgetRendererReady = true

    // Reveal the window and replay the current state, so a dictation already in flight
    // during startup shows correctly rather than appearing stuck on `idle`.
    this.widget.setRendererReady()

    const state = this.pipeline.getState()
    this.widget.send('state', { state, label: state === 'idle' ? 'Ready' : undefined })

    const waiters = this.widgetReadyWaiters
    this.widgetReadyWaiters = []
    for (const fn of waiters) fn()
  }

  cancel(): void {
    this.pipeline.cancel()
    this.widget.setInteractive(false)
  }

  async quit(): Promise<void> {
    await this.shutdown()
    app.quit()
  }

  resolveReview(decision: ReviewDecision): void {
    this.pipeline.resolveReview(decision)
  }

  /** Re-run STT and cleanup on an already-recorded utterance is intentionally out of v1. */
  async diagnostics() {
    const deps: DiagnosticsDeps = {
      models: this.stt.models,
      providers: this.providers,
      vadDetail: 'see pipeline',
      hotkeyRegistered: globalShortcut.isRegistered(this.config.get().hotkey.accelerator),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node
    }
    return buildDiagnostics(this.config.get(), deps)
  }

  async shutdown(): Promise<void> {
    if (this.quitting) return
    this.quitting = true
    this.unsubscribeConfig?.()
    globalShortcut.unregisterAll()
    this.tray.destroy()
    this.widget.destroy()
    await this.pipeline.dispose()
    await this.stt.dispose()
    ClipboardPasteInjector.daemon.stop()
  }

  // ------------------------------------------------------------------ wiring

  private wirePipelineEvents(): void {
    this.pipeline.on('state', (state: string, label?: string) => {
      this.widget.send('state', { state, label })

      // The pill stays on screen; it only stops being click-through while the user has
      // buttons to press. `idle` deliberately does not hide it any more.
      this.widget.setInteractive(state === 'reviewing')

      if (state === 'idle' && this.config.get().ui.alwaysVisibleWidget) this.widget.show()
      this.tray.rebuild()
    })

    this.pipeline.on('wave', (frame) => this.widget.send('wave', frame))
    this.pipeline.on('progress', (progress) => this.widget.send('progress', progress))
    this.pipeline.on('review', ({ text, raw }) => this.widget.send('review', { text, raw }))
    this.pipeline.on('complete', (utterance: CompletedUtterance) => this.widget.send('complete', utterance))
    this.pipeline.on('degraded', (message: string) => this.widget.send('degraded', message))
    // Deliberately not the reserved EventEmitter 'error' event: emitting that with no
    // listener throws, which would turn a recoverable paste failure into a crash.
    this.pipeline.on('failed', (message: string) => this.widget.send('error', message))
    this.pipeline.on('cancelled', () => this.widget.send('cancelled', {}))
  }

  private wireConfigEvents(): void {
    this.unsubscribeConfig = this.config.subscribe((cfg) => {
      setDebug(cfg.general.debugLogging)
      this.widget.resize(cfg.ui.widgetWidth)
      this.widget.reposition()
      if (cfg.ui.alwaysVisibleWidget) this.widget.show()
      this.settings.send('config:changed', cfg)

      if (globalShortcut.isRegistered(cfg.hotkey.accelerator) && cfg.hotkey.accelerator !== this.lastAccelerator) {
        this.registerHotkey()
      }
      this.tray.rebuild()
    })
  }

  private registerHotkey(): void {
    const accelerator = this.config.get().hotkey.accelerator
    globalShortcut.unregisterAll()
    this.lastAccelerator = accelerator

    // A malformed accelerator makes globalShortcut.register *throw*. That must never
    // be fatal: the tray, the widget and the settings window all still work, and the
    // user can fix the binding from settings.
    let registered = false
    try {
      registered = globalShortcut.register(accelerator, () => void this.toggle())
    } catch (err) {
      log.error(`invalid hotkey "${accelerator}": ${(err as Error).message}`)
    }

    if (registered) {
      log.info(`hotkey registered: ${accelerator}`)
      return
    }

    // Known hazard on Wayland: the GlobalShortcuts portal is not universally
    // implemented, and KWin's support has varied between releases. Give the user a
    // concrete system-level workaround instead of a silent dead key.
    const message = `Could not register the global hotkey "${accelerator}". If the key combination is invalid, pick another one in Settings. On Wayland, global shortcuts also need the GlobalShortcuts portal; if it is unavailable, bind a system shortcut instead: KDE System Settings → Shortcuts → Custom Shortcuts → Command: ${JSON.stringify(app.getPath('exe'))} --toggle`
    log.error(message)
    this.widget.show()
    this.widget.send('error', message)
    this.settings.send('hotkey:error', { message })
  }
}