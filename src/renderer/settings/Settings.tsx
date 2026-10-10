import { useCallback, useEffect, useMemo, useState } from 'react'
import type { XonoConfig } from '../../shared/schema'
import { TABS, type PatchFn, type TabId } from './types'
import { ProvidersTab } from './tabs/Providers'
import { TranscriptionTab } from './tabs/Transcription'
import { DictationTab, VocabularyTab } from './tabs/Dictation'
import { AppearanceTab, InjectionTab } from './tabs/Injection'
import { DiagnosticsTab, HistoryTab } from './tabs/Diagnostics'

export function Settings(): React.JSX.Element {
  const [config, setConfig] = useState<XonoConfig | null>(null)
  const [tab, setTab] = useState<TabId>('providers')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.xono.config.get().then(setConfig)
    void window.xono.app.version().then((v) => setVersion(`v${v.version}`))
    return window.xono.config.onChanged(setConfig)
  }, [])

  // Writes go through a single debounce so typing an API key does not fire a disk
  // write per keystroke.
  const patch = useCallback<PatchFn>((section, value) => {
    void window.xono.config
      .patch(section, value)
      .then((next) => {
        setConfig(next)
        setSaveError(null)
      })
      .catch((err: Error) => setSaveError(err.message))
  }, [])

  const groups = useMemo(() => {
    const map = new Map<string, typeof TABS>()
    for (const t of TABS) {
      const list = map.get(t.group) ?? []
      map.set(t.group, [...list, t])
    }
    return [...map.entries()]
  }, [])

  if (!config) {
    return (
      <div className="settings settings--loading">
        <p className="muted">Loading settings…</p>
      </div>
    )
  }

  return (
    <div className="settings">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true" />
          <span className="brand__name">Xono</span>
          <span className="brand__version">{version}</span>
        </div>
        <nav className="nav">
          {groups.map(([group, items]) => (
            <div key={group} className="nav__group">
              <span className="nav__group-label">{group}</span>
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`nav__item ${tab === item.id ? 'nav__item--active' : ''}`}
                  onClick={() => setTab(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <p className="sidebar__path">
          <code>~/.config/xono/config.json</code>
        </p>
      </aside>

      <main className="content">
        {saveError ? <div className="banner banner--error">{saveError}</div> : null}
        {tab === 'providers' ? <ProvidersTab config={config} patch={patch} /> : null}
        {tab === 'transcription' ? <TranscriptionTab config={config} patch={patch} /> : null}
        {tab === 'dictation' ? <DictationTab config={config} patch={patch} /> : null}
        {tab === 'vocabulary' ? <VocabularyTab config={config} patch={patch} /> : null}
        {tab === 'injection' ? <InjectionTab config={config} patch={patch} /> : null}
        {tab === 'appearance' ? <AppearanceTab config={config} patch={patch} /> : null}
        {tab === 'diagnostics' ? <DiagnosticsTab /> : null}
        {tab === 'history' ? <HistoryTab /> : null}
      </main>
    </div>
  )
}