import { useState } from 'react'
import type { XonoConfig } from '../../../shared/schema'
import { Field, Section, Toggle } from '../components'
import type { PatchFn } from '../types'

export function DictationTab({
  config,
  patch
}: {
  config: XonoConfig
  patch: PatchFn
}): React.JSX.Element {
  return (
    <div className="tab">
      <Section title="Output style">
        <Field
          label="Add punctuation"
          hint="Lets the cleanup model insert commas and full stops. Turn off to keep exactly what was transcribed."
        >
          <Toggle
            checked={config.dictation.autoPunctuation}
            onChange={(v) => patch('dictation', { autoPunctuation: v })}
          />
        </Field>
        <Field
          label="Capitalise sentences"
          hint="Turn off to preserve however the words were spoken."
        >
          <Toggle
            checked={config.dictation.autoCapitalize}
            onChange={(v) => patch('dictation', { autoCapitalize: v })}
          />
        </Field>
        <Field
          label="When cleanup is unavailable"
          hint="Almost always paste the raw transcript: your words are worth more than a tidy sentence."
        >
          <Field label="">
            <Toggle
              checked={config.llm.failOpenToRaw}
              onChange={(v) => patch('llm', { failOpenToRaw: v })}
            />
          </Field>
        </Field>
      </Section>

      <Section title="Review before pasting">
        <p className="muted">
          Xono normally pastes as soon as the text is ready. Turn this on to see the cleaned result and choose
          between it and the raw transcript before anything lands in your input.
        </p>
        <Field label="Ask me first">
          <Toggle
            checked={config.ui.reviewBeforeInject}
            onChange={(v) => patch('ui', { reviewBeforeInject: v })}
          />
        </Field>
        {config.ui.reviewBeforeInject ? (
          <Field label="Auto-dismiss after (ms)">
            <input
              type="number"
              value={config.ui.reviewMs}
              min={500}
              step={100}
              onChange={(e) => patch('ui', { reviewMs: Math.max(500, Number(e.target.value) || 2500) })}
            />
          </Field>
        ) : null}
      </Section>

      <Section title="Startup">
        <Field label="Start when you log in" hint="Xono then lives in the tray until you quit it.">
          <Toggle checked={config.ui.startWithLogin} onChange={(v) => patch('ui', { startWithLogin: v })} />
        </Field>
      </Section>
    </div>
  )
}

export function VocabularyTab({
  config,
  patch
}: {
  config: XonoConfig
  patch: PatchFn
}): React.JSX.Element {
  const [term, setTerm] = useState('')
  const [busy, setBusy] = useState(false)

  const add = async (): Promise<void> => {
    const clean = term.trim()
    if (!clean || busy) return
    setBusy(true)
    try {
      const list = await window.xono.vocab.add(clean)
      setTerm('')
      patch('general', { vocabulary: list })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="tab">
      <Section title="Custom vocabulary">
        <p className="muted">
          Words, tool names, and acronyms you say often. Xono passes them to whisper as a decoding hint so it
          <em> hears</em> them right the first time, and tells the cleanup model never to 'correct' them. This is
          the single highest-leverage setting for dictating about your own codebase.
        </p>
        <Field label="Add a term">
          <span className="row">
            <input
              type="text"
              value={term}
              placeholder="e.g. pnpm, electron-vite, ydotool, xono"
              spellCheck={false}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add()
              }}
            />
            <button type="button" className="btn btn--primary" onClick={() => void add()} disabled={busy}>
              Add
            </button>
          </span>
        </Field>

        <div className="chips">
          {config.general.vocabulary.length === 0 ? (
            <p className="muted">No terms yet.</p>
          ) : (
            config.general.vocabulary.map((t) => (
              <span key={t} className="chip">
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => {
                    void window.xono.vocab.remove(t).then((list) => patch('general', { vocabulary: list }))
                  }}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
      </Section>

      <Section title="Privacy">
        <p className="muted">
          Audio is captured locally and written only to a temporary WAV, deleted the moment the utterance is
          transcribed. The only thing that leaves the machine is the transcript text, sent to whichever cleanup
          provider you selected. Choosing Ollama keeps the whole pipeline local.
        </p>
        <Field label="Keep a local history" hint="Lets you recover a bad paste. Stored in your config directory.">
          <Toggle
            checked={config.general.keepHistory}
            onChange={(v) => patch('general', { keepHistory: v })}
          />
        </Field>
        <Field label="Verbose logging">
          <Toggle
            checked={config.general.debugLogging}
            onChange={(v) => patch('general', { debugLogging: v })}
          />
        </Field>
      </Section>
    </div>
  )
}