import type { TranscriptResult } from '@shared/types'
import type { SttConfig, WhisperModelId } from '@shared/schema'

export interface TranscribeOptions {
  wavPath: string
  config: SttConfig
  vocabulary: string[]
  signal?: AbortSignal
  onProgress?: (label: string) => void
}

export interface SttProvider {
  readonly id: string
  readonly label: string
  isReady(): boolean
  ensureReady(onProgress?: (label: string, value?: number) => void): Promise<void>
  transcribe(opts: TranscribeOptions): Promise<TranscriptResult>
  dispose(): Promise<void>
}