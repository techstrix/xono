import type { ProviderConfig } from '@shared/schema'
import type { ProviderDefinition } from '@shared/providers'
import type { RemoteModel } from './types'
import { OpenAICompatibleProvider } from './openaiCompat'

/**
 * NVIDIA's NIM catalogue is OpenAI-compatible for inference, so everything about the
 * request is inherited. What is *not* inherited is catalogue handling.
 *
 * `GET /v1/models` returns only `{ id, object, created, owned_by }` — no display name,
 * no description, no context length, no pricing, and crucially no modality. OpenRouter
 * hands us `architecture.output_modalities` and can classify models precisely; NVIDIA
 * hands us a bare id, so classification here is necessarily a naming heuristic.
 *
 * That heuristic is why this class exists rather than reusing the base implementation
 * unchanged: without it the picker would happily offer an embedding model or a content
 * safety guard for a job that is "rewrite this sentence without the filler".
 */

/**
 * Model families that exist in the catalogue but cannot serve as a general chat model.
 *
 * Deliberately conservative: this only excludes things that definitively cannot do
 * text-in/text-out chat, rather than trying to rank quality. A false negative costs one
 * extra entry in a searchable list; a false positive hides a model someone wanted.
 */
const NON_CHAT_PATTERNS = [
  /embed/, // embed-qa, nemotron-3-embed, arctic-embed, nv-embedqa
  /nvclip/,
  /nemoretriever/,
  /content-safety/,
  /nemoguard/,
  /llama-guard/,
  /topic-control/,
  /reward/, // a reward model is not a generator
  /ising-calibration/,
  /calibration/,
  /riva-translate/, // translation only, no instruction following
  /nemotron-parse/, // document parsing, not conversation
  /synthetic-video/,
  /deplot/ // chart-to-table
]

/** Vendor ids as they appear in NVIDIA's catalogue, mapped to something readable. */
const VENDOR_NAMES: Record<string, string> = {
  '01-ai': '01 AI',
  adept: 'Adept',
  ai21labs: 'AI21 Labs',
  aisingapore: 'AI Singapore',
  bigcode: 'BigCode',
  databricks: 'Databricks',
  'deepseek-ai': 'DeepSeek AI',
  google: 'Google',
  ibm: 'IBM',
  meta: 'Meta',
  microsoft: 'Microsoft',
  mistralai: 'Mistral AI',
  moonshotai: 'Moonshot AI',
  'nv-mistralai': 'NV Mistral AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  poolside: 'Poolside',
  snowflake: 'Snowflake',
  writer: 'Writer',
  'z-ai': 'Z AI',
  zyphra: 'Zyphra'
}

/** Tokens that should stay fully uppercase when prettifying a model id. */
const ACRONYMS = new Set(['ai', 'vl', 'vlm', 'moe', 'oss', 'xs', 'glm', 'llm', 'tts', 'stt', 'asr', 'cpu', 'gpu'])

export function isChatCapableModel(id: string): boolean {
  return !NON_CHAT_PATTERNS.some((re) => re.test(id.toLowerCase()))
}

/**
 * Turn `nvidia/nemotron-3.5-lightning-30b-a3b` into
 * "NVIDIA · Nemotron 3.5 Lightning 30B A3B".
 *
 * NVIDIA publishes no names, and a wall of lowercase slugs is unpleasant to scan.
 * Parameter counts are uppercased and a small acronym list is preserved, which is
 * enough to make the list readable without inventing claims about a model.
 */
export function prettifyModelId(id: string): string {
  const slash = id.indexOf('/')
  const vendorId = slash > 0 ? id.slice(0, slash) : ''
  const rest = slash > 0 ? id.slice(slash + 1) : id

  // Run the vendor through the same token rules so an unknown "acme-ai" becomes
  // "Acme AI" rather than "Acme Ai".
  const vendor =
    VENDOR_NAMES[vendorId.toLowerCase()] ??
    vendorId
      .split('-')
      .filter(Boolean)
      .map(prettifyToken)
      .join(' ')
  const model = rest
    .split('-')
    .filter(Boolean)
    .map(prettifyToken)
    .join(' ')

  return vendor ? `${vendor} · ${model}` : model
}

function prettifyToken(token: string): string {
  // "120b", "7b", and the mixture-of-experts forms "a3b" / "a12b" are parameter counts.
  if (/^[a-z]?\d+(\.\d+)?[bkm]$/i.test(token)) return token.toUpperCase()
  if (ACRONYMS.has(token.toLowerCase())) return token.toUpperCase()
  return titleCase(token)
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

export class NvidiaProvider extends OpenAICompatibleProvider {
  constructor(def: ProviderDefinition) {
    super(def)
  }

  /**
   * Fill in the gaps NVIDIA leaves in its catalogue: readable names, and a usable
   * classification where the API gives none.
   */
  override async listModels(config: ProviderConfig, signal?: AbortSignal): Promise<RemoteModel[]> {
    const models = await super.listModels(config, signal)

    return models.map((model) => ({
      ...model,
      name: prettifyModelId(model.id),
      // The base class already defaults this to true when no architecture block is
      // present; refine it here using the family heuristic.
      supportsText: isChatCapableModel(model.id)
    }))
  }
}