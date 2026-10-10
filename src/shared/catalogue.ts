import type { RemoteModel } from './types'

/**
 * Normalises the model catalogues published by the OpenAI-compatible providers.
 *
 * OpenRouter is by far the richest: 400+ models with context length, pricing and
 * descriptions. Mistral, Groq and Ollama return only an id and an owner, which is
 * still enough to populate a picker.
 *
 * Two quirks worth knowing about:
 *
 *  - Pricing arrives as a **string per token** (`"0.000001"` = $1 per million), and
 *    routing models such as `openrouter/auto` report `"−1"` because the real price
 *    depends on which upstream model gets picked. A negative value therefore means
 *    "unknown", not "free".
 *  - `context_length` is `null` on some entries and absent on others.
 */
export interface CatalogueEntry {
  id?: unknown
  name?: unknown
  display_name?: unknown
  canonical_slug?: unknown
  description?: unknown
  context_length?: unknown
  pricing?: Record<string, unknown> | null
  architecture?: {
    modality?: unknown
    input_modalities?: unknown
    output_modalities?: unknown
  } | null
}

export function normaliseCatalogue(payload: unknown): RemoteModel[] {
  const entries = extractEntries(payload)
  const seen = new Set<string>()
  const models: RemoteModel[] = []

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as CatalogueEntry

    const id = firstString(e.id, e.canonical_slug)
    if (!id || seen.has(id)) continue
    seen.add(id)

    models.push({
      id,
      name: firstString(e.name, e.display_name) ?? id,
      inputPricePerMillion: pricePerMillion(e.pricing?.prompt),
      outputPricePerMillion: pricePerMillion(e.pricing?.completion),
      contextLength: positiveNumber(e.context_length),
      description: truncate(firstString(e.description) ?? undefined, 220),
      vendor: vendorOf(id),
      supportsText: supportsText(e)
    })
  }

  return models
}

function extractEntries(payload: unknown): CatalogueEntry[] {
  if (Array.isArray(payload)) return payload as CatalogueEntry[]
  if (!payload || typeof payload !== 'object') return []

  const obj = payload as Record<string, unknown>
  // OpenRouter and OpenAI both wrap in { data: [...] }; Anthropic uses { data: [...] }
  // too but with different field names.
  if (Array.isArray(obj.data)) return obj.data as CatalogueEntry[]
  if (Array.isArray(obj.models)) return obj.models as CatalogueEntry[]
  return []
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Convert a per-token price string to USD per million tokens. Negative values are the
 * "price varies" sentinel used by routing models, so they become undefined rather than
 * a misleading number.
 */
export function pricePerMillion(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const perToken = typeof value === 'string' ? Number(value) : value
  if (typeof perToken !== 'number' || !Number.isFinite(perToken) || perToken < 0) return undefined
  return perToken * 1_000_000
}

/**
 * Can this model actually do the job? We need text in and text out, so vision-only or
 * audio-only entries are flagged out of the picker. A missing architecture block means
 * the provider did not say, and we assume it is usable rather than hiding it.
 */
function supportsText(entry: CatalogueEntry): boolean {
  const arch = entry.architecture
  if (!arch) return true

  const outputs = arch.output_modalities
  if (Array.isArray(outputs) && outputs.length > 0) return outputs.includes('text')
  if (typeof arch.modality === 'string' && arch.modality.includes('->')) {
    return arch.modality.split('->')[1]?.includes('text') ?? true
  }
  return true
}

function vendorOf(id: string): string | undefined {
  const slash = id.indexOf('/')
  return slash > 0 ? id.slice(0, slash) : undefined
}

function truncate(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Order for the picker: text-capable models first, then cheapest, then by name.
 * Router pseudo-models land last because they have no meaningful price of their own.
 */
export function sortCatalogue(models: RemoteModel[]): RemoteModel[] {
  const price = (m: RemoteModel): number =>
    m.inputPricePerMillion === undefined ? Number.POSITIVE_INFINITY : m.inputPricePerMillion

  return [...models].sort((a, b) => {
    if (a.supportsText !== b.supportsText) return a.supportsText ? -1 : 1
    const priced = Number.isFinite(price(a)) && Number.isFinite(price(b))
    if (priced && price(a) !== price(b)) return price(a) - price(b)
    return a.name.localeCompare(b.name)
  })
}

/**
 * Case-insensitive match against the id, name, vendor and description.
 *
 * Non-text models are dropped even on an empty query: a model that cannot emit text
 * can never be a useful choice for cleanup, so it should not merely be deprioritised.
 */
export function filterCatalogue(models: RemoteModel[], query: string): RemoteModel[] {
  const q = query.trim().toLowerCase()

  return models.filter((m) => {
    if (!m.supportsText) return false
    if (!q) return true

    // ":free" is OpenRouter's free-tier marker, so a bare "free" should find it.
    const haystack = `${m.id} ${m.name} ${m.vendor ?? ''} ${m.description ?? ''}`.toLowerCase()
    if (q.startsWith(':') && haystack.includes(q.slice(1))) return true
    return q.split(/\s+/).every((t) => haystack.includes(t))
  })
}