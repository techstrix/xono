import { acceleratorKeys } from '@shared/accelerator'
import { useCallback, useEffect, useRef, useState } from 'react'
import { WIDGET_SHADOW_ROOM, type PipelineState, type Progress, type WaveFrame } from '../../shared/types'
import type { XonoApi } from '../../preload'
import { BorderBeam } from './BorderBeam'

declare global {
  interface Window {
    xono: XonoApi
  }
}

const BAR_COUNT = 48

/** States in which the pill is wider than its resting size. */
const EXPANDED: ReadonlySet<PipelineState> = new Set([
  'starting',
  'listening',
  'transcribing',
  'cleaning',
  'reviewing',
  'injecting',
  'done',
  'error'
])

/** States the user can click. The main process flips mouse passthrough to match. */
const INTERACTIVE: ReadonlySet<PipelineState> = new Set(['reviewing'])

interface WidgetView {
  state: PipelineState
  label: string
  notice: string | null
  progress: Progress | null
  result: string | null
  review: { text: string; raw: string } | null
  elapsed: number
  /** Whether the current state warrants the full-width layout. */
  expanded: boolean
}

const INITIAL: WidgetView = {
  state: 'idle',
  label: '',
  notice: null,
  progress: null,
  result: null,
  review: null,
  elapsed: 0,
  expanded: false
}

export function Widget(): React.JSX.Element {
  const [view, setView] = useState<WidgetView>(INITIAL)
  const [accelerator, setAccelerator] = useState('')
  const [peeked, setPeeked] = useState(false)

  const barsRef = useRef<number[]>(new Array(BAR_COUNT).fill(0))
  /**
   * Bar elements, cached. They only change when the state changes, and this renderer
   * runs for the whole life of the app — re-querying the DOM every animation frame
   * would mean 60 style/DOM walks a second, forever, to move 48 elements.
   */
  const barElsRef = useRef<HTMLElement[]>([])

  const push = useCallback((level: number) => {
    const next = barsRef.current.slice(1)
    // A gentle floor keeps a quiet room from reading as a dead microphone, which would
    // be indistinguishable from a broken one.
    next.push(Math.max(0.06, Math.min(1, level)))
    barsRef.current = next
  }, [])

  // Bars are written straight to the DOM from rAF. Re-rendering React 60 times a second
  // to move 48 divs would keep this renderer permanently busy for no benefit.
  useEffect(() => {
    let raf = 0
    const paint = (): void => {
      const els = barElsRef.current
      const arr = barsRef.current
      for (let i = 0; i < els.length; i++) {
        const el = els[i]!
        el.style.height = `${Math.max(8, (arr[i] ?? 0) * 100)}%`
      }
      raf = requestAnimationFrame(paint)
    }
    raf = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Re-acquire the bars whenever the waveform is mounted or torn down.
  useEffect(() => {
    barElsRef.current = Array.from(document.querySelectorAll<HTMLElement>('.wave__bar'))
  }, [view.state])

  useEffect(() => {
    void window.xono.hotkey.current().then(setAccelerator)
    // The main process offsets the window by this much so the pill's edge lands exactly
    // on the configured gap and its shadow is not clipped.
    document.documentElement.style.setProperty('--shadow-room', `${WIDGET_SHADOW_ROOM}px`)
  }, [])

  useEffect(() => {
    const p = window.xono.pipeline

    const offState = p.onState(({ state, label }) => {
      setView((v) => ({
        ...v,
        state,
        label: label ?? '',
        expanded: EXPANDED.has(state),
        progress: state === 'transcribing' || state === 'cleaning' ? v.progress : null,
        review: state === 'reviewing' ? v.review : null,
        notice: state === 'listening' || state === 'done' ? null : v.notice
      }))
    })

    const offWave = p.onWave((frame: WaveFrame) => push(frame.level))
    const offProgress = p.onProgress((progress: Progress) => setView((v) => ({ ...v, progress })))
    const offReview = p.onReview((review) => setView((v) => ({ ...v, review, result: review.text })))

    const offComplete = p.onComplete(({ cleaned, fallback }) =>
      setView((v) => ({
        ...v,
        result: cleaned,
        notice: fallback ? 'Cleaned locally — the provider was unavailable' : v.notice
      }))
    )

    const offDegraded = p.onDegraded((message: string) => setView((v) => ({ ...v, notice: message })))
    const offError = p.onError((message: string) =>
      setView((v) => ({ ...v, state: 'error', label: message, notice: message, expanded: true }))
    )
    const offCancelled = p.onCancelled(() =>
      setView((v) => ({ ...v, state: 'idle', label: '', result: null, review: null, expanded: false }))
    )

    // Announce readiness only after the listeners above are attached, so the state the
    // main process replays cannot arrive before there is anything to receive it.
    void window.xono.widget.ready()

    return () => {
      offState()
      offWave()
      offProgress()
      offReview()
      offComplete()
      offDegraded()
      offError()
      offCancelled()
    }
  }, [push])

  useEffect(() => {
    if (view.state !== 'listening') return
    const timer = setInterval(() => setView((v) => ({ ...v, elapsed: v.elapsed + 100 })), 100)
    return () => clearInterval(timer)
  }, [view.state])

  // Reset the waveform and the clock between utterances so the next one starts clean.
  useEffect(() => {
    if (view.state !== 'idle') return
    barsRef.current = new Array(BAR_COUNT).fill(0)
    setView((v) => (v.elapsed === 0 ? v : { ...v, elapsed: 0, label: '', result: null, review: null }))
  }, [view.state])

  const { state } = view
  const listening = state === 'listening'
  const working = state === 'transcribing' || state === 'cleaning' || state === 'injecting'
  const reviewing = state === 'reviewing'
  const interactive = INTERACTIVE.has(state)

  return (
    <div
      className={`stage ${view.expanded ? 'stage--expanded' : ''} ${interactive ? 'stage--interactive' : ''}`}
      data-state={state}
      role="status"
      aria-live="polite"
      onMouseEnter={() => setPeeked(true)}
      onMouseLeave={() => setPeeked(false)}
    >
      {state === 'idle' && (
        <IdlePill accelerator={accelerator} peeked={peeked} />
      )}

      {listening && (
        <div className="pill pill--live">
          <BorderBeam />
          <span className="dot dot--live" aria-hidden="true" />
          <div className="wave" aria-hidden="true">
            {barsRef.current.map((_, i) => (
              <span className="wave__bar" key={i} />
            ))}
          </div>
          <span className="timer">{formatElapsed(view.elapsed)}</span>
        </div>
      )}

      {working && (
        <div className="pill pill--work">
          <BorderBeam />
          <div className="work">
            <div className="work__bar">
              <div
                className={`work__fill ${view.progress?.value === undefined ? 'work__fill--indeterminate' : ''}`}
                style={view.progress?.value === undefined ? undefined : { width: `${view.progress.value * 100}%` }}
              />
            </div>
            <span className="work__label">{view.progress?.label ?? view.label}</span>
          </div>
        </div>
      )}

      {state === 'done' && view.result && <div className="pill pill--done">
          <BorderBeam /><Tick /><span className="preview">{view.result}</span></div>}

      {reviewing && view.review && (
        <div className="pill pill--review">
          <BorderBeam />
          <div className="review__text">{view.review.text}</div>
          <div className="review__actions">
            <button type="button" className="btn btn--primary" onClick={() => void window.xono.pipeline.review('accept')}>
              Paste
            </button>
            <button type="button" className="btn" onClick={() => void window.xono.pipeline.review('raw')}>
              Paste raw
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => void window.xono.pipeline.review('reject')}>
              Discard
            </button>
          </div>
        </div>
      )}

      {state === 'error' && !reviewing && (
        <div className="pill pill--error">
          <BorderBeam />
          <span className="error__text">{shorten(view.label || 'Something went wrong', 140)}</span>
          <button type="button" className="btn btn--ghost" onClick={() => void window.xono.pipeline.cancel()}>
            Dismiss
          </button>
        </div>
      )}

      {view.notice && !reviewing && state !== 'error' && state !== 'done' && listening === false && (
        <div className="notice">{shorten(view.notice, 150)}</div>
      )}
    </div>
  )
}

/**
 * The resting state: a small pill that is always there, showing the shortcut because a
 * global hotkey is otherwise undiscoverable. It breathes very slightly so it reads as
 * alive without pulling the eye.
 */
function IdlePill({ accelerator, peeked }: { accelerator: string; peeked: boolean }): React.JSX.Element {
  return (
    <div className={`pill pill--idle ${peeked ? 'pill--peeked' : ''}`}>
      <Mic />
      <span className="idle__hint keys">
        {acceleratorKeys(accelerator).map((key, i) => (
          <kbd key={`${key.label}-${i}`} className={key.modifier ? 'key key--mod' : 'key'}>
            {key.label}
          </kbd>
        ))}
      </span>
    </div>
  )
}

function Mic(): React.JSX.Element {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3Z"
        fill="currentColor"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function Tick(): React.JSX.Element {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="m5 13 4 4L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}
