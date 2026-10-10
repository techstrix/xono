import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '../shared/types'
import type { ProviderDefinition } from '../shared/providers'
import type { ProviderId, XonoConfig } from '../shared/schema'
import type { RemoteModel } from '../shared/types'
import type {
  DiagnosticsReport,
  HistoryEntry,
  ModelStatus,
  PipelineState,
  PreflightReport,
  Progress,
  WaveFrame
} from '../shared/types'

type Section = keyof XonoConfig
type Unsubscribe = () => void

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function on<T>(channel: string, handler: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => handler(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  config: {
    get: () => invoke<XonoConfig>(IPC.configGet),
    patch: <K extends Section>(section: K, patch: Partial<XonoConfig[K]>) =>
      invoke<XonoConfig>(IPC.configPatch, section, patch),
    onChanged: (handler: (cfg: XonoConfig) => void) =>
      on(IPC.configChanged, handler),
    onHotkeyError: (handler: (payload: { message: string }) => void) =>
      on('hotkey:error', handler)
  },

  pipeline: {
    start: () => invoke<void>(IPC.pipelineStart),
    stop: () => invoke<void>(IPC.pipelineStop),
    cancel: () => invoke<void>(IPC.pipelineCancel),
    state: () => invoke<PipelineState>(IPC.pipelineState),
    review: (decision: 'accept' | 'raw' | 'reject') => invoke<void>(IPC.pipelineReview, decision),
    injectText: (text: string) => invoke<boolean>(IPC.pipelineInjectText, text),
    onState: (handler: (p: { state: PipelineState; label?: string }) => void) => on('state', handler),
    onWave: (handler: (frame: WaveFrame) => void) => on('wave', handler),
    onProgress: (handler: (p: Progress) => void) => on('progress', handler),
    onReview: (handler: (p: { text: string; raw: string }) => void) => on('review', handler),
    onComplete: (
      handler: (p: { raw: string; cleaned: string; mode: string; elapsedMs: number; fallback: boolean }) => void
    ) => on('complete', handler),
    onDegraded: (handler: (message: string) => void) => on('degraded', handler),
    onError: (handler: (message: string) => void) => on('error', handler),
    onCancelled: (handler: () => void) => on('cancelled', handler)
  },

  models: {
    list: () => invoke<ModelStatus[]>(IPC.modelStatusList),
    download: (id: string) => invoke<{ ok: boolean; path?: string; error?: string }>(IPC.modelDownload, id),
    remove: (id: string) => invoke<ModelStatus[]>(IPC.modelDelete, id),
    reveal: (id: string) => invoke<{ ok: boolean }>(IPC.modelReveal, id),
    onProgress: (handler: (p: { id: string; label: string; value?: number }) => void) =>
      on('model:progress', handler),
    onStatus: (handler: (list: ModelStatus[]) => void) => on('model:status', handler)
  },

  providers: {
    list: () => invoke<(ProviderDefinition & { configured: boolean })[]>(IPC.providerList),
    health: (id: string) => invoke<{ ok: boolean; detail: string }>(IPC.providerHealth, id),
    /**
     * Fetch (or reuse) a provider's model catalogue for the picker. Falls back to a
     * stale cached list and flags `stale` when the network is unavailable.
     */
    models: (id: string, options?: { force?: boolean }) =>
      invoke<{ models: RemoteModel[]; fromCache: boolean; stale: boolean; fetchedAt?: number; source: string }>(
        IPC.providerModels,
        id,
        options
      )
  },

  vocab: {
    add: (term: string) => invoke<string[]>(IPC.vocabAdd, term),
    remove: (term: string) => invoke<string[]>(IPC.vocabRemove, term)
  },

  history: {
    list: () => invoke<HistoryEntry[]>(IPC.historyList),
    clear: () => invoke<{ ok: boolean }>(IPC.historyClear),
    restore: (id: string) => invoke<{ ok: boolean }>(IPC.historyRestore, id)
  },

  diagnostics: {
    run: () => invoke<DiagnosticsReport>(IPC.diagnosticsRun),
    preflight: () => invoke<PreflightReport>(IPC.preflightRun),
    testInjection: () =>
      invoke<{ ok: boolean; marker: string; degraded: boolean; reason?: string; error?: string }>(IPC.testInjection)
  },

  hotkey: {
    set: (accelerator: string) => invoke<{ accelerator: string }>(IPC.hotkeySet, accelerator),
    current: () => invoke<string>(IPC.hotkeyCurrent)
  },

  widget: {
    /**
     * Announce that the widget renderer has mounted and its IPC listeners are attached.
     * The main process holds the window hidden until this arrives, so no state sent
     * during startup is dropped.
     */
    ready: () => invoke<void>(IPC.widgetReady)
  },

  windows: {
    openSettings: () => invoke<void>(IPC.settingsOpen),
    closeSettings: () => invoke<void>(IPC.settingsClose)
  },

  clipboard: {
    read: () => invoke<string>(IPC.clipboardRead),
    write: (text: string) => invoke<void>(IPC.clipboardWrite),
    sendEnter: () => invoke<void>(IPC.clipboardSendEnter)
  },

  app: {
    version: () => invoke<{ version: string; electron: string }>(IPC.appVersion),
    openExternal: (url: string) => invoke<{ ok: boolean }>(IPC.appOpenExternal),
    quit: () => invoke<void>(IPC.appQuit)
  }
}

export type XonoApi = typeof api

contextBridge.exposeInMainWorld('xono', api)