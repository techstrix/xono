import { cpus, totalmem, platform, release } from 'node:os'
import { accessSync, constants, existsSync } from 'node:fs'
import type { DiagnosticsReport, PreflightCheck, PreflightReport } from '@shared/types'
import type { XonoConfig } from '@shared/schema'
import { commandExists } from './exec'
import { findWhisperCli } from './stt/whisperCpp'
import type { ModelManager } from './stt'
import type { ProviderRegistry } from './llm'
import { PROVIDER_DEFINITIONS } from './llm'
import { createInjector, sessionType, type Injector } from './inject'

/**
 * Checks that the machine can actually do what the pipeline is about to ask it to.
 * Every check carries the exact fix command, because a preflight that only says "no"
 * is worse than useless at 9am.
 */
export async function runPreflight(
  cfg: XonoConfig,
  models: ModelManager,
  vadDetail: string
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = []

  const hasParec = await commandExists('parec')
  checks.push({
    id: 'parec',
    label: 'Audio capture (parec)',
    ok: hasParec,
    severity: 'error',
    detail: hasParec ? 'found on PATH' : 'parec is not installed, so there is no microphone access',
    fixes: hasParec ? [] : ['sudo pacman -S pipewire-utils']
  })

  const wireplumber = await commandExists('wpctl')
  checks.push({
    id: 'pipewire',
    label: 'PipeWire is running',
    ok: wireplumber,
    severity: wireplumber ? 'info' : 'error',
    detail: wireplumber
      ? 'ok'
      : 'PipeWire does not appear to be running. Audio capture will fail without it.',
    fixes: wireplumber ? [] : ['systemctl --user status pipewire', 'systemctl --user start pipewire']
  })

  const modelStatus = models.status(cfg.stt.model)
  checks.push({
    id: 'model',
    label: `${cfg.stt.model} model downloaded`,
    ok: models.isReady(cfg.stt.model),
    severity: 'error',
    detail: modelStatus.present
      ? `${modelStatus.path}`
      : 'not downloaded yet; xono fetches it on first dictation or from Settings → Models',
    fixes: []
  })

  const binary = findWhisperCli(cfg.stt.enginePath)
  checks.push({
    id: 'whisper-binary',
    label: 'whisper.cpp binary',
    ok: Boolean(binary),
    severity: 'error',
    detail: binary ?? 'not found',
    fixes: binary ? [] : ['npm run setup:engine']
  })

  if (cfg.vad.engine === 'silero') {
    const modelPath = cfg.vad.sileroModelPath
    checks.push({
      id: 'silero',
      label: 'Silero VAD model',
      ok: Boolean(modelPath) && existsSync(modelPath),
      severity: 'warning',
      detail: modelPath && existsSync(modelPath) ? modelPath : vadDetail,
      fixes:
        modelPath && existsSync(modelPath)
          ? []
          : ['Set the Silero model path in Settings → Dictation, or switch the VAD engine to "energy".']
    })
  }

  const injector = createInjector(cfg.inject.method)
  const injectorChecks = await injector.preflight()
  checks.push(...injectorChecks)

  const ok = !checks.some((c) => c.severity === 'error' && !c.ok)
  return { checks, ok }
}

export interface DiagnosticsDeps {
  models: ModelManager
  providers: ProviderRegistry
  vadDetail: string
  hotkeyRegistered: boolean
  hotkeyError?: string
  electronVersion: string
  nodeVersion: string
}

export async function buildDiagnostics(cfg: XonoConfig, deps: DiagnosticsDeps): Promise<DiagnosticsReport> {
  const providers = await Promise.all(
    (Object.keys(PROVIDER_DEFINITIONS) as (keyof typeof PROVIDER_DEFINITIONS)[]).map(async (id) => {
      const provider = deps.providers[id]!
      const health = await provider.healthCheck(cfg.llm.providers[id])
      return { id, ok: health.ok, detail: health.detail }
    })
  )

  return {
    platform: {
      os: platform(),
      release: release(),
      sessionType: sessionType(),
      desktop: process.env.XDG_CURRENT_DESKTOP ?? 'unknown',
      cpus: cpus().length,
      totalMemMb: Math.round(totalmem() / 1024 / 1024),
      electron: deps.electronVersion,
      node: deps.nodeVersion
    },
    vadEngine: cfg.vad.engine,
    vadEngineDetail: deps.vadDetail,
    injectionMethod: cfg.inject.method,
    hotkeyRegistered: deps.hotkeyRegistered,
    hotkeyError: deps.hotkeyError,
    models: deps.models.list(),
    providers,
    preflight: await runPreflight(cfg, deps.models, deps.vadDetail)
  }
}

/** Whether we can open the audio device at all; used to enable the mic preflight. */
export function audioDeviceReachable(): boolean {
  try {
    accessSync('/run/user/' + (process.getuid?.() ?? 1000) + '/pipewire-0', constants.F_OK)
    return true
  } catch {
    return existsSync('/run/user/1000/pipewire-0')
  }
}

export async function pickBestInjector(cfg: XonoConfig): Promise<Injector> {
  return createInjector(cfg.inject.method)
}