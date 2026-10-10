import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProvider } from '../../src/main/core/llm'
import { CatalogueCache, CATALOGUE_TTL_MS } from '../../src/main/core/llm/catalogueCache'
import { filterCatalogue, normaliseCatalogue, pricePerMillion, sortCatalogue } from '../../src/shared/catalogue'
import type { ProviderConfig } from '../../src/shared/schema'

/**
 * The model picker is only as good as the normalisation feeding it, and the shapes here
 * come from four different providers. These pin down the real quirks: OpenRouter's
 * per-token price strings, its "price varies" negative sentinel, and the difference
 * between a model that can do text cleanup and one that cannot.
 */
let server: Server
let baseUrl: string
let captured: { url: string; headers: Record<string, string | string[] | undefined> } | null = null
let respondWith: (res: ServerResponse) => void

beforeAll(async () => {
  server = createServer((req, res) => {
    captured = { url: req.url ?? '', headers: req.headers }
    respondWith(res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not bind')
  baseUrl = `http://127.0.0.1:${address.port}/api/v1`
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

/** A trimmed but structurally faithful slice of a real OpenRouter /models response. */
const OPENROUTER_SAMPLE = {
  data: [
    {
      id: 'mistralai/mistral-small-2603',
      name: 'Mistral: Mistral Small 26.03',
      context_length: 262144,
      description: 'A compact model that punches above its weight.',
      architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.00000015', completion: '0.0000006' }
    },
    {
      id: 'anthropic/claude-haiku-5.5',
      name: 'Anthropic: Claude Haiku 5.5',
      context_length: 1000000,
      architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000001', completion: '0.0000005' }
    },
    {
      id: 'some-vendor/vision-only',
      name: 'Some Vendor: Vision Only',
      context_length: 128000,
      architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] }
    },
    {
      id: 'some-vendor/tts-only',
      name: 'Some Vendor: Speech Output',
      architecture: { modality: 'text->audio', input_modalities: ['text'], output_modalities: ['audio'] }
    },
    {
      id: 'openrouter/auto',
      name: 'OpenRouter: Auto',
      context_length: 2000000,
      architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      // Negative means "price depends on the routed model", not "free".
      pricing: { prompt: '-1', completion: '-1' }
    },
    {
      id: 'vendor/no-pricing-listed',
      name: 'Vendor: Unpriced',
      context_length: null,
      architecture: { modality: 'text->text' }
    }
  ]
}

describe('price normalisation', () => {
  it('converts a per-token string to USD per million', () => {
    expect(pricePerMillion('0.00000015')).toBeCloseTo(0.15, 6)
    expect(pricePerMillion('0.000001')).toBeCloseTo(1, 6)
  })

  it('treats the negative routing sentinel as unknown, not free', () => {
    expect(pricePerMillion('-1')).toBeUndefined()
    expect(pricePerMillion(-1)).toBeUndefined()
  })

  it('reports a genuine zero price as zero', () => {
    expect(pricePerMillion('0')).toBe(0)
  })

  it('handles missing and unparseable values', () => {
    expect(pricePerMillion(undefined)).toBeUndefined()
    expect(pricePerMillion(null)).toBeUndefined()
    expect(pricePerMillion('free')).toBeUndefined()
  })
})

describe('catalogue normalisation', () => {
  it('reads the OpenRouter shape', () => {
    const models = normaliseCatalogue(OPENROUTER_SAMPLE)
    expect(models).toHaveLength(6)

    const mistral = models.find((m) => m.id === 'mistralai/mistral-small-2603')!
    expect(mistral.name).toBe('Mistral: Mistral Small 26.03')
    expect(mistral.contextLength).toBe(262144)
    expect(mistral.inputPricePerMillion).toBeCloseTo(0.15, 6)
    expect(mistral.outputPricePerMillion).toBeCloseTo(0.6, 6)
    expect(mistral.vendor).toBe('mistralai')
    expect(mistral.supportsText).toBe(true)
  })

  it('flags models that cannot produce text', () => {
    const models = normaliseCatalogue(OPENROUTER_SAMPLE)
    expect(models.find((m) => m.id === 'some-vendor/tts-only')!.supportsText).toBe(false)
    // Vision-in, text-out is fine for us.
    expect(models.find((m) => m.id === 'some-vendor/vision-only')!.supportsText).toBe(true)
  })

  it('reports no price rather than a misleading zero for routers', () => {
    const auto = normaliseCatalogue(OPENROUTER_SAMPLE).find((m) => m.id === 'openrouter/auto')!
    expect(auto.inputPricePerMillion).toBeUndefined()
    expect(auto.outputPricePerMillion).toBeUndefined()
  })

  it('falls back to the id when the name is missing', () => {
    const models = normaliseCatalogue({ data: [{ id: 'bare/model' }] })
    expect(models[0]?.name).toBe('bare/model')
    // Missing metadata must not disqualify a model.
    expect(models[0]?.supportsText).toBe(true)
  })

  it('reads the Anthropic shape, which uses display_name', () => {
    const models = normaliseCatalogue({
      data: [{ id: 'claude-haiku-5.5', display_name: 'Claude Haiku 5.5' }]
    })
    expect(models[0]?.name).toBe('Claude Haiku 5.5')
    expect(models[0]?.vendor).toBeUndefined()
  })

  it('reads a bare array, as Ollama-adjacent endpoints sometimes return', () => {
    expect(normaliseCatalogue([{ id: 'a/b' }])).toHaveLength(1)
  })

  it('de-duplicates repeated ids', () => {
    const models = normaliseCatalogue({ data: [{ id: 'a/b' }, { id: 'a/b' }] })
    expect(models).toHaveLength(1)
  })

  it('survives rubbish without throwing', () => {
    expect(normaliseCatalogue(null)).toEqual([])
    expect(normaliseCatalogue('nope')).toEqual([])
    expect(normaliseCatalogue({})).toEqual([])
    expect(normaliseCatalogue({ data: [null, 42, { noId: true }] })).toEqual([])
  })

  it('truncates a very long description', () => {
    const models = normaliseCatalogue({ data: [{ id: 'a/b', description: 'x'.repeat(1000) }] })
    expect(models[0]!.description!.length).toBeLessThanOrEqual(220)
    expect(models[0]!.description!.endsWith('…')).toBe(true)
  })
})

describe('catalogue sorting and filtering', () => {
  it('puts text-capable models first, cheapest first within that', () => {
    const sorted = sortCatalogue(normaliseCatalogue(OPENROUTER_SAMPLE))
    const textModels = sorted.filter((m) => m.supportsText)
    expect(textModels).toHaveLength(5)
    // Claude Haiku 5.5 is $0.10/M in, Mistral Small is $0.15/M.
    expect(textModels[0]?.id).toBe('anthropic/claude-haiku-5.5')
    expect(textModels[1]?.id).toBe('mistralai/mistral-small-2603')
    // Unpriced entries (routers) sort after priced ones but before... nothing is lost.
    expect(textModels.map((m) => m.id)).toContain('openrouter/auto')
    // Non-text sinks to the end.
    expect(sorted[sorted.length - 1]?.supportsText).toBe(false)
  })

  it('filters across id, name, vendor and description', () => {
    const models = normaliseCatalogue(OPENROUTER_SAMPLE)
    expect(filterCatalogue(models, 'haiku').map((m) => m.id)).toEqual(['anthropic/claude-haiku-5.5'])
    expect(filterCatalogue(models, 'mistralai').map((m) => m.id)).toEqual(['mistralai/mistral-small-2603'])
    expect(filterCatalogue(models, 'anthropic claude').map((m) => m.id)).toEqual(['anthropic/claude-haiku-5.5'])
    expect(filterCatalogue(models, 'free')).toEqual([])
  })

  it('never surfaces a non-text model, even on an empty query', () => {
    const models = normaliseCatalogue(OPENROUTER_SAMPLE)
    expect(filterCatalogue(models, '').every((m) => m.supportsText)).toBe(true)
    expect(filterCatalogue(models, 'speech').every((m) => m.supportsText)).toBe(true)
  })

  it('matches OpenRouter free-tier models by id without the colon', () => {
    const models = normaliseCatalogue({
      data: [
        {
          id: 'vendor/thing:free',
          name: 'Vendor: Thing Free',
          architecture: { modality: 'text->text' },
          pricing: { prompt: '0', completion: '0' }
        }
      ]
    })
    expect(filterCatalogue(models, ':free').map((m) => m.id)).toEqual(['vendor/thing:free'])
    expect(filterCatalogue(models, 'free').map((m) => m.id)).toEqual(['vendor/thing:free'])
  })
})

describe('OpenRouter provider', () => {
  it('sends the attribution headers when configured', async () => {
    respondWith = (res) => json(res, 200, OPENROUTER_SAMPLE)
    const provider = buildProvider('openrouter')

    const models = await provider.listModels(
      config({ referer: 'https://example.com', title: 'Xono' })
    )

    expect(models.length).toBe(6)
    expect(captured?.url).toBe('/api/v1/models')
    expect(captured?.headers.authorization).toBe('Bearer test-key')
    expect(captured?.headers['http-referer']).toBe('https://example.com')
    expect(captured?.headers['x-openrouter-title']).toBe('Xono')
  })

  it('omits attribution headers when they are blank', async () => {
    respondWith = (res) => json(res, 200, { data: [] })
    await buildProvider('openrouter').listModels(config())
    expect(captured?.headers['http-referer']).toBeUndefined()
    expect(captured?.headers['x-openrouter-title']).toBeUndefined()
  })

  it('sends attribution headers on chat requests too', async () => {
    respondWith = (res) => json(res, 200, { choices: [{ message: { content: 'ok' } }] })
    const provider = buildProvider('openrouter')

    await provider.cleanup(
      { raw: 'hi', mode: 'cleaned', vocabulary: [], punctuation: true, capitalize: true },
      config({ referer: 'https://example.com', title: 'Xono' }),
      5000
    )

    expect(captured?.url).toBe('/api/v1/chat/completions')
    expect(captured?.headers['http-referer']).toBe('https://example.com')
  })

  it('reports a helpful error when the catalogue request fails', async () => {
    respondWith = (res) => json(res, 401, { error: { message: 'no key' } })
    await expect(buildProvider('openrouter').listModels(config())).rejects.toThrow(/401/)
  })

  it('returns nothing rather than throwing when the base URL is unusable', async () => {
    const models = await buildProvider('openrouter').listModels(config({ baseUrl: 'not-a-url' }))
    expect(models).toEqual([])
  })
})

describe('Anthropic catalogue', () => {
  it('reads /models with the Anthropic headers', async () => {
    respondWith = (res) => json(res, 200, { data: [{ id: 'claude-haiku-5.5', display_name: 'Claude Haiku 5.5' }] })

    const models = await buildProvider('anthropic').listModels(config())

    expect(captured?.url).toBe('/api/v1/models')
    expect(captured?.headers['x-api-key']).toBe('test-key')
    expect(captured?.headers['anthropic-version']).toBe('2023-06-01')
    expect(models[0]?.name).toBe('Claude Haiku 5.5')
  })
})

describe('CatalogueCache', () => {
  const dirs: string[] = []

  afterEach(() => {
    // A dir made in beforeAll would already be gone by the second test.
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  function newDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'xono-cat-'))
    dirs.push(dir)
    return dir
  }

  function cache(dir = newDir()): CatalogueCache {
    return new CatalogueCache(join(dir, 'catalogue.json'))
  }

  const two = [
    { id: 'a/b', name: 'B', supportsText: true },
    { id: 'a/c', name: 'C', supportsText: true }
  ]

  it('stores and reloads across instances', async () => {
    const dir = newDir()
    const c = cache(dir)
    await c.fetch('openrouter', async () => two)
    expect(cache(dir).get('openrouter')?.models).toHaveLength(2)
  })

  it('serves a fresh entry without calling the loader', async () => {
    const c = cache()
    let calls = 0
    const loader = async (): Promise<typeof two> => {
      calls++
      return two
    }

    await c.fetch('openrouter', loader)
    const second = await c.fetch('openrouter', loader)
    expect(calls).toBe(1)
    expect(second.fromCache).toBe(true)
  })

  it('refetches once the TTL has passed', async () => {
    const c = cache()
    let calls = 0
    const loader = async (): Promise<typeof two> => {
      calls++
      return two
    }

    await c.fetch('openrouter', loader)
    await c.fetch('openrouter', loader, { now: Date.now() + CATALOGUE_TTL_MS + 1000 })
    expect(calls).toBe(2)
  })

  it('refetches when forced, even if fresh', async () => {
    const c = cache()
    let calls = 0
    const loader = async (): Promise<typeof two> => {
      calls++
      return two
    }

    await c.fetch('openrouter', loader)
    await c.fetch('openrouter', loader, { force: true })
    expect(calls).toBe(2)
  })

  it('collapses concurrent requests for the same provider', async () => {
    const c = cache()
    let calls = 0
    const loader = async (): Promise<typeof two> => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
      return two
    }

    await Promise.all([c.fetch('openrouter', loader), c.fetch('openrouter', loader), c.fetch('openrouter', loader)])
    expect(calls).toBe(1)
  })

  it('serves a stale list rather than an empty picker when the fetch fails', async () => {
    const c = cache()
    await c.fetch('openrouter', async () => two)

    const result = await c.fetch(
      'openrouter',
      async () => {
        throw new Error('offline')
      },
      { force: true }
    )

    expect(result.models).toHaveLength(2)
    expect(result.fromCache).toBe(true)
    expect(result.stale).toBe(true)
  })

  it('propagates the error when there is nothing cached to fall back on', async () => {
    await expect(
      cache().fetch('openrouter', async () => {
        throw new Error('offline')
      })
    ).rejects.toThrow(/offline/)
  })

  it('keeps providers separate', async () => {
    const c = cache()
    await c.fetch('openrouter', async () => two)
    await c.fetch('mistral', async () => [two[0]!])

    expect(c.get('openrouter')?.models).toHaveLength(2)
    expect(c.get('mistral')?.models).toHaveLength(1)
    expect(c.get('groq')).toBeNull()
  })

  it('survives a corrupt cache file', () => {
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    const file = join(newDir(), 'catalogue.json')
    writeFileSync(file, '{ not json')
    expect(() => new CatalogueCache(file).get('openrouter')).not.toThrow()
  })
})