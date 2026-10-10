import { spawn } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import type { TranscriptResult } from '@shared/types'
import { loggerScope } from '../logger'
import type { ModelManager } from './modelManager'
import type { SttProvider, TranscribeOptions } from './types'
import type { WhisperModelId } from '@shared/schema'

const log = loggerScope('whisper')
const WORK_PREFIX = 'xono-stt-'

/**
 * Locates the whisper.cpp CLI. Preference order: explicit config path, the local
 * vendor build (dev), the packaged resources dir (prod), then PATH.
 */
export function findWhisperCli(configuredPath: string): string | null {
  const candidates = [
    configuredPath,
    resolve(process.cwd(), 'vendor/whisper.cpp/build/bin/whisper-cli'),
    process.resourcesPath ? join(process.resourcesPath, 'whisper', 'whisper-cli') : '',
    'whisper-cli'
  ].filter((c): c is string => Boolean(c))

  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
    } else {
      for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
        const full = join(dir, candidate)
        try {
          accessSync(full, constants.X_OK)
          return full
        } catch {
          /* keep looking */
        }
      }
    }
  }
  return null
}

interface ArgOptions {
  wav: string
  model: string
  language: string
  threads: number
  prompt: string
  beamSize: number
  temperature: number
  outputBase: string
}

/**
 * Verified against whisper.cpp 1.9.5 (`whisper-cli --help`): temperature is
 * `--temperature` / `-tp`, timestamps come off with `--no-timestamps` / `-nt`, and
 * `--output-json-full` / `-ojf` writes the JSON artefact we parse.
 *
 * Both the long and short spellings are offered as a fallback set, because upstream
 * has renamed flags between releases and an unrecognised flag makes the process print
 * usage and exit non-zero rather than failing in a way we can interpret. Retrying on
 * that specific failure keeps us working across builds without pinning a version.
 */
function buildArgSets(opts: ArgOptions): string[][] {
  const { wav, model, language, threads, prompt, beamSize, temperature, outputBase } = opts
  const common = ['-m', model, '-l', language, '-t', String(threads)]

  const modern: string[] = [
    '-f', wav,
    ...common,
    '--no-timestamps',
    '--output-json-full',
    '--output-file', outputBase,
    '--beam-size', String(beamSize),
    '--temperature', String(temperature),
    '--no-prints'
  ]
  const shortFlags: string[] = ['-f', wav, ...common, '-nt', '-ojf', '-of', outputBase, '-bs', String(beamSize), '-tp', String(temperature), '-np']

  if (prompt) {
    modern.push('--prompt', prompt)
    shortFlags.push('--prompt', prompt)
  }

  return [modern, shortFlags]
}

/** whisper.cpp caps its prompt at the model's context; 600 chars is well inside it. */
export function buildInitialPrompt(vocabulary: string[]): string {
  const terms = vocabulary
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 80)
  if (terms.length === 0) return ''
  return `Technical vocabulary in this audio: ${terms.join(', ')}.`.slice(0, 600)
}

export class WhisperCppSttProvider implements SttProvider {
  readonly id = 'whisper-cpp'
  readonly label = 'whisper.cpp (local)'

  private binaryPath: string | null

  constructor(
    private readonly models: ModelManager,
    private readonly getEnginePath: () => string
  ) {
    this.binaryPath = findWhisperCli(getEnginePath())
    if (!this.binaryPath) {
      log.warn('whisper-cli not found. Run `npm run setup:engine` to build it.')
    } else {
      log.info('using whisper binary at', this.binaryPath)
    }
  }

  isReady(): boolean {
    return Boolean(this.binaryPath)
  }

  binary(): string | null {
    return this.binaryPath
  }

  /** Re-resolve the binary after the user changes the path in settings. */
  refresh(): void {
    this.binaryPath = findWhisperCli(this.getEnginePath())
  }

  async ensureReady(): Promise<void> {
    if (!this.binaryPath) {
      throw new Error(
        'whisper.cpp is not built. Run `npm run setup:engine`, or set the binary path in Settings → Transcription.'
      )
    }
  }

  async ensureModel(id: string, onProgress?: (label: string, value?: number) => void): Promise<string> {
    const modelId = id as WhisperModelId
    if (!this.models.isReady(modelId)) {
      onProgress?.(`Downloading ${id} model…`, 0)
      await this.models.download(modelId)
      onProgress?.('Model ready', 1)
    }
    return this.models.pathFor(modelId)
  }

  async transcribe(opts: TranscribeOptions): Promise<TranscriptResult> {
    const started = Date.now()
    await this.ensureReady()

    const modelPath = await this.ensureModel(opts.config.model, opts.onProgress)
    const workDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', WORK_PREFIX))
    const outputBase = join(workDir, 'out')

    try {
      const threads = opts.config.threads > 0 ? opts.config.threads : Math.max(1, cpus().length - 1)
      const argSets = buildArgSets({
        wav: opts.wavPath,
        model: modelPath,
        language: opts.config.language,
        threads,
        prompt: buildInitialPrompt(opts.vocabulary),
        beamSize: opts.config.beamSize,
        temperature: opts.config.temperature,
        outputBase
      })

      let lastError = ''
      for (let attempt = 0; attempt < argSets.length; attempt++) {
        opts.onProgress?.(attempt === 0 ? 'Transcribing…' : 'Retrying with legacy CLI flags…')
        try {
          const { stdout, stderr } = await this.run(this.binaryPath!, argSets[attempt]!, opts)
          const text = this.readResult(outputBase, stdout)
          if (text.trim()) {
            return {
              text: normalise(text),
              providerId: this.id,
              model: opts.config.model,
              latencyMs: Date.now() - started,
              language: opts.config.language
            }
          }
          lastError = stderr.trim() || 'whisper.cpp produced no output'
        } catch (err) {
          const message = (err as Error).message
          lastError = message
          // Only fall through to the legacy flags when the binary complained about
          // the arguments; any other failure is a real error.
          if (!/unrecognized|unknown option|invalid|usage:|error:.*option/i.test(message)) throw err
          log.warn(`whisper.cpp rejected flag set ${attempt}: ${message}`)
        }
      }

      throw new Error(`Transcription failed. ${lastError}`)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  private run(
    binary: string,
    args: string[],
    opts: TranscribeOptions
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''

      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        cleanup()
        reject(new Error(`Transcription timed out after ${opts.config.timeoutMs}ms`))
      }, opts.config.timeoutMs)

      const onAbort = (): void => {
        child.kill('SIGKILL')
        cleanup()
        reject(new Error('Transcription cancelled'))
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }

      opts.signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString()
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString()
      })
      child.on('error', (err) => {
        cleanup()
        reject(new Error(`Could not run whisper.cpp: ${err.message}`))
      })
      child.on('close', (code) => {
        cleanup()
        if (code === 0) resolvePromise({ stdout, stderr })
        else reject(new Error(stderr.trim() || stdout.trim() || `whisper.cpp exited with code ${code}`))
      })
    })
  }

  /** Prefer the JSON artefact; fall back to stdout for builds without --output-file. */
  private readResult(outputBase: string, stdout: string): string {
    for (const suffix of ['.json', '.wav.json']) {
      const file = `${outputBase}${suffix}`
      if (!existsSync(file)) continue
      try {
        const text = extractText(JSON.parse(readFileSync(file, 'utf8')) as unknown)
        if (text) return text
      } catch (err) {
        log.warn('could not parse whisper json output', err)
      }
    }
    return extractText(stdout)
  }

  async dispose(): Promise<void> {
    /* each transcription is a short-lived child process; nothing to release */
  }
}

interface WhisperJsonSegment {
  text?: string
}

function extractText(payload: unknown): string {
  if (typeof payload === 'string') return payload
  const obj = payload as { transcription?: WhisperJsonSegment[]; text?: string } | null
  if (!obj || typeof obj !== 'object') return ''
  if (Array.isArray(obj.transcription)) {
    return obj.transcription.map((seg) => (typeof seg?.text === 'string' ? seg.text : '')).join('').trim()
  }
  return typeof obj.text === 'string' ? obj.text : ''
}

/**
 * The special tokens whisper.cpp emits when it cannot find speech. Matching an explicit
 * list matters: a blanket `/\[[^\]]*\]/g` also eats whatever the user actually
 * dictated, and "[TODO]" or "[see README]" are perfectly legitimate to say out loud.
 */
const WHISPER_SPECIAL_TOKENS = [
  'BLANK_AUDIO',
  'SILENCE',
  'NO SPEECH',
  'MUSIC',
  'SOUNDS',
  'HALLUCINATION',
  'INDEFINITE',
  '_BEG_',
  '_TT_',
  '_TOT_',
  '_HASH_'
].join('|')

const SPECIAL_TOKEN_RE = new RegExp(`\\[\\s*(?:${WHISPER_SPECIAL_TOKENS})\\s*\\]`, 'gi')

/**
 * Also strips whisper's segment markers, but only the shapes it actually emits
 * (`[00:00:00.000 --> 00:00:02.000]`), so other bracketed text survives intact.
 */
const TIMESTAMP_MARKER_RE = /\[\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\s*\]/g

export function normalise(text: string): string {
  return text
    .replace(SPECIAL_TOKEN_RE, ' ')
    .replace(TIMESTAMP_MARKER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** True when the transcript is nothing but silence markers. */
export function isSilenceTranscript(text: string): boolean {
  return normalise(text).length === 0
}

/** Remove temp workdirs orphaned by a previous crash. */
export function sweepSttWorkDirs(maxAgeMs = 3_600_000): void {
  const base = process.env.TMPDIR ?? '/tmp'
  if (!existsSync(base)) return
  const cutoff = Date.now() - maxAgeMs
  for (const name of readdirSync(base)) {
    if (!name.startsWith(WORK_PREFIX)) continue
    const full = join(base, name)
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}