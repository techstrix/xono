import { describe, expect, it } from 'vitest'
import { buildProvider } from '../../src/main/core/llm'
import { filterCatalogue } from '../../src/shared/catalogue'
import { providerDefaults, type ProviderConfig } from '../../src/shared/schema'

/**
 * Exercises the NVIDIA provider against the live NIM catalogue.
 *
 * `GET /v1/models` on integrate.api.nvidia.com is public, so this needs no key and
 * spends nothing. It matters because NVIDIA sends only an id per model — every readable
 * name and every chat/non-chat classification in the picker is inferred, and the only
 * way to know those inferences are sane is to run them over the real list.
 *
 *   npm run test:nvidia
 */
const enabled = process.env.XONO_NVIDIA === '1'

const NVIDIA_BASE = 'https://integrate.api.nvidia.com/v1'

function config(): ProviderConfig {
  return { apiKey: '', model: '', baseUrl: NVIDIA_BASE, referer: '', title: '' }
}

describe.skipIf(!enabled)('NVIDIA live catalogue', () => {
  it('fetches the real list and classifies it', async () => {
    const started = Date.now()
    const models = await buildProvider('nvidia').listModels(config())
    const elapsed = Date.now() - started

    console.log(`\n  fetched ${models.length} models in ${(elapsed / 1000).toFixed(1)}s`)

    expect(models.length).toBeGreaterThan(20)

    const chat = models.filter((m) => m.supportsText)
    const nonChat = models.filter((m) => !m.supportsText)
    console.log(`  chat-capable: ${chat.length}   filtered out: ${nonChat.length}`)
    console.log(`  filtered: ${nonChat.map((m) => m.id).join(', ')}`)

    // Every id is vendor-prefixed and every model gets a readable name.
    expect(models.every((m) => m.id.includes('/'))).toBe(true)
    expect(models.every((m) => m.name.includes('·'))).toBe(true)

    // No prices are published, so the picker must not invent any.
    expect(models.every((m) => m.inputPricePerMillion === undefined)).toBe(true)

    // Sample a few real names to confirm the prettifier is doing something sensible.
    for (const id of ['nvidia/nemotron-3.5-lightning-30b-a3b', 'meta/llama-3.2-11b-vision-instruct']) {
      const m = models.find((x) => x.id === id)
      if (m) console.log(`  ${m.id} -> ${m.name}`)
    }

    // The classifier must not have thrown away the models we would actually pick.
    expect(chat.length).toBeGreaterThan(20)
    expect(nonChat.length).toBeGreaterThan(0)

    // Nothing embedding-shaped should survive into the default view.
    const visible = filterCatalogue(models, '')
    expect(visible.some((m) => /embed|nvclip|nemoretriever/.test(m.id))).toBe(false)
  }, 60_000)

  it('search finds real models by vendor and by family', async () => {
    const models = await buildProvider('nvidia').listModels(config())

    expect(filterCatalogue(models, 'nemotron').length).toBeGreaterThan(3)
    expect(filterCatalogue(models, 'llama').length).toBeGreaterThan(0)
    expect(filterCatalogue(models, 'mistral').length).toBeGreaterThan(0)
    expect(filterCatalogue(models, 'lightning').length).toBeGreaterThan(0)
    expect(filterCatalogue(models, 'definitely-not-real-xyz').length).toBe(0)
  }, 60_000)

  it('ships a default model that still exists upstream', async () => {
    const models = await buildProvider('nvidia').listModels(config())
    const defaults = providerDefaults('nvidia')

    const present = models.some((m) => m.id === defaults.model)
    console.log(`\n  default "${defaults.model}" present: ${present}`)
    expect(present).toBe(true)

    // And it must not be one of the models we filter out as non-chat.
    const chosen = models.find((m) => m.id === defaults.model)!
    expect(chosen.supportsText).toBe(true)
  }, 60_000)

  it('every chat-capable model has a distinct display name', async () => {
    const models = await buildProvider('nvidia').listModels(config())
    const chat = models.filter((m) => m.supportsText)
    // Two different ids prettifying to the same name would make the picker ambiguous.
    const names = chat.map((m) => m.name)
    expect(new Set(names).size).toBe(names.length)
  }, 60_000)
})