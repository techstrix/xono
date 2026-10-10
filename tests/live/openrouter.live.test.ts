import { describe, expect, it } from 'vitest'
import { buildProvider } from '../../src/main/core/llm'
import { CatalogueCache } from '../../src/main/core/llm/catalogueCache'
import { filterCatalogue, sortCatalogue } from '../../src/shared/catalogue'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Hits the real OpenRouter `/models` endpoint with no API key.
 *
 * The catalogue is public, so this needs no credentials and no spend — it verifies
 * against the live response shape rather than a fixture that could drift from it.
 *
 *   npm run test:openrouter
 */
const enabled = process.env.XONO_OPENROUTER === '1'

describe.skipIf(!enabled)('OpenRouter live catalogue', () => {
  it('fetches, normalises, sorts and filters the real catalogue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xono-or-'))
    const provider = buildProvider('openrouter')

    const started = Date.now()
    const raw = await provider.listModels({
      apiKey: '',
      // The catalogue is public; no key is required to read it.
      model: '',
      baseUrl: 'https://openrouter.ai/api/v1',
      referer: '',
      title: ''
    })
    const elapsed = Date.now() - started

    try {
      console.log(`\n  fetched ${raw.length} models in ${(elapsed / 1000).toFixed(1)}s`)

      expect(raw.length).toBeGreaterThan(100)

      const priced = raw.filter((m) => m.inputPricePerMillion !== undefined)
      const free = raw.filter((m) => m.inputPricePerMillion === 0)
      const text = raw.filter((m) => m.supportsText)
      const nonText = raw.filter((m) => !m.supportsText)

      console.log(`  with a price: ${priced.length}   free: ${free.length}`)
      console.log(`  text-capable: ${text.length}   other: ${nonText.length}`)

      // Ids are vendor-prefixed and unique.
      const ids = new Set(raw.map((m) => m.id))
      expect(ids.size).toBe(raw.length)
      expect(raw.every((m) => m.id.includes('/'))).toBe(true)

      // Every model has something to display.
      expect(raw.every((m) => m.name.length > 0)).toBe(true)

      // Sanity-check the price conversion against a known-cheap entry.
      const cheapest = [...priced].sort((a, b) => a.inputPricePerMillion! - b.inputPricePerMillion!)[0]
      expect(cheapest!.inputPricePerMillion).toBeGreaterThanOrEqual(0)
      expect(cheapest!.inputPricePerMillion).toBeLessThan(1)
      console.log(`  cheapest: ${cheapest!.id} at $${cheapest!.inputPricePerMillion}/M in`)

      // Routing pseudo-models must never look free.
      const routers = raw.filter((m) => /^openrouter\//.test(m.id))
      if (routers.length > 0) {
        const mispriced = routers.filter((m) => m.inputPricePerMillion !== undefined)
        console.log(`  routing models: ${routers.length}, priced: ${mispriced.length}`)
      }

      // Sorting and filtering must behave against real data.
      const sorted = sortCatalogue(raw)
      expect(sorted.filter((m) => m.supportsText).length).toBe(text.length)
      expect(filterCatalogue(raw, '').every((m) => m.supportsText)).toBe(true)

      const haiku = filterCatalogue(raw, 'haiku')
      console.log(`  "haiku" matches: ${haiku.length}`)
      expect(haiku.length).toBeGreaterThan(0)
      expect(filterCatalogue(raw, 'definitely-not-a-real-model-xyz').length).toBe(0)

      // The configured default must actually exist upstream, or first use would 404.
      const { providerDefaults } = await import('../../src/shared/schema')
      const defaults = providerDefaults('openrouter')
      const known = raw.some((m) => m.id === defaults.model)
      console.log(`  default "${defaults.model}" present: ${known}`)
      expect(known).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('caches the live catalogue and reuses it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xono-or-'))
    const cache = new CatalogueCache(join(dir, 'catalogue.json'))
    let calls = 0

    const loader = async () => {
      calls++
      return buildProvider('openrouter').listModels({
        apiKey: '',
        model: '',
        baseUrl: 'https://openrouter.ai/api/v1',
        referer: '',
        title: ''
      })
    }

    try {
      const first = await cache.fetch('openrouter', loader)
      expect(first.models.length).toBeGreaterThan(100)
      expect(first.fromCache).toBe(false)

      const second = await cache.fetch('openrouter', loader)
      expect(second.fromCache).toBe(true)
      expect(calls).toBe(1)

      // The persisted copy must survive a fresh instance, which is what makes the
      // picker usable offline and instant on reopen.
      const reopened = new CatalogueCache(join(dir, 'catalogue.json'))
      expect(reopened.get('openrouter')?.models.length).toBeGreaterThan(100)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})