import { PROVIDER_IDS, type ProviderId } from '@shared/schema'
import { PROVIDER_DEFINITIONS } from '@shared/providers'
import { loggerScope } from '../logger'
import { AnthropicProvider } from './anthropic'
import { OpenAICompatibleProvider } from './openaiCompat'
import { NvidiaProvider } from './nvidia'
import { OpenRouterProvider } from './openrouter'
import type { LlmProvider } from './types'
import type { ProviderDefinition } from '@shared/providers'

const log = loggerScope('llm')

export type { CleanupRequest, LlmProvider, ProviderHealth } from './types'
export { PROVIDER_DEFINITIONS } from '@shared/providers'
export type { ProviderDefinition } from '@shared/providers'

export function buildProvider(id: ProviderId): LlmProvider {
  const def = PROVIDER_DEFINITIONS[id]
  if (id === 'anthropic') return new AnthropicProvider(def)
  if (id === 'openrouter') return new OpenRouterProvider(def)
  if (id === 'nvidia') return new NvidiaProvider(def)
  return new OpenAICompatibleProvider(def)
}

export type ProviderRegistry = Record<ProviderId, LlmProvider>

export function createProviderRegistry(): ProviderRegistry {
  const registry = {} as ProviderRegistry
  for (const id of PROVIDER_IDS) registry[id] = buildProvider(id)
  log.info('providers registered:', Object.keys(registry).join(', '))
  return registry
}