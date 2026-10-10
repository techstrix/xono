import type { ProviderConfig, ProviderId } from '@shared/schema'
import type { CleanupResult } from '@shared/types'
import { loggerScope } from '../logger'
import { normaliseCatalogue, sortCatalogue } from './catalogue'
import { buildContextBlock, buildSystemPrompt, buildUserMessage, countFillers } from './prompt'
import type { CleanupRequest, LlmProvider, ProviderDefinition, ProviderHealth, RemoteModel } from './types'

const log = loggerScope('llm')

interface AnthropicResponse {
  content?: { type: string; text?: string }[]
  error?: { message?: string }
}

/** Anthropic's Messages API differs enough from OpenAI's to warrant its own class. */
export class AnthropicProvider implements LlmProvider {
  readonly requiresApiKey = true

  constructor(private readonly def: ProviderDefinition) {}

  get id(): ProviderId {
    return this.def.id
  }
  get label(): string {
    return this.def.label
  }
  get defaultModel(): string {
    return this.def.defaultModel
  }
  get defaultBaseUrl(): string {
    return this.def.defaultBaseUrl
  }

  validateConfig(config: ProviderConfig): { ok: boolean; error?: string } {
    if (!config.apiKey.trim()) return { ok: false, error: 'Anthropic needs an API key' }
    if (!config.model.trim()) return { ok: false, error: 'Anthropic needs a model name' }
    return { ok: true }
  }

  async healthCheck(config: ProviderConfig, signal?: AbortSignal): Promise<ProviderHealth> {
    const validation = this.validateConfig(config)
    if (!validation.ok) return { ok: false, detail: validation.error ?? 'invalid config' }
    const started = Date.now()
    try {
      await this.post(config, [{ role: 'user', content: 'ping' }], 6000, signal, 16)
      return { ok: true, detail: `reachable in ${Date.now() - started}ms` }
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) }
    }
  }

  async cleanup(
    req: CleanupRequest,
    config: ProviderConfig,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<CleanupResult> {
    const started = Date.now()
    const system = buildSystemPrompt(req, {
      punctuation: req.punctuation,
      capitalize: req.capitalize,
      vocabulary: req.vocabulary,
      hasContext: Boolean(req.previousContext)
    })
    const content = req.previousContext ? buildContextBlock(req.previousContext) + buildUserMessage(req) : buildUserMessage(req)

    const text = await this.post(config, [{ role: 'user', content }], timeoutMs, signal, undefined, system)

    return {
      text: text.trim(),
      fallback: false,
      removedFillers: countFillers(req.raw, text),
      latencyMs: Date.now() - started,
      providerId: this.id,
      model: config.model
    }
  }

  /**
   * Anthropic publishes a catalogue at `/v1/models`, in its own shape
   * (`id` plus `display_name`). Reuses the shared normaliser.
   */
  async listModels(config: ProviderConfig, signal?: AbortSignal): Promise<RemoteModel[]> {
    const base = config.baseUrl.replace(/\/+$/, '') || this.def.defaultBaseUrl
    if (!base) return []

    const url = base.endsWith('/models') ? base : `${base}/models`
    const timeout = AbortSignal.timeout(15000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    try {
      const res = await fetch(url, {
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        signal: combined
      })
      if (!res.ok) {
        throw new Error(`Anthropic returned HTTP ${res.status} listing models`)
      }
      return sortCatalogue(normaliseCatalogue((await res.json()) as unknown))
    } catch (err) {
      if (combined.aborted) {
        throw new Error(signal?.aborted ? 'Cancelled' : 'Anthropic model list timed out')
      }
      throw new Error(`Could not list Anthropic models: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async post(
    config: ProviderConfig,
    messages: { role: 'user' | 'assistant'; content: string }[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    maxTokens?: number,
    system?: string
  ): Promise<string> {
    const base = config.baseUrl.replace(/\/+$/, '') || this.def.defaultBaseUrl
    const url = base.endsWith('/messages') ? base : `${base}/messages`

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': config.apiKey
    }

    const payload: Record<string, unknown> = {
      model: config.model,
      messages,
      max_tokens: maxTokens ?? 2048,
      temperature: 0.1
    }
    if (system) payload.system = system

    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    log.debug('anthropic request to', url)

    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: combined })
    } catch (err) {
      if (combined.aborted) {
        throw new Error(signal?.aborted ? 'Cancelled' : `Anthropic timed out after ${timeoutMs}ms`)
      }
      throw new Error(`Anthropic request failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Anthropic returned HTTP ${res.status}: ${detail.replace(/\s+/g, ' ').slice(0, 300)}`)
    }

    const json = (await res.json()) as AnthropicResponse
    if (json.error?.message) throw new Error(`Anthropic: ${json.error.message}`)

    const text = (json.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')

    if (!text.trim()) throw new Error('Anthropic returned an empty response')
    return text
  }
}