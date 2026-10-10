import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildProvider, PROVIDER_DEFINITIONS } from '../../src/main/core/llm'
import { DEFAULT_CONFIG, type ProviderConfig } from '../../src/shared/schema'

/**
 * The cleanup providers are the only place where the user's dictation leaves the
 * machine, so the request shape and the response parsing are worth pinning down. These
 * run against a local HTTP server rather than a real provider: no keys, no cost, no
 * network, and the error paths become testable.
 */
interface Captured {
  url: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
}

let server: Server
let baseUrl: string
let captured: Captured | null = null
let respondWith: (res: import('node:http').ServerResponse) => void

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
      } catch {
        /* leave empty */
      }
      captured = {
        url: req.url ?? '',
        headers: req.headers,
        body
      }
      respondWith(res)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not bind test server')
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

function json(res: import('node:http').ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function openAiConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { apiKey: 'test-key', model: 'test-model', baseUrl, referer: '', title: '', ...overrides }
}

const request = {
  raw: 'um so deploy the thing on friday you know',
  mode: 'cleaned' as const,
  vocabulary: ['ydotool'],
  punctuation: true,
  capitalize: true
}

describe('OpenAI-compatible cleanup provider', () => {
  it('sends a system prompt carrying the mode, switches and vocabulary', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'Deploy the thing on Friday.' } }] })
    const provider = buildProvider('mistral')

    const result = await provider.cleanup(request, openAiConfig(), 5000)

    expect(result.text).toBe('Deploy the thing on Friday.')
    expect(result.fallback).toBe(false)
    expect(result.providerId).toBe('mistral')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)

    expect(captured?.url).toBe('/v1/chat/completions')
    expect(captured?.headers.authorization).toBe('Bearer test-key')

    const messages = captured?.body.messages as { role: string; content: string }[]
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('Never answer')
    expect(messages[0]?.content).toContain('Mode: CLEANED')
    expect(messages[0]?.content).toContain('ydotool')
    expect(messages[1]?.content).toContain(request.raw)
  })

  it('sends low temperature and no streaming, for deterministic cleanup', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'ok' } }] })
    await buildProvider('mistral').cleanup(request, openAiConfig(), 5000)

    expect(captured?.body.temperature).toBe(0.1)
    expect(captured?.body.stream).toBe(false)
    expect(captured?.body.model).toBe('test-model')
  })

  it('adds the previous utterance as context when one is supplied', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'ok' } }] })
    await buildProvider('mistral').cleanup({ ...request, previousContext: 'earlier words' }, openAiConfig(), 5000)

    const messages = captured?.body.messages as { role: string; content: string }[]
    expect(messages[1]?.content).toContain('<previous utterance>')
    expect(messages[0]?.content).toContain('previous utterance')
  })

  it('omits the context block when there is no context', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'ok' } }] })
    await buildProvider('mistral').cleanup(request, openAiConfig(), 5000)

    const messages = captured?.body.messages as { content: string }[]
    expect(messages[1]?.content).not.toContain('<previous utterance>')
  })

  it('counts the fillers the model removed', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'Deploy the thing on Friday.' } }] })
    const result = await buildProvider('mistral').cleanup(request, openAiConfig(), 5000)
    // The raw transcript contains "um" and "you know"; the cleaned one has neither.
    expect(result.removedFillers).toBe(2)
  })

  it('never claims to have removed a filler it did not', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'um, like, you know' } }] })
    const result = await buildProvider('mistral').cleanup(request, openAiConfig(), 5000)
    expect(result.removedFillers).toBe(0)
  })

  it('raises a useful error on an HTTP failure', async () => {
    respondWith = (res) => json(res, 429, { error: { message: 'rate limited' } })
    await expect(buildProvider('mistral').cleanup(request, openAiConfig(), 5000)).rejects.toThrow(/429/)
  })

  it('raises when the provider returns an empty completion', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: '   ' } }] })
    await expect(buildProvider('mistral').cleanup(request, openAiConfig(), 5000)).rejects.toThrow(/empty/i)
  })

  it('times out rather than hanging forever', async () => {
    respondWith = () => {
      /* never responds */
    }
    await expect(buildProvider('mistral').cleanup(request, openAiConfig(), 300)).rejects.toThrow(/timed out|Cancelled/i)
  })

  it('treats a missing key as a configuration error, not a request error', () => {
    const provider = buildProvider('mistral')
    expect(provider.validateConfig({ apiKey: '', model: 'm', baseUrl: 'https://x', referer: '', title: '' })).toEqual({
      ok: false,
      error: expect.stringContaining('API key')
    })
    expect(provider.validateConfig({ apiKey: 'k', model: '', baseUrl: 'https://x', referer: '', title: '' }).ok).toBe(false)
    expect(provider.validateConfig({ apiKey: 'k', model: 'm', baseUrl: 'not-a-url', referer: '', title: '' }).ok).toBe(false)
    expect(provider.validateConfig({ apiKey: 'k', model: 'm', baseUrl: 'https://x', referer: '', title: '' }).ok).toBe(true)
  })

  it('does not require an API key for a local provider', () => {
    expect(buildProvider('ollama').validateConfig({ apiKey: '', model: 'qwen2.5:3b', baseUrl, referer: '', title: '' }).ok).toBe(true)
  })

  it('sends no Authorization header when there is no key', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'ok' } }] })
    await buildProvider('ollama').cleanup(request, openAiConfig({ apiKey: '' }), 5000)
    expect(captured?.headers.authorization).toBeUndefined()
  })

  it('surfaces a health check result without throwing', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'pong' } }] })
    const health = await buildProvider('groq').healthCheck(openAiConfig())
    expect(health.ok).toBe(true)
    expect(health.detail).toMatch(/reachable/)
  })
})

describe('Anthropic cleanup provider', () => {
  it('uses the Messages API shape and the x-api-key header', async () => {
    respondWith = (res) =>
      json(res, 200, { content: [{ type: 'text', text: 'Deploy the thing on Friday.' }] })

    const result = await buildProvider('anthropic').cleanup(request, openAiConfig(), 5000)

    expect(result.text).toBe('Deploy the thing on Friday.')
    expect(captured?.url).toBe('/v1/messages')
    expect(captured?.headers['x-api-key']).toBe('test-key')
    expect(captured?.headers['anthropic-version']).toBe('2023-06-01')
    // Anthropic takes the system prompt as a top-level field, not a message role.
    expect(captured?.body.system).toContain('Never answer')
    const messages = captured?.body.messages as { role: string }[]
    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe('user')
    expect(captured?.body.authorization).toBeUndefined()
  })

  it('joins multiple text blocks', async () => {
    respondWith = (res) =>
      json(res, 200, {
        content: [
          { type: 'text', text: 'Deploy the ' },
          { type: 'text', text: 'thing on Friday.' }
        ]
      })
    const result = await buildProvider('anthropic').cleanup(request, openAiConfig(), 5000)
    expect(result.text).toBe('Deploy the thing on Friday.')
  })

  it('requires a key', () => {
    expect(buildProvider('anthropic').validateConfig({ apiKey: '', model: 'm', baseUrl: 'https://x', referer: '', title: '' }).ok).toBe(false)
  })
})

describe('provider catalogue', () => {
  it('gives every provider a default model and base URL', () => {
    for (const def of Object.values(PROVIDER_DEFINITIONS)) {
      expect(def.defaultModel).toBeTruthy()
      expect(def.defaultBaseUrl).toMatch(/^https?:\/\//)
      expect(def.hint).toBeTruthy()
    }
  })

  it('matches the defaults baked into the shipped config', () => {
    for (const [id, def] of Object.entries(PROVIDER_DEFINITIONS)) {
      const shipped = DEFAULT_CONFIG.llm.providers[id as keyof typeof DEFAULT_CONFIG.llm.providers]
      expect(shipped.baseUrl).toBe(def.defaultBaseUrl)
      expect(shipped.model).toBe(def.defaultModel)
    }
  })

  it('only requires keys for the hosted providers', () => {
    expect(PROVIDER_DEFINITIONS.ollama.requiresApiKey).toBe(false)
    expect(PROVIDER_DEFINITIONS.mistral.requiresApiKey).toBe(true)
    expect(PROVIDER_DEFINITIONS.groq.requiresApiKey).toBe(true)
    expect(PROVIDER_DEFINITIONS.anthropic.requiresApiKey).toBe(true)
  })
})