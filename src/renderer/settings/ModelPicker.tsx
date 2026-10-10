import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RemoteModel } from '../../shared/types'
import { filterCatalogue } from '../../shared/catalogue'
import { Badge, Button } from './components'

/**
 * Searchable model picker for providers that publish a catalogue.
 *
 * OpenRouter lists 400+ models, so a `<select>` is unusable and a flat list is
 * unreadable. This filters as you type and shows the two facts that actually decide
 * the choice here: what it costs and how much context it has.
 *
 * The free-text field is kept alongside the picker on purpose — a model id can always
 * be typed by hand, which matters when the catalogue is stale or the provider is down.
 */
export function ModelPicker({
  models,
  loading,
  error,
  stale,
  value,
  onSelect,
  onRefresh,
  onManualChange,
  filter,
  setFilter,
  manualValue
}: {
  models: RemoteModel[]
  loading: boolean
  error: string | null
  stale: boolean
  value: string
  onSelect: (id: string) => void
  onRefresh: () => void
  onManualChange: (id: string) => void
  filter: string
  setFilter: (v: string) => void
  manualValue: string
}): React.JSX.Element {
  // The same function the main process uses, so the visible set can never disagree.
  const visible = useMemo(() => filterCatalogue(models, filter), [models, filter])
  const listRef = useRef<HTMLDivElement>(null)

  // Selecting an entry clears the filter so the user immediately sees the new choice
  // rather than wondering why the list collapsed.
  const choose = useCallback(
    (id: string) => {
      onSelect(id)
      setFilter('')
    },
    [onSelect, setFilter]
  )

  useEffect(() => {
    // Bring the current selection into view when the list changes underneath it.
    if (!listRef.current) return
    const active = listRef.current.querySelector('[data-active="true"]')
    active?.scrollIntoView({ block: 'nearest' })
  }, [filter, models])

  return (
    <div className="picker">
      <div className="picker__bar">
        <input
          type="text"
          className="picker__search"
          placeholder="Search models — try 'haiku', 'llama', 'free', 'gpt'"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        <Button onClick={onRefresh} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      {error ? (
        <p className="picker__error">{error}</p>
      ) : stale ? (
        <p className="picker__notice">Could not reach the provider — showing the last known list.</p>
      ) : null}

      <div className="picker__meta">
        {loading && models.length === 0 ? (
          <span>Loading models…</span>
        ) : (
          <span>
            {visible.length} of {models.length} models
            {visible.length < models.length ? ' match' : ''}
          </span>
        )}
        {models.length > 0 && models.some((m) => !m.supportsText) ? (
          <span className="picker__meta-note">non-text models are hidden</span>
        ) : null}
      </div>

      {visible.length === 0 && !loading ? (
        <p className="picker__empty">
          {models.length === 0
            ? 'No models loaded yet. Press Refresh, or type a model id below.'
            : `Nothing matches “${filter}”.`}
        </p>
      ) : (
        <div className="picker__list" ref={listRef} role="listbox" aria-label="Available models">
          {visible.map((model) => {
            const active = model.id === value
            return (
              <button
                key={model.id}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active}
                className={`picker__item ${active ? 'picker__item--active' : ''}`}
                onClick={() => choose(model.id)}
              >
                <span className="picker__item-main">
                  <span className="picker__item-name">{model.name}</span>
                  <span className="picker__item-id">{model.id}</span>
                </span>
                <span className="picker__item-meta">
                  {model.contextLength ? <span>{formatContext(model.contextLength)}</span> : null}
                  {model.inputPricePerMillion !== undefined ? (
                    <span title="USD per million tokens">
                      {formatPrice(model.inputPricePerMillion)} in / {formatPrice(model.outputPricePerMillion)} out
                    </span>
                  ) : (
                    <span className="picker__unknown" title="No published price">
                      no price listed
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="picker__manual">
        <input
          type="text"
          value={manualValue}
          placeholder="Or type a model id"
          spellCheck={false}
          onChange={(e) => onManualChange(e.target.value)}
          onBlur={(e) => {
            const typed = e.target.value.trim()
            if (typed) onSelect(typed)
          }}
        />
        {value && !models.some((m) => m.id === value) ? (
          <Badge tone="warn">custom id — not in the fetched list</Badge>
        ) : null}
      </div>
    </div>
  )
}

export function formatContext(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M ctx`
  if (n >= 1000) return `${trim(n / 1000)}k ctx`
  return `${n} ctx`
}

export function formatPrice(perMillion?: number): string {
  if (perMillion === undefined) return '—'
  if (perMillion === 0) return 'free'
  if (perMillion < 0.01) return `$${perMillion.toFixed(4)}`
  if (perMillion < 1) return `$${perMillion.toFixed(3)}`
  return `$${perMillion.toFixed(2)}`
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}