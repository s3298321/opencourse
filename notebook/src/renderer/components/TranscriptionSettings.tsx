import { useEffect, useState } from 'react'
import { TranscriptionModelPicker } from '../../learning-ui/TranscriptionModelPicker'
import type { TranscriptionConfig } from '../../core/transcription'

export default function TranscriptionSettings({ version }: { version: number }) {
  const [config, setConfig] = useState<TranscriptionConfig>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    window.opencourse.dictation.settings().then(s => { if (current) setConfig(s.config) })
      .catch(e => { if (current) setError(e.message) })
    return () => { current = false }
  }, [version])
  return <section className="settings-section">
    <h2>Transcription</h2>
    <p className="meta">Dictate into an empty chat message using your OpenAI API key.</p>
    {config && <div className="settings-defaults"><TranscriptionModelPicker value={config} disabled={busy} change={value => {
      setBusy(true)
      setError('')
      window.opencourse.dictation.configure(value).then(s => setConfig(s.config))
        .catch(e => setError(e.message)).finally(() => setBusy(false))
    }} /></div>}
    {error && <p role="alert">{error}</p>}
  </section>
}
