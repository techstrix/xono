import { useEffect, useState } from 'react'
import type { DiagnosticsReport, HistoryEntry } from '../../../shared/types'
import { Badge, Button, Section } from '../components'

export function DiagnosticsTab(): React.JSX.Element {
  const [report, setReport] = useState<DiagnosticsReport | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    setReport(await window.xono.diagnostics.run())
    setBusy(false)
  }

  useEffect(() => {
    void run()
  }, [])

  const failing = report?.preflight.checks.filter((c) => c.severity === 'error' && !c.ok) ?? []
  const warnings = report?.preflight.checks.filter((c) => c.severity === 'warning' && !c.ok) ?? []

  return (
    <div className="tab">
      <Section title="Status">
        <div className="row">
          <Button variant="primary" onClick={() => void run()} disabled={busy}>
            {busy ? 'Checking…' : 'Run checks'}
          </Button>
          {report ? (
            <Badge tone={failing.length === 0 ? 'ok' : 'error'}>
              {failing.length === 0
                ? warnings.length === 0
                  ? 'Everything checks out'
                  : `Ready, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
                : `${failing.length} problem${failing.length === 1 ? '' : 's'} found`}
            </Badge>
          ) : null}
        </div>
      </Section>

      {report ? (
        <>
          <Section title="Checks">
            <div className="checks">
              {report.preflight.checks.map((c) => (
                <div key={c.id} className={`check check--${c.ok ? 'ok' : c.severity}`}>
                  <div className="check__head">
                    <span className="check__label">{c.label}</span>
                    <Badge tone={c.ok ? 'ok' : c.severity === 'error' ? 'error' : 'warn'}>
                      {c.ok ? 'ok' : 'problem'}
                    </Badge>
                  </div>
                  <p className="check__detail">{c.detail}</p>
                  {!c.ok && c.fixes.length > 0 ? (
                    <div className="fixes">
                      <span className="fixes__label">Fix:</span>
                      {c.fixes.map((fix) => (
                        <code key={fix} className="fix">
                          {fix}
                          <button
                            type="button"
                            aria-label="Copy this command"
                            onClick={() => void navigator.clipboard.writeText(fix)}
                          >
                            copy
                          </button>
                        </code>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Section>

          <Section title="Providers">
            <div className="checks">
              {report.providers.map((p) => (
                <div key={p.id} className={`check check--${p.ok ? 'ok' : 'warn'}`}>
                  <div className="check__head">
                    <span className="check__label">{p.id}</span>
                    <Badge tone={p.ok ? 'ok' : 'warn'}>{p.ok ? 'reachable' : 'unavailable'}</Badge>
                  </div>
                  <p className="check__detail">{p.detail}</p>
                </div>
              ))}
            </div>
          </Section>

          <Section title="System">
            <dl className="kv">
              <Row k="OS" v={`${report.platform.os} ${report.platform.release}`} />
              <Row k="Desktop" v={`${report.platform.desktop} (${report.platform.sessionType})`} />
              <Row k="Hotkey" v={report.hotkeyRegistered ? 'registered' : `NOT registered — ${report.hotkeyError ?? ''}`} />
              <Row k="VAD" v={report.vadEngineDetail} />
              <Row k="Injection" v={report.injectionMethod} />
              <Row k="CPUs" v={String(report.platform.cpus)} />
              <Row k="Memory" v={`${report.platform.totalMemMb} MB`} />
              <Row k="Electron" v={report.platform.electron} />
              <Row k="Node" v={report.platform.node} />
            </dl>
          </Section>

          <Section title="Models">
            <dl className="kv">
              {report.models.map((m) => (
                <Row key={m.id} k={m.id} v={m.present ? `${m.actualBytes ?? 0} bytes on disk` : 'not downloaded'} />
              ))}
            </dl>
          </Section>
        </>
      ) : null}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }): React.JSX.Element {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  )
}

export function HistoryTab(): React.JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[]>([])

  const refresh = (): void => {
    void window.xono.history.list().then(setEntries)
  }

  useEffect(() => {
    refresh()
    const off = window.xono.pipeline.onComplete(() => refresh())
    return off
  }, [])

  return (
    <div className="tab">
      <Section
        title="Recent dictations"
        headerExtra={
          <Button onClick={() => void window.xono.history.clear().then(refresh)}>Clear all</Button>
        }
      >
        <p className="muted">
          Kept locally so you can recover a bad paste. Capped at the limit set in the config file.
        </p>
        {entries.length === 0 ? (
          <p className="muted">Nothing recorded yet.</p>
        ) : (
          <div className="history">
            {entries.map((e) => (
              <div key={e.id} className="history__item">
                <div className="history__meta">
                  <span>{new Date(e.at).toLocaleTimeString()}</span>
                  <Badge tone={e.injected ? 'ok' : 'warn'}>{e.injected ? 'pasted' : 'not pasted'}</Badge>
                  {e.mode !== 'cleaned' ? <Badge tone="muted">{e.mode}</Badge> : null}
                </div>
                <p className="history__text">{e.cleaned}</p>
                <Button onClick={() => void window.xono.history.restore(e.id).then(refresh)}>
                  Paste again
                </Button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}