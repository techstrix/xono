import { app, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '@shared/types'
import type { ProviderConfig, ProviderId, WhisperModelId } from '@shared/schema'
import { PROVIDER_DEFINITIONS, type ProviderRegistry } from '../core/llm'
import { electronClipboard, resolveInjector, sendEnter } from '../core/inject'
import type { XonoApp } from '../app'
import type { ReviewDecision } from '../core/pipeline'
import { loggerScope } from '../core/logger'

const log = loggerScope('ipc')

type Section = 'llm' | 'stt' | 'vad' | 'dictation' | 'inject' | 'ui' | 'hotkey' | 'general'

const SECTIONS = new Set<Section>([
  'llm',
  'stt',
  'vad',
  'dictation',
  'inject',
  'ui',
  'hotkey',
  'general'
])

/**
 * All renderer→main entry points. Handlers are thin: they validate the section name,
 * delegate to a core module, and return plain data. Nothing in here makes a policy
 * decision, so the logic stays testable without Electron.
 */
export function registerIpc(xono: XonoApp): void {
  const handle = (channel: string, fn: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void => {
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await fn(event, ...(args as never[]))
      } catch (err) {
        log.error(`${channel} failed:`, (err as Error).message)
        return { ok: false, error: (err as Error).message }
      }
    })
  }

  // ------------------------------------------------------------------- config

  handle(IPC.configGet, () => xono.getConfigStore().get())

  handle(IPC.configPatch, (_e, section: string, patch: unknown) => {
    if (!SECTIONS.has(section as Section)) {
      throw new Error(`unknown config section: ${section}`)
    }
    return xono.getConfigStore().patch(section as Section, patch as never)
  })

  // -------------------------------------------------------------- diagnostics

  handle(IPC.diagnosticsRun, async () => xono.diagnostics())

  handle(IPC.preflightRun, async () => (await xono.diagnostics()).preflight)

  handle(IPC.testInjection, async () => {
    const marker = `xono test injection ${new Date().toISOString()} ✓`
    const { injector, degraded, reason } = await resolveInjector(xono.getConfigStore().get().inject.method)
    const result = await injector.inject(marker, xono.getConfigStore().get().inject)
    return { ...result, marker, degraded, reason }
  })

  handle(IPC.hotkeySet, (_e, accelerator: string) => {
    xono.getConfigStore().patch('hotkey', { accelerator })
    return xono.getConfigStore().get().hotkey
  })

  handle(IPC.hotkeyCurrent, () => xono.getConfigStore().get().hotkey.accelerator)

  // ------------------------------------------------------------------- models

  handle(IPC.modelStatusList, () => xono.getModels().list())

  handle(IPC.modelDownload, async (_e, id: string) => {
    const models = xono.getModels()
    const target = id as WhisperModelId
    const unsubscribe = models.onDownload(target, (p) => {
      xono.getSettingsWindow().send('model:progress', { id: target, ...p })
    })
    try {
      const path = await models.download(target)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      unsubscribe()
      xono.getSettingsWindow().send('model:status', models.list())
    }
  })

  handle(IPC.modelDelete, (_e, id: string) => {
    xono.getModels().delete(id as WhisperModelId)
    return xono.getModels().list()
  })

  handle(IPC.modelReveal, async (_e, id: string) => {
    const models = xono.getModels()
    const target = id as WhisperModelId
    shell.showItemInFolder(models.pathFor(target))
    return { ok: true }
  })

  // ---------------------------------------------------------------- providers

  handle(IPC.providerList, () =>
    Object.values(PROVIDER_DEFINITIONS).map((def) => ({
      ...def,
      configured: providerConfigured(xono.getProviders(), xono.getConfigStore().get().llm.providers[def.id], def.id)
    }))
  )

  handle(IPC.providerModels, async (_e, id: string, options?: { force?: boolean }) => {
    const providerId = id as ProviderId
    const provider = xono.getProviders()[providerId]
    if (!provider) throw new Error(`unknown provider: ${id}`)
    const cfg = xono.getConfigStore().get().llm.providers[providerId]

    const result = await xono.getCatalogue().fetch(providerId, () => provider.listModels(cfg), {
      force: options?.force === true
    })

    return {
      models: result.models,
      fromCache: result.fromCache,
      stale: result.stale,
      fetchedAt: result.fetchedAt,
      source: PROVIDER_DEFINITIONS[providerId].label
    }
  })

  handle(IPC.providerHealth, async (_e, id: string) => {
    const providerId = id as keyof typeof PROVIDER_DEFINITIONS
    const provider = xono.getProviders()[providerId]
    if (!provider) throw new Error(`unknown provider: ${id}`)
    const cfg = xono.getConfigStore().get().llm.providers[providerId]
    return provider.healthCheck(cfg)
  })

  // --------------------------------------------------------------- vocabulary

  handle(IPC.vocabAdd, (_e, term: string) => {
    const clean = term.trim().slice(0, 80)
    if (!clean) throw new Error('empty term')
    const cfg = xono.getConfigStore().get()
    if (cfg.general.vocabulary.some((t) => t.toLowerCase() === clean.toLowerCase())) {
      return cfg.general.vocabulary
    }
    return xono.getConfigStore().patch('general', {
      vocabulary: [...cfg.general.vocabulary, clean].slice(0, 500)
    }).general.vocabulary
  })

  handle(IPC.vocabRemove, (_e, term: string) =>
    xono
      .getConfigStore()
      .patch('general', {
        vocabulary: xono
          .getConfigStore()
          .get()
          .general.vocabulary.filter((t) => t !== term)
      })
      .general.vocabulary
  )

  // ------------------------------------------------------------------ history

  handle(IPC.historyList, () => xono.getHistory().list())

  handle(IPC.historyClear, () => {
    xono.getHistory().clear()
    return { ok: true }
  })

  handle(IPC.historyRestore, async (_e, id: string) => {
    const entry = xono.getHistory().get(id)
    if (!entry) throw new Error('that entry is no longer in the history')
    return { ok: await xono.getPipeline().injectText(entry.cleaned) }
  })

  // ------------------------------------------------------------------ pipeline

  handle('pipeline:start', () => xono.getPipeline().start())
  handle('pipeline:stop', () => xono.getPipeline().stop())
  handle('pipeline:cancel', () => xono.cancel())
  handle('pipeline:review', (_e, decision: ReviewDecision) => xono.resolveReview(decision))
  handle('pipeline:injectText', (_e, text: string) => xono.getPipeline().injectText(text))
  handle('pipeline:state', () => xono.getPipeline().getState())

  // ------------------------------------------------------------------ windows

  handle(IPC.widgetReady, () => {
    xono.onWidgetReady()
    return { ok: true }
  })

  handle(IPC.settingsOpen, () => xono.getSettingsWindow().show())
  handle(IPC.settingsClose, () => xono.getSettingsWindow().hide())
  handle('clipboard:read', () => electronClipboard.read())
  handle('clipboard:write', (_e, text: string) => electronClipboard.write(String(text ?? '').slice(0, 100_000)))
  handle('clipboard:sendEnter', () => sendEnter())
  handle('app:version', () => ({ version: app.getVersion(), electron: process.versions.electron }))
  handle('app:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { ok: true }
  })
  handle('app:quit', async () => {
    await xono.shutdown()
    app.quit()
  })
}

function providerConfigured(
  registry: ProviderRegistry,
  config: ProviderConfig,
  id: keyof typeof PROVIDER_DEFINITIONS
): boolean {
  return registry[id].validateConfig(config).ok
}