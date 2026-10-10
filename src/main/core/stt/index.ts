import type { WhisperModelId } from '@shared/schema'
import { loggerScope } from '../logger'
import { ModelManager } from './modelManager'
import type { SttProvider } from './types'
import { WhisperCppSttProvider } from './whisperCpp'

const log = loggerScope('stt')

export { ModelManager } from './modelManager'
export {
  WhisperCppSttProvider,
  buildInitialPrompt,
  findWhisperCli,
  isSilenceTranscript,
  normalise,
  sweepSttWorkDirs
} from './whisperCpp'
export type { SttProvider, TranscribeOptions } from './types'

export interface SttRegistry {
  models: ModelManager
  current: SttProvider
  /** Only meaningful once a cloud provider exists; recorded for logs/UI today. */
  select(id: WhisperModelId): void
  dispose(): Promise<void>
}

/**
 * v1 ships local whisper.cpp only. Cloud STT providers implement the same
 * `SttProvider` interface and slot in here without touching the pipeline.
 */
export function createSttRegistry(getEnginePath: () => string): SttRegistry {
  const models = new ModelManager()
  const current = new WhisperCppSttProvider(models, getEnginePath)
  return {
    models,
    current,
    select: (id) => log.info(`stt model set to ${id}`),
    dispose: () => current.dispose()
  }
}