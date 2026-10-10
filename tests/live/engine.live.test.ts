import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WhisperCppSttProvider, findWhisperCli } from '../../src/main/core/stt/whisperCpp'
import { ModelManager } from '../../src/main/core/stt/modelManager'
import { DEFAULT_CONFIG } from '../../src/shared/schema'
import { encodeWav } from '../../src/main/core/wav'

/**
 * Exercises the real whisper.cpp provider against the real binary and a real model.
 *
 * Skipped unless both are present, so `npm test` stays hermetic. To run it:
 *
 *   npm run setup:engine
 *   npm run test:engine
 *
 * The clip is synthetic: a low-level tone, not speech. The point is to verify the
 * process spawn, the exact flag set, the JSON artefact path and the parser — not
 * transcription quality. A tone should come back as a silence marker, which is
 * exactly the `isSilenceTranscript` case the pipeline relies on.
 */
const enabled = process.env.XONO_ENGINE === '1'
const binary = findWhisperCli('')

describe.skipIf(!enabled)('WhisperCppSttProvider (live engine)', () => {
  const modelId = 'tiny.en'
  const modelPath = join(
    process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? '', '.local/share'),
    'xono/models',
    `ggml-${modelId}.bin`
  )

  it('has a binary and a model to talk to', () => {
    expect(binary, 'run `npm run setup:engine` first').toBeTruthy()
    expect(existsSync(binary!), 'whisper-cli should be executable').toBe(true)
    expect(existsSync(modelPath), `run: bash scripts/setup-engine.sh`).toBe(true)
  })

  it('spawns whisper-cli with valid flags and parses its JSON output', async () => {
    const models = new ModelManager()
    const provider = new WhisperCppSttProvider(models, () => binary ?? '')

    expect(provider.isReady()).toBe(true)
    await expect(provider.ensureReady()).resolves.toBeUndefined()

    // Two seconds of a quiet tone, as a 16 kHz mono WAV.
    const pcm = new Int16Array(16_000 * 2)
    for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(i * 0.02) * 3000)

    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
    const workDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'xono-engine-'))
    const wavPath = join(workDir, 'tone.wav')
    writeFileSync(wavPath, encodeWav(pcm))

    const started = Date.now()
    const result = await provider.transcribe({
      wavPath,
      config: { ...DEFAULT_CONFIG.stt, model: modelId, timeoutMs: 120_000 },
      vocabulary: ['ydotool', 'parec']
    })
    const elapsed = Date.now() - started

    rmSync(workDir, { recursive: true, force: true })

    console.log(`  elapsed: ${(elapsed / 1000).toFixed(1)}s  result: ${JSON.stringify(result.text)}`)

    // The call completed, which proves the flag set is accepted and the JSON was read.
    expect(typeof result.text).toBe('string')
    expect(result.providerId).toBe('whisper-cpp')
    expect(result.model).toBe(modelId)
    expect(result.latencyMs).toBeGreaterThan(0)

    // A tone is not speech, so this must read as silence rather than as literal text.
    const { isSilenceTranscript } = await import('../../src/main/core/stt/whisperCpp')
    expect(isSilenceTranscript(result.text)).toBe(true)
  }, 180_000)
})