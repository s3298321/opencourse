import { useEffect, useRef, useState, type JSX } from 'react'
import { isCoachVoice, VOICES, VOICE_LANGUAGES } from '@core/coach/models'
import { VoicePreview, type VoicePreviewState } from '../coach/voice-preview'
import ActionButton from './ActionButton'

function voiceLabel(id: string): string {
  const name = id.charAt(0).toUpperCase() + id.slice(1)
  return isCoachVoice(id) ? `${name} · ${VOICE_LANGUAGES[id]}` : name
}

export default function CoachVoicePicker({ voice, busy, active, onSave }: {
  voice: string | null; busy: boolean; active: boolean; onSave: (voice: string) => Promise<void>
}): JSX.Element {
  const [chosen, setChosen] = useState(voice ?? '')
  const [state, setState] = useState<VoicePreviewState>('idle')
  const [error, setError] = useState<string | null>(null)
  const preview = useRef<VoicePreview | null>(null)
  useEffect(() => { setChosen(voice ?? '') }, [voice])
  useEffect(() => {
    setState('idle')
    return () => {
      const current = preview.current
      preview.current = null
      void current?.stop()
    }
  }, [active, voice === null])
  const listen = (): void => {
    if (preview.current) { void preview.current.stop(); return }
    setError(null)
    const current = new VoicePreview((next, message) => {
      if (preview.current !== current) return
      setState(next)
      if (message) setError(message)
      if (next === 'idle') preview.current = null
    })
    preview.current = current
    current.start(chosen)
  }
  return <div className="settings-coach-voice-picker">
    <label>
      <span>Default voice</span>
      <select className="settings-default-coach-voice" value={chosen} disabled={voice === null || busy}
        onChange={event => { void preview.current?.stop(); setChosen(event.target.value); setError(null) }}>
        {VOICES.map(id => <option key={id} value={id}>{voiceLabel(id)}</option>)}
      </select>
    </label>
    <div className="actions">
      <ActionButton icon={state === 'idle' ? 'play' : 'stop'} className="secondary settings-preview-coach-voice"
        disabled={!chosen || !active || busy} onClick={listen}>
        {state === 'idle' ? 'Preview voice' : state === 'loading' ? 'Cancel preview' : 'Stop preview'}
      </ActionButton>
      <ActionButton icon="check" className="settings-save-coach-voice" disabled={!chosen || chosen === voice || busy}
        onClick={() => { void preview.current?.stop(); void onSave(chosen) }}>Use voice</ActionButton>
    </div>
    <p className="meta" role="status">{state === 'loading' ? 'Connecting voice preview…' : state === 'playing' ? 'Playing voice preview…' : `Saved voice: ${voice ? voiceLabel(voice) : 'Loading…'}.`}</p>
    <p className="meta">Listen before choosing Use voice. Previews use your OpenAI API key and incur normal voice charges. Your microphone stays off.</p>
    {error && <p className="import-note error" role="alert">{error}</p>}
  </div>
}
