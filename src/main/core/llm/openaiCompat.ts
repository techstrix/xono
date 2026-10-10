import type { ProviderConfig, ProviderId } from '@shared/schema'
import type { CleanupResult } from '@shared/types'
import { loggerScope } from '../logger'
import { buildContextBlock, buildSystemPrompt, buildUserMessage, countFillers } from './prompt'
import { normaliseCatalogue, sortCatalogue } from './catalogue'
import type { CleanupRequest, LlmProvider, ProviderDefinition, ProviderHealth, RemoteModel } from './types'

const log = loggerScope('llm')

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }[]
  error?: { message?: string }
}

/**
 * Mistral, Groq and Ollama all speak the OpenAI `/chat/completions` dialect, so the
 * fetch/retry/timeout/parse logic lives here once and each backend supplies only its
 * base URL and model ids.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly requiresApiKey: boolean

  constructor(private readonly def: ProviderDefinition) {
    this.requiresApiKey = def.requiresApiKey
  }

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
    if (this.requiresApiKey && !config.apiKey.trim()) {
      return { ok: false, error: `${this.def.label} needs an API key` }
    }
    if (!config.model.trim()) return { ok: false, error: `${this.def.label} needs a model name` }
    if (!/^https?:\/\//.test(config.baseUrl)) return { ok: false, error: `${this.def.label} needs a valid base URL` }
    return { ok: true }
  }

  async healthCheck(config: ProviderConfig, signal?: AbortSignal): Promise<ProviderHealth> {
    const validation = this.validateConfig(config)
    if (!validation.ok) return { ok: false, detail: validation.error ?? 'invalid config' }

    // Ollama has no auth, so a plain chat call is the only meaningful liveness probe.
    const started = Date.now()
    try {
      await this.post(
        config,
        [{ role: 'user', content: 'ping' }],
        6000,
        signal,
        1
      )
      return { ok: true, detail: `reachable in ${Date.now() - started}ms` }
    } catch (err) {
      return { ok: false, detail: describe(err) }
    }
  }

  async cleanup(
    req: CleanupRequest,
    config: ProviderConfig,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<CleanupResult> {
    const started = Date.now()
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(req, {
          punctuation: req.punctuation,
          capitalize: req.capitalize,
          vocabulary: req.vocabulary,
          hasContext: Boolean(req.previousContext)
        })
      }
    ]

    const body = req.previousContext ? buildContextBlock(req.previousContext) + buildUserMessage(req) : buildUserMessage(req)
    messages.push({ role: 'user', content: body })

    const text = await this.post(config, messages, timeoutMs, signal)

    return {
      text: text.trim(),
      fallback: false,
      removedFillers: countFillers(req.raw, text),
      latencyMs: Date.now() - started,
      providerId: this.id,
      model: config.model
    }
  }

  private async post(
    config: ProviderConfig,
    messages: ChatMessage[],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    maxTokens?: number
  ): Promise<string> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    Object.assign(headers, this.extraHeaders(config))

    const payload: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 0.1,
      stream: false
    }
    if (maxTokens) payload.max_tokens = maxTokens

    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    log.debug(`${this.id} request to`, url)

    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: combined })
    } catch (err) {
      if (combined.aborted) {
        throw new Error(signal?.aborted ? 'Cancelled' : `${this.def.label} timed out after ${timeoutMs}ms`)
      }
      throw new Error(`${this.def.label} request failed: ${describe(err)}`)
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${this.def.label} returned HTTP ${res.status}: ${truncate(detail)}`)
    }

    const json = (await res.json()) as ChatCompletionResponse
    if (json.error?.message) throw new Error(`${this.def.label}: ${json.error.message}`)

    const message = json.choices?.[0]?.message
    const content = message?.content
    if (typeof content === 'string' && content.trim()) return stripLeadingReasoning(content)

    // Reasoning models (several on NVIDIA and OpenRouter) put their thinking in a
    // separate field. Reaching here with reasoning present means the model burned
    // tokens thinking and returned nothing usable, which is worth saying plainly
    // rather than reporting a bare "empty response".
    const reasoning = message?.reasoning_content ?? message?.reasoning
    if (typeof reasoning === 'string' && reasoning.trim()) {
      throw new Error(
        `${this.def.label} returned only reasoning and no answer. This model is a reasoning model; pick a non-reasoning one for fast, deterministic cleanup.`
      )
    }

    throw new Error(`${this.def.label} returned an empty response`)
  }

  /**
   * Per-provider request headers, merged into every call. OpenRouter uses this for app
   * attribution; the default implementation contributes nothing.
   */
  protected extraHeaders(_config: ProviderConfig): Record<string, string> {
    return {}
  }

  async listModels(config: ProviderConfig, signal?: AbortSignal): Promise<RemoteModel[]> {
    if (!/^https?:\/\//.test(config.baseUrl)) return []

    const url = `${config.baseUrl.replace(/\/+$/, '')}/models`
    const headers: Record<string, string> = {}
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`
    Object.assign(headers, this.extraHeaders(config))

    const timeout = AbortSignal.timeout(15000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

    try {
      const res = await fetch(url, { headers, signal: combined })
      if (!res.ok) {
        throw new Error(`${this.def.label} returned HTTP ${res.status} listing models`)
      }
      return sortCatalogue(normaliseCatalogue((await res.json()) as unknown))
    } catch (err) {
      if (combined.aborted) throw new Error(signal?.aborted ? 'Cancelled' : `${this.def.label} model list timed out`)
      throw new Error(`Could not list ${this.def.label} models: ${describe(err)}`)
    }
  }
}

/**
 * Some gateways inline the thinking block at the start of `content` instead of using a
 * separate field. Dropping it keeps the cleanup prompt free of scratch work.
 */
export function stripLeadingReasoning(text: string): string {
  const match = /^\s*(?:<think>|<thinking>|<reasoning>)[\s\S]*?(?:<\/think>|<\/thinking>|<\/reasoning>)\s*/i.exec(text)
  return match ? text.slice(match[0].length).trim() : text.trim()
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function truncate(text: string, max = 300): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}