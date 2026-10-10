import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { isChatCapableModel, prettifyModelId } from '../../src/main/core/llm/nvidia'
import { stripLeadingReasoning } from '../../src/main/core/llm/openaiCompat'
import { buildProvider, PROVIDER_DEFINITIONS } from '../../src/main/core/llm'
import { filterCatalogue, sortCatalogue } from '../../src/shared/catalogue'
import { providerDefaults, type ProviderConfig } from '../../src/shared/schema'

/**
 * NVIDIA publishes the least metadata of any provider we support: `/models` returns
 * only an id per entry. Everything that makes the picker usable is therefore inferred,
 * so those inferences are pinned down here.
 */
let server: Server
let baseUrl: string
let captured: {
  url: string
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
} | null = null
let respondWith: (res: ServerResponse) => void

/** The real response shape, trimmed to the four fields NVIDIA actually sends. */
const NVIDIA_SAMPLE = {
  object: 'list',
  data: [
    { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', object: 'model', created: 735790403, owned_by: 'nvidia' },
    { id: 'nvidia/embed-qa-4', object: 'model', created: 735790403, owned_by: 'nvidia' },
    { id: 'nvidia/nvclip', object: 'model', created: 735790403, owned_by: 'nvidia' },
    { id: 'meta/llama-3.2-11b-vision-instruct', object: 'model', created: 735790403, owned_by: 'meta' },
    { id: 'mistralai/mistral-large-2-instruct', object: 'model', created: 735790403, owned_by: 'mistralai' },
    { id: 'snowflake/arctic-embed-l', object: 'model', created: 735790403, owned_by: 'snowflake' },
    { id: 'google/deplot', object: 'model', created: 735790403, owned_by: 'google' },
    { id: 'openai/gpt-oss-20b', object: 'model', created: 735790403, owned_by: 'openai' },
    { id: 'standalone-without-vendor', object: 'model', created: 735790403, owned_by: 'somebody' }
  ]
}

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
      captured = { url: req.url ?? '', headers: req.headers, body }
      respondWith(res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not bind')
  baseUrl = `http://127.0.0.1:${address.port}/v1`
})

afterEach(() => {
  captured = null
})

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function config(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { apiKey: 'test-key', model: 'test-model', baseUrl, referer: '', title: '', ...overrides }
}

describe('NVIDIA model-id prettifying', () => {
  it('turns a raw id into something readable', () => {
    expect(prettifyModelId('nvidia/nemotron-3.5-lightning-30b-a3b')).toBe(
      'NVIDIA · Nemotron 3.5 Lightning 30B A3B'
    )
    expect(prettifyModelId('mistralai/mistral-large-2-instruct')).toBe('Mistral AI · Mistral Large 2 Instruct')
  })

  it('uppercases parameter counts', () => {
    expect(prettifyModelId('meta/llama-3.2-11b-vision-instruct')).toContain('11B')
    expect(prettifyModelId('nvidia/nemotron-3-ultra-550b-a55b')).toContain('550B')
    expect(prettifyModelId('openai/gpt-oss-20b')).toContain('20B')
  })

  it('uppercases the mixture-of-experts active-parameter form', () => {
    // "a3b" means 3B active parameters out of 30B; leaving it as "A3b" reads as a typo.
    expect(prettifyModelId('nvidia/nemotron-3.5-lightning-30b-a3b')).toContain('A3B')
    expect(prettifyModelId('nvidia/nemotron-3-super-120b-a12b')).toContain('A12B')
    expect(prettifyModelId('nvidia/nemotron-3-nano-30b-a3b')).toContain('A3B')
  })

  it('preserves known acronyms', () => {
    expect(prettifyModelId('some/thing-moe-model')).toContain('MOE')
    expect(prettifyModelId('some/thing-ai-model')).toContain('AI')
    expect(prettifyModelId('some/thing-vlm-model')).toContain('VLM')
    expect(prettifyModelId('some/thing-glm-9b')).toContain('GLM')
  })

  it('falls back sensibly for an unknown vendor', () => {
    expect(prettifyModelId('acme-ai/widget-2b')).toBe('Acme AI · Widget 2B')
  })

  it('handles an id with no vendor prefix', () => {
    expect(prettifyModelId('standalone-without-vendor')).toBe('Standalone Without Vendor')
  })
})

describe('NVIDIA chat-capability heuristic', () => {
  it('accepts general chat models', () => {
    for (const id of [
      'nvidia/nemotron-3.5-lightning-30b-a3b',
      'nvidia/llama-3.1-nemotron-70b-instruct',
      'mistralai/mistral-large-2-instruct',
      'meta/llama-3.2-11b-vision-instruct',
      'moonshotai/kimi-k2.6',
      'openai/gpt-oss-20b',
      'google/gemma-3-12b-it'
    ]) {
      expect(isChatCapableModel(id), id).toBe(true)
    }
  })

  it('rejects models that cannot do chat', () => {
    for (const id of [
      'nvidia/embed-qa-4',
      'nvidia/nvclip',
      'nvidia/nemotron-3-embed-1b',
      'nvidia/nv-embedqa-mistral-7b-v2',
      'nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1',
      'snowflake/arctic-embed-l',
      'nvidia/llama-3.1-nemoguard-8b-content-safety',
      'nvidia/llama-3.1-nemoguard-8b-topic-control',
      'meta/llama-guard-4-12b',
      'nvidia/nemotron-3.5-content-safety',
      'nvidia/nemotron-4-340b-reward',
      'nvidia/ising-calibration-1.5-31b',
      'nvidia/riva-translate-4b-instruct',
      'nvidia/nemotron-parse-2.0',
      'nvidia/ai-synthetic-video-detector',
      'google/deplot'
    ]) {
      expect(isChatCapableModel(id), id).toBe(false)
    }
  })

  it('is case insensitive', () => {
    expect(isChatCapableModel('NVIDIA/EMBED-QA-4')).toBe(false)
  })
})

describe('NVIDIA catalogue', () => {
  it('reads the sparse shape and fills in names and classification', async () => {
    respondWith = (res) => json(res, 200, NVIDIA_SAMPLE)
    const models = await buildProvider('nvidia').listModels(config())

    expect(models).toHaveLength(9)
    expect(captured?.url).toBe('/v1/models')
    expect(captured?.headers.authorization).toBe('Bearer test-key')

    const lightning = models.find((m) => m.id === 'nvidia/nemotron-3.5-lightning-30b-a3b')!
    expect(lightning.name).toBe('NVIDIA · Nemotron 3.5 Lightning 30B A3B')
    expect(lightning.supportsText).toBe(true)
    expect(lightning.vendor).toBe('nvidia')
    // NVIDIA publishes no price, so the picker must show "unknown", not "free".
    expect(lightning.inputPricePerMillion).toBeUndefined()

    expect(models.find((m) => m.id === 'nvidia/embed-qa-4')!.supportsText).toBe(false)
    expect(models.find((m) => m.id === 'google/deplot')!.supportsText).toBe(false)
  })

  it('hides non-chat models from the picker', async () => {
    respondWith = (res) => json(res, 200, NVIDIA_SAMPLE)
    const models = await buildProvider('nvidia').listModels(config())

    const visible = filterCatalogue(models, '')
    expect(visible.map((m) => m.id)).not.toContain('nvidia/embed-qa-4')
    expect(visible.map((m) => m.id)).toContain('nvidia/nemotron-3.5-lightning-30b-a3b')
    // Still searchable if someone specifically asks for it.
    expect(filterCatalogue(models, 'embed').map((m) => m.id)).toEqual([])
  })

  it('sends a normal OpenAI-shaped chat request', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'Deploy on Friday.' } }] })
    const provider = buildProvider('nvidia')

    const result = await provider.cleanup(
      { raw: 'deploy on friday', mode: 'cleaned', vocabulary: [], punctuation: true, capitalize: true },
      config({ model: 'nvidia/nemotron-3.5-lightning-30b-a3b' }),
      5000
    )

    expect(result.text).toBe('Deploy on Friday.')
    expect(captured?.url).toBe('/v1/chat/completions')
    expect(captured?.body.model).toBe('nvidia/nemotron-3.5-lightning-30b-a3b')
  })

  it('explains itself when a reasoning model returns only thinking', async () => {
    respondWith = (res) =>
      json(res, 200, {
        choices: [{ message: { content: '', reasoning_content: 'Let me think about this sentence…' } }]
      })

    await expect(
      buildProvider('nvidia').cleanup(
        { raw: 'hi', mode: 'cleaned', vocabulary: [], punctuation: true, capitalize: true },
        config(),
        5000
      )
    ).rejects.toThrow(/reasoning/i)
  })

  it('reports a helpful error when the catalogue request fails', async () => {
    respondWith = (res) => json(res, 401, { error: { message: 'no key' } })
    await expect(buildProvider('nvidia').listModels(config())).rejects.toThrow(/401/)
  })
})

describe('reasoning handling', () => {
  it('strips an inlined thinking block from the front of the answer', () => {
    expect(stripLeadingReasoning('<think>the user said um twice</think>Deploy on Friday.')).toBe(
      'Deploy on Friday.'
    )
    expect(stripLeadingReasoning('<thinking>hmm</thinking>\n\nDeploy on Friday.')).toBe('Deploy on Friday.')
    expect(stripLeadingReasoning('<reasoning>x</reasoning>Done')).toBe('Done')
  })

  it('leaves ordinary text alone', () => {
    expect(stripLeadingReasoning('Deploy on Friday.')).toBe('Deploy on Friday.')
    // A bracket that is not a thinking tag must survive.
    expect(stripLeadingReasoning('Add a [TODO] for this')).toBe('Add a [TODO] for this')
  })

  it('handles a tag that never closes without eating the answer', () => {
    expect(stripLeadingReasoning('<think>unterminated Deploy on Friday.')).toBe('<think>unterminated Deploy on Friday.')
  })
})

describe('provider registry', () => {
  it('exposes NVIDIA with a catalogue and a working default', () => {
    const def = PROVIDER_DEFINITIONS.nvidia
    expect(def.defaultBaseUrl).toBe('https://integrate.api.nvidia.com/v1')
    expect(def.hasModelCatalogue).toBe(true)
    expect(def.keyUrl).toContain('build.nvidia.com')
    expect(providerDefaults('nvidia').baseUrl).toBe(def.defaultBaseUrl)
  })

  it('sorts unpriced models by name without dropping them', async () => {
    respondWith = (res) => json(res, 200, NVIDIA_SAMPLE)
    const models = await buildProvider('nvidia').listModels(config())
    const sorted = sortCatalogue(models)
    const chat = sorted.filter((m) => m.supportsText)

    // Nothing is priced, so ordering falls through to the name.
    expect(chat).toHaveLength(5)
    for (let i = 1; i < chat.length; i++) {
      expect(chat[i]!.name.localeCompare(chat[i - 1]!.name)).toBeGreaterThan(0)
    }
  })
})