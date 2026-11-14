import { TRANSCRIPTION_MODELS, type TranscriptionConfig } from '../core/transcription'

export function TranscriptionModelPicker({ value, disabled, change }: {
  value: TranscriptionConfig
  disabled: boolean
  change: (config: TranscriptionConfig) => void
}) {
  return <label>
    <span>Transcription model</span>
    <select value={value.model} disabled={disabled} onChange={e => {
      const model = TRANSCRIPTION_MODELS.find(model => model === e.target.value)
      if (model) change({ model })
    }}>
      {TRANSCRIPTION_MODELS.map(model => <option key={model}>{model}</option>)}
    </select>
  </label>
}
