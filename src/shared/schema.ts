import { z } from 'zod'

export const PROVIDER_IDS = ['mistral', 'groq', 'openrouter', 'nvidia', 'ollama', 'anthropic'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export const DICTATION_MODES = ['verbatim', 'cleaned', 'structured'] as const
export type DictationMode = (typeof DICTATION_MODES)[number]

export const VAD_ENGINES = ['energy', 'silero'] as const
export type VadEngineId = (typeof VAD_ENGINES)[number]

export const INJECTION_METHODS = ['clipboard-ydotool', 'clipboard-xdotool', 'clipboard-only'] as const
export type InjectionMethod = (typeof INJECTION_METHODS)[number]

export const WHISPER_MODELS = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3-turbo'] as const
export type WhisperModelId = (typeof WHISPER_MODELS)[number]

/**
 * Catalogue of GGML models. `url` is the canonical HuggingFace resolve URL;
 * `bytes` drives the "how long will this take" estimate in the settings UI.
 */
export const MODEL_CATALOGUE: Record<
  WhisperModelId,
  { label: string; file: string; bytes: number; note: string }
> = {
  // Timings below were measured on the reference machine: a 4-core Skylake-U with
  // AVX2 and no GPU. whisper.cpp always runs the encoder across a full 30-second mel
  // window, so the cost is dominated by that fixed window rather than by how long you
  // spoke — a 3s clip and a 24s clip cost about the same.
  //
  //   tiny.en ~10s      base.en ~19s      small.en far slower
  //
  // That is why tiny.en is the default: on this hardware base.en means a ~19s wait per
  // utterance, which is long enough to break the flow the tool exists for. Move up to
  // base.en only once the vocabulary list has taught it your jargon.
  'tiny.en': {
    label: 'tiny.en',
    file: 'ggml-tiny.en.bin',
    bytes: 75_478_967,
    note: 'Default. ~10s per utterance on a 4-core CPU. Weakest on jargon, so lean on the vocabulary list.'
  },
  'base.en': {
    label: 'base.en',
    file: 'ggml-base.en.bin',
    bytes: 147_951_465,
    note: 'Noticeably better on technical vocabulary, but ~19s per utterance here.'
  },
  'small.en': {
    label: 'small.en',
    file: 'ggml-small.en.bin',
    bytes: 487_601_967,
    note: 'Best accuracy on jargon. Expect tens of seconds per utterance on CPU.'
  },
  'medium.en': {
    label: 'medium.en',
    file: 'ggml-medium.en.bin',
    bytes: 1_533_763_076,
    note: 'Very slow on CPU. Rarely worth it.'
  },
  'large-v3-turbo': {
    label: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    bytes: 1_624_603_391,
    note: 'Also multilingual. Large download and slow on CPU.'
  }
}


const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'

export function modelUrl(id: WhisperModelId): string {
  return `${HF_BASE}/${MODEL_CATALOGUE[id].file}`
}

export const providerConfigSchema = z.object({
  apiKey: z.string().default(''),
  model: z.string().default(''),
  baseUrl: z.string().default(''),
  /**
   * OpenRouter app-attribution headers. Optional everywhere else and ignored by
   * providers that do not understand them.
   */
  referer: z.string().default(''),
  title: z.string().default('')
})

export type ProviderConfig = z.infer<typeof providerConfigSchema>

/** Sent as OpenRouter's HTTP-Referer so the app is identifiable in their rankings. */
export const DEFAULT_OPENROUTER_REFERER = 'https://github.com/xono-voice/xono'

/** Sent as OpenRouter's X-OpenRouter-Title. */
export const DEFAULT_OPENROUTER_TITLE = 'Xono'

/**
 * Explicit keys rather than `z.record(...)`: the record form infers a partial map,
 * which forces a non-null assertion at every `cfg.llm.providers[cfg.llm.provider]`
 * site. Enumerating the four providers keeps the type total.
 */
export const providersSchema = z.object({
  mistral: providerConfigSchema.default({
    apiKey: '',
    model: 'mistral-small-latest',
    baseUrl: 'https://api.mistral.ai/v1'
  }),
  groq: providerConfigSchema.default({
    apiKey: '',
    model: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1'
  }),
  ollama: providerConfigSchema.default({
    apiKey: '',
    model: 'qwen2.5:3b',
    baseUrl: 'http://127.0.0.1:11434/v1'
  }),
  anthropic: providerConfigSchema.default({
    apiKey: '',
    model: 'claude-haiku-4-5',
    baseUrl: 'https://api.anthropic.com/v1'
  }),
  openrouter: providerConfigSchema.default({
    apiKey: '',
    model: 'mistralai/mistral-small-2603',
    baseUrl: 'https://openrouter.ai/api/v1',
    referer: DEFAULT_OPENROUTER_REFERER,
    title: DEFAULT_OPENROUTER_TITLE
  }),
  nvidia: providerConfigSchema.default({
    apiKey: '',
    // NVIDIA's own fast text-only model: 1M context, 3B active of 30B, and positioned
    // for always-on agent workloads.
    model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
    baseUrl: 'https://integrate.api.nvidia.com/v1'
  })
})

export type ProvidersConfig = z.infer<typeof providersSchema>

export const llmConfigSchema = z.object({
  provider: z.enum(PROVIDER_IDS).default('mistral'),
  ollamaBaseUrl: z.string().default('http://127.0.0.1:11434/v1'),
  providers: providersSchema.default({}),
  /** On LLM failure/timeout, inject the raw transcript instead of dropping the utterance. */
  failOpenToRaw: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120_000).default(15_000),
  mode: z.enum(DICTATION_MODES).default('cleaned'),
  /** Send the previous committed utterance as context for resolving "now do the same for X". */
  useConversationContext: z.boolean().default(true)
})

export type LlmConfig = z.infer<typeof llmConfigSchema>

export const sttConfigSchema = z.object({
  model: z.enum(WHISPER_MODELS).default('tiny.en'),
  language: z.string().default('en'),
  /** 0 means "all cores but one"; see whisperCpp.transcribe. */
  threads: z.number().int().min(0).max(64).default(0),
  beamSize: z.number().int().min(1).max(10).default(5),
  temperature: z.number().min(0).max(1).default(0),
  enginePath: z.string().default(''),
  /** Auto-download the model on first run instead of failing. */
  autoDownload: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(300_000).default(120_000)
})

export type SttConfig = z.infer<typeof sttConfigSchema>

export const vadConfigSchema = z.object({
  engine: z.enum(VAD_ENGINES).default('energy'),
  /** Speech probability above which audio counts as speech (silero only). */
  speechThreshold: z.number().min(0).max(1).default(0.5),
  /**
   * RMS above which audio counts as speech (energy engine).
   *
   * Low on purpose. A false "silence" truncates the utterance; a false "speech" only
   * records a little room tone, which the cleanup model ignores. Quiet speech and
   * fillers ("uhm") sit near the bottom of this scale.
   */
  energyThreshold: z.number().min(0).max(1).default(0.006),
  /**
   * How long a trailing silence ends the utterance.
   *
   * Generous because fillers and pauses mid-thought must not be mistaken for the end of
   * a sentence. Fillers are removed by the cleanup model, so it is not this layer's job
   * to notice them — it only has to avoid cutting the speaker off.
   */
  silenceMsToStop: z.number().int().min(500).max(20_000).default(2500),
  /** Auto-stop on end-of-speech. Off means only the hotkey stops recording. */
  autoStopOnSilence: z.boolean().default(true),
  /** Discard silence before/after the utterance before sending to STT. */
  trimSilence: z.boolean().default(true),
  maxUtteranceMs: z.number().int().min(2000).max(600_000).default(120_000),
  sileroModelPath: z.string().default('')
})

export type VadConfig = z.infer<typeof vadConfigSchema>

export const dictationConfigSchema = z.object({
  autoPunctuation: z.boolean().default(true),
  autoCapitalize: z.boolean().default(true),
  /** Join consecutive short sentences into one paragraph. */
  joinSentences: z.boolean().default(false)
})

export type DictationConfig = z.infer<typeof dictationConfigSchema>

export const injectConfigSchema = z.object({
  method: z.enum(INJECTION_METHODS).default('clipboard-ydotool'),
  /** Restore the user's previous clipboard after a successful paste. */
  restoreClipboard: z.boolean().default(true),
  restoreClipboardDelayMs: z.number().int().min(0).max(10_000).default(1500),
  /** Put text on the clipboard even when the transport is virtual-keyboard typing. */
  useClipboard: z.boolean().default(true),
  typeDelayMs: z.number().int().min(0).max(50).default(3),
  /** Append a trailing newline, which usually submits the message. */
  trailingNewline: z.boolean().default(false),
  /**
   * Separator inserted before text that lands directly after a previous dictation.
   *
   * Pasting happens at the caret, so two dictations in a row run together unless
   * something separates them. A space is the default because it is the only choice
   * that is safe everywhere — a newline submits the line in a terminal.
   */
  appendSeparator: z.enum(['space', 'newline', 'none']).default('space'),
  /**
   * How long after a dictation a following one still counts as "the same flow" and
   * gets a separator. Beyond this the user has almost certainly moved on, and a stray
   * leading space would be noise.
   */
  appendWindowMs: z.number().int().min(1000).max(600_000).default(90_000)
})

export type InjectConfig = z.infer<typeof injectConfigSchema>

export const uiConfigSchema = z.object({
  /** Width of the *expanded* pill; the idle pill is considerably narrower. */
  widgetWidth: z.number().int().min(320).max(900).default(460),
  /** Gap between the bottom of the pill and the bottom edge of the work area. */
  widgetOffsetBottom: z.number().int().min(8).max(1000).default(36),
  autoHideMs: z.number().int().min(200).max(30_000).default(1400),
  errorAutoHideMs: z.number().int().min(500).max(120_000).default(6000),
  startWithLogin: z.boolean().default(false),
  /**
   * Keep the pill on screen for the whole life of the app rather than only while a
   * dictation is in flight. On by default: a global hotkey is otherwise invisible, so
   * the pill is the only standing reminder that the app is running.
   */
  alwaysVisibleWidget: z.boolean().default(true),
  /** Show the cleaned text in the widget for `reviewMs` before injecting. */
  reviewBeforeInject: z.boolean().default(false),
  reviewMs: z.number().int().min(500).max(30_000).default(2500)
})

export type UiConfig = z.infer<typeof uiConfigSchema>

export const hotkeyConfigSchema = z.object({
  // Electron accelerator keys are literal characters, not X11-style names:
  // 'Quote' throws, '`' is correct.
  accelerator: z.string().default('Super+`'),
  /** Press again while listening to stop and commit. */
  toggle: z.boolean().default(true),
  pushToTalk: z.boolean().default(false)
})

export type HotkeyConfig = z.infer<typeof hotkeyConfigSchema>

export const generalConfigSchema = z.object({
  vocabulary: z.array(z.string().min(1)).default([]),
  keepHistory: z.boolean().default(true),
  historyLimit: z.number().int().min(0).max(500).default(50),
  debugLogging: z.boolean().default(false)
})

export type GeneralConfig = z.infer<typeof generalConfigSchema>

export const configSchema = z.object({
  version: z.number().int().default(1),
  llm: llmConfigSchema.default({}),
  stt: sttConfigSchema.default({}),
  vad: vadConfigSchema.default({}),
  dictation: dictationConfigSchema.default({}),
  inject: injectConfigSchema.default({}),
  ui: uiConfigSchema.default({}),
  hotkey: hotkeyConfigSchema.default({}),
  general: generalConfigSchema.default({})
})

export type XonoConfig = z.infer<typeof configSchema>

export const DEFAULT_CONFIG: XonoConfig = (() => {
  const parsed = configSchema.safeParse({})
  if (parsed.success) return parsed.data
  // A failure here means a schema's .default() violates its own validator, which is a
  // programming error rather than bad user input. Surface the offending paths.
  const detail = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`DEFAULT_CONFIG is invalid — a schema default violates its own validator:\n${detail}`)
})()

export function providerDefaults(id: ProviderId): Required<ProviderConfig> {
  const base = { apiKey: '', referer: '', title: '' }
  switch (id) {
    case 'mistral':
      return { ...base, model: 'mistral-small-latest', baseUrl: 'https://api.mistral.ai/v1' }
    case 'groq':
      return { ...base, model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' }
    case 'ollama':
      return { ...base, model: 'qwen2.5:3b', baseUrl: 'http://127.0.0.1:11434/v1' }
    case 'anthropic':
      return { ...base, model: 'claude-haiku-4-5', baseUrl: 'https://api.anthropic.com/v1' }
    case 'openrouter':
      return {
        ...base,
        model: 'mistralai/mistral-small-2603',
        baseUrl: 'https://openrouter.ai/api/v1',
        // OpenRouter uses these for app attribution on their dashboard.
        referer: DEFAULT_OPENROUTER_REFERER,
        title: DEFAULT_OPENROUTER_TITLE
      }
    case 'nvidia':
      return {
        ...base,
        model: 'nvidia/nemotron-3.5-lightning-30b-a3b',
        baseUrl: 'https://integrate.api.nvidia.com/v1'
      }
  }
}


/**
 * Coerce arbitrary persisted JSON into a valid config. Unknown keys are dropped and
 * malformed fields fall back to defaults, so a hand-edited or partially-written file
 * still boots.
 */
export function parseConfig(raw: unknown): XonoConfig {
  const candidate = (raw ?? {}) as Record<string, unknown>
  const merged = {
    ...candidate,
    llm: mergeProviders(candidate.llm, candidate),
    stt: candidate.stt,
    vad: candidate.vad,
    dictation: candidate.dictation,
    inject: candidate.inject,
    ui: candidate.ui,
    hotkey: candidate.hotkey,
    general: candidate.general
  }
  const result = configSchema.safeParse(merged)
  if (result.success) return result.data
  // Second chance: let Zod tell us which field is bad, then fall back wholly.
  const fallback = configSchema.safeParse({})
  return fallback.success ? fallback.data : DEFAULT_CONFIG
}

function mergeProviders(llm: unknown, root: Record<string, unknown>): unknown {
  void root
  const llmObj = (llm ?? {}) as Record<string, unknown>
  const defaults = DEFAULT_CONFIG.llm.providers
  const provided = (llmObj.providers ?? {}) as Record<string, Record<string, unknown>>
  const providers = {} as ProvidersConfig

  for (const id of PROVIDER_IDS) {
    const providedFields = (provided[id] ?? {}) as Record<string, unknown>
    const catalogue = providerDefaults(id)
    const merged = { ...defaults[id] } as Record<string, string>

    // Fill in blanks from our catalogue without clobbering anything the user set. Doing
    // it field by field (rather than special-casing baseUrl) means new fields added to
    // ProviderConfig are backfilled automatically.
    for (const [key, fallback] of Object.entries(catalogue)) {
      const value = providedFields[key]
      merged[key] = typeof value === 'string' && value.trim() ? value : fallback
    }
    providers[id] = merged as ProviderConfig
  }

  const ollamaBaseUrl =
    typeof llmObj.ollamaBaseUrl === 'string' && llmObj.ollamaBaseUrl
      ? llmObj.ollamaBaseUrl
      : DEFAULT_CONFIG.llm.ollamaBaseUrl

  // Keep ollama's base URL consistent with whatever the top-level field says.
  if (providers.ollama.baseUrl === DEFAULT_CONFIG.llm.ollamaBaseUrl) {
    providers.ollama = { ...providers.ollama, baseUrl: ollamaBaseUrl }
  }

  return { ...llmObj, ollamaBaseUrl, providers }
}