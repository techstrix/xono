import { useState } from 'react'
import type { InjectionMethod, XonoConfig } from '../../../shared/schema'
import { Badge, Button, Field, Section, Select, TextInput } from '../components'
import type { PatchFn } from '../types'

const METHODS: { value: InjectionMethod; label: string; note: string }[] = [
  {
    value: 'clipboard-ydotool',
    label: 'Clipboard + ydotool (recommended on Wayland)',
    note: 'Text goes on the clipboard; ydotool sends the Ctrl+V chord through /dev/uinput. Fast, unicode-safe, and works in terminals.'
  },
  {
    value: 'clipboard-xdotool',
    label: 'Clipboard + xdotool (X11 sessions)',
    note: 'Same idea, using X11. xdotool does not work under Wayland.'
  },
  {
    value: 'clipboard-only',
    label: 'Clipboard only — I will paste manually',
    note: 'Never fails. Xono copies the text and you press Ctrl+V yourself.'
  }
]

export function InjectionTab({
  config,
  patch
}: {
  config: XonoConfig
  patch: PatchFn
}): React.JSX.Element {
  const [accelerator, setAccelerator] = useState(config.hotkey.accelerator)
  const [probe, setProbe] = useState<{ ok: boolean; detail: string } | null>(null)
  const [checking, setChecking] = useState(false)

  const runProbe = async (): Promise<void> => {
    setChecking(true)
    const report = await window.xono.diagnostics.preflight()
    const injectorChecks = report.checks.filter((c) => c.id !== 'parec' && c.id !== 'model' && c.id !== 'whisper-binary')
    const failed = injectorChecks.filter((c) => !c.ok)
    setProbe({
      ok: failed.length === 0,
      detail: failed.length === 0 ? 'Injection looks ready.' : failed.map((c) => c.detail).join(' ')
    })
    setChecking(false)
  }

  return (
    <div className="tab">
      <Section title="Hotkey">
        <Field
          label="Toggle shortcut"
          hint="Press once to start recording, press again to finish and paste. Use the format Super+Quote or Control+Alt+Space."
        >
          <span className="row">
            <TextInput
              value={accelerator}
              onChange={setAccelerator}
              placeholder="Super+Quote"
              spellCheck={false}
            />
            <Button
              variant="primary"
              onClick={() => {
                void window.xono.hotkey.set(accelerator.trim())
              }}
            >
              Apply
            </Button>
          </span>
        </Field>
        <p className="muted">
          On Wayland the shortcut is bound through the desktop portal, which resolves the bind
          asynchronously — a shortcut can look registered here and still do nothing. Run{' '}
          <code>npm run check:hotkey</code> to ask the desktop whether the key is really bound.{' '}
          If the portal refuses it, bind a KDE system shortcut instead:{' '}
          <em>System Settings → Shortcuts → Custom Shortcuts</em>, command{' '}
          <code>xono --toggle</code>.
        </p>
        <p className="muted">
          Xono must also be launched through its desktop entry (<code>npm run launch</code>) rather
          than straight from a terminal. The portal identifies an app by its desktop identity, and a
          shell-launched process has none — the bind is then refused without any error.
        </p>
      </Section>

      <Section title="Method">
        <Field label="How text reaches the focused field" hint={METHODS.find((m) => m.value === config.inject.method)?.note}>
          <Select
            value={config.inject.method}
            onChange={(v) => patch('inject', { method: v })}
            options={METHODS.map((m) => ({ value: m.value, label: m.label }))}
          />
        </Field>

        <Field
          label="Restore your clipboard afterwards"
          hint="Xono puts your dictation on the clipboard to paste it. This puts your previous contents back a moment later."
        >
          <Select
            value={config.inject.restoreClipboard ? 'on' : 'off'}
            onChange={(v) => patch('inject', { restoreClipboard: v === 'on' })}
            options={[
              { value: 'on', label: 'Yes, restore it' },
              { value: 'off', label: 'No, leave my text there' }
            ]}
          />
        </Field>

        <Field label="Add a trailing newline" hint="Usually submits the message in a chat box. Turn off if you want to review before sending.">
          <Select
            value={config.inject.trailingNewline ? 'on' : 'off'}
            onChange={(v) => patch('inject', { trailingNewline: v === 'on' })}
            options={[
              { value: 'on', label: 'Yes — press Enter after pasting' },
              { value: 'off', label: 'No — paste only' }
            ]}
          />
        </Field>

        <Field
          label="Separate back-to-back dictations"
          hint="Pasting happens at the caret, so two dictations in a row would otherwise run together. Xono inserts a separator when the caret is still where it left the previous one."
        >
          <Select
            value={config.inject.appendSeparator}
            onChange={(v) => patch('inject', { appendSeparator: v })}
            options={[
              { value: 'space', label: 'A space (safe everywhere)' },
              { value: 'newline', label: 'A new line (careful in a terminal)' },
              { value: 'none', label: 'Nothing — paste exactly what was said' }
            ]}
          />
        </Field>

        <Field
          label="Treat dictations as consecutive for (seconds)"
          hint="How long after one dictation the next one still counts as following on from it. Beyond this, a separator would be a stray leading space."
        >
          <TextInput
            type="number"
            value={String(Math.round(config.inject.appendWindowMs / 1000))}
            onChange={(v) =>
              patch('inject', {
                appendWindowMs: Math.min(600_000, Math.max(1000, Number(v) * 1000 || 90_000))
              })
            }
          />
        </Field>

        <Field label="Restore delay (ms)">
          <TextInput
            type="number"
            value={String(config.inject.restoreClipboardDelayMs)}
            onChange={(v) =>
              patch('inject', {
                restoreClipboardDelayMs: Math.min(10_000, Math.max(0, Number.parseInt(v, 10) || 0))
              })
            }
          />
        </Field>
      </Section>

      <Section title="Check">
        <p className="muted">
          Verifies that the virtual-keyboard path is usable on this machine and tells you exactly what to run
          if it is not.
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => void runProbe()} disabled={checking}>
            {checking ? 'Checking…' : 'Check injection support'}
          </Button>
          {probe ? <Badge tone={probe.ok ? 'ok' : 'error'}>{probe.detail}</Badge> : null}
        </div>
      </Section>
    </div>
  )
}

export function AppearanceTab({
  config,
  patch
}: {
  config: XonoConfig
  patch: PatchFn
}): React.JSX.Element {
  return (
    <div className="tab">
      <Section title="Widget">
        <Field label="Width (px)">
          <TextInput
            type="number"
            value={String(config.ui.widgetWidth)}
            onChange={(v) => patch('ui', { widgetWidth: Math.min(900, Math.max(240, Number.parseInt(v, 10) || 420)) })}
          />
        </Field>
        <Field label="Distance from the bottom (px)">
          <TextInput
            type="number"
            value={String(config.ui.widgetOffsetBottom)}
            onChange={(v) =>
              patch('ui', { widgetOffsetBottom: Math.min(1000, Math.max(0, Number.parseInt(v, 10) || 48)) })
            }
          />
        </Field>
        <Field label="Hide after success (ms)">
          <TextInput
            type="number"
            value={String(config.ui.autoHideMs)}
            onChange={(v) => patch('ui', { autoHideMs: Math.min(30_000, Math.max(200, Number.parseInt(v, 10) || 1400)) })}
          />
        </Field>
      </Section>
    </div>
  )
}