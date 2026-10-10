import type { DictationMode, ProviderConfig, ProviderId } from '@shared/schema'
import type { ProviderDefinition } from '@shared/providers'
import type { CleanupResult } from '@shared/types'

export type { ProviderDefinition }

export interface CleanupRequest {
  raw: string
  mode: DictationMode
  vocabulary: string[]
  punctuation: boolean
  capitalize: boolean
  previousContext?: string
}

export interface ProviderHealth {
  ok: boolean
  detail: string
}

/**
 * A model as advertised by the provider, normalised across response shapes.
 * Declared here rather than imported from shared so this module stays the single
 * place the provider contract lives.
 */
export interface RemoteModel {
  id: string
  name: string
  inputPricePerMillion?: number
  outputPricePerMillion?: number
  contextLength?: number
  description?: string
  vendor?: string
  supportsText: boolean
}

export interface LlmProvider {
  readonly id: ProviderId
  readonly label: string
  readonly requiresApiKey: boolean
  readonly defaultModel: string
  readonly defaultBaseUrl: string

  /** Cheap synchronous check so the settings UI can flag obvious problems. */
  validateConfig(config: ProviderConfig): { ok: boolean; error?: string }
  healthCheck(config: ProviderConfig, signal?: AbortSignal): Promise<ProviderHealth>
  cleanup(req: CleanupRequest, config: ProviderConfig, timeoutMs: number, signal?: AbortSignal): Promise<CleanupResult>
  /**
   * Fetch the provider's model catalogue for the settings picker.
   *
   * Returns an empty list for providers that publish no catalogue rather than
   * throwing, so the settings UI can simply hide the picker.
   */
  listModels(config: ProviderConfig, signal?: AbortSignal): Promise<RemoteModel[]>
}
