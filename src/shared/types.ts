import type { DictationMode, InjectionMethod, ProviderId, VadEngineId, WhisperModelId } from './schema'

export const SAMPLE_RATE = 16_000
export const CHANNELS = 1

/** 512 samples at 16 kHz is the Silero VAD frame size. */
export const VAD_FRAME_SAMPLES = 512
export const VAD_FRAME_MS = (VAD_FRAME_SAMPLES / SAMPLE_RATE) * 1000

/**
 * Vertical space reserved *below* the pill for its drop shadow.
 *
 * This couples the widget window's position to the renderer's padding: the window is
 * placed `shadowRoom` lower than the requested gap so that the shadow has somewhere to
 * render instead of being clipped by the window edge. The renderer sets this as a CSS
 * custom property, so the two cannot drift apart silently.
 */
export const WIDGET_SHADOW_ROOM = 14

export type PipelineState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'transcribing'
  | 'cleaning'
  | 'reviewing'
  | 'injecting'
  | 'done'
  | 'error'
  | 'cancelled'

export interface Progress {
  label: string
  /** 0..1 when known, otherwise undefined for indeterminate. */
  value?: number
}

export interface WaveFrame {
  /** Normalised 0..1 amplitude. */
  level: number
  /** Speech probability from the active VAD engine, 0..1. */
  speech: number
  /** Milliseconds since recording started. */
  t: number
}

export interface TranscriptResult {
  text: string
  providerId: string
  model: string
  latencyMs: number
  language?: string
  segments?: { start: number; end: number; text: string }[]
}

export interface CleanupResult {
  text: string
  /** True when the LLM was unavailable and the raw transcript was passed through. */
  fallback: boolean
  removedFillers: number
  latencyMs: number
  providerId: ProviderId | 'none'
  model: string
}

export interface InjectResult {
  ok: boolean
  method: InjectionMethod
  error?: string
  /** True when a previous clipboard value was restored. */
  clipboardRestored: boolean
}

export interface HistoryEntry {
  id: string
  at: number
  raw: string
  cleaned: string
  mode: DictationMode
  providerId: string
  injected: boolean
}

export interface PreflightCheck {
  id: string
  label: string
  ok: boolean
  detail: string
  /** Shell commands the user can run to fix this, when known. */
  fixes: string[]
  severity: 'error' | 'warning' | 'info'
}

export interface PreflightReport {
  checks: PreflightCheck[]
  ok: boolean
}

export interface ModelStatus {
  id: WhisperModelId
  bytes: number
  path: string
  present: boolean
  actualBytes?: number
  downloading: boolean
  progress?: number
  error?: string
}

/**
 * A model as advertised by a provider's catalogue, normalised across the very
 * different shapes they return. Every field beyond `id` is optional because only
 * OpenRouter reports context length and pricing.
 */
export interface RemoteModel {
  id: string
  name: string
  /** USD per million input tokens. Undefined when the provider does not say. */
  inputPricePerMillion?: number
  /** USD per million output tokens. */
  outputPricePerMillion?: number
  contextLength?: number
  /** First sentence or two of the provider's own description. */
  description?: string
  /** Vendor prefix of the id, e.g. `mistralai` from `mistralai/mistral-small`. */
  vendor?: string
  /** False for vision/audio-only models, which cannot do text cleanup. */
  supportsText: boolean
}

export interface ModelCatalogue {
  models: RemoteModel[]
  /** Epoch ms the list was fetched. */
  fetchedAt: number
  source: string
}

export interface DiagnosticsReport {
  platform: {
    os: string
    release: string
    sessionType: string
    desktop: string
    cpus: number
    totalMemMb: number
    electron: string
    node: string
  }
  vadEngine: VadEngineId
  vadEngineDetail: string
  injectionMethod: InjectionMethod
  hotkeyRegistered: boolean
  hotkeyError?: string
  models: ModelStatus[]
  providers: { id: ProviderId; ok: boolean; detail: string }[]
  preflight: PreflightReport
}

/** Events pushed from main to the widget renderer. */
export type WidgetEvent =
  | { type: 'state'; state: PipelineState; label?: string }
  | { type: 'wave'; frame: WaveFrame }
  | { type: 'progress'; progress: Progress }
  | { type: 'result'; text: string; mode: DictationMode; ms: number }
  | { type: 'error'; message: string; recoverable: boolean }
  | { type: 'hide' }

export const IPC = {
  // renderer -> main, invoke/handle
  configGet: 'config:get',
  configPatch: 'config:patch',
  diagnosticsRun: 'diagnostics:run',
  preflightRun: 'preflight:run',
  testInjection: 'inject:test',
  modelStatusList: 'model:status',
  modelDownload: 'model:download',
  modelDelete: 'model:delete',
  modelReveal: 'model:reveal',
  vocabAdd: 'vocab:add',
  vocabRemove: 'vocab:remove',
  providerHealth: 'provider:health',
  providerModels: 'provider:models',
  providerList: 'provider:list',
  historyList: 'history:list',
  historyClear: 'history:clear',
  historyRestore: 'history:restore',
  settingsOpen: 'settings:open',
  settingsClose: 'settings:close',
  hotkeySet: 'hotkey:set',
  hotkeyCurrent: 'hotkey:current',
  // pipeline control
  pipelineStart: 'pipeline:start',
  pipelineStop: 'pipeline:stop',
  pipelineCancel: 'pipeline:cancel',
  pipelineState: 'pipeline:state',
  pipelineReview: 'pipeline:review',
  pipelineInjectText: 'pipeline:injectText',
  // clipboard + app
  clipboardRead: 'clipboard:read',
  clipboardWrite: 'clipboard:write',
  clipboardSendEnter: 'clipboard:sendEnter',
  appVersion: 'app:version',
  appOpenExternal: 'app:openExternal',
  appQuit: 'app:quit',
  // main -> widget, send
  widgetEvent: 'widget:event',
  widgetReady: 'widget:ready',
  // main -> settings, send
  configChanged: 'config:changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]