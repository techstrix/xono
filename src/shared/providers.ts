import type { ProviderId } from './schema'

/**
 * Metadata describing a cleanup provider. Lives in `shared/` because the settings UI
 * renders it directly and the main process constructs providers from it — neither
 * side should have to import the other's modules.
 */
export interface ProviderDefinition {
  id: ProviderId
  label: string
  requiresApiKey: boolean
  defaultModel: string
  defaultBaseUrl: string
  /** Where to get an API key, shown as a link in settings. */
  keyUrl?: string
  hint: string
  /**
   * True when the provider exposes a model catalogue we can fetch to populate the
   * model picker. Providers without one fall back to a free-text model field.
   */
  hasModelCatalogue: boolean
}

export const PROVIDER_DEFINITIONS: Record<ProviderId, ProviderDefinition> = {
  mistral: {
    id: 'mistral',
    label: 'Mistral',
    requiresApiKey: true,
    defaultModel: 'mistral-small-latest',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys',
    hint: 'Fast, cheap, good at filler removal. Usually the best default.',
    hasModelCatalogue: true
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    requiresApiKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys',
    hint: 'Very fast inference on open models. Good for long dictations.',
    hasModelCatalogue: true
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    requiresApiKey: false,
    defaultModel: 'qwen2.5:3b',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    hint: 'Fully offline and free. Slower on CPU, but nothing leaves the machine.',
    hasModelCatalogue: true
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    requiresApiKey: true,
    defaultModel: 'claude-haiku-4-5',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'Best instruction following for paragraph structuring.',
    hasModelCatalogue: true
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    requiresApiKey: true,
    defaultModel: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    keyUrl: 'https://build.nvidia.com/settings',
    hint: 'NVIDIA-hosted NIM models, with a free trial tier. Pick a small or "lightning" model for speed.',
    hasModelCatalogue: true
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    requiresApiKey: true,
    defaultModel: 'mistralai/mistral-small-2603',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/keys',
    hint: 'One key, every model on the marketplace, and a live model list with pricing.',
    hasModelCatalogue: true
  }
}