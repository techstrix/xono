import { useCallback, useEffect, useState } from 'react'
import type { ProviderId, XonoConfig } from '../../../shared/schema'
import type { RemoteModel } from '../../../shared/types'
import { Badge, Button, Field, Section, Select, TextInput } from '../components'
import { ModelPicker } from '../ModelPicker'
import type { PatchFn } from '../types'

export function ProvidersTab({
  config,
  patch
}: {
  config: XonoConfig
  patch: PatchFn
}): React.JSX.Element {
  const [health, setHealth] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [catalogues, setCatalogues] = useState<Record<string, RemoteModel[]>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [modelError, setModelError] = useState<Record<string, string | null>>({})
  const [stale, setStale] = useState<Record<string, boolean>>({})
  const [filter, setFilter] = useState<Record<string, string>>({})

  const selected = config.llm.provider
  const hasKey = config.llm.providers[selected].apiKey.trim().length > 0

  const setProvider = useCallback(
    (id: ProviderId, patcher: Partial<XonoConfig['llm']['providers'][ProviderId]>): void => {
      patch('llm', {
        providers: { ...config.llm.providers, [id]: { ...config.llm.providers[id], ...patcher } }
      })
    },
    [config.llm.providers, patch]
  )

  const loadModels = useCallback(
    async (id: ProviderId, force = false): Promise<void> => {
      setLoading((l) => ({ ...l, [id]: true }))
      setModelError((e) => ({ ...e, [id]: null }))
      try {
        const result = await window.xono.providers.models(id, { force })
        setCatalogues((c) => ({ ...c, [id]: result.models }))
        setStale((s) => ({ ...s, [id]: result.stale }))
      } catch (err) {
        // Keep any list we already have on screen; an empty picker is worse than a
        // stale one, and the free-text field below still works.
        setModelError((e) => ({ ...e, [id]: (err as Error).message }))
      } finally {
        setLoading((l) => ({ ...l, [id]: false }))
      }
    },
    []
  )

  // Load the catalogue for whichever provider is active, once its key is present.
  useEffect(() => {
    if (!hasKey) return
    if (catalogues[selected]) return
    void loadModels(selected)
  }, [selected, hasKey, catalogues, loadModels])

  const test = async (id: ProviderId): Promise<void> => {
    setHealth((h) => ({ ...h, [id]: { ok: false, detail: 'testing…' } }))
    const result = await window.xono.providers.health(id)
    setHealth((h) => ({ ...h, [id]: result }))
  }

  return (
    <div className="tab">
      <Section title="Active provider">
        <Field
          label="Cleanup model provider"
          hint="The provider that rewrites your transcript into clean text. Most speak the same API shape, so switching is instant."
        >
          <Select
            value={config.llm.provider}
            onChange={(v) => patch('llm', { provider: v })}
            options={PROVIDER_ORDER.map((p) => ({ value: p, label: LABELS[p] }))}
          />
        </Field>
        <Field label="Dictation mode">
          <Select
            value={config.llm.mode}
            onChange={(v) => patch('llm', { mode: v })}
            options={[
              { value: 'verbatim', label: 'Verbatim — fix transcription artefacts only' },
              { value: 'cleaned', label: 'Cleaned — remove fillers and false starts (default)' },
              { value: 'structured', label: 'Structured — cleaned, split into paragraphs' }
            ]}
          />
        </Field>
        <Field
          label="Timeout"
          hint="If a provider is slower than this, xono falls back to your raw transcript rather than losing your words."
        >
          <TextInput
            type="number"
            value={String(config.llm.timeoutMs)}
            onChange={(v) => patch('llm', { timeoutMs: clampInt(v, 1000, 120_000, 15_000) })}
          />
        </Field>
        <Field
          label="Use the previous utterance as context"
          hint="Lets the model resolve 'now do the same for the second one'. It never repeats the earlier text into your input."
        >
          <Select
            value={config.llm.useConversationContext ? 'on' : 'off'}
            onChange={(v) => patch('llm', { useConversationContext: v === 'on' })}
            options={[
              { value: 'on', label: 'Yes' },
              { value: 'off', label: 'No' }
            ]}
          />
        </Field>
        <Field
          label="Fail open to the raw transcript"
          hint="Strongly recommended. When a provider is unreachable, your un-cleaned text is pasted instead of nothing at all."
        >
          <Select
            value={config.llm.failOpenToRaw ? 'on' : 'off'}
            onChange={(v) => patch('llm', { failOpenToRaw: v === 'on' })}
            options={[
              { value: 'on', label: 'Yes — always paste something' },
              { value: 'off', label: 'No — report the error instead' }
            ]}
          />
        </Field>
      </Section>

      {PROVIDER_ORDER.map((id) => {
        const cfg = config.llm.providers[id]
        const result = health[id]
        const catalogue = catalogues[id] ?? []
        const isActive = selected === id
        const supportsCatalogue = PROVIDERS_WITH_CATALOGUE.has(id)

        return (
          <Section key={id} title={LABELS[id]}>
            <div className="provider-head">
              <p className="provider-hint">{HINTS[id]}</p>
              <div className="provider-head__right">
                {result ? (
                  <Badge tone={result.ok ? 'ok' : 'error'}>{result.detail}</Badge>
                ) : (
                  <Badge tone={hasKeys(config, id) ? 'ok' : 'muted'}>
                    {hasKeys(config, id) ? 'configured' : 'not configured'}
                  </Badge>
                )}
                <Button onClick={() => void test(id)}>Test</Button>
              </div>
            </div>

            <Field
              label="API key"
              hint={
                <>
                  Stored in <code>~/.config/xono/config.json</code> with 0600 permissions.{' '}
                  {KEY_URLS[id] ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => void window.xono.app.openExternal(KEY_URLS[id]!)}
                    >
                      Get a key
                    </button>
                  ) : null}
                </>
              }
            >
              <TextInput
                secret
                value={cfg.apiKey}
                placeholder="sk-…"
                onChange={(v) => setProvider(id, { apiKey: v.trim() })}
              />
            </Field>

            {supportsCatalogue ? (
              <Field
                label="Model"
                hint={`Fetched from ${LABELS[id]} and cached for six hours. Shows context length and price per million tokens.`}
              >
                <ModelPicker
                  models={catalogue}
                  loading={Boolean(loading[id])}
                  error={modelError[id] ?? null}
                  stale={Boolean(stale[id])}
                  value={cfg.model}
                  manualValue={cfg.model}
                  filter={filter[id] ?? ''}
                  setFilter={(v) => setFilter((f) => ({ ...f, [id]: v }))}
                  onSelect={(modelId) => setProvider(id, { model: modelId })}
                  onManualChange={(modelId) => setProvider(id, { model: modelId })}
                  onRefresh={() => void loadModels(id, true)}
                />
              </Field>
            ) : (
              <Field label="Model" hint="This provider does not publish a catalogue; type the model id.">
                <TextInput value={cfg.model} onChange={(v) => setProvider(id, { model: v.trim() })} />
              </Field>
            )}

            <Field
              label="Base URL"
              hint={id === 'ollama' ? 'Point this at your Ollama server.' : 'Change only if you need a proxy.'}
            >
              <TextInput value={cfg.baseUrl} onChange={(v) => setProvider(id, { baseUrl: v.trim() })} />
            </Field>

            {id === 'openrouter' ? (
              <>
                <p className="muted">
                  OpenRouter attributes usage to these headers. Both are optional; setting them makes Xono
                  identifiable in your OpenRouter dashboard.
                </p>
                <Field label="App title (X-OpenRouter-Title)">
                  <TextInput value={cfg.title} placeholder="Xono" onChange={(v) => setProvider(id, { title: v.trim() })} />
                </Field>
                <Field label="Referer (HTTP-Referer)">
                  <TextInput
                    value={cfg.referer}
                    placeholder="https://example.com"
                    onChange={(v) => setProvider(id, { referer: v.trim() })}
                  />
                </Field>
              </>
            ) : null}
          </Section>
        )
      })}
    </div>
  )
}

const PROVIDER_ORDER: ProviderId[] = ['mistral', 'groq', 'openrouter', 'nvidia', 'ollama', 'anthropic']

/** Providers that expose a `/models` catalogue worth a picker. */
const PROVIDERS_WITH_CATALOGUE = new Set<ProviderId>([
  'mistral',
  'groq',
  'openrouter',
  'nvidia',
  'ollama',
  'anthropic'
])

const LABELS: Record<ProviderId, string> = {
  mistral: 'Mistral',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  nvidia: 'NVIDIA NIM',
  ollama: 'Ollama (local)',
  anthropic: 'Anthropic Claude'
}

const HINTS: Record<ProviderId, string> = {
  mistral: 'Fast, cheap, good at filler removal.',
  groq: 'Very fast inference on open models. Good for long dictations.',
  openrouter: 'One key, every model on the marketplace, with live pricing.',
  nvidia: 'NVIDIA-hosted NIM models with a free trial tier. Prefer a small or "lightning" model.',
  ollama: 'Fully offline and free. Slower on CPU, but nothing leaves the machine.',
  anthropic: 'Best instruction following for paragraph structuring.'
}

const KEY_URLS: Record<ProviderId, string | undefined> = {
  mistral: 'https://console.mistral.ai/api-keys',
  groq: 'https://console.groq.com/keys',
  openrouter: 'https://openrouter.ai/keys',
  nvidia: 'https://build.nvidia.com/settings',
  ollama: undefined,
  anthropic: 'https://console.anthropic.com/settings/keys'
}

function hasKeys(config: XonoConfig, id: ProviderId): boolean {
  if (id === 'ollama') return config.llm.providers.ollama.model.trim().length > 0
  return config.llm.providers[id].apiKey.trim().length > 0
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, n))
}