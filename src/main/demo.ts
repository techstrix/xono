import { loggerScope } from './core/logger'

const log = loggerScope('demo')

/**
 * Plays a scripted sequence of widget events.
 *
 * The widget's expanded states cannot otherwise be reached without a microphone, a
 * downloaded model and a configured LLM provider — which makes iterating on the
 * animation painful, and makes "did the pill actually expand?" unanswerable from a
 * script. This drives the real IPC channels the real pipeline uses, so what you see is
 * what the renderer actually renders.
 *
 * Enabled by `--demo`; harmless otherwise since it is never invoked.
 */
export function playWidgetDemo(send: (channel: string, payload: unknown) => void): () => void {
  let cancelled = false
  let timer: NodeJS.Timeout | undefined

  const at = (ms: number, fn: () => void): void => {
    timer = setTimeout(() => {
      if (!cancelled) fn()
    }, ms)
  }

  const state = (s: string, label?: string): void => send('state', { state: s, label })

  // A synthetic speech envelope: syllabic bursts with pauses, closer to real speech
  // than a sine would be, so the waveform can be judged honestly.
  const speech = (t: number): number => {
    const syllable = Math.sin(t * 0.011) * 0.5 + 0.5
    const phrase = Math.sin(t * 0.0017) * 0.5 + 0.5
    const pause = phrase > 0.28 ? 1 : 0.05
    return Math.max(0, syllable * phrase * pause)
  }

  log.info('playing the widget demo')

  state('starting', 'Preparing…')

  let elapsed = 0
  let tick = 0
  at(700, () => {
    state('listening', 'Listening…')
    const stream = setInterval(() => {
      if (cancelled) return
      elapsed += 32
      tick++
      send('wave', { level: speech(elapsed), speech: speech(elapsed) > 0.1 ? 1 : 0, t: elapsed })

      if (tick === 90) state('transcribing', 'Finishing recording…')
      if (tick === 110) state('cleaning', 'Cleaning with Mistral…')
      if (tick === 120) {
        state('injecting', 'Pasting…')
      }
      if (tick === 132) {
        send('complete', {
          raw: 'um so deploy the widget on friday you know',
          cleaned: 'Deploy the widget on Friday.',
          mode: 'cleaned',
          durationMs: elapsed,
          elapsedMs: 4200,
          fallback: false
        })
        state('done')
      }
      if (tick === 200) {
        clearInterval(stream)
        state('idle')
      }
    }, 32)
  })

  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
