/**
 * Live hardware smoke test. Runs the real capture → VAD → WAV path against the real
 * microphone, so a broken pipe, a wrong `parec` flag, or a VAD that never fires shows
 * up without needing whisper or an LLM.
 *
 * Skipped by default because it records from an actual device:
 *
 *   npm run test:live              # 6 seconds, default mic
 *   XONO_LIVE_SECONDS=15 npm run test:live
 *
 * Speak or make noise while it runs — silence is a legitimate result here and is
 * reported as such rather than failing the test.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AudioRecorder, listInputDevices } from '../../src/main/core/recorder'
import { UtteranceTracker } from '../../src/main/core/vad'
import { encodeWav, pcmDurationMs, peak, rms } from '../../src/main/core/wav'
import { DEFAULT_CONFIG } from '../../src/shared/schema'
import { SAMPLE_RATE } from '../../src/shared/types'

const live = process.env.XONO_LIVE === '1'
const seconds = Number(process.env.XONO_LIVE_SECONDS ?? 6)

describe.skipIf(!live)('live audio capture', () => {
  it('captures, analyses, and trims real audio from the default device', async () => {
    const devices = await listInputDevices()
    console.log(`\n  devices: ${devices.map((d) => d.name).join(', ') || '(none reported)'}`)

    const recorder = new AudioRecorder()
    const tracker = new UtteranceTracker({ ...DEFAULT_CONFIG.vad, autoStopOnSilence: false })

    let frames = 0
    let loudest = 0

    await recorder.start({
      deviceId: devices[0]?.id,
      onChunk: (pcm) => void tracker.push(pcm),
      onFrame: (frame) => {
        frames++
        loudest = Math.max(loudest, frame.level)
      }
    })

    console.log(`  capturing for ${seconds}s — speak now…`)
    await new Promise((r) => setTimeout(r, seconds * 1000))

    const pcm = await recorder.stop()
    await tracker.flush()

    const dir = mkdtempSync(join(tmpdir(), 'xono-live-'))
    const wav = join(dir, 'utterance.wav')
    const bytes = encodeWav(pcm)
    writeFileSync(wav, bytes)

    const status = tracker.status()
    const range = tracker.trimRange()

    console.log(`  captured:     ${pcm.length} samples (${pcmDurationMs(pcm).toFixed(0)} ms @ ${SAMPLE_RATE}Hz)`)
    console.log(`  frames:       ${frames} (${(frames / seconds).toFixed(1)}/s)`)
    console.log(`  peak / rms:   ${peak(pcm).toFixed(4)} / ${rms(pcm).toFixed(5)}`)
    console.log(`  loudest lvl:  ${loudest.toFixed(4)}`)
    console.log(`  speech:       ${status.speechDetected} (prob ${status.speechProb.toFixed(2)})`)
    console.log(`  trim:         ${range.start}..${range.end} of ${pcm.length}`)
    console.log(`  wav:          ${bytes.length} bytes`)

    if (peak(pcm) < 0.001) {
      console.log('  ! near-silence — the mic may be muted or the wrong source selected')
    } else {
      console.log('  ✓ real audio captured')
    }

    // The hard assertions are about the pipe and the framing, not about whether the
    // room happened to be quiet.
    expect(pcm.length).toBeGreaterThan(0)
    expect(bytes.length).toBe(44 + pcm.length * 2)
    // Frames arrive roughly every 32ms; anything under ~10/s means the pipe is not
    // streaming.
    expect(frames / seconds).toBeGreaterThan(5)
    expect(range.end).toBeLessThanOrEqual(pcm.length)
    expect(range.start).toBeLessThanOrEqual(range.end)

    rmSync(dir, { recursive: true, force: true })
  }, seconds * 1000 + 30_000)
})