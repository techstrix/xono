import { useEffect, useState } from 'react'
import { MODEL_CATALOGUE, WHISPER_MODELS, type WhisperModelId, type XonoConfig } from '../../../shared/schema'
import type { ModelStatus } from '../../../shared/types'
import type { PatchFn } from '../types'
import { Badge, Button, Field, Section, Select, TextInput, formatBytes } from '../components'

export function TranscriptionTab({
  config,
  patch
}: {
  config: XonoConfig
  patch: PatchFn
}): React.JSX.Element {
  const [models, setModels] = useState<ModelStatus[]>([])
  const [progress, setProgress] = useState<Record<string, number | undefined>>({})

  const refresh = (): void => {
    void window.xono.models.list().then(setModels)
  }

  useEffect(() => {
    refresh()
    const offProgress = window.xono.models.onProgress(({ id, value }) =>
      setProgress((p) => ({ ...p, [id]: value }))
    )
    const offStatus = window.xono.models.onStatus(() => {
      refresh()
      setProgress({})
    })
    return () => {
      offProgress()
      offStatus()
    }
  }, [])

  const download = async (id: string): Promise<void> => {
    setProgress((p) => ({ ...p, [id]: 0 }))
    await window.xono.models.download(id)
    refresh()
  }

  return (
    <div className="tab">
      <Section title="Models">
        <p className="muted">
          Models download once into <code>~/.local/share/xono/models</code> and are used offline. Whisper needs the
          model for your language; the smaller ones are fine on CPU but mishear technical terms more often.
        </p>
        <div className="models">
          {models.map((m) => {
            const meta = MODEL_CATALOGUE[m.id as WhisperModelId]
            const pct = progress[m.id]
            const active = config.stt.model === m.id
            return (
              <div key={m.id} className={`model ${active ? 'model--active' : ''}`}>
                <div className="model__row">
                  <label className="model__pick">
                    <input
                      type="radio"
                      name="model"
                      checked={active}
                      onChange={() => patch('stt', { model: m.id })}
                    />
                    <span className="model__name">{meta?.label ?? m.id}</span>
                  </label>
                  <div className="model__actions">
                    {m.present ? (
                      <Badge tone="ok">on disk</Badge>
                    ) : (
                      <Badge tone="muted">{formatBytes(m.bytes)}</Badge>
                    )}
                    <Button onClick={() => void window.xono.models.reveal(m.id)}>Reveal</Button>
                    {m.present ? (
                      <Button variant="danger" onClick={() => void window.xono.models.remove(m.id).then(refresh)}>
                        Delete
                      </Button>
                    ) : (
                      <Button variant="primary" onClick={() => void download(m.id)}>
                        Download
                      </Button>
                    )}
                  </div>
                </div>
                <p className="model__note">
                  {meta?.note}
                  {pct !== undefined ? ` — ${Math.round((pct ?? 0) * 100)}%` : ''}
                </p>
                {pct !== undefined ? (
                  <div className="progress">
                    <div className="progress__fill" style={{ width: `${(pct ?? 0) * 100}%` }} />
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="Transcription">
        <Field label="Active model">
          <Select
            value={config.stt.model}
            onChange={(v) => patch('stt', { model: v })}
            options={WHISPER_MODELS.map((m) => ({ value: m, label: MODEL_CATALOGUE[m].label }))}
          />
        </Field>
        <Field label="Language" hint="ISO code passed to whisper. 'auto' detects per utterance.">
          <TextInput value={config.stt.language} onChange={(v) => patch('stt', { language: v.trim() || 'en' })} />
        </Field>
        <Field
          label="Threads"
          hint="0 uses every core except one. Lower this if the machine feels sluggish while transcribing."
        >
          <TextInput
            type="number"
            value={String(config.stt.threads)}
            onChange={(v) => patch('stt', { threads: Math.max(1, Number.parseInt(v, 10) || 1) })}
          />
        </Field>
        <Field label="Beam size" hint="Higher is more accurate and slower. 5 is a good default; 1 is fastest.">
          <TextInput
            type="number"
            value={String(config.stt.beamSize)}
            onChange={(v) => patch('stt', { beamSize: Math.min(10, Math.max(1, Number.parseInt(v, 10) || 5)) })}
          />
        </Field>
        <Field
          label="whisper.cpp binary"
          hint="Leave blank to use the vendored build. Run `npm run setup:engine` if this is empty."
        >
          <TextInput
            value={config.stt.enginePath}
            placeholder="vendor/whisper.cpp/build/bin/whisper-cli"
            onChange={(v) => patch('stt', { enginePath: v.trim() })}
          />
        </Field>
      </Section>

      <Section title="Voice activity detection">
        <Field
          label="VAD engine"
          hint="The energy detector has no native dependency and is the default. Silero is more accurate on noisy input but needs onnxruntime-node rebuilt for Electron."
        >
          <Select
            value={config.vad.engine}
            onChange={(v) => patch('vad', { engine: v })}
            options={[
              { value: 'energy', label: 'Energy (built in, no native modules)' },
              { value: 'silero', label: 'Silero (ONNX)' }
            ]}
          />
        </Field>
        <Field
          label="Silence before auto-stop (ms)"
          hint="How long a pause ends your utterance. Longer is safer: it will not mistake a filler or a pause mid-thought for the end of a sentence. Fillers are removed by the cleanup model, so this only needs to avoid cutting you off."
        >
          <TextInput
            type="number"
            value={String(config.vad.silenceMsToStop)}
            onChange={(v) => patch('vad', { silenceMsToStop: Math.max(500, Number.parseInt(v, 10) || 2500) })}
          />
        </Field>
        <Field
          label="Speech threshold"
          hint="Lower detects quieter speech and fillers; higher ignores more room tone. Erring low only records a little silence, which is harmless."
        >
          <TextInput
            type="number"
            value={String(config.vad.energyThreshold)}
            onChange={(v) => patch('vad', { energyThreshold: Math.min(1, Math.max(0, Number(v) || 0.006)) })}
          />
        </Field>
        <Field label="Only the hotkey stops recording" hint="Turn off auto-stop for long, deliberate passages.">
          <Select
            value={config.vad.autoStopOnSilence ? 'off' : 'on'}
            onChange={(v) => patch('vad', { autoStopOnSilence: v === 'off' })}
            options={[
              { value: 'off', label: 'No — stop on silence' },
              { value: 'on', label: 'Yes — only the hotkey stops' }
            ]}
          />
        </Field>
        <Field label="Trim silence before transcribing" hint="Shorter audio means faster and more accurate transcription.">
          <Select
            value={config.vad.trimSilence ? 'on' : 'off'}
            onChange={(v) => patch('vad', { trimSilence: v === 'on' })}
            options={[
              { value: 'on', label: 'Yes' },
              { value: 'off', label: 'No' }
            ]}
          />
        </Field>
        <Field label="Maximum utterance length" hint="Safety valve: a very long recording is cut off and processed.">
          <TextInput
            type="number"
            value={String(config.vad.maxUtteranceMs)}
            onChange={(v) => patch('vad', { maxUtteranceMs: Math.max(2000, Number.parseInt(v, 10) || 120_000) })}
          />
        </Field>
      </Section>
    </div>
  )
}
