export const TRANSCRIPTION_MODELS = ['gpt-live-transcribe', 'gpt-realtime-whisper'] as const
export interface TranscriptionConfig {
  model: typeof TRANSCRIPTION_MODELS[number]
}
export const DEFAULT_TRANSCRIPTION: TranscriptionConfig = { model: 'gpt-live-transcribe' }

export function isTranscriptionConfig(input: unknown): input is TranscriptionConfig {
  const value = input as Partial<TranscriptionConfig> | null
  return !!value && TRANSCRIPTION_MODELS.some(model => model === value.model)
}
